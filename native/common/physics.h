#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <vector>

#include "track.h"

namespace cg {

namespace physics {
constexpr double kCarWidth = 30;
constexpr double kCarHeight = 50;
constexpr double kCarMass = 1.2;
constexpr double kFrictionAir = 0.01;
constexpr double kEngineForce = 12.0;
constexpr double kReverseForce = 3.5;
constexpr double kDrag = 0.015;
constexpr double kRolling = 0.012;
constexpr double kOffroadForce = 0.8;
constexpr double kOffroadSpeed = 0.85;
constexpr double kOffroadRolling = 0.03;
constexpr double kContactForce = 0.4;
constexpr double kCollisionRetention = 0.65;
constexpr double kMaxSteeringAngle = 3 * kPi / 40;
constexpr double kMaxAngularVelocity = 2.0;
constexpr double kMaxSpeed = 20;
constexpr double kMaxReverseSpeed = 10;
constexpr double kNitroBoost = 1.3;
constexpr double kNitroMax = 100;
constexpr double kNitroDrain = 50;
constexpr double kNitroRecharge = 10;
constexpr int kTickRate = 60;
constexpr double kDt = 1.0 / kTickRate;
// (1000 / 60)^2: the force integration factor of the reference rigid body engine.
constexpr double kDtSquaredMs = (1000.0 / kTickRate) * (1000.0 / kTickRate);
} // namespace physics

enum InputButtons : uint8_t {
  kInputAccelerate = 1,
  kInputBrake = 2,
  kInputLeft = 4,
  kInputRight = 8,
  kInputNitro = 16,
  kInputRespawn = 32,
};

struct InputCmd {
  uint8_t buttons = 0;
  int8_t steer = 0; // analog steering -127..127; 0 = use digital buttons

  bool has(uint8_t b) const { return (buttons & b) != 0; }
  double steering() const {
    if (steer != 0) return clampd(steer / 127.0, -1, 1);
    return has(kInputLeft) ? -1 : has(kInputRight) ? 1 : 0;
  }
  bool operator==(const InputCmd &o) const { return buttons == o.buttons && steer == o.steer; }
  bool operator!=(const InputCmd &o) const { return !(*this == o); }
};

constexpr int kMaxContacts = 8;

struct CarState {
  bool active = false;
  Vec2 pos;
  Vec2 vel;
  double angle = 0;
  double angVel = 0;
  double nitro = physics::kNitroMax;
  bool nitroActive = false;
  bool onAsphalt = true;
  int lap = 0;
  int checkpoint = 0;
  Vec2 progressPos;
  // Contact pairs of the previous step: drive force reduction and impact speed loss.
  uint8_t contactCount = 0;
  std::array<uint32_t, kMaxContacts> contacts{};
  bool finished = false;

  double speed() const { return length(vel); }
};

struct RaceEvent {
  enum class Type { Checkpoint, Lap } type;
  int slot = 0;
  int value = 0;
};

// Deterministic car world shared by the authoritative server and client-side prediction.
class World {
public:
  explicit World(std::shared_ptr<const Track> track);

  const Track &track() const { return *track_; }
  std::shared_ptr<const Track> trackPtr() const { return track_; }
  int checkpointCount() const { return static_cast<int>(checkpoints_.size()); }
  const std::vector<TrackElement> &checkpoints() const { return checkpoints_; }
  const TrackElement *finishLine() const { return hasFinish_ ? &finish_ : nullptr; }
  const RoadSurfaceIndex &surfaces() const { return surfaces_; }
  const WallIndex &walls() const { return walls_; }

  void resize(int slots);
  int slots() const { return static_cast<int>(cars.size()); }
  void place(int slot, const Vec2 &position, double rotation);
  // Moves the car to the last passed checkpoint, as the browser game does.
  void respawn(int slot);

  // Advances one fixed tick. Inactive cars are skipped.
  void step(const std::vector<InputCmd> &inputs, std::vector<RaceEvent> *events = nullptr);

  std::vector<CarState> cars;

private:
  void updateCar(CarState &car, const InputCmd &input);
  void collide();
  void trackProgress(int slot, std::vector<RaceEvent> *events);

  std::shared_ptr<const Track> track_;
  RoadSurfaceIndex surfaces_;
  WallIndex walls_;
  std::vector<TrackElement> checkpoints_;
  std::vector<TrackElement> rawCheckpoints_;
  TrackElement finish_;
  bool hasFinish_ = false;
  std::vector<std::pair<uint32_t, Obb>> scratch_;
};

Obb carObb(const CarState &car);
// Separating axis test; normal points from a to b. Returns penetration depth (negative = gap).
bool obbOverlap(const Obb &a, const Obb &b, Vec2 &normal, double &depth);

} // namespace cg
