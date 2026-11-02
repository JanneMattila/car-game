#pragma once

#include <cstdarg>
#include <cstdint>
#include <string>

namespace cg {

enum class LogLevel { Error = 0, Warn = 1, Info = 2, Debug = 3, Trace = 4 };

void setLogLevel(LogLevel level);
LogLevel logLevel();
void setLogPrefix(const std::string &prefix);
// Optional file mirror for clients that have no console (e.g., the windowed client).
void setLogFile(const std::string &path);
void logf(LogLevel level, const char *fmt, ...)
#if defined(__GNUC__)
    __attribute__((format(printf, 2, 3)))
#endif
    ;
LogLevel parseLogLevel(const std::string &name, LogLevel fallback);

#define CG_LOG(level, ...)                                                                         \
  do {                                                                                             \
    if (static_cast<int>(level) <= static_cast<int>(::cg::logLevel())) ::cg::logf(level, __VA_ARGS__); \
  } while (0)
#define CG_ERROR(...) CG_LOG(::cg::LogLevel::Error, __VA_ARGS__)
#define CG_WARN(...) CG_LOG(::cg::LogLevel::Warn, __VA_ARGS__)
#define CG_INFO(...) CG_LOG(::cg::LogLevel::Info, __VA_ARGS__)
#define CG_DEBUG(...) CG_LOG(::cg::LogLevel::Debug, __VA_ARGS__)
#define CG_TRACE(...) CG_LOG(::cg::LogLevel::Trace, __VA_ARGS__)

// Monotonic clock in microseconds / milliseconds.
int64_t nowMicros();
double nowMillis();
void sleepMillis(int ms);
// Raises timer resolution on Windows so short sleeps are accurate.
void initPlatformTiming();
// Precise sleep used by fixed-step loops (sleeps most of the time, then spins).
void sleepUntilMicros(int64_t target);

bool readFile(const std::string &path, std::string &out);
bool writeFile(const std::string &path, const std::string &data);

} // namespace cg
