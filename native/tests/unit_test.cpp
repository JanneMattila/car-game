// Unit tests for the native core: JSON, wire protocol, deterministic simulation, and the
// network condition simulator.
#include <cmath>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

#include "../common/json.h"
#include "../common/log.h"
#include "../common/net.h"
#include "../common/physics.h"
#include "../common/protocol.h"
#include "../common/track.h"

using namespace cg;

namespace {
int gFailures = 0;
#define CHECK(cond)                                                                                \
  do {                                                                                             \
    if (!(cond)) {                                                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);                                  \
      gFailures++;                                                                                 \
    }                                                                                              \
  } while (0)

void testJson() {
  std::string error;
  Json j = Json::parse(R"({"a":1.5,"b":[true,null,"x\n\u00e4"],"c":{"d":-2e3}})", &error);
  CHECK(error.empty());
  CHECK(j["a"].number() == 1.5);
  CHECK(j["b"][0].boolean());
  CHECK(j["b"][1].isNull());
  CHECK(j["b"][2].string() == "x\n\xc3\xa4");
  CHECK(j["c"]["d"].number() == -2000);
  CHECK(j["missing"]["deep"].isNull());
  Json round = Json::parse(j.dump(), &error);
  CHECK(error.empty() && round.dump() == j.dump());
  Json::parse("{bad", &error);
  CHECK(!error.empty());
}

void testProtocol() {
  SnapshotMsg snap;
  snap.serverTick = 12345;
  snap.phase = MatchPhase::Racing;
  snap.raceStartTick = 400;
  snap.echoClientTime = 777;
  snap.holdMs = 12;
  snap.lastInputTick = 12350;
  snap.inputLead = -3;
  CarState car;
  car.active = true;
  car.pos = {100.25, -42.5};
  car.vel = {3.5, 1.25};
  car.angle = 1.0;
  car.lap = 2;
  car.checkpoint = 5;
  car.contactCount = 2;
  car.contacts[0] = 0x80000001;
  car.contacts[1] = 77;
  CarSnapshot cs = toSnapshot(car, 3);
  cs.lastInput.buttons = kInputAccelerate | kInputLeft;
  cs.lastInput.steer = -100;
  cs.finishMs = 61234;
  snap.cars.push_back(cs);
  snap.results.push_back({3, 1, true, 61234, 20111});
  auto bytes = encodeSnapshot(snap);
  CHECK(bytes.size() < kMaxPacketSize);
  ByteReader r(bytes.data(), bytes.size());
  PacketType type;
  CHECK(readHeader(r, type) && type == PacketType::Snapshot);
  SnapshotMsg out;
  CHECK(decodeSnapshot(r, out));
  CHECK(out.serverTick == 12345 && out.phase == MatchPhase::Racing && out.inputLead == -3);
  CHECK(out.cars.size() == 1 && out.cars[0].slot == 3 && out.cars[0].lap == 2);
  CHECK(out.cars[0].contactCount == 2 && out.cars[0].contacts[0] == 0x80000001);
  CHECK(out.cars[0].lastInput.steer == -100 && out.cars[0].finishMs == 61234);
  CHECK(out.results.size() == 1 && out.results[0].bestLapMs == 20111);
  CarState back;
  applySnapshot(out.cars[0], back);
  CHECK(back.pos.x == 100.25 && back.lap == 2 && back.active);

  InputMsg in;
  in.firstTick = 99;
  for (int i = 0; i < 16; ++i) in.inputs.push_back({static_cast<uint8_t>(i), static_cast<int8_t>(-i)});
  auto ib = encodeInput(in);
  ByteReader ir(ib.data(), ib.size());
  InputMsg inOut;
  CHECK(readHeader(ir, type) && type == PacketType::Input && decodeInput(ir, inOut));
  CHECK(inOut.firstTick == 99 && inOut.inputs.size() == 16 && inOut.inputs[15].steer == -15);

  // Truncated or foreign packets must be rejected without crashing.
  for (size_t n = 0; n < bytes.size(); n += 7) {
    ByteReader tr(bytes.data(), n);
    SnapshotMsg junk;
    if (readHeader(tr, type)) decodeSnapshot(tr, junk);
  }
  uint8_t foreign[8] = {1, 2, 3, 4, 5, 6, 7, 8};
  ByteReader fr(foreign, sizeof(foreign));
  CHECK(!readHeader(fr, type));
}

// Two worlds fed identical inputs must stay bit-identical, and a world restored from a
// snapshot must replay to the same state (the basis of rollback re-simulation).
void testDeterminism(const std::string &trackPath) {
  auto track = std::make_shared<Track>();
  std::string error;
  if (!loadTrackFile(trackPath, *track, &error)) {
    std::printf("SKIP determinism: %s\n", error.c_str());
    return;
  }
  World a(track), b(track);
  auto grid = computeStartGrid(*track, 4);
  for (World *w : {&a, &b}) {
    w->resize(4);
    for (int i = 0; i < 4; ++i) {
      w->place(i, grid[i].position, grid[i].rotation);
      w->cars[i].active = true;
    }
  }
  auto inputAt = [](int tick, int slot) {
    InputCmd in;
    in.buttons = kInputAccelerate;
    if ((tick / 40 + slot) % 3 == 0) in.buttons |= kInputLeft;
    if ((tick / 55 + slot) % 4 == 0) in.buttons |= kInputRight;
    if (tick % 300 > 250) in.buttons |= kInputNitro;
    if (tick == 500 + slot) in.buttons |= kInputRespawn;
    return in;
  };
  std::vector<CarSnapshot> saved;
  for (int tick = 0; tick < 900; ++tick) {
    std::vector<InputCmd> inputs(4);
    for (int i = 0; i < 4; ++i) inputs[i] = inputAt(tick, i);
    a.step(inputs);
    b.step(inputs);
    for (auto &car : a.cars) quantize(car);
    for (auto &car : b.cars) quantize(car);
    if (tick == 449) {
      for (int i = 0; i < 4; ++i) saved.push_back(toSnapshot(a.cars[i], i));
    }
  }
  bool identical = true;
  for (int i = 0; i < 4; ++i)
    identical = identical && a.cars[i].pos.x == b.cars[i].pos.x &&
                a.cars[i].pos.y == b.cars[i].pos.y && a.cars[i].angle == b.cars[i].angle;
  CHECK(identical);
  bool moved = length(a.cars[0].pos - grid[0].position) > 50;
  CHECK(moved);

  // Restore from the tick-450 snapshot and replay.
  World c(track);
  c.resize(4);
  for (int i = 0; i < 4; ++i) applySnapshot(saved[i], c.cars[i]);
  for (int tick = 450; tick < 900; ++tick) {
    std::vector<InputCmd> inputs(4);
    for (int i = 0; i < 4; ++i) inputs[i] = inputAt(tick, i);
    c.step(inputs);
    for (auto &car : c.cars) quantize(car);
  }
  bool replayed = true;
  for (int i = 0; i < 4; ++i)
    replayed = replayed && c.cars[i].pos.x == a.cars[i].pos.x &&
               c.cars[i].pos.y == a.cars[i].pos.y && c.cars[i].vel.x == a.cars[i].vel.x;
  if (!replayed)
    std::printf("  replay diverged: a=(%.4f,%.4f) c=(%.4f,%.4f)\n", a.cars[0].pos.x,
                a.cars[0].pos.y, c.cars[0].pos.x, c.cars[0].pos.y);
  CHECK(replayed);
}

void testConditioner() {
  UdpSocket rx, tx;
  CHECK(rx.open(0, "127.0.0.1"));
  CHECK(tx.open(0, "127.0.0.1"));
  ConditionedSocket net(tx);
  NetConditions c;
  c.latencyMs = 100; // 50 ms one way
  net.setConditions(c);
  Address to;
  CHECK(resolveAddress("127.0.0.1", rx.localPort(), to));
  int64_t sentAt = nowMicros();
  net.sendTo(to, {1, 2, 3});
  uint8_t buffer[16];
  Address from;
  int64_t receivedAt = 0;
  while (nowMicros() - sentAt < 500000) {
    net.pump();
    if (rx.receiveFrom(from, buffer, sizeof(buffer)) == 3) {
      receivedAt = nowMicros();
      break;
    }
    sleepMillis(1);
  }
  double delayMs = (receivedAt - sentAt) / 1000.0;
  CHECK(receivedAt != 0 && delayMs >= 45 && delayMs < 120);

  c.latencyMs = 0;
  c.lossPercent = 100;
  net.setConditions(c);
  net.sendTo(to, {9});
  sleepMillis(20);
  net.pump();
  CHECK(rx.receiveFrom(from, buffer, sizeof(buffer)) == 0);
  CHECK(net.stats().droppedOut == 1);
}
} // namespace

int main(int argc, char **argv) {
  initPlatformTiming();
  setLogLevel(LogLevel::Warn);
  std::string trackPath = argc > 1 ? argv[1] : "../data/tracks/bristol-short-oval.json";
  testJson();
  testProtocol();
  testDeterminism(trackPath);
  testConditioner();
  if (gFailures) {
    std::printf("%d check(s) failed\n", gFailures);
    return 1;
  }
  std::printf("all unit tests passed\n");
  return 0;
}
