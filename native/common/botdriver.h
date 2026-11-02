#pragma once

#include <cstdint>
#include <memory>
#include <string>

#include "physics.h"
#include "racingline.h"

namespace cg {

enum class BotSkill { Easy, Medium, Hard };
BotSkill parseBotSkill(const std::string &name, BotSkill fallback = BotSkill::Medium);
const char *botSkillName(BotSkill skill);

// AI driver following a shared racing line (port of server/game/botDriver.ts). Deterministic:
// time is measured in simulation ticks and randomness comes from the seed.
class BotDriver {
public:
  enum class RespawnReason { None, MissedGate, NoProgress };

  BotDriver(std::shared_ptr<const RacingLine> line, BotSkill skill, uint32_t seed);
  // Decide the input for car `slot` for the next tick, reading only the given world state.
  // `tick` is a monotonically increasing simulation tick (60 Hz).
  InputCmd update(const World &world, int slot, int32_t tick);
  // Call after the car was teleported (respawn/grid placement) so internal tracking resets.
  void reset(const World &world, int slot, int32_t tick);

  BotSkill skill() const { return skill_; }
  int respawnCount() const { return respawns_; }
  RespawnReason lastRespawnReason() const { return lastRespawnReason_; }

private:
  struct Profile {
    // Fraction of the racing line's safe corner speed the driver dares to carry.
    double cornerFactor;
    double topSpeed;
    bool useNitro;
    // Maximum sideways offset from the racing line, giving each bot its own line.
    double lineOffset;
  };
  struct Ahead {
    Vec2 point;
    int index;
  };

  double random();
  bool allowed(int expected, const CarState &car) const;
  void locate(const CarState &car);
  Ahead ahead(double span, const Vec2 &reference, bool stopAtGate = false) const;
  void resetRecovery();
  InputCmd requestRespawn(const CarState &car, RespawnReason reason);
  static InputCmd command(bool accelerate, bool brake, bool nitro, double steer);

  std::shared_ptr<const RacingLine> line_;
  BotSkill skill_;
  Profile profile_{};
  double lateral_ = 0;
  uint32_t rng_ = 0;
  int index_ = -1;
  int32_t time_ = 0;
  int32_t stuckSince_ = -1;
  int32_t reverseUntil_ = -1;
  double reverseSteer_ = 0;
  double progress_ = 0;
  double progressMark_ = 0;
  int32_t progressMarkTime_ = 0;
  // Car being overtaken (slot) and the side chosen to pass it on (-1 left, 1 right).
  int passingSlot_ = -1;
  int passingSide_ = 0;
  // A respawn was requested on the previous update; tracking resets once the car moved.
  bool respawnPending_ = false;
  // Checkpoint progress at the time of the respawn request.
  int respawnCheckpoint_ = 0;
  int respawns_ = 0;
  RespawnReason lastRespawnReason_ = RespawnReason::None;
};

} // namespace cg
