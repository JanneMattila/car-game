#include "match.h"

#include <algorithm>
#include <cmath>
#include <tuple>

#include "../common/log.h"

namespace cg {

namespace {
constexpr int kInputRing = 256;
constexpr int kMaxInputAhead = 120;
constexpr double kTickMicros = 1e6 / physics::kTickRate;

uint32_t ticksToMs(int32_t ticks) {
  return static_cast<uint32_t>(std::llround(ticks * 1000.0 / physics::kTickRate));
}
} // namespace

bool parseMatchConfig(const Json &json, MatchConfig &config, std::string *error) {
  auto fail = [&](const std::string &message) {
    if (error) *error = message;
    return false;
  };
  if (!json.isObject()) return fail("config must be a JSON object");
  config.matchId = json["matchId"].string(config.matchId);
  if (json["port"].isNumber()) config.port = static_cast<uint16_t>(json["port"].integer());
  config.bindHost = json["bindHost"].string(config.bindHost);
  config.lapCount = std::max(1, std::min(20, json["lapCount"].integer(config.lapCount)));
  config.snapshotRate = std::max(10, std::min(60, json["snapshotRate"].integer(config.snapshotRate)));
  config.waitTimeoutSec = json["waitTimeoutSec"].number(config.waitTimeoutSec);
  config.resultsSec = json["resultsSec"].number(config.resultsSec);
  config.clientTimeoutSec = json["clientTimeoutSec"].number(config.clientTimeoutSec);
  config.finishGraceSec = json["finishGraceSec"].number(config.finishGraceSec);
  config.countdownSec = json["countdownSec"].number(config.countdownSec);
  config.statsIntervalSec = json["statsIntervalSec"].number(config.statsIntervalSec);
  const Json &net = json["netConditions"];
  if (net.isObject()) {
    config.conditions.latencyMs = net["latencyMs"].integer(0);
    config.conditions.jitterMs = net["jitterMs"].integer(0);
    config.conditions.lossPercent = net["lossPercent"].number(0);
  }

  auto track = std::make_shared<Track>();
  std::string trackError;
  if (json["track"].isObject()) {
    if (!loadTrack(json["track"], *track, &trackError)) return fail("invalid track: " + trackError);
  } else if (json["trackFile"].isString()) {
    if (!loadTrackFile(json["trackFile"].string(), *track, &trackError))
      return fail("invalid track file: " + trackError);
  } else {
    return fail("config needs 'track' or 'trackFile'");
  }
  config.track = track;

  config.players.clear();
  for (const Json &p : json["players"].items()) {
    MatchConfig::Entry entry;
    entry.id = p["id"].string();
    entry.nickname = p["nickname"].string("Player");
    entry.color = p["color"].string("red");
    entry.token = p["token"].string();
    if (entry.token.empty()) return fail("player '" + entry.nickname + "' has no token");
    if (entry.id.empty()) entry.id = entry.nickname;
    config.players.push_back(entry);
  }
  int botIndex = 0;
  for (const Json &b : json["bots"].items()) {
    MatchConfig::Entry entry;
    entry.bot = true;
    entry.nickname = b["nickname"].string("Bot " + std::to_string(botIndex + 1));
    entry.id = b["id"].string("bot-" + std::to_string(botIndex));
    entry.color = b["color"].string("silver");
    entry.skill = parseBotSkill(b["skill"].string("medium"));
    config.players.push_back(entry);
    botIndex++;
  }
  if (config.players.empty()) return fail("match has no players");
  if (config.players.size() > 16) return fail("too many players (max 16)");
  return true;
}

Match::Match(MatchConfig config) : config_(std::move(config)), net_(socket_) {
  net_.setConditions(config_.conditions);
}

Match::~Match() = default;

bool Match::open() {
  if (!socket_.open(config_.port, config_.bindHost)) {
    CG_ERROR("cannot bind UDP %s:%u", config_.bindHost.c_str(), config_.port);
    return false;
  }
  world_ = std::make_unique<World>(config_.track);
  int count = static_cast<int>(config_.players.size());
  world_->resize(count);
  auto grid = computeStartGrid(*config_.track, count);
  slots_.resize(count);
  bool needLine = false;
  for (int i = 0; i < count; ++i) {
    Slot &slot = slots_[i];
    slot.entry = config_.players[i];
    slot.inputs.assign(kInputRing, InputCmd{});
    slot.inputTicks.assign(kInputRing, -1);
    world_->place(i, grid[i].position, grid[i].rotation);
    world_->cars[i].active = slot.entry.bot; // humans activate on connect
    needLine = needLine || slot.entry.bot;
  }
  if (needLine) {
    line_ = buildRacingLine(*config_.track);
    if (!line_) CG_WARN("track has no racing line; server bots will idle");
    for (int i = 0; i < count; ++i) {
      if (slots_[i].entry.bot && line_)
        slots_[i].driver =
            std::make_unique<BotDriver>(line_, slots_[i].entry.skill, 0x5eed + i * 7919);
    }
  }
  CG_INFO("match %s: track '%s' (%s), %d laps, %d slots, UDP port %u", config_.matchId.c_str(),
          config_.track->name.c_str(), config_.track->id.c_str(), config_.lapCount, count,
          socket_.localPort());
  return true;
}

void Match::emit(const Json &event) {
  if (sink_) sink_(event);
}

int Match::connectedHumans() const {
  int n = 0;
  for (const Slot &s : slots_)
    if (!s.entry.bot && s.connected) n++;
  return n;
}

int Match::run(const std::atomic<bool> &stop) {
  Json ready = Json::object();
  ready.set("type", "ready");
  ready.set("matchId", config_.matchId);
  ready.set("port", static_cast<int>(socket_.localPort()));
  emit(ready);

  phaseEndTick_ = static_cast<int32_t>(config_.waitTimeoutSec * physics::kTickRate);
  if (connectedHumans() == 0 && std::none_of(slots_.begin(), slots_.end(), [](const Slot &s) {
        return !s.entry.bot;
      }))
    startCountdown(); // bots only

  const int64_t start = nowMicros();
  int64_t ticksDone = 0;
  nextStatsMs_ = nowMillis() + config_.statsIntervalSec * 1000;
  std::vector<uint8_t> data;
  Address from;
  while (!stop.load() && phase_ != MatchPhase::Ended) {
    net_.pump();
    while (net_.receive(from, data)) handlePacket(from, data);

    int64_t now = nowMicros();
    int64_t due = start + static_cast<int64_t>((ticksDone + 1) * kTickMicros);
    if (now >= due) {
      // Never run more than a few catch-up ticks after a stall.
      if (now - due > static_cast<int64_t>(kTickMicros * 5)) {
        int64_t skip = static_cast<int64_t>((now - due) / kTickMicros) - 1;
        CG_WARN("server stalled; skipping %lld ticks of wall time", static_cast<long long>(skip));
        ticksDone += skip;
      }
      tick();
      ticksDone++;
      continue;
    }
    int64_t wake = std::min(due, net_.nextDueMicros());
    int64_t waitMicros = wake - now;
    if (waitMicros > 1500) socket_.wait(static_cast<int>((waitMicros - 1000) / 1000));
    else if (waitMicros > 0) sleepUntilMicros(std::min(wake, now + 200));
  }

  if (stop.load() && phase_ != MatchPhase::Ended) endMatch("server stopped");
  // Best-effort shutdown notice, repeated for packet loss.
  auto shutdown = encodeShutdown({endReason_});
  for (int repeat = 0; repeat < 3; ++repeat) {
    for (const Slot &s : slots_)
      if (!s.entry.bot && s.address.valid()) net_.sendTo(s.address, shutdown);
    net_.pump();
    sleepMillis(20);
  }
  // Flush delayed packets when a simulated latency is active.
  int64_t flushUntil = nowMicros() + 2'000'000;
  while (net_.nextDueMicros() != INT64_MAX && nowMicros() < flushUntil) {
    net_.pump();
    sleepMillis(2);
  }
  Json ended = Json::object();
  ended.set("type", "ended");
  ended.set("matchId", config_.matchId);
  ended.set("reason", endReason_);
  emit(ended);
  return 0;
}

void Match::handlePacket(const Address &from, const std::vector<uint8_t> &data) {
  ByteReader r(data.data(), data.size());
  PacketType type;
  if (!readHeader(r, type)) return;
  double nowMs = nowMillis();

  if (type == PacketType::Hello) {
    HelloMsg hello;
    if (!decodeHello(r, hello)) return;
    auto it = std::find_if(slots_.begin(), slots_.end(), [&](const Slot &s) {
      return !s.entry.bot && s.entry.token == hello.token;
    });
    if (it == slots_.end()) {
      CG_WARN("rejecting %s: unknown token", from.toString().c_str());
      net_.sendTo(from, encodeReject("unknown player token"));
      return;
    }
    if (phase_ == MatchPhase::Results || phase_ == MatchPhase::Ended) {
      net_.sendTo(from, encodeReject("match is over"));
      return;
    }
    int index = static_cast<int>(it - slots_.begin());
    Slot &slot = *it;
    if (!slot.connected || slot.address != from) {
      CG_INFO("%s joined slot %d from %s%s", slot.entry.nickname.c_str(), index,
              from.toString().c_str(), slot.everConnected ? " (reconnect)" : "");
      Json joined = Json::object();
      joined.set("type", "joined");
      joined.set("playerId", slot.entry.id);
      joined.set("nickname", slot.entry.nickname);
      joined.set("reconnect", slot.everConnected);
      emit(joined);
    }
    bool wasConnected = slot.connected;
    slot.address = from;
    slot.connected = true;
    slot.everConnected = true;
    slot.lastHeardMs = nowMs;
    CarState &car = world_->cars[index];
    if (!car.active && phase_ != MatchPhase::Waiting) {
      car.active = true;
      if (phase_ == MatchPhase::Racing && !wasConnected) world_->respawn(index);
      quantize(car);
    } else if (phase_ == MatchPhase::Waiting) {
      car.active = true;
    }

    WelcomeMsg welcome;
    welcome.slot = static_cast<uint8_t>(index);
    welcome.serverTick = tick_;
    welcome.echoClientTime = hello.clientTime;
    welcome.snapshotRate = static_cast<uint8_t>(config_.snapshotRate);
    welcome.lapCount = static_cast<uint8_t>(config_.lapCount);
    welcome.matchId = config_.matchId;
    welcome.trackId = config_.track->id;
    for (size_t i = 0; i < slots_.size(); ++i) {
      PlayerInfo info;
      info.slot = static_cast<uint8_t>(i);
      info.id = slots_[i].entry.id;
      info.nickname = slots_[i].entry.nickname;
      info.color = slots_[i].entry.color;
      info.bot = slots_[i].entry.bot;
      welcome.players.push_back(info);
    }
    net_.sendTo(from, encodeWelcome(welcome));
    return;
  }

  auto it = std::find_if(slots_.begin(), slots_.end(), [&](const Slot &s) {
    return !s.entry.bot && s.connected && s.address == from;
  });
  if (it == slots_.end()) return;
  Slot &slot = *it;
  int index = static_cast<int>(it - slots_.begin());

  if (type == PacketType::Disconnect) {
    CG_INFO("%s left", slot.entry.nickname.c_str());
    slot.connected = false;
    if (phase_ != MatchPhase::Results) world_->cars[index].active = false;
    Json left = Json::object();
    left.set("type", "left");
    left.set("playerId", slot.entry.id);
    left.set("reason", "disconnect");
    emit(left);
    return;
  }
  if (type != PacketType::Input) return;
  InputMsg msg;
  if (!decodeInput(r, msg)) return;
  slot.lastHeardMs = nowMs;
  slot.packetsIn++;
  slot.rttMs = msg.rttMs;
  if (msg.clientTime != slot.lastClientTime) {
    slot.lastClientTime = msg.clientTime;
    slot.lastClientTimeAtMs = nowMs;
  }
  int32_t newest = msg.firstTick + static_cast<int32_t>(msg.inputs.size()) - 1;
  if (msg.inputs.empty()) return;
  if (newest < tick_) slot.late++;
  for (size_t i = 0; i < msg.inputs.size(); ++i) {
    int32_t t = msg.firstTick + static_cast<int32_t>(i);
    if (t < tick_ || t > tick_ + kMaxInputAhead) continue;
    int ring = t % kInputRing;
    slot.inputs[ring] = msg.inputs[i];
    slot.inputTicks[ring] = t;
  }
  if (newest > slot.newestInputTick) slot.newestInputTick = newest;
  slot.leadWindowMin = std::min(slot.leadWindowMin, newest - tick_);
}

InputCmd Match::inputFor(Slot &slot, int index) {
  if (slot.entry.bot) {
    if (!slot.driver || tick_ < raceStartTick_) return {};
    return slot.driver->update(*world_, index, tick_);
  }
  int ring = tick_ % kInputRing;
  if (slot.inputTicks[ring] == tick_) {
    slot.lastInput = slot.inputs[ring];
    return slot.lastInput;
  }
  // Missing input: keep doing what the player did last, but never repeat a respawn.
  if (slot.connected && phase_ == MatchPhase::Racing) slot.missed++;
  slot.lastInput.buttons &= static_cast<uint8_t>(~kInputRespawn);
  return slot.lastInput;
}

void Match::startCountdown() {
  phase_ = MatchPhase::Countdown;
  raceStartTick_ = tick_ + static_cast<int32_t>(config_.countdownSec * physics::kTickRate);
  phaseEndTick_ = raceStartTick_;
  for (size_t i = 0; i < slots_.size(); ++i) {
    if (!slots_[i].entry.bot && !slots_[i].connected) world_->cars[i].active = false;
    if (slots_[i].driver) slots_[i].driver->reset(*world_, static_cast<int>(i), raceStartTick_);
  }
  CG_INFO("countdown: race starts at tick %d (%d humans connected)", raceStartTick_,
          connectedHumans());
  Json started = Json::object();
  started.set("type", "started");
  started.set("matchId", config_.matchId);
  started.set("raceStartTick", raceStartTick_);
  Json players = Json::array();
  for (const Slot &s : slots_) {
    if (s.entry.bot || s.connected) players.push(Json(s.entry.id));
  }
  started.set("players", players);
  emit(started);
}

uint32_t Match::bestLapMs(const Slot &slot) const {
  uint32_t best = 0;
  int32_t previous = 0;
  for (int32_t t : slot.lapTicks) {
    uint32_t lap = ticksToMs(t - previous);
    if (best == 0 || lap < best) best = lap;
    previous = t;
  }
  return best;
}

uint32_t Match::lastLapMs(const Slot &slot) const {
  size_t n = slot.lapTicks.size();
  if (n == 0) return 0;
  return ticksToMs(slot.lapTicks[n - 1] - (n > 1 ? slot.lapTicks[n - 2] : 0));
}

void Match::updateRanks() {
  std::vector<int> order(slots_.size());
  for (size_t i = 0; i < order.size(); ++i) order[i] = static_cast<int>(i);
  auto key = [&](int i) {
    const CarState &car = world_->cars[i];
    return std::make_tuple(!slots_[i].finished, slots_[i].finished ? slots_[i].finishTicks : 0,
                           -car.lap, -car.checkpoint, !car.active);
  };
  std::stable_sort(order.begin(), order.end(), [&](int a, int b) { return key(a) < key(b); });
  for (size_t r = 0; r < order.size(); ++r) slots_[order[r]].rank = static_cast<int>(r) + 1;
}

void Match::tick() {
  // Timeouts.
  double nowMs = nowMillis();
  for (size_t i = 0; i < slots_.size(); ++i) {
    Slot &slot = slots_[i];
    if (slot.entry.bot || !slot.connected) continue;
    if (nowMs - slot.lastHeardMs > config_.clientTimeoutSec * 1000) {
      CG_WARN("%s timed out", slot.entry.nickname.c_str());
      slot.connected = false;
      if (phase_ != MatchPhase::Results) world_->cars[i].active = false;
      Json left = Json::object();
      left.set("type", "left");
      left.set("playerId", slot.entry.id);
      left.set("reason", "timeout");
      emit(left);
    }
  }

  bool anyHuman = std::any_of(slots_.begin(), slots_.end(), [](const Slot &s) { return !s.entry.bot; });
  switch (phase_) {
  case MatchPhase::Waiting: {
    bool allIn = std::all_of(slots_.begin(), slots_.end(),
                             [](const Slot &s) { return s.entry.bot || s.connected; });
    if (allIn) {
      startCountdown();
    } else if (tick_ >= phaseEndTick_) {
      if (connectedHumans() == 0) {
        endMatch("no players connected");
        return;
      }
      CG_WARN("join timeout; starting without missing players");
      startCountdown();
    }
    break;
  }
  case MatchPhase::Countdown:
  case MatchPhase::Racing:
    if (anyHuman && connectedHumans() == 0) {
      endMatch("all players left");
      return;
    }
    if (phase_ == MatchPhase::Countdown && tick_ >= raceStartTick_) {
      phase_ = MatchPhase::Racing;
      CG_INFO("race started");
    }
    break;
  case MatchPhase::Results:
    if (tick_ >= phaseEndTick_) {
      endMatch(endReason_.empty() ? "race complete" : endReason_);
      return;
    }
    break;
  case MatchPhase::Ended:
    return;
  }

  // Gather inputs for this tick (bots decide from the current state).
  std::vector<InputCmd> inputs(slots_.size());
  for (size_t i = 0; i < slots_.size(); ++i) inputs[i] = inputFor(slots_[i], static_cast<int>(i));

  if (tick_ >= raceStartTick_) {
    std::vector<RaceEvent> events;
    world_->step(inputs, &events);
    for (CarState &car : world_->cars) quantize(car);
    int32_t elapsed = tick_ + 1 - raceStartTick_;
    for (const RaceEvent &event : events) {
      if (event.type != RaceEvent::Type::Lap) continue;
      Slot &slot = slots_[event.slot];
      if (slot.finished) continue;
      slot.lapTicks.push_back(elapsed);
      CarState &car = world_->cars[event.slot];
      Json lap = Json::object();
      lap.set("type", "lap");
      lap.set("playerId", slot.entry.id);
      lap.set("nickname", slot.entry.nickname);
      lap.set("lap", car.lap);
      lap.set("lapMs", lastLapMs(slot));
      lap.set("isBot", slot.entry.bot);
      emit(lap);
      CG_INFO("%s lap %d: %.3fs", slot.entry.nickname.c_str(), car.lap, lastLapMs(slot) / 1000.0);
      if (car.lap >= config_.lapCount) {
        slot.finished = true;
        slot.finishTicks = elapsed;
        car.finished = true;
        finishOrder_.push_back(event.slot);
        if (firstFinishTick_ < 0) firstFinishTick_ = tick_;
        CG_INFO("%s finished #%zu in %.3fs", slot.entry.nickname.c_str(), finishOrder_.size(),
                ticksToMs(elapsed) / 1000.0);
      }
    }
  }
  tick_++;
  updateRanks();

  if (phase_ == MatchPhase::Racing) {
    bool allDone = true;
    for (size_t i = 0; i < slots_.size(); ++i) {
      if (world_->cars[i].active && !slots_[i].finished) allDone = false;
    }
    if (allDone) finishRace("race complete");
    else if (firstFinishTick_ >= 0 &&
             tick_ - firstFinishTick_ >= config_.finishGraceSec * physics::kTickRate)
      finishRace("finish time limit");
  }

  // Lead window: report the smallest lead seen over the last quarter second.
  if (tick_ % (physics::kTickRate / 4) == 0) {
    for (Slot &s : slots_) {
      s.reportedLead = s.leadWindowMin;
      s.leadWindowMin = 1 << 30;
    }
  }

  int interval = std::max(1, physics::kTickRate / config_.snapshotRate);
  if (tick_ % interval == 0) sendSnapshots();
  if (nowMs >= nextStatsMs_) {
    logStats();
    nextStatsMs_ = nowMs + config_.statsIntervalSec * 1000;
  }
}

void Match::finishRace(const std::string &reason) {
  phase_ = MatchPhase::Results;
  phaseEndTick_ = tick_ + static_cast<int32_t>(config_.resultsSec * physics::kTickRate);
  endReason_ = reason;
  updateRanks();
  results_.clear();
  std::vector<int> order(slots_.size());
  for (size_t i = 0; i < order.size(); ++i) order[i] = static_cast<int>(i);
  std::sort(order.begin(), order.end(), [&](int a, int b) { return slots_[a].rank < slots_[b].rank; });
  for (int i : order) {
    ResultEntry entry;
    entry.slot = static_cast<uint8_t>(i);
    entry.position = static_cast<uint8_t>(slots_[i].rank);
    entry.finished = slots_[i].finished;
    entry.totalMs = slots_[i].finished ? ticksToMs(slots_[i].finishTicks) : 0;
    entry.bestLapMs = bestLapMs(slots_[i]);
    results_.push_back(entry);
  }
  CG_INFO("race over (%s)", reason.c_str());
  for (const ResultEntry &e : results_)
    CG_INFO("  %d. %-16s %s best lap %.3fs", e.position, slots_[e.slot].entry.nickname.c_str(),
            e.finished ? (std::to_string(e.totalMs / 1000.0) + "s").c_str() : "DNF",
            e.bestLapMs / 1000.0);
  emit(resultsJson());
  resultsEmitted_ = true;
  sendSnapshots();
}

Json Match::resultsJson() const {
  Json event = Json::object();
  event.set("type", "result");
  event.set("matchId", config_.matchId);
  event.set("trackId", config_.track->id);
  event.set("lapCount", config_.lapCount);
  event.set("reason", endReason_);
  Json list = Json::array();
  for (const ResultEntry &e : results_) {
    const Slot &slot = slots_[e.slot];
    Json entry = Json::object();
    entry.set("playerId", slot.entry.id);
    entry.set("nickname", slot.entry.nickname);
    entry.set("position", static_cast<int>(e.position));
    entry.set("finished", e.finished);
    entry.set("totalMs", e.totalMs);
    entry.set("bestLapMs", e.bestLapMs);
    entry.set("laps", static_cast<int>(slot.lapTicks.size()));
    entry.set("isBot", slot.entry.bot);
    list.push(entry);
  }
  event.set("results", list);
  return event;
}

void Match::endMatch(const std::string &reason) {
  if (!resultsEmitted_ && phase_ == MatchPhase::Racing) {
    finishRace(reason);
  }
  endReason_ = reason;
  phase_ = MatchPhase::Ended;
  CG_INFO("match ended: %s", reason.c_str());
}

void Match::sendSnapshots() {
  SnapshotMsg snap;
  snap.serverTick = tick_;
  snap.phase = phase_;
  snap.raceStartTick = raceStartTick_;
  snap.phaseEndTick = phaseEndTick_;
  for (size_t i = 0; i < slots_.size(); ++i) {
    CarSnapshot car = toSnapshot(world_->cars[i], static_cast<int>(i));
    car.finished = slots_[i].finished;
    car.connected = slots_[i].entry.bot || slots_[i].connected;
    car.rank = static_cast<uint8_t>(slots_[i].rank);
    car.lastInput = slots_[i].lastInput;
    car.finishMs = slots_[i].finished ? ticksToMs(slots_[i].finishTicks) : 0;
    car.bestLapMs = bestLapMs(slots_[i]);
    car.lastLapMs = lastLapMs(slots_[i]);
    snap.cars.push_back(car);
  }
  if (phase_ == MatchPhase::Results || phase_ == MatchPhase::Ended) snap.results = results_;
  double nowMs = nowMillis();
  for (Slot &slot : slots_) {
    if (slot.entry.bot || !slot.connected) continue;
    snap.echoClientTime = slot.lastClientTime;
    snap.holdMs = static_cast<uint16_t>(
        std::min(65535.0, std::max(0.0, nowMs - slot.lastClientTimeAtMs)));
    snap.lastInputTick = slot.newestInputTick;
    int lead = std::min(slot.leadWindowMin, slot.reportedLead);
    snap.inputLead = lead == (1 << 30)
                         ? kLeadUnknown
                         : static_cast<int16_t>(std::max(-32000, std::min(32000, lead)));
    net_.sendTo(slot.address, encodeSnapshot(snap));
  }
}

void Match::logStats() {
  std::string line;
  for (size_t i = 0; i < slots_.size(); ++i) {
    const Slot &s = slots_[i];
    if (s.entry.bot) continue;
    char buf[200];
    std::snprintf(buf, sizeof(buf), " [%s %s rtt=%dms lead=%d missed=%llu late=%llu pkts=%llu]",
                  s.entry.nickname.c_str(), s.connected ? "on" : "off", s.rttMs,
                  s.reportedLead == (1 << 30) ? 0 : s.reportedLead,
                  static_cast<unsigned long long>(s.missed),
                  static_cast<unsigned long long>(s.late),
                  static_cast<unsigned long long>(s.packetsIn));
    line += buf;
  }
  CG_INFO("tick %d phase=%s%s", tick_, phaseName(phase_), line.c_str());
}

} // namespace cg
