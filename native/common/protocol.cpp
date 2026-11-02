#include "protocol.h"

namespace cg {

const char *phaseName(MatchPhase phase) {
  switch (phase) {
  case MatchPhase::Waiting: return "waiting";
  case MatchPhase::Countdown: return "countdown";
  case MatchPhase::Racing: return "racing";
  case MatchPhase::Results: return "results";
  case MatchPhase::Ended: return "ended";
  }
  return "unknown";
}

void writeHeader(ByteWriter &w, PacketType type) {
  w.u16(kProtocolMagic);
  w.u8(kProtocolVersion);
  w.u8(static_cast<uint8_t>(type));
}

bool readHeader(ByteReader &r, PacketType &type) {
  if (r.u16() != kProtocolMagic) return false;
  if (r.u8() != kProtocolVersion) return false;
  type = static_cast<PacketType>(r.u8());
  return r.ok();
}

std::vector<uint8_t> encodeHello(const HelloMsg &m) {
  ByteWriter w;
  writeHeader(w, PacketType::Hello);
  w.str(m.token);
  w.u32(m.clientTime);
  // Pad so the handshake is never smaller than the reply (avoids amplification).
  while (w.data.size() < 200) w.u8(0);
  return w.data;
}

bool decodeHello(ByteReader &r, HelloMsg &m) {
  m.token = r.str();
  m.clientTime = r.u32();
  return r.ok();
}

std::vector<uint8_t> encodeWelcome(const WelcomeMsg &m) {
  ByteWriter w;
  writeHeader(w, PacketType::Welcome);
  w.u8(m.slot);
  w.i32(m.serverTick);
  w.u32(m.echoClientTime);
  w.u8(m.tickRate);
  w.u8(m.snapshotRate);
  w.u8(m.lapCount);
  w.str(m.matchId);
  w.str(m.trackId);
  w.u8(static_cast<uint8_t>(m.players.size()));
  for (const auto &p : m.players) {
    w.u8(p.slot);
    w.str(p.id);
    w.str(p.nickname);
    w.str(p.color);
    w.u8(p.bot ? 1 : 0);
  }
  return w.data;
}

bool decodeWelcome(ByteReader &r, WelcomeMsg &m) {
  m.slot = r.u8();
  m.serverTick = r.i32();
  m.echoClientTime = r.u32();
  m.tickRate = r.u8();
  m.snapshotRate = r.u8();
  m.lapCount = r.u8();
  m.matchId = r.str();
  m.trackId = r.str();
  size_t count = r.u8();
  m.players.clear();
  for (size_t i = 0; i < count && r.ok(); ++i) {
    PlayerInfo p;
    p.slot = r.u8();
    p.id = r.str();
    p.nickname = r.str();
    p.color = r.str();
    p.bot = r.u8() != 0;
    m.players.push_back(p);
  }
  return r.ok();
}

std::vector<uint8_t> encodeReject(const std::string &reason) {
  ByteWriter w;
  writeHeader(w, PacketType::Reject);
  w.str(reason);
  return w.data;
}

bool decodeReject(ByteReader &r, std::string &reason) {
  reason = r.str();
  return r.ok();
}

std::vector<uint8_t> encodeInput(const InputMsg &m) {
  ByteWriter w;
  writeHeader(w, PacketType::Input);
  w.u32(m.clientTime);
  w.u16(m.rttMs);
  w.i32(m.ackSnapshotTick);
  w.i32(m.firstTick);
  size_t count = m.inputs.size() > kMaxInputsPerPacket ? kMaxInputsPerPacket : m.inputs.size();
  w.u8(static_cast<uint8_t>(count));
  for (size_t i = m.inputs.size() - count; i < m.inputs.size(); ++i) {
    w.u8(m.inputs[i].buttons);
    w.i8(m.inputs[i].steer);
  }
  return w.data;
}

bool decodeInput(ByteReader &r, InputMsg &m) {
  m.clientTime = r.u32();
  m.rttMs = r.u16();
  m.ackSnapshotTick = r.i32();
  m.firstTick = r.i32();
  size_t count = r.u8();
  if (count > kMaxInputsPerPacket) return false;
  m.inputs.resize(count);
  for (size_t i = 0; i < count; ++i) {
    m.inputs[i].buttons = r.u8();
    m.inputs[i].steer = r.i8();
  }
  return r.ok();
}

std::vector<uint8_t> encodeSnapshot(const SnapshotMsg &m) {
  ByteWriter w;
  writeHeader(w, PacketType::Snapshot);
  w.i32(m.serverTick);
  w.u8(static_cast<uint8_t>(m.phase));
  w.i32(m.raceStartTick);
  w.i32(m.phaseEndTick);
  w.u32(m.echoClientTime);
  w.u16(m.holdMs);
  w.i32(m.lastInputTick);
  w.i16(m.inputLead);
  w.u8(static_cast<uint8_t>(m.cars.size()));
  for (const auto &c : m.cars) {
    w.u8(c.slot);
    w.u8(static_cast<uint8_t>((c.active ? 1 : 0) | (c.finished ? 2 : 0) | (c.connected ? 4 : 0)));
    w.f32(c.x);
    w.f32(c.y);
    w.f32(c.vx);
    w.f32(c.vy);
    w.f32(c.angle);
    w.f32(c.angVel);
    w.f32(c.nitro);
    w.u8(c.lap);
    w.u8(c.checkpoint);
    w.u8(c.rank);
    w.u8(c.contactCount);
    for (int i = 0; i < c.contactCount; ++i) w.u32(c.contacts[i]);
    w.u8(c.lastInput.buttons);
    w.i8(c.lastInput.steer);
    w.u32(c.finishMs);
    w.u32(c.bestLapMs);
    w.u32(c.lastLapMs);
  }
  w.u8(static_cast<uint8_t>(m.results.size()));
  for (const auto &e : m.results) {
    w.u8(e.slot);
    w.u8(e.position);
    w.u8(e.finished ? 1 : 0);
    w.u32(e.totalMs);
    w.u32(e.bestLapMs);
  }
  return w.data;
}

bool decodeSnapshot(ByteReader &r, SnapshotMsg &m) {
  m.serverTick = r.i32();
  m.phase = static_cast<MatchPhase>(r.u8());
  m.raceStartTick = r.i32();
  m.phaseEndTick = r.i32();
  m.echoClientTime = r.u32();
  m.holdMs = r.u16();
  m.lastInputTick = r.i32();
  m.inputLead = r.i16();
  size_t count = r.u8();
  m.cars.resize(count);
  for (size_t i = 0; i < count && r.ok(); ++i) {
    CarSnapshot &c = m.cars[i];
    c.slot = r.u8();
    uint8_t flags = r.u8();
    c.active = flags & 1;
    c.finished = (flags & 2) != 0;
    c.connected = (flags & 4) != 0;
    c.x = r.f32();
    c.y = r.f32();
    c.vx = r.f32();
    c.vy = r.f32();
    c.angle = r.f32();
    c.angVel = r.f32();
    c.nitro = r.f32();
    c.lap = r.u8();
    c.checkpoint = r.u8();
    c.rank = r.u8();
    c.contactCount = r.u8();
    if (c.contactCount > kMaxContacts) return false;
    for (int k = 0; k < c.contactCount; ++k) c.contacts[k] = r.u32();
    c.lastInput.buttons = r.u8();
    c.lastInput.steer = r.i8();
    c.finishMs = r.u32();
    c.bestLapMs = r.u32();
    c.lastLapMs = r.u32();
  }
  size_t results = r.u8();
  m.results.resize(results);
  for (size_t i = 0; i < results && r.ok(); ++i) {
    m.results[i].slot = r.u8();
    m.results[i].position = r.u8();
    m.results[i].finished = r.u8() != 0;
    m.results[i].totalMs = r.u32();
    m.results[i].bestLapMs = r.u32();
  }
  return r.ok();
}

std::vector<uint8_t> encodeDisconnect() {
  ByteWriter w;
  writeHeader(w, PacketType::Disconnect);
  return w.data;
}

std::vector<uint8_t> encodeShutdown(const ShutdownMsg &m) {
  ByteWriter w;
  writeHeader(w, PacketType::Shutdown);
  w.str(m.reason);
  return w.data;
}

bool decodeShutdown(ByteReader &r, ShutdownMsg &m) {
  m.reason = r.str();
  return r.ok();
}

CarSnapshot toSnapshot(const CarState &car, int slot) {
  CarSnapshot s;
  s.slot = static_cast<uint8_t>(slot);
  s.active = car.active;
  s.finished = car.finished;
  s.x = static_cast<float>(car.pos.x);
  s.y = static_cast<float>(car.pos.y);
  s.vx = static_cast<float>(car.vel.x);
  s.vy = static_cast<float>(car.vel.y);
  s.angle = static_cast<float>(car.angle);
  s.angVel = static_cast<float>(car.angVel);
  s.nitro = static_cast<float>(car.nitro);
  s.lap = static_cast<uint8_t>(car.lap);
  s.checkpoint = static_cast<uint8_t>(car.checkpoint);
  s.contactCount = car.contactCount;
  for (int i = 0; i < car.contactCount; ++i) s.contacts[i] = car.contacts[i];
  return s;
}

void applySnapshot(const CarSnapshot &s, CarState &car) {
  car.active = s.active;
  car.finished = s.finished;
  car.pos = {s.x, s.y};
  car.vel = {s.vx, s.vy};
  car.angle = s.angle;
  car.angVel = s.angVel;
  car.nitro = s.nitro;
  car.lap = s.lap;
  car.checkpoint = s.checkpoint;
  car.progressPos = car.pos;
  car.contactCount = s.contactCount;
  for (int i = 0; i < kMaxContacts; ++i) car.contacts[i] = i < s.contactCount ? s.contacts[i] : 0;
}

void quantize(CarState &car) {
  auto q = [](double v) { return static_cast<double>(static_cast<float>(v)); };
  car.pos = {q(car.pos.x), q(car.pos.y)};
  car.vel = {q(car.vel.x), q(car.vel.y)};
  car.angle = q(wrapAngle(car.angle));
  car.angVel = q(car.angVel);
  car.nitro = q(car.nitro);
  car.progressPos = car.pos;
}

} // namespace cg
