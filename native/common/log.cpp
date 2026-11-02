#include "log.h"

#include <chrono>
#include <cstdio>
#include <fstream>
#include <mutex>
#include <sstream>
#include <thread>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <timeapi.h>
#pragma comment(lib, "winmm.lib")
#endif

namespace cg {

namespace {
LogLevel gLevel = LogLevel::Info;
std::string gPrefix;
std::mutex gMutex;
FILE *gFile = nullptr;
const auto gStart = std::chrono::steady_clock::now();
} // namespace

void setLogLevel(LogLevel level) { gLevel = level; }
LogLevel logLevel() { return gLevel; }
void setLogPrefix(const std::string &prefix) { gPrefix = prefix; }

void setLogFile(const std::string &path) {
  std::lock_guard<std::mutex> lock(gMutex);
  if (gFile) std::fclose(gFile);
  gFile = path.empty() ? nullptr : std::fopen(path.c_str(), "w");
}

LogLevel parseLogLevel(const std::string &name, LogLevel fallback) {
  if (name == "error") return LogLevel::Error;
  if (name == "warn") return LogLevel::Warn;
  if (name == "info") return LogLevel::Info;
  if (name == "debug") return LogLevel::Debug;
  if (name == "trace") return LogLevel::Trace;
  return fallback;
}

void logf(LogLevel level, const char *fmt, ...) {
  static const char *names[] = {"ERROR", "WARN", "INFO", "DEBUG", "TRACE"};
  char message[2048];
  va_list args;
  va_start(args, fmt);
  std::vsnprintf(message, sizeof(message), fmt, args);
  va_end(args);
  double t = nowMillis() / 1000.0;
  std::lock_guard<std::mutex> lock(gMutex);
  // Logs go to stderr so stdout stays reserved for machine-readable events.
  std::fprintf(stderr, "[%9.3f] %-5s %s%s\n", t, names[static_cast<int>(level)], gPrefix.c_str(),
               message);
  std::fflush(stderr);
  if (gFile) {
    std::fprintf(gFile, "[%9.3f] %-5s %s%s\n", t, names[static_cast<int>(level)],
                 gPrefix.c_str(), message);
    std::fflush(gFile);
  }
}

int64_t nowMicros() {
  return std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() -
                                                               gStart)
      .count();
}

double nowMillis() { return static_cast<double>(nowMicros()) / 1000.0; }

void initPlatformTiming() {
#ifdef _WIN32
  static bool done = false;
  if (!done) {
    timeBeginPeriod(1);
    done = true;
  }
#endif
}

void sleepMillis(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }

void sleepUntilMicros(int64_t target) {
  while (true) {
    int64_t remaining = target - nowMicros();
    if (remaining <= 0) return;
    if (remaining > 2000) {
      std::this_thread::sleep_for(std::chrono::microseconds(remaining - 1500));
    } else {
      std::this_thread::yield();
    }
  }
}

bool readFile(const std::string &path, std::string &out) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return false;
  std::ostringstream ss;
  ss << in.rdbuf();
  out = ss.str();
  return true;
}

bool writeFile(const std::string &path, const std::string &data) {
  std::ofstream out(path, std::ios::binary);
  if (!out) return false;
  out << data;
  return static_cast<bool>(out);
}

} // namespace cg
