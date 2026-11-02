// In-process end-to-end test: a real server match on a loopback UDP port and two AI-driven
// network clients, each behind its own simulated network whose latency changes mid-race.
// Also checks that clients detect a vanished server.
//
// Usage: loopback_test [track.json] [--laps N] [--verbose]
#include <atomic>
#include <cstdio>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "../common/botdriver.h"
#include "../common/clientnet.h"
#include "../common/log.h"
#include "../common/racingline.h"
#include "../server/match.h"

using namespace cg;

namespace {

struct LatencyStep {
  double atSec;
  int latencyMs;
  int jitterMs;
  double lossPercent;
};

struct ClientResult {
  NetClient::State state = NetClient::State::Connecting;
  bool lost = false;
  bool finished = false;
  uint32_t finishMs = 0;
  NetClient::Stats stats;
  std::string status;
  size_t results = 0;
};

void runClient(uint16_t port, const std::string &token, std::shared_ptr<const Track> track,
               BotSkill skill, uint32_t seed, std::vector<LatencyStep> schedule,
               double lostTimeoutSec, ClientResult &result, double maxSec) {
  NetClient::Options options;
  resolveAddress("127.0.0.1", port, options.server);
  options.token = token;
  options.seed = seed;
  options.lostTimeoutSec = lostTimeoutSec;
  NetClient client(options, [&](const std::string &) { return track; });
  client.start();
  auto line = buildRacingLine(*track);
  BotDriver driver(line, skill, seed);
  bool reset = false;
  auto sampler = [&](int32_t tick, const World &world, int slot) -> InputCmd {
    if (tick < client.raceStartTick()) return {};
    if (!reset) {
      driver.reset(world, slot, tick);
      reset = true;
    }
    return driver.update(world, slot, tick);
  };
  double start = nowMillis();
  size_t next = 0;
  double nextLog = start + 2000;
  while (client.state() == NetClient::State::Connecting ||
         client.state() == NetClient::State::Connected) {
    double elapsed = (nowMillis() - start) / 1000;
    while (next < schedule.size() && elapsed >= schedule[next].atSec) {
      NetConditions c;
      c.latencyMs = schedule[next].latencyMs;
      c.jitterMs = schedule[next].jitterMs;
      c.lossPercent = schedule[next].lossPercent;
      client.setConditions(c);
      CG_INFO("%s: latency -> %dms jitter %dms loss %.0f%%", token.c_str(), c.latencyMs,
              c.jitterMs, c.lossPercent);
      next++;
    }
    client.update(sampler);
    if (nowMillis() >= nextLog) {
      auto s = client.stats();
      CG_INFO("%s: tick=%d rtt=%.0f lead=%d/%.1f scale=%.3f resim=%d corr=%.2f max=%.2f mis=%llu",
              token.c_str(), s.predictedTick, s.rttMs, s.serverLead, s.targetLead, s.timeScale,
              s.lastResimTicks, s.lastCorrectionPx, s.maxCorrectionPx,
              static_cast<unsigned long long>(s.mispredictions));
      nextLog += 2000;
    }
    if (elapsed > maxSec) {
      client.disconnect();
      break;
    }
    sleepMillis(1);
  }
  result.state = client.state();
  result.lost = client.lostConnection();
  result.status = client.statusMessage();
  result.stats = client.stats();
  result.results = client.results().size();
  if (client.slot() >= 0) {
    result.finished = client.meta()[client.slot()].finished;
    result.finishMs = client.meta()[client.slot()].finishMs;
  }
}

MatchConfig baseConfig(std::shared_ptr<const Track> track, int laps) {
  MatchConfig config;
  config.matchId = "loopback";
  config.port = 0;
  config.bindHost = "127.0.0.1";
  config.lapCount = laps;
  config.track = track;
  config.countdownSec = 1;
  config.resultsSec = 1;
  config.waitTimeoutSec = 10;
  config.statsIntervalSec = 3;
  MatchConfig::Entry a{"p1", "AlphaAI", "red", "token-a"};
  MatchConfig::Entry b{"p2", "BetaAI", "blue", "token-b"};
  config.players = {a, b};
  MatchConfig::Entry bot{"bot-0", "ServerBot", "green", "", true, BotSkill::Easy};
  config.players.push_back(bot);
  return config;
}

int g_failures = 0;
void expect(bool ok, const char *what) {
  std::printf("%s %s\n", ok ? "  ok  " : "  FAIL", what);
  if (!ok) g_failures++;
}

void raceTest(std::shared_ptr<const Track> track, int laps) {
  std::printf("== race with two networked AI drivers and changing latency ==\n");
  Match match(baseConfig(track, laps));
  if (!match.open()) {
    expect(false, "server opens");
    return;
  }
  std::vector<Json> events;
  std::mutex eventsMutex;
  match.setEventSink([&](const Json &e) {
    std::lock_guard<std::mutex> lock(eventsMutex);
    std::printf("  @@EVENT %s\n", e.dump().c_str());
    events.push_back(e);
  });
  std::atomic<bool> stop{false};
  int exitCode = -1;
  std::thread server([&] { exitCode = match.run(stop); });
  uint16_t port = match.port();

  ClientResult ra, rb;
  // Client A: starts fast, then degrades with jitter; client B: starts slow, then improves.
  std::thread ta(runClient, port, "token-a", track, BotSkill::Hard, 11u,
                 std::vector<LatencyStep>{{0, 40, 0, 0}, {4, 180, 15, 0}, {9, 80, 5, 2}}, 5.0,
                 std::ref(ra), 240.0);
  std::thread tb(runClient, port, "token-b", track, BotSkill::Medium, 23u,
                 std::vector<LatencyStep>{{0, 250, 0, 0}, {6, 30, 0, 0}, {11, 120, 30, 0}}, 5.0,
                 std::ref(rb), 240.0);
  ta.join();
  tb.join();
  stop = true;
  server.join();

  for (auto *r : {&ra, &rb}) {
    std::printf("  client: state=%s finished=%d finish=%.2fs rtt=%.0f snapshots=%llu gaps=%llu "
                "mispredictions=%llu avgCorr=%.2fpx maxCorr=%.2fpx resyncs=%llu status='%s'\n",
                netStateName(r->state), r->finished, r->finishMs / 1000.0, r->stats.rttMs,
                static_cast<unsigned long long>(r->stats.snapshots),
                static_cast<unsigned long long>(r->stats.snapshotGaps),
                static_cast<unsigned long long>(r->stats.mispredictions),
                r->stats.avgCorrectionPx, r->stats.maxCorrectionPx,
                static_cast<unsigned long long>(r->stats.hardResyncs), r->status.c_str());
  }
  bool haveResult = false, haveEnded = false;
  int finishedHumans = 0;
  for (const Json &e : events) {
    if (e["type"].string() == "result") {
      haveResult = true;
      for (const Json &r : e["results"].items())
        if (!r["isBot"].boolean() && r["finished"].boolean()) finishedHumans++;
    }
    if (e["type"].string() == "ended") haveEnded = true;
  }
  expect(exitCode == 0, "server exits cleanly");
  expect(ra.state == NetClient::State::Ended && rb.state == NetClient::State::Ended,
         "both clients receive the shutdown notice");
  expect(ra.finished && rb.finished, "both networked AI drivers finish the race");
  expect(ra.results > 0 && rb.results > 0, "clients receive the final results");
  expect(haveResult && finishedHumans == 2, "server reports a result with both finishers");
  expect(haveEnded, "server reports the end of the match");
  // Corrections come from unpredictable contact with other cars and from sudden latency spikes;
  // spread over every snapshot they must stay small.
  auto perSnapshot = [](const ClientResult &r) {
    return r.stats.snapshots ? r.stats.avgCorrectionPx * r.stats.mispredictions / r.stats.snapshots
                             : 0.0;
  };
  std::printf("  correction per snapshot: %.2fpx / %.2fpx\n", perSnapshot(ra), perSnapshot(rb));
  expect(perSnapshot(ra) < 3 && perSnapshot(rb) < 3,
         "prediction correction per snapshot stays below 3px");
}

void lostServerTest(std::shared_ptr<const Track> track) {
  std::printf("== clients detect a vanished server ==\n");
  MatchConfig config = baseConfig(track, 5);
  Match match(config);
  if (!match.open()) {
    expect(false, "server opens");
    return;
  }
  std::atomic<bool> stop{false};
  std::thread server([&] { match.run(stop); });
  ClientResult ra, rb;
  std::thread ta(runClient, match.port(), "token-a", track, BotSkill::Medium, 5u,
                 std::vector<LatencyStep>{{0, 50, 0, 0}}, 1.5, std::ref(ra), 30.0);
  std::thread tb(runClient, match.port(), "token-b", track, BotSkill::Medium, 6u,
                 std::vector<LatencyStep>{{0, 50, 0, 0}}, 1.5, std::ref(rb), 30.0);
  // Let the race start, then make the server go silent as if it crashed.
  double start = nowMillis();
  while (match.phase() != MatchPhase::Racing && nowMillis() - start < 10000) sleepMillis(10);
  sleepMillis(1500);
  NetConditions dead;
  dead.lossPercent = 100;
  match.setConditions(dead);
  double silencedAt = nowMillis();
  ta.join();
  tb.join();
  double detectSec = (nowMillis() - silencedAt) / 1000;
  stop = true;
  server.join();
  std::printf("  detected after %.2fs: '%s' / '%s'\n", detectSec, ra.status.c_str(),
              rb.status.c_str());
  expect(ra.lost && rb.lost, "both clients report the lost server connection");
  expect(detectSec < 4, "loss detected within the timeout");
}

} // namespace

int main(int argc, char **argv) {
  initPlatformTiming();
  setLogLevel(LogLevel::Warn);
  std::string trackPath = "../data/tracks/bristol-short-oval.json";
  int laps = 1;
  for (int i = 1; i < argc; ++i) {
    std::string arg = argv[i];
    if (arg == "--laps" && i + 1 < argc) laps = std::atoi(argv[++i]);
    else if (arg == "--verbose") setLogLevel(LogLevel::Info);
    else trackPath = arg;
  }
  auto track = std::make_shared<Track>();
  std::string error;
  if (!loadTrackFile(trackPath, *track, &error)) {
    std::printf("cannot load %s: %s\n", trackPath.c_str(), error.c_str());
    return 2;
  }
  raceTest(track, laps);
  lostServerTest(track);
  if (g_failures) {
    std::printf("%d expectation(s) failed\n", g_failures);
    return 1;
  }
  std::printf("loopback e2e passed\n");
  return 0;
}
