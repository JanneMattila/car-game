#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "net.h"
#include "physics.h"
#include "protocol.h"

namespace cg {

// Client side of the realtime protocol: connection handshake, clock synchronisation, input
// redundancy, client-side prediction with server reconciliation (rollback and re-simulation),
// and visual error smoothing.
class NetClient {
public:
  enum class State { Connecting, Connected, Ended, Failed };

  struct Options {
    Address server;
    std::string token;
    NetConditions conditions;
    double connectTimeoutSec = 10;
    double lostTimeoutSec = 5;
    // Visual error smoothing rate (1/s); higher converges faster.
    double smoothingRate = 12;
    double snapDistance = 200;
    uint32_t seed = 1;
  };

  // Resolves a track id from the Welcome message into a loaded track.
  using TrackResolver = std::function<std::shared_ptr<const Track>(const std::string &trackId)>;
  // Supplies the local player's input for a predicted tick.
  using InputSampler = std::function<InputCmd(int32_t tick, const World &predicted, int slot)>;

  struct CarMeta {
    PlayerInfo info;
    bool connected = true;
    bool finished = false;
    int rank = 0;
    uint32_t finishMs = 0, bestLapMs = 0, lastLapMs = 0;
  };

  struct RenderCar {
    bool active = false;
    Vec2 pos;
    double angle = 0;
    Vec2 vel;
    bool nitroActive = false;
    double nitro = 0;
  };

  struct Stats {
    double rttMs = 0;
    double jitterMs = 0;
    int serverLead = 0;  // input lead reported by server (ticks)
    double targetLead = 0;
    double timeScale = 1;
    int32_t predictedTick = 0;
    int32_t serverTick = 0;
    int lastResimTicks = 0;
    double lastCorrectionPx = 0;
    double maxCorrectionPx = 0;
    double avgCorrectionPx = 0;
    uint64_t snapshots = 0;
    uint64_t snapshotGaps = 0;
    uint64_t inputsSent = 0;
    uint64_t mispredictions = 0;
    uint64_t hardResyncs = 0;
    double bytesInPerSec = 0, bytesOutPerSec = 0;
    NetConditions conditions;
  };

  NetClient(Options options, TrackResolver resolver);
  ~NetClient();

  bool start();
  // Call once per frame (or more often). Advances the predicted simulation by wall time.
  void update(const InputSampler &sampler);
  // Sends a disconnect notice; the state becomes Ended.
  void disconnect();

  State state() const { return state_; }
  const std::string &statusMessage() const { return status_; }
  bool lostConnection() const { return lost_; }

  int slot() const { return slot_; }
  const WelcomeMsg &welcome() const { return welcome_; }
  std::shared_ptr<const Track> track() const { return track_; }
  const World *world() const { return world_.get(); }
  MatchPhase phase() const { return phase_; }
  int32_t predictedTick() const { return predictedTick_; }
  int32_t raceStartTick() const { return raceStartTick_; }
  int32_t phaseEndTick() const { return phaseEndTick_; }
  // Fraction (0..1) between the previous and current predicted tick, for rendering.
  double alpha() const { return alpha_; }
  const std::vector<CarMeta> &meta() const { return meta_; }
  const std::vector<ResultEntry> &results() const { return results_; }
  // Interpolated and smoothed state for drawing.
  RenderCar renderCar(int slot) const;
  Stats stats() const;

  void setConditions(const NetConditions &conditions) { net_->setConditions(conditions); }
  NetConditions conditions() const { return net_->conditions(); }

private:
  void handlePacket(const std::vector<uint8_t> &data);
  void onWelcome(const WelcomeMsg &welcome);
  void onSnapshot(const SnapshotMsg &snapshot);
  void stepPredicted(int32_t tick);
  void sendInputs();
  uint32_t clientTimeMs() const;
  void adjustClock(int serverLead);

  Options options_;
  TrackResolver resolver_;
  UdpSocket socket_;
  std::unique_ptr<ConditionedSocket> net_;
  State state_ = State::Connecting;
  std::string status_;
  bool lost_ = false;
  int64_t startMicros_ = 0;
  double lastHelloMs_ = -1e9;
  double lastHeardMs_ = 0;

  WelcomeMsg welcome_;
  int slot_ = -1;
  std::shared_ptr<const Track> track_;
  std::unique_ptr<World> world_;
  std::vector<CarState> previous_;
  std::vector<Vec2> posError_;
  std::vector<double> angleError_;
  std::vector<CarMeta> meta_;
  std::vector<ResultEntry> results_;
  MatchPhase phase_ = MatchPhase::Waiting;
  int32_t raceStartTick_ = INT32_MAX;
  int32_t phaseEndTick_ = 0;

  // Predicted clock.
  double clockTicks_ = 0; // fractional predicted tick
  int32_t predictedTick_ = 0;
  double timeScale_ = 1;
  uint64_t clockHoldUntilMs_ = 0; // ignore lead reports until post-resync inputs have arrived
  int64_t lastUpdateMicros_ = 0;
  double alpha_ = 0;

  // Input history for re-simulation and redundancy.
  static constexpr int kHistory = 256;
  std::vector<InputCmd> history_;
  std::vector<int32_t> historyTicks_;
  int32_t ackedInputTick_ = -1;
  std::vector<InputCmd> remoteInputs_;

  // Latest authoritative state.
  int32_t lastSnapshotTick_ = -1;
  int snapshotInterval_ = 2;

  double srtt_ = -1;
  double rttVar_ = 0;
  int serverLead_ = 0;
  double correctionSum_ = 0;
  uint64_t correctionCount_ = 0;
  Stats stats_;
  double rateWindowStartMs_ = 0;
  uint64_t rateBytesIn_ = 0, rateBytesOut_ = 0;
};

const char *netStateName(NetClient::State state);

} // namespace cg
