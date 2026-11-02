// Dedicated authoritative race server. One process runs one match.
//
// Usage:
//   cg_server --config match.json [--port 5555] [--log-level info] [--log-file path]
//   cg_server --config -            (reads the configuration from stdin)
//
// Machine-readable lifecycle events are printed to stdout as "@@EVENT {json}" lines;
// human-readable logs go to stderr.

#include <atomic>
#include <csignal>
#include <cstdio>
#include <iostream>
#include <iterator>
#include <mutex>
#include <string>

#include "../common/log.h"
#include "match.h"

namespace {
std::atomic<bool> gStop{false};
std::mutex gStdoutMutex;

void onSignal(int) { gStop.store(true); }

void printUsage() {
  std::fprintf(stderr,
               "cg_server --config <file|-> [--port N] [--bind HOST] [--log-level "
               "error|warn|info|debug|trace] [--log-file PATH]\n"
               "          [--latency MS] [--jitter MS] [--loss PCT]\n");
}
} // namespace

int main(int argc, char **argv) {
  using namespace cg;
  initPlatformTiming();
  setLogPrefix("server");
  std::string configPath;
  int port = -1;
  std::string bindHost;
  NetConditions conditions;
  bool overrideConditions = false;
  for (int i = 1; i < argc; ++i) {
    std::string arg = argv[i];
    auto next = [&]() -> std::string { return i + 1 < argc ? argv[++i] : ""; };
    if (arg == "--config") configPath = next();
    else if (arg == "--port") port = std::atoi(next().c_str());
    else if (arg == "--bind") bindHost = next();
    else if (arg == "--log-level") setLogLevel(parseLogLevel(next(), LogLevel::Info));
    else if (arg == "--log-file") setLogFile(next());
    else if (arg == "--latency") conditions.latencyMs = std::atoi(next().c_str()), overrideConditions = true;
    else if (arg == "--jitter") conditions.jitterMs = std::atoi(next().c_str()), overrideConditions = true;
    else if (arg == "--loss") conditions.lossPercent = std::atof(next().c_str()), overrideConditions = true;
    else if (arg == "--help" || arg == "-h") {
      printUsage();
      return 0;
    } else {
      std::fprintf(stderr, "unknown argument: %s\n", arg.c_str());
      printUsage();
      return 2;
    }
  }
  if (configPath.empty()) {
    printUsage();
    return 2;
  }

  std::string text;
  if (configPath == "-") {
    text.assign(std::istreambuf_iterator<char>(std::cin), std::istreambuf_iterator<char>());
  } else if (!readFile(configPath, text)) {
    CG_ERROR("cannot read config %s", configPath.c_str());
    return 2;
  }
  std::string error;
  Json json = Json::parse(text, &error);
  MatchConfig config;
  if (!error.empty() || !parseMatchConfig(json, config, &error)) {
    CG_ERROR("invalid config: %s", error.c_str());
    return 2;
  }
  if (port >= 0) config.port = static_cast<uint16_t>(port);
  if (!bindHost.empty()) config.bindHost = bindHost;
  if (overrideConditions) config.conditions = conditions;

  std::signal(SIGINT, onSignal);
  std::signal(SIGTERM, onSignal);

  Match match(config);
  match.setEventSink([](const Json &event) {
    std::lock_guard<std::mutex> lock(gStdoutMutex);
    std::string line = "@@EVENT " + event.dump() + "\n";
    std::fwrite(line.data(), 1, line.size(), stdout);
    std::fflush(stdout);
  });
  if (!match.open()) {
    std::lock_guard<std::mutex> lock(gStdoutMutex);
    std::printf("@@EVENT {\"type\":\"error\",\"message\":\"cannot bind port %u\"}\n", config.port);
    std::fflush(stdout);
    return 3;
  }
  return match.run(gStop);
}
