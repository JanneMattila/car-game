#pragma once

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "physics.h"

namespace cg {

constexpr uint16_t kProtocolMagic = 0x4743; // "CG"
constexpr uint8_t kProtocolVersion = 1;
constexpr uint16_t kDefaultPort = 5555;
constexpr size_t kMaxPacketSize = 1400;
constexpr int kMaxInputsPerPacket = 16;

enum class PacketType : uint8_t {
  Hello = 1,
  Welcome = 2,
  Reject = 3,
  Input = 4,
  Snapshot = 5,
  Disconnect = 6,
  Shutdown = 7,
};

enum class MatchPhase : uint8_t { Waiting = 0, Countdown = 1, Racing = 2, Results = 3, Ended = 4 };
const char *phaseName(MatchPhase phase);

class ByteWriter {
public:
  void u8(uint8_t v) { data.push_back(v); }
  void i8(int8_t v) { u8(static_cast<uint8_t>(v)); }
  void u16(uint16_t v) {
    u8(static_cast<uint8_t>(v));
    u8(static_cast<uint8_t>(v >> 8));
  }
  void i16(int16_t v) { u16(static_cast<uint16_t>(v)); }
  void u32(uint32_t v) {
    u16(static_cast<uint16_t>(v));
    u16(static_cast<uint16_t>(v >> 16));
  }
  void i32(int32_t v) { u32(static_cast<uint32_t>(v)); }
  void f32(float v) {
    uint32_t bits;
    std::memcpy(&bits, &v, 4);
    u32(bits);
  }
  void str(const std::string &s) {
    size_t n = s.size() > 255 ? 255 : s.size();
    u8(static_cast<uint8_t>(n));
    data.insert(data.end(), s.begin(), s.begin() + n);
  }
  std::vector<uint8_t> data;
};

class ByteReader {
public:
  ByteReader(const uint8_t *data, size_t size) : data_(data), size_(size) {}
  bool ok() const { return ok_; }
  size_t remaining() const { return ok_ ? size_ - pos_ : 0; }
  uint8_t u8() {
    if (pos_ + 1 > size_) {
      ok_ = false;
      return 0;
    }
    return data_[pos_++];
  }
  int8_t i8() { return static_cast<int8_t>(u8()); }
  uint16_t u16() {
    uint16_t lo = u8();
    return static_cast<uint16_t>(lo | (u8() << 8));
  }
  int16_t i16() { return static_cast<int16_t>(u16()); }
  uint32_t u32() {
    uint32_t lo = u16();
    return lo | (static_cast<uint32_t>(u16()) << 16);
  }
  int32_t i32() { return static_cast<int32_t>(u32()); }
  float f32() {
    uint32_t bits = u32();
    float v;
    std::memcpy(&v, &bits, 4);
    return v;
  }
  std::string str() {
    size_t n = u8();
    if (pos_ + n > size_) {
      ok_ = false;
      return {};
    }
    std::string s(reinterpret_cast<const char *>(data_ + pos_), n);
    pos_ += n;
    return s;
  }

private:
  const uint8_t *data_;
  size_t size_;
  size_t pos_ = 0;
  bool ok_ = true;
};

struct HelloMsg {
  std::string token;
  uint32_t clientTime = 0;
};

struct PlayerInfo {
  uint8_t slot = 0;
  std::string id;
  std::string nickname;
  std::string color;
  bool bot = false;
};

struct WelcomeMsg {
  uint8_t slot = 0;
  int32_t serverTick = 0;
  uint32_t echoClientTime = 0;
  uint8_t tickRate = physics::kTickRate;
  uint8_t snapshotRate = 30;
  uint8_t lapCount = 3;
  std::string matchId;
  std::string trackId;
  std::vector<PlayerInfo> players;
};

struct InputMsg {
  uint32_t clientTime = 0;
  uint16_t rttMs = 0; // client's estimate, for server-side diagnostics
  int32_t ackSnapshotTick = 0;
  int32_t firstTick = 0;
  std::vector<InputCmd> inputs; // ticks firstTick .. firstTick + size - 1
};

struct CarSnapshot {
  uint8_t slot = 0;
  bool active = false;
  bool finished = false;
  bool connected = true;
  float x = 0, y = 0, vx = 0, vy = 0, angle = 0, angVel = 0, nitro = 0;
  uint8_t lap = 0, checkpoint = 0, rank = 0;
  uint8_t contactCount = 0;
  uint32_t contacts[kMaxContacts] = {};
  InputCmd lastInput;
  uint32_t finishMs = 0;
  uint32_t bestLapMs = 0;
  uint32_t lastLapMs = 0;
};

struct ResultEntry {
  uint8_t slot = 0;
  uint8_t position = 0;
  bool finished = false;
  uint32_t totalMs = 0;
  uint32_t bestLapMs = 0;
};

// Snapshot inputLead value meaning "no inputs received recently".
constexpr int16_t kLeadUnknown = -32768;

struct SnapshotMsg {
  int32_t serverTick = 0;
  MatchPhase phase = MatchPhase::Waiting;
  int32_t raceStartTick = 0;  // valid from countdown on
  int32_t phaseEndTick = 0;   // waiting timeout / results end
  uint32_t echoClientTime = 0;
  uint16_t holdMs = 0;        // time the echoed input spent on the server before this snapshot
  int32_t lastInputTick = -1; // newest input tick the server has received from this client
  int16_t inputLead = kLeadUnknown; // minimum recent lead (ticks) of received inputs over server tick
  std::vector<CarSnapshot> cars;
  std::vector<ResultEntry> results;
};

struct ShutdownMsg {
  std::string reason;
};

void writeHeader(ByteWriter &w, PacketType type);
// Validates magic/version; returns false for foreign or malformed packets.
bool readHeader(ByteReader &r, PacketType &type);

std::vector<uint8_t> encodeHello(const HelloMsg &m);
std::vector<uint8_t> encodeWelcome(const WelcomeMsg &m);
std::vector<uint8_t> encodeReject(const std::string &reason);
std::vector<uint8_t> encodeInput(const InputMsg &m);
std::vector<uint8_t> encodeSnapshot(const SnapshotMsg &m);
std::vector<uint8_t> encodeDisconnect();
std::vector<uint8_t> encodeShutdown(const ShutdownMsg &m);

bool decodeHello(ByteReader &r, HelloMsg &m);
bool decodeWelcome(ByteReader &r, WelcomeMsg &m);
bool decodeReject(ByteReader &r, std::string &reason);
bool decodeInput(ByteReader &r, InputMsg &m);
bool decodeSnapshot(ByteReader &r, SnapshotMsg &m);
bool decodeShutdown(ByteReader &r, ShutdownMsg &m);

// Snapshot <-> simulation state. Floats are the canonical replicated precision.
CarSnapshot toSnapshot(const CarState &car, int slot);
void applySnapshot(const CarSnapshot &snap, CarState &car);
// Rounds simulation state to replicated precision so that server and client predict from
// bit-identical values.
void quantize(CarState &car);

} // namespace cg
