#pragma once

#include <atomic>
#include <climits>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "../common/botdriver.h"
#include "../common/json.h"
#include "../common/net.h"
#include "../common/physics.h"
#include "../common/protocol.h"
#include "../common/racingline.h"

namespace cg {

struct MatchConfig {
  struct Entry {
    std::string id;
    std::string nickname;
    std::string color = "red";
    std::string token; // empty for server-driven bots
    bool bot = false;
    BotSkill skill = BotSkill::Medium;
  };
  std::string matchId = "local";
  uint16_t port = kDefaultPort;
  std::string bindHost = "0.0.0.0";
  int lapCount = 3;
  std::shared_ptr<const Track> track;
  std::vector<Entry> players;
  int snapshotRate = 30;
  double waitTimeoutSec = 30;
  double resultsSec = 8;
  double clientTimeoutSec = 10;
  double finishGraceSec = 60;
  double countdownSec = 3.5;
  double statsIntervalSec = 5;
  NetConditions conditions; // optional server-side network simulation
};

bool parseMatchConfig(const Json &json, MatchConfig &config, std::string *error);

class Match {
public:
  using EventSink = std::function<void(const Json &)>;

  explicit Match(MatchConfig config);
  ~Match();

  // Binds the UDP socket; returns false if the port is unavailable.
  bool open();
  uint16_t port() const { return socket_.localPort(); }
  void setEventSink(EventSink sink) { sink_ = std::move(sink); }
  // Runs until the match ends or stop becomes true. Returns process exit code.
  int run(const std::atomic<bool> &stop);

  MatchPhase phase() const { return phase_; }
  // Server-side network simulation; may be changed while running (thread-safe).
  void setConditions(const NetConditions &conditions) { net_.setConditions(conditions); }

private:
  struct Slot {
    MatchConfig::Entry entry;
    std::unique_ptr<BotDriver> driver;
    bool connected = false;
    bool everConnected = false;
    Address address;
    double lastHeardMs = 0;
    std::vector<InputCmd> inputs;
    std::vector<int32_t> inputTicks;
    int32_t newestInputTick = -1;
    InputCmd lastInput;
    int leadWindowMin = 1 << 30;
    int reportedLead = 1 << 30;
    uint32_t lastClientTime = 0;
    double lastClientTimeAtMs = 0;
    int rttMs = 0;
    uint64_t packetsIn = 0, missed = 0, late = 0;
    std::vector<int32_t> lapTicks;
    bool finished = false;
    int32_t finishTicks = 0;
    int rank = 0;
  };

  void handlePacket(const Address &from, const std::vector<uint8_t> &data);
  void tick();
  void startCountdown();
  void finishRace(const std::string &reason);
  void endMatch(const std::string &reason);
  void updateRanks();
  void sendSnapshots();
  void logStats();
  InputCmd inputFor(Slot &slot, int index);
  int connectedHumans() const;
  uint32_t bestLapMs(const Slot &slot) const;
  uint32_t lastLapMs(const Slot &slot) const;
  void emit(const Json &event);
  Json resultsJson() const;

  MatchConfig config_;
  UdpSocket socket_;
  ConditionedSocket net_;
  std::unique_ptr<World> world_;
  std::shared_ptr<const RacingLine> line_;
  std::vector<Slot> slots_;
  std::vector<int> finishOrder_;
  std::vector<ResultEntry> results_;
  std::atomic<MatchPhase> phase_{MatchPhase::Waiting};
  int32_t tick_ = 0;
  int32_t raceStartTick_ = INT32_MAX; // physics is frozen until the countdown ends
  int32_t phaseEndTick_ = 0;
  int32_t firstFinishTick_ = -1;
  std::string endReason_;
  EventSink sink_;
  double nextStatsMs_ = 0;
  bool resultsEmitted_ = false;
};

} // namespace cg
