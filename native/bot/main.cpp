// Headless test client. Drives a car with the built-in AI through the real network protocol so
// the server, the netcode, and the lobby flow can be tested end-to-end without a GPU.
//
// Direct mode:  cg_bot --server 127.0.0.1:5555 --token T (--track-file F | --api URL)
// Lobby mode:   cg_bot --api http://localhost:3000 --nickname Bot1 (--create TRACK | --join ID)
//
// Network simulation can be changed while running, via stdin commands
//   latency <ms> | jitter <ms> | loss <pct> | stats | quit
// or a timed script:  --script "5:latency=150;12:jitter=20;20:latency=0"

#include <atomic>
#include <cstdio>
#include <deque>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "../common/botdriver.h"
#include "../common/clientnet.h"
#include "../common/lobbyapi.h"
#include "../common/log.h"
#include "../common/racingline.h"

using namespace cg;

namespace {

struct Options {
  std::string server;
  std::string token;
  std::string trackFile;
  std::string api;
  std::string nickname = "AI";
  std::string color = "blue";
  std::string createTrack;
  std::string joinLobby;
  bool joinAny = false;
  int laps = 2;
  int serverBots = 0;
  int startWhen = 1; // host starts once this many players are in the lobby
  BotSkill skill = BotSkill::Medium;
  NetConditions conditions;
  std::string script;
  double statsInterval = 1;
  double maxSeconds = 300;
  bool stdinCommands = true;
  bool expectLobbyReturn = false;
  uint32_t seed = 7;
};

struct ScriptStep {
  double atSec;
  std::string key;
  double value;
};

std::mutex gCommandMutex;
std::deque<std::string> gCommands;

void stdinReader() {
  std::string line;
  while (std::getline(std::cin, line)) {
    std::lock_guard<std::mutex> lock(gCommandMutex);
    gCommands.push_back(line);
  }
}

bool popCommand(std::string &out) {
  std::lock_guard<std::mutex> lock(gCommandMutex);
  if (gCommands.empty()) return false;
  out = gCommands.front();
  gCommands.pop_front();
  return true;
}

std::vector<ScriptStep> parseScript(const std::string &text) {
  std::vector<ScriptStep> steps;
  std::stringstream ss(text);
  std::string item;
  while (std::getline(ss, item, ';')) {
    size_t colon = item.find(':');
    size_t eq = item.find('=');
    if (colon == std::string::npos || eq == std::string::npos || eq < colon) continue;
    steps.push_back({std::atof(item.substr(0, colon).c_str()),
                     item.substr(colon + 1, eq - colon - 1), std::atof(item.c_str() + eq + 1)});
  }
  return steps;
}

bool applySetting(NetClient &client, const std::string &key, double value) {
  NetConditions c = client.conditions();
  if (key == "latency") c.latencyMs = static_cast<int>(value);
  else if (key == "jitter") c.jitterMs = static_cast<int>(value);
  else if (key == "loss") c.lossPercent = value;
  else return false;
  client.setConditions(c);
  CG_INFO("net conditions: latency=%dms jitter=%dms loss=%.1f%%", c.latencyMs, c.jitterMs,
          c.lossPercent);
  return true;
}

void printStats(const NetClient &client) {
  auto s = client.stats();
  const World *world = client.world();
  std::string car = "-";
  if (world && client.slot() >= 0) {
    const CarState &c = world->cars[client.slot()];
    char buf[160];
    std::snprintf(buf, sizeof(buf), "lap=%d cp=%d speed=%.1f rank=%d", c.lap + 1, c.checkpoint,
                  c.speed(), client.meta()[client.slot()].rank);
    car = buf;
  }
  CG_INFO("[%s] phase=%s tick=%d srv=%d rtt=%.0fms jit=%.1fms lead=%d/%.1f scale=%.3f resim=%d "
          "corr=%.2f/%.2fpx mis=%llu gaps=%llu sim=%d/%d/%.0f%% in=%.0fB/s out=%.0fB/s %s",
          netStateName(client.state()), phaseName(client.phase()), s.predictedTick, s.serverTick,
          s.rttMs, s.jitterMs, s.serverLead, s.targetLead, s.timeScale, s.lastResimTicks,
          s.lastCorrectionPx, s.maxCorrectionPx, static_cast<unsigned long long>(s.mispredictions),
          static_cast<unsigned long long>(s.snapshotGaps), s.conditions.latencyMs,
          s.conditions.jitterMs, s.conditions.lossPercent, s.bytesInPerSec, s.bytesOutPerSec,
          car.c_str());
}

void emitSummary(const std::string &outcome, const NetClient *client, const std::string &message,
                 const Lobby *lobby) {
  Json summary = Json::object();
  summary.set("type", "bot-summary");
  summary.set("outcome", outcome);
  summary.set("message", message);
  if (client) {
    auto s = client->stats();
    summary.set("slot", client->slot());
    summary.set("rttMs", s.rttMs);
    summary.set("snapshots", static_cast<double>(s.snapshots));
    summary.set("snapshotGaps", static_cast<double>(s.snapshotGaps));
    summary.set("mispredictions", static_cast<double>(s.mispredictions));
    summary.set("maxCorrectionPx", s.maxCorrectionPx);
    summary.set("avgCorrectionPx", s.avgCorrectionPx);
    summary.set("hardResyncs", static_cast<double>(s.hardResyncs));
    if (client->world() && client->slot() >= 0) {
      const CarState &car = client->world()->cars[client->slot()];
      summary.set("lap", car.lap);
      const auto &meta = client->meta()[client->slot()];
      summary.set("finished", meta.finished);
      summary.set("finishMs", meta.finishMs);
      summary.set("bestLapMs", meta.bestLapMs);
      summary.set("rank", meta.rank);
    }
    Json results = Json::array();
    for (const ResultEntry &r : client->results()) {
      Json e = Json::object();
      e.set("position", static_cast<int>(r.position));
      e.set("nickname", client->meta()[r.slot].info.nickname);
      e.set("finished", r.finished);
      e.set("totalMs", r.totalMs);
      e.set("bestLapMs", r.bestLapMs);
      results.push(e);
    }
    summary.set("results", results);
  }
  if (lobby) {
    summary.set("lobbyId", lobby->id);
    summary.set("lobbyStatus", lobby->status);
    summary.set("lobbyMessage", lobby->message);
  }
  std::printf("@@BOT %s\n", summary.dump().c_str());
  std::fflush(stdout);
}

// Runs one race on an already known server. Returns "finished", "ended", "lost", or "failed".
std::string race(const Options &opt, const Address &server, const std::string &token,
                 NetClient::TrackResolver resolver, std::unique_ptr<NetClient> &clientOut) {
  NetClient::Options co;
  co.server = server;
  co.token = token;
  co.conditions = opt.conditions;
  co.seed = opt.seed;
  clientOut = std::make_unique<NetClient>(co, resolver);
  NetClient &client = *clientOut;
  if (!client.start()) return "failed";

  std::shared_ptr<const RacingLine> line;
  std::unique_ptr<BotDriver> driver;
  bool driverReset = false;
  auto sampler = [&](int32_t tick, const World &world, int slot) -> InputCmd {
    if (!driver) {
      line = buildRacingLine(world.track());
      if (!line) return {};
      driver = std::make_unique<BotDriver>(line, opt.skill, opt.seed * 2654435761u);
    }
    if (tick < client.raceStartTick()) return {};
    if (!driverReset) {
      driver->reset(world, slot, tick);
      driverReset = true;
    }
    return driver->update(world, slot, tick);
  };

  auto script = parseScript(opt.script);
  size_t scriptIndex = 0;
  double start = nowMillis();
  double nextStats = start + opt.statsInterval * 1000;
  bool announcedFinish = false;
  while (true) {
    client.update(sampler);
    double now = nowMillis();
    double elapsed = (now - start) / 1000;
    while (scriptIndex < script.size() && elapsed >= script[scriptIndex].atSec) {
      applySetting(client, script[scriptIndex].key, script[scriptIndex].value);
      scriptIndex++;
    }
    std::string command;
    while (popCommand(command)) {
      std::stringstream ss(command);
      std::string key;
      double value = 0;
      ss >> key >> value;
      if (key == "stats") printStats(client);
      else if (key == "quit") {
        client.disconnect();
        return "ended";
      } else if (!applySetting(client, key, value))
        CG_WARN("unknown command '%s' (latency|jitter|loss <n>, stats, quit)", command.c_str());
    }
    if (now >= nextStats) {
      printStats(client);
      nextStats = now + opt.statsInterval * 1000;
    }
    if (client.slot() >= 0 && !announcedFinish && client.meta()[client.slot()].finished) {
      announcedFinish = true;
      CG_INFO("finished the race in %.3fs", client.meta()[client.slot()].finishMs / 1000.0);
    }
    if (client.state() == NetClient::State::Ended) {
      printStats(client);
      return announcedFinish ? "finished" : "ended";
    }
    if (client.state() == NetClient::State::Failed) {
      printStats(client);
      return client.lostConnection() ? "lost" : "failed";
    }
    if (elapsed > opt.maxSeconds) {
      CG_ERROR("race did not end within %.0fs", opt.maxSeconds);
      client.disconnect();
      return "timeout";
    }
    sleepMillis(1);
  }
}

int exitCodeFor(const std::string &outcome) {
  if (outcome == "finished") return 0;
  if (outcome == "lost") return 3;
  return 1;
}

int runDirect(const Options &opt) {
  Address server;
  if (!parseHostPort(opt.server, kDefaultPort, server)) {
    CG_ERROR("cannot resolve %s", opt.server.c_str());
    return 2;
  }
  std::shared_ptr<LobbyApi> api;
  if (!opt.api.empty()) api = std::make_shared<LobbyApi>(opt.api);
  auto resolver = [&](const std::string &trackId) -> std::shared_ptr<const Track> {
    if (!opt.trackFile.empty()) {
      auto track = std::make_shared<Track>();
      std::string error;
      if (loadTrackFile(opt.trackFile, *track, &error)) return track;
      CG_ERROR("cannot load %s: %s", opt.trackFile.c_str(), error.c_str());
      return nullptr;
    }
    if (api) return api->getTrack(trackId);
    return nullptr;
  };
  std::unique_ptr<NetClient> client;
  std::string outcome = race(opt, server, opt.token, resolver, client);
  emitSummary(outcome, client.get(), client ? client->statusMessage() : "", nullptr);
  return exitCodeFor(outcome);
}

int runLobby(const Options &opt) {
  LobbyApi api(opt.api);
  Profile profile;
  if (!api.createProfile(opt.nickname, opt.color, profile)) {
    CG_ERROR("cannot create profile: %s", api.lastError().c_str());
    return 2;
  }
  CG_INFO("profile %s (%s)", profile.nickname.c_str(), profile.id.c_str());
  Lobby lobby;
  bool host = false;
  if (!opt.createTrack.empty()) {
    if (!api.createLobby(profile.id, opt.createTrack, opt.laps, opt.serverBots, lobby)) {
      CG_ERROR("cannot create lobby: %s", api.lastError().c_str());
      return 2;
    }
    host = true;
    CG_INFO("created lobby %s on %s", lobby.id.c_str(), lobby.trackName.c_str());
    std::printf("@@BOT {\"type\":\"lobby\",\"lobbyId\":\"%s\"}\n", lobby.id.c_str());
    std::fflush(stdout);
  } else {
    std::string target = opt.joinLobby;
    double deadline = nowMillis() + 30000;
    while (target.empty() && nowMillis() < deadline) {
      std::vector<Lobby> lobbies;
      if (api.listLobbies(lobbies)) {
        for (const Lobby &l : lobbies)
          if (l.status == "waiting") target = l.id;
      }
      if (target.empty()) sleepMillis(250);
    }
    if (target.empty() || !api.joinLobby(target, profile.id, lobby)) {
      CG_ERROR("cannot join lobby: %s", api.lastError().c_str());
      return 2;
    }
    CG_INFO("joined lobby %s", lobby.id.c_str());
  }
  api.setReady(lobby.id, profile.id, true);

  double deadline = nowMillis() + 60000;
  bool startRequested = false;
  while (nowMillis() < deadline) {
    if (!api.getLobby(lobby.id, profile.id, lobby)) {
      CG_ERROR("lobby poll failed: %s", api.lastError().c_str());
      return 2;
    }
    if (lobby.hasConnection) break;
    if (host && !startRequested && lobby.status == "waiting" &&
        static_cast<int>(lobby.players.size()) >= opt.startWhen) {
      bool allReady = true;
      for (const auto &p : lobby.players) allReady = allReady && p.ready;
      if (allReady) {
        if (api.startLobby(lobby.id, profile.id)) {
          startRequested = true;
          CG_INFO("start requested with %zu players", lobby.players.size());
        } else {
          CG_WARN("start failed: %s", api.lastError().c_str());
        }
      }
    }
    sleepMillis(200);
  }
  if (!lobby.hasConnection) {
    CG_ERROR("game server never became available (%s)", lobby.message.c_str());
    emitSummary("failed", nullptr, lobby.message, &lobby);
    return 1;
  }
  std::string hostName = lobby.connection.host.empty() ? api.serverHost() : lobby.connection.host;
  Address server;
  if (!resolveAddress(hostName, static_cast<uint16_t>(lobby.connection.port), server)) {
    CG_ERROR("cannot resolve game server %s", hostName.c_str());
    return 2;
  }
  CG_INFO("game server %s (match %s)", server.toString().c_str(),
          lobby.connection.matchId.c_str());
  auto resolver = [&](const std::string &trackId) { return api.getTrack(trackId); };
  std::unique_ptr<NetClient> client;
  std::string outcome = race(opt, server, lobby.connection.token, resolver, client);

  // Back to the lobby: the web server reports the result or why the game server stopped.
  double backDeadline = nowMillis() + 15000;
  bool backInLobby = false;
  while (nowMillis() < backDeadline) {
    if (api.getLobby(lobby.id, profile.id, lobby) && !lobby.hasConnection &&
        lobby.status == "waiting") {
      backInLobby = true;
      break;
    }
    sleepMillis(250);
  }
  CG_INFO("returned to lobby: %s%s%s", backInLobby ? "yes" : "no",
          lobby.message.empty() ? "" : " - ", lobby.message.c_str());
  emitSummary(outcome, client.get(), client ? client->statusMessage() : "", &lobby);
  api.leaveLobby(lobby.id, profile.id);
  if (!backInLobby) return 4;
  return exitCodeFor(outcome);
}

void printUsage() {
  std::fprintf(
      stderr,
      "cg_bot (--server HOST:PORT --token T [--track-file F] | --api URL --nickname N "
      "[--create TRACK_ID | --join LOBBY_ID | --join-any])\n"
      "  [--laps N] [--server-bots N] [--start-when N] [--skill easy|medium|hard] [--color C]\n"
      "  [--latency MS] [--jitter MS] [--loss PCT] [--script \"SEC:key=value;...\"]\n"
      "  [--stats-interval SEC] [--max-seconds SEC] [--no-stdin] [--seed N] [--log-level L]\n");
}

} // namespace

int main(int argc, char **argv) {
  initPlatformTiming();
  Options opt;
  for (int i = 1; i < argc; ++i) {
    std::string arg = argv[i];
    auto next = [&]() -> std::string { return i + 1 < argc ? argv[++i] : ""; };
    if (arg == "--server") opt.server = next();
    else if (arg == "--token") opt.token = next();
    else if (arg == "--track-file") opt.trackFile = next();
    else if (arg == "--api") opt.api = next();
    else if (arg == "--nickname") opt.nickname = next();
    else if (arg == "--color") opt.color = next();
    else if (arg == "--create") opt.createTrack = next();
    else if (arg == "--join") opt.joinLobby = next();
    else if (arg == "--join-any") opt.joinAny = true;
    else if (arg == "--laps") opt.laps = std::atoi(next().c_str());
    else if (arg == "--server-bots") opt.serverBots = std::atoi(next().c_str());
    else if (arg == "--start-when") opt.startWhen = std::atoi(next().c_str());
    else if (arg == "--skill") opt.skill = parseBotSkill(next());
    else if (arg == "--latency") opt.conditions.latencyMs = std::atoi(next().c_str());
    else if (arg == "--jitter") opt.conditions.jitterMs = std::atoi(next().c_str());
    else if (arg == "--loss") opt.conditions.lossPercent = std::atof(next().c_str());
    else if (arg == "--script") opt.script = next();
    else if (arg == "--stats-interval") opt.statsInterval = std::atof(next().c_str());
    else if (arg == "--max-seconds") opt.maxSeconds = std::atof(next().c_str());
    else if (arg == "--no-stdin") opt.stdinCommands = false;
    else if (arg == "--seed") opt.seed = static_cast<uint32_t>(std::atoi(next().c_str()));
    else if (arg == "--log-level") setLogLevel(parseLogLevel(next(), LogLevel::Info));
    else if (arg == "--help" || arg == "-h") {
      printUsage();
      return 0;
    } else {
      std::fprintf(stderr, "unknown argument: %s\n", arg.c_str());
      printUsage();
      return 2;
    }
  }
  setLogPrefix("bot:" + opt.nickname);
  if (opt.stdinCommands) std::thread(stdinReader).detach();

  if (!opt.server.empty()) {
    if (opt.token.empty()) {
      std::fprintf(stderr, "--token is required with --server\n");
      return 2;
    }
    return runDirect(opt);
  }
  if (!opt.api.empty() && (!opt.createTrack.empty() || !opt.joinLobby.empty() || opt.joinAny))
    return runLobby(opt);
  printUsage();
  return 2;
}
