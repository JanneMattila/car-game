#include "clientnet.h"

#include <algorithm>
#include <cmath>

#include "log.h"

namespace cg {

namespace {
constexpr double kTickMs = 1000.0 / physics::kTickRate;
constexpr int kMaxStepsPerUpdate = 30;
constexpr int kHardResyncTicks = 30;
} // namespace

const char *netStateName(NetClient::State state) {
  switch (state) {
  case NetClient::State::Connecting: return "connecting";
  case NetClient::State::Connected: return "connected";
  case NetClient::State::Ended: return "ended";
  case NetClient::State::Failed: return "failed";
  }
  return "?";
}

NetClient::NetClient(Options options, TrackResolver resolver)
    : options_(std::move(options)), resolver_(std::move(resolver)) {
  history_.assign(kHistory, InputCmd{});
  historyTicks_.assign(kHistory, -1);
}

NetClient::~NetClient() = default;

uint32_t NetClient::clientTimeMs() const {
  // Never zero so that zero can mean "no echo" on the wire.
  return static_cast<uint32_t>((nowMicros() - startMicros_) / 1000) + 1;
}

bool NetClient::start() {
  if (!socket_.open(0)) {
    state_ = State::Failed;
    status_ = "cannot open UDP socket";
    return false;
  }
  net_ = std::make_unique<ConditionedSocket>(socket_, options_.seed);
  net_->setConditions(options_.conditions);
  startMicros_ = nowMicros();
  lastUpdateMicros_ = startMicros_;
  rateWindowStartMs_ = nowMillis();
  state_ = State::Connecting;
  status_ = "connecting to " + options_.server.toString();
  CG_INFO("%s", status_.c_str());
  return true;
}

void NetClient::disconnect() {
  if (state_ == State::Connected || state_ == State::Connecting) {
    auto packet = encodeDisconnect();
    // Bypass simulated latency so the notice leaves before the socket closes.
    for (int i = 0; i < 2; ++i) socket_.sendTo(options_.server, packet.data(), packet.size());
    state_ = State::Ended;
    status_ = "disconnected";
  }
}

void NetClient::update(const InputSampler &sampler) {
  if (!net_) return;
  int64_t now = nowMicros();
  double nowMs = nowMillis();
  net_->pump();
  Address from;
  std::vector<uint8_t> data;
  while (net_->receive(from, data)) {
    if (from != options_.server) continue;
    rateBytesIn_ += data.size();
    handlePacket(data);
  }

  if (state_ == State::Connecting) {
    if (nowMs - lastHelloMs_ > 250) {
      HelloMsg hello{options_.token, clientTimeMs()};
      auto packet = encodeHello(hello);
      rateBytesOut_ += packet.size();
      net_->sendTo(options_.server, packet);
      lastHelloMs_ = nowMs;
    }
    if ((now - startMicros_) / 1e6 > options_.connectTimeoutSec) {
      state_ = State::Failed;
      lost_ = true;
      status_ = "could not reach game server " + options_.server.toString();
      CG_WARN("%s", status_.c_str());
    }
  } else if (state_ == State::Connected) {
    if (nowMs - lastHeardMs_ > options_.lostTimeoutSec * 1000) {
      state_ = State::Failed;
      lost_ = true;
      status_ = "lost connection to game server";
      CG_WARN("%s", status_.c_str());
    } else {
      double dt = std::min(0.25, (now - lastUpdateMicros_) / 1e6);
      clockTicks_ += dt * physics::kTickRate * timeScale_;
      int32_t target = static_cast<int32_t>(std::floor(clockTicks_));
      int steps = 0;
      while (predictedTick_ < target && steps < kMaxStepsPerUpdate) {
        InputCmd input = sampler ? sampler(predictedTick_, *world_, slot_) : InputCmd{};
        int ring = predictedTick_ % kHistory;
        history_[ring] = input;
        historyTicks_[ring] = predictedTick_;
        stepPredicted(predictedTick_);
        predictedTick_++;
        sendInputs();
        steps++;
      }
      if (predictedTick_ < target) clockTicks_ = predictedTick_; // drop time after a long stall
      alpha_ = clampd(clockTicks_ - predictedTick_, 0, 1);
      double decay = std::exp(-options_.smoothingRate * dt);
      for (size_t i = 0; i < posError_.size(); ++i) {
        posError_[i] = posError_[i] * decay;
        angleError_[i] *= decay;
      }
    }
  }
  lastUpdateMicros_ = now;
  net_->pump();

  if (nowMs - rateWindowStartMs_ >= 1000) {
    double seconds = (nowMs - rateWindowStartMs_) / 1000;
    stats_.bytesInPerSec = rateBytesIn_ / seconds;
    stats_.bytesOutPerSec = rateBytesOut_ / seconds;
    rateBytesIn_ = rateBytesOut_ = 0;
    rateWindowStartMs_ = nowMs;
  }
}

void NetClient::handlePacket(const std::vector<uint8_t> &data) {
  ByteReader r(data.data(), data.size());
  PacketType type;
  if (!readHeader(r, type)) return;
  lastHeardMs_ = nowMillis();
  switch (type) {
  case PacketType::Welcome: {
    WelcomeMsg welcome;
    if (decodeWelcome(r, welcome) && state_ == State::Connecting) onWelcome(welcome);
    break;
  }
  case PacketType::Reject: {
    std::string reason;
    decodeReject(r, reason);
    if (state_ == State::Connecting || state_ == State::Connected) {
      state_ = State::Failed;
      status_ = "server rejected connection: " + reason;
      CG_WARN("%s", status_.c_str());
    }
    break;
  }
  case PacketType::Snapshot: {
    SnapshotMsg snapshot;
    if (state_ == State::Connected && decodeSnapshot(r, snapshot)) onSnapshot(snapshot);
    break;
  }
  case PacketType::Shutdown: {
    ShutdownMsg msg;
    decodeShutdown(r, msg);
    if (state_ == State::Connected || state_ == State::Connecting) {
      state_ = State::Ended;
      status_ = "match ended: " + msg.reason;
      CG_INFO("%s", status_.c_str());
    }
    break;
  }
  default: break;
  }
}

void NetClient::onWelcome(const WelcomeMsg &welcome) {
  auto track = resolver_ ? resolver_(welcome.trackId) : nullptr;
  if (!track) {
    state_ = State::Failed;
    status_ = "track '" + welcome.trackId + "' is not available";
    CG_ERROR("%s", status_.c_str());
    return;
  }
  welcome_ = welcome;
  slot_ = welcome.slot;
  track_ = track;
  world_ = std::make_unique<World>(track_);
  int count = static_cast<int>(welcome.players.size());
  world_->resize(count);
  for (auto &car : world_->cars) car.active = false;
  previous_ = world_->cars;
  posError_.assign(count, Vec2{});
  angleError_.assign(count, 0);
  remoteInputs_.assign(count, InputCmd{});
  meta_.assign(count, CarMeta{});
  for (const PlayerInfo &p : welcome.players)
    if (p.slot < count) meta_[p.slot].info = p;
  snapshotInterval_ = std::max(1, physics::kTickRate / std::max<int>(1, welcome.snapshotRate));

  double rtt = std::max<double>(0, static_cast<double>(clientTimeMs()) - welcome.echoClientTime);
  srtt_ = rtt;
  rttVar_ = rtt / 4;
  // The welcome took half an RTT to arrive and our inputs need another half to reach the server.
  predictedTick_ = welcome.serverTick + static_cast<int32_t>(std::ceil(rtt / kTickMs)) + 2;
  clockTicks_ = predictedTick_;
  lastUpdateMicros_ = nowMicros();
  state_ = State::Connected;
  status_ = "connected";
  CG_INFO("joined match %s as slot %d (%s), track %s, rtt %.0fms, start tick %d",
          welcome.matchId.c_str(), slot_, meta_[slot_].info.nickname.c_str(),
          welcome.trackId.c_str(), rtt, predictedTick_);
}

void NetClient::stepPredicted(int32_t tick) {
  previous_ = world_->cars;
  if (tick < raceStartTick_) return;
  std::vector<InputCmd> inputs = remoteInputs_;
  int ring = tick % kHistory;
  if (slot_ >= 0 && slot_ < static_cast<int>(inputs.size()))
    inputs[slot_] = historyTicks_[ring] == tick ? history_[ring] : InputCmd{};
  world_->step(inputs);
  for (CarState &car : world_->cars) quantize(car);
}

void NetClient::sendInputs() {
  int32_t last = predictedTick_ - 1;
  int32_t first = std::max(ackedInputTick_ + 1, last - (kMaxInputsPerPacket - 1));
  InputMsg msg;
  msg.clientTime = clientTimeMs();
  msg.rttMs = static_cast<uint16_t>(std::min(65535.0, std::max(0.0, srtt_)));
  msg.ackSnapshotTick = lastSnapshotTick_;
  for (int32_t t = first; t <= last; ++t) {
    int ring = t % kHistory;
    if (historyTicks_[ring] != t) {
      if (msg.inputs.empty()) continue;
      break;
    }
    if (msg.inputs.empty()) msg.firstTick = t;
    msg.inputs.push_back(history_[ring]);
  }
  if (msg.inputs.empty()) return;
  auto packet = encodeInput(msg);
  rateBytesOut_ += packet.size();
  net_->sendTo(options_.server, packet);
  stats_.inputsSent++;
}

void NetClient::adjustClock(int serverLead) {
  double jitterTicks = rttVar_ / kTickMs;
  NetConditions c = net_->conditions();
  double lossMargin = c.lossPercent > 0 ? 1 : 0;
  double target = clampd(1.5 + 2 * jitterTicks + lossMargin, 1.5, 15);
  stats_.targetLead = target;
  double error = serverLead - target;
  uint64_t nowMs = clientTimeMs();
  if (serverLead == kLeadUnknown || nowMs < clockHoldUntilMs_) return;
  // Before the race a jump is invisible, so snap quickly. While racing, only snap when inputs
  // are clearly arriving too late (they would be dropped) or the clock drifted far ahead.
  bool preRace = lastSnapshotTick_ < raceStartTick_;
  bool resync = preRace ? std::fabs(error) > 2 : (serverLead < 0 || error > kHardResyncTicks);
  if (resync) {
    clockTicks_ -= error;
    int32_t newTick = static_cast<int32_t>(std::floor(clockTicks_));
    CG_WARN("clock resync: lead %d target %.1f, predicted tick %d -> %d", serverLead, target,
            predictedTick_, newTick);
    if (newTick < predictedTick_) predictedTick_ = std::max(newTick, lastSnapshotTick_);
    timeScale_ = 1;
    stats_.hardResyncs++;
    // Wait for inputs sent after the jump to reach the server and its lead window to roll over.
    clockHoldUntilMs_ = nowMs + static_cast<uint64_t>(std::max(0.0, srtt_) + 2 * rttVar_) + 300;
    return;
  }
  if (std::fabs(error) < 0.75) timeScale_ = 1;
  else timeScale_ = 1 + clampd(-error * 0.02, -0.08, 0.08);
}

void NetClient::onSnapshot(const SnapshotMsg &snap) {
  if (snap.serverTick <= lastSnapshotTick_) return; // duplicate or reordered
  if (lastSnapshotTick_ >= 0) {
    int missing = (snap.serverTick - lastSnapshotTick_) / snapshotInterval_ - 1;
    if (missing > 0) stats_.snapshotGaps += missing;
  }
  lastSnapshotTick_ = snap.serverTick;
  stats_.snapshots++;
  stats_.serverTick = snap.serverTick;

  if (snap.echoClientTime != 0) {
    double sample = static_cast<double>(clientTimeMs()) - snap.echoClientTime - snap.holdMs;
    if (sample >= 0 && sample < 5000) {
      if (srtt_ < 0) srtt_ = sample;
      rttVar_ = rttVar_ * 0.9 + std::fabs(sample - srtt_) * 0.1;
      srtt_ = srtt_ * 0.9 + sample * 0.1;
    }
  }
  phase_ = snap.phase;
  raceStartTick_ = snap.phase == MatchPhase::Waiting ? INT32_MAX : snap.raceStartTick;
  phaseEndTick_ = snap.phaseEndTick;
  if (!snap.results.empty()) results_ = snap.results;
  ackedInputTick_ = std::max(ackedInputTick_, snap.lastInputTick);
  if (snap.inputLead != kLeadUnknown) serverLead_ = snap.inputLead;
  adjustClock(snap.inputLead);

  // Reconcile: rewind to the authoritative state and replay to the predicted tick.
  std::vector<CarState> before = world_->cars;
  for (const CarSnapshot &cs : snap.cars) {
    if (cs.slot >= world_->cars.size()) continue;
    applySnapshot(cs, world_->cars[cs.slot]);
    InputCmd remote = cs.lastInput;
    remote.buttons &= static_cast<uint8_t>(~kInputRespawn);
    remoteInputs_[cs.slot] = remote;
    CarMeta &m = meta_[cs.slot];
    m.connected = cs.connected;
    m.finished = cs.finished;
    m.rank = cs.rank;
    m.finishMs = cs.finishMs;
    m.bestLapMs = cs.bestLapMs;
    m.lastLapMs = cs.lastLapMs;
  }
  if (snap.serverTick > predictedTick_) {
    // Prediction fell behind the server (start-up or a long stall): jump ahead.
    predictedTick_ = snap.serverTick;
    clockTicks_ = predictedTick_ + stats_.targetLead;
    previous_ = world_->cars;
    std::fill(posError_.begin(), posError_.end(), Vec2{});
    std::fill(angleError_.begin(), angleError_.end(), 0.0);
    stats_.hardResyncs++;
    stats_.lastResimTicks = 0;
    return;
  }
  previous_ = world_->cars;
  for (int32_t t = snap.serverTick; t < predictedTick_; ++t) stepPredicted(t);
  stats_.lastResimTicks = predictedTick_ - snap.serverTick;

  const Track &track = *track_;
  for (size_t i = 0; i < world_->cars.size(); ++i) {
    const CarState &now = world_->cars[i];
    const CarState &old = before[i];
    if (!now.active || !old.active) {
      posError_[i] = {};
      angleError_[i] = 0;
      continue;
    }
    Vec2 oldPos = track.wrapAround ? unwrapForTrack(old.pos, now.pos, track.width, track.height)
                                   : old.pos;
    Vec2 delta = oldPos - now.pos;
    double d = length(delta);
    if (static_cast<int>(i) == slot_) {
      stats_.lastCorrectionPx = d;
      if (d > 0.01) {
        stats_.mispredictions++;
        stats_.maxCorrectionPx = std::max(stats_.maxCorrectionPx, d);
        correctionSum_ += d;
        correctionCount_++;
      }
    }
    if (d > options_.snapDistance) {
      posError_[i] = {};
      angleError_[i] = 0;
    } else {
      posError_[i] = posError_[i] + delta;
      angleError_[i] = wrapAngle(angleError_[i] + wrapAngle(old.angle - now.angle));
    }
  }
}

NetClient::RenderCar NetClient::renderCar(int slot) const {
  RenderCar out;
  if (!world_ || slot < 0 || slot >= world_->slots()) return out;
  const CarState &cur = world_->cars[slot];
  const CarState &prev = slot < static_cast<int>(previous_.size()) ? previous_[slot] : cur;
  const Track &track = *track_;
  out.active = cur.active;
  Vec2 prevPos = prev.pos;
  if (track.wrapAround) prevPos = unwrapForTrack(prev.pos, cur.pos, track.width, track.height);
  if (!prev.active) prevPos = cur.pos;
  out.pos = prevPos + (cur.pos - prevPos) * alpha_ + posError_[slot];
  if (track.wrapAround) {
    out.pos.x = positiveMod(out.pos.x, track.width);
    out.pos.y = positiveMod(out.pos.y, track.height);
  }
  double prevAngle = prev.active ? prev.angle : cur.angle;
  out.angle = prevAngle + wrapAngle(cur.angle - prevAngle) * alpha_ + angleError_[slot];
  out.vel = cur.vel;
  out.nitro = cur.nitro;
  out.nitroActive = cur.nitroActive;
  return out;
}

NetClient::Stats NetClient::stats() const {
  Stats s = stats_;
  s.rttMs = std::max(0.0, srtt_);
  s.jitterMs = rttVar_;
  s.serverLead = serverLead_;
  s.timeScale = timeScale_;
  s.predictedTick = predictedTick_;
  s.avgCorrectionPx = correctionCount_ ? correctionSum_ / correctionCount_ : 0;
  if (net_) s.conditions = net_->conditions();
  return s;
}

} // namespace cg
