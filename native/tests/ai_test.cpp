// Drives AI cars around tracks and checks they complete laps.
// Usage: ai_test [--ticks N] [--laps N] track.json [track.json ...]
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

#include "../common/botdriver.h"
#include "../common/log.h"
#include "../common/physics.h"
#include "../common/racingline.h"
#include "../common/track.h"

namespace {

struct CarResult {
  int laps = 0;
  int respawns = 0;
  int32_t firstLapTick = -1;
  int32_t lastLapTick = -1;
};

bool runTrack(const std::string &path, int maxTicks, int targetLaps) {
  auto track = std::make_shared<cg::Track>();
  std::string error;
  if (!cg::loadTrackFile(path, *track, &error)) {
    std::printf("%s: failed to load: %s\n", path.c_str(), error.c_str());
    return false;
  }
  auto started = std::chrono::steady_clock::now();
  auto line = cg::buildRacingLine(*track);
  double buildMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() -
                                                             started)
                       .count();
  if (!line) {
    std::printf("%s: no racing line (%.0f ms)\n", track->name.c_str(), buildMs);
    return false;
  }
  std::printf("%s: %dx%d wrap=%d gates=%d line=%d points built in %.0f ms\n",
              track->name.c_str(), static_cast<int>(track->width),
              static_cast<int>(track->height), track->wrapAround ? 1 : 0, line->gateCount,
              line->size(), buildMs);

  const int carCount = 2;
  cg::World world(track);
  world.resize(carCount);
  auto grid = cg::computeStartGrid(*track, carCount);
  if (static_cast<int>(grid.size()) < carCount) {
    std::printf("  no start grid\n");
    return false;
  }
  std::vector<cg::BotDriver> drivers;
  const cg::BotSkill skills[carCount] = {cg::BotSkill::Medium, cg::BotSkill::Hard};
  for (int i = 0; i < carCount; ++i) {
    world.place(i, grid[i].position, grid[i].rotation);
    drivers.emplace_back(line, skills[i], 1234u + static_cast<uint32_t>(i) * 7919u);
    drivers.back().reset(world, i, 0);
  }

  std::vector<CarResult> results(carCount);
  std::vector<cg::InputCmd> inputs(carCount);
  std::vector<cg::RaceEvent> events;
  int32_t tick = 0;
  for (; tick < maxTicks; ++tick) {
    for (int i = 0; i < carCount; ++i) inputs[i] = drivers[i].update(world, i, tick);
    events.clear();
    world.step(inputs, &events);
    for (const auto &event : events) {
      if (event.type != cg::RaceEvent::Type::Lap) continue;
      CarResult &result = results[event.slot];
      result.laps = event.value;
      if (result.firstLapTick < 0) result.firstLapTick = tick;
      result.lastLapTick = tick;
    }
    bool done = true;
    for (const auto &result : results) done = done && result.laps >= targetLaps;
    if (done) break;
  }

  bool ok = true;
  for (int i = 0; i < carCount; ++i) {
    CarResult &result = results[i];
    result.respawns = drivers[i].respawnCount();
    // Laps after the first start from the finish line, so they give a clean lap time.
    double perLap = result.laps > 1 ? static_cast<double>(result.lastLapTick -
                                                          result.firstLapTick) /
                                          (result.laps - 1)
                                    : -1;
    std::printf("  car %d (%s): laps=%d respawns=%d first-lap-tick=%d ticks/lap=%.0f "
                "(%.1f s) checkpoint=%d\n",
                i, cg::botSkillName(drivers[i].skill()), result.laps, result.respawns,
                result.firstLapTick, perLap, perLap / 60, world.cars[i].checkpoint);
    if (result.laps < 2) ok = false;
  }
  std::printf("  %s after %d ticks\n", ok ? "PASS" : "FAIL", tick);

  // Missed-gate recovery: start a car beyond the first checkpoints without having passed them.
  if (line->gateCount >= 2) {
    cg::World skipped(track);
    skipped.resize(1);
    const auto &gate = line->gates[1];
    cg::Vec2 start = gate.center + gate.forward * 80;
    skipped.place(0, start, cg::headingOf(gate.forward));
    cg::BotDriver driver(line, cg::BotSkill::Medium, 42);
    driver.reset(skipped, 0, 0);
    std::vector<cg::InputCmd> input(1);
    int32_t recovered = -1;
    for (int32_t t = 0; t < maxTicks && recovered < 0; ++t) {
      input[0] = driver.update(skipped, 0, t);
      events.clear();
      skipped.step(input, &events);
      for (const auto &event : events)
        if (event.type == cg::RaceEvent::Type::Lap) recovered = t;
    }
    std::printf("  missed-gate recovery: %s (lap at tick %d, respawns=%d)\n",
                recovered >= 0 ? "PASS" : "FAIL", recovered, driver.respawnCount());
    if (recovered < 0) ok = false;
  }
  return ok;
}

} // namespace

int main(int argc, char **argv) {
  int maxTicks = 20000;
  int targetLaps = 3;
  std::vector<std::string> tracks;
  for (int i = 1; i < argc; ++i) {
    std::string arg = argv[i];
    if (arg == "--ticks" && i + 1 < argc) {
      maxTicks = std::atoi(argv[++i]);
    } else if (arg == "--laps" && i + 1 < argc) {
      targetLaps = std::atoi(argv[++i]);
    } else {
      tracks.push_back(arg);
    }
  }
  if (tracks.empty()) {
    std::printf("usage: ai_test [--ticks N] [--laps N] track.json [track.json ...]\n");
    return 2;
  }
  bool ok = true;
  for (const auto &path : tracks) ok = runTrack(path, maxTicks, targetLaps) && ok;
  return ok ? 0 : 1;
}
