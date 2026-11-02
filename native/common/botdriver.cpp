#include "botdriver.h"

#include <algorithm>
#include <cmath>
#include <utility>

namespace cg {

namespace {

constexpr int kSearchBehind = 8;
constexpr int kSearchAhead = 40;
constexpr double kLostDistance = 260;
constexpr double kStuckSpeed = 0.8;
// Timings of the reference driver (ms) converted to 60 Hz ticks.
constexpr int32_t kStuckTicks = 54;           // 900 ms
constexpr int32_t kFacingAwayTicks = 12;      // 200 ms
constexpr int32_t kReverseTicks = 54;         // 900 ms
constexpr int32_t kNoProgressRespawn = 420;   // 7000 ms
// Reverse briefly after a respawn onto the uncounted first checkpoint so it is crossed again.
constexpr int32_t kRespawnBackUpTicks = 20;
constexpr double kMissedGateDistance = 160;
constexpr double kGateCommitDistance = 30;
constexpr double kCarLength = physics::kCarHeight;
constexpr double kPassOffset = 60;
constexpr double kUnlimited = 1e9;

double normalizeHeading(double angle) {
  return wrapAngle(std::remainder(angle, 2 * kPi));
}

} // namespace

BotSkill parseBotSkill(const std::string &name, BotSkill fallback) {
  std::string lower;
  for (char c : name) lower += static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c);
  if (lower == "easy") return BotSkill::Easy;
  if (lower == "medium") return BotSkill::Medium;
  if (lower == "hard") return BotSkill::Hard;
  return fallback;
}

const char *botSkillName(BotSkill skill) {
  switch (skill) {
  case BotSkill::Easy:
    return "easy";
  case BotSkill::Hard:
    return "hard";
  case BotSkill::Medium:
  default:
    return "medium";
  }
}

BotDriver::BotDriver(std::shared_ptr<const RacingLine> line, BotSkill skill, uint32_t seed)
    : line_(std::move(line)), skill_(skill) {
  // Cars reach about 13 px/frame on asphalt (18 with nitro), so speed caps sit below that.
  switch (skill) {
  case BotSkill::Easy:
    profile_ = {0.75, 10.5, false, 30};
    break;
  case BotSkill::Hard:
    profile_ = {1, kUnlimited, true, 14};
    break;
  case BotSkill::Medium:
  default:
    profile_ = {0.88, 12, false, 22};
    break;
  }
  // FNV-1a over the seed bytes, as the reference hashes the player id.
  rng_ = 2166136261u;
  for (int i = 0; i < 4; ++i) rng_ = (rng_ ^ ((seed >> (i * 8)) & 0xffu)) * 16777619u;
  // Deterministic per-bot variation so several bots of one skill do not drive identically.
  profile_.cornerFactor *= 0.97 + random() * 0.05;
  lateral_ = (random() * 2 - 1) * profile_.lineOffset;
}

double BotDriver::random() {
  uint32_t state = rng_;
  state = (state ^ (state >> 15)) * 2246822507u;
  state = (state ^ (state >> 13)) * 3266489909u;
  state ^= state >> 16;
  rng_ = state;
  return state / 4294967296.0;
}

bool BotDriver::allowed(int expected, const CarState &car) const {
  return expected == car.checkpoint || (car.checkpoint == 0 && expected == line_->gateCount);
}

void BotDriver::locate(const CarState &car) {
  const RacingLine &line = *line_;
  const int n = line.size();
  int best = -1;
  double bestDistance = 1e300;
  auto consider = [&](int i) {
    Vec2 point = line.relative(line.points[i], car.pos);
    double d = lengthSq(point - car.pos);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  };
  if (index_ >= 0) {
    for (int offset = -kSearchBehind; offset <= kSearchAhead; ++offset)
      consider(((index_ + offset) % n + n) % n);
  }
  if (best < 0 || bestDistance > kLostDistance * kLostDistance) {
    best = -1;
    bestDistance = 1e300;
    for (int i = 0; i < n; ++i)
      if (allowed(line.expected[i], car)) consider(i);
  }
  if (best < 0) return;
  if (index_ >= 0) {
    int advance = best - index_;
    if (advance > n / 2) advance -= n;
    if (advance < -n / 2) advance += n;
    progress_ += advance * line.spacing;
  }
  index_ = best;
}

// Point on the racing line a given distance ahead, never skipping past the next gate.
BotDriver::Ahead BotDriver::ahead(double span, const Vec2 &reference, bool stopAtGate) const {
  const RacingLine &line = *line_;
  const int n = line.size();
  int steps = std::max(1, static_cast<int>(std::lround(span / line.spacing)));
  if (stopAtGate) {
    int gate = line.nextGate[index_];
    int gateSteps = ((gate - index_) % n + n) % n;
    Vec2 gatePoint = line.relative(line.points[gate], reference);
    double gateDistance = distance(gatePoint, reference);
    if (gateSteps < steps && gateDistance > kGateCommitDistance) steps = std::max(1, gateSteps);
  }
  int index = (index_ + steps) % n;
  return {line.relative(line.points[index], reference), index};
}

InputCmd BotDriver::command(bool accelerate, bool brake, bool nitro, double steer) {
  steer = clampd(steer, -1, 1);
  InputCmd input;
  if (accelerate) input.buttons |= kInputAccelerate;
  if (brake) input.buttons |= kInputBrake;
  if (nitro) input.buttons |= kInputNitro;
  if (steer < -0.05) input.buttons |= kInputLeft;
  if (steer > 0.05) input.buttons |= kInputRight;
  input.steer = static_cast<int8_t>(clampd(std::round(steer * 127), -127, 127));
  return input;
}

void BotDriver::resetRecovery() {
  stuckSince_ = -1;
  reverseUntil_ = -1;
  progressMark_ = progress_;
  progressMarkTime_ = time_;
}

void BotDriver::reset(const World &world, int slot, int32_t tick) {
  time_ = tick;
  index_ = -1;
  passingSlot_ = -1;
  passingSide_ = 0;
  respawnPending_ = false;
  resetRecovery();
  if (line_ && slot >= 0 && slot < world.slots() && world.cars[slot].active)
    locate(world.cars[slot]);
}

InputCmd BotDriver::requestRespawn(const CarState &car, RespawnReason reason) {
  resetRecovery();
  respawnPending_ = true;
  respawnCheckpoint_ = car.checkpoint;
  lastRespawnReason_ = reason;
  ++respawns_;
  InputCmd input;
  input.buttons = kInputRespawn;
  return input;
}

InputCmd BotDriver::update(const World &world, int slot, int32_t tick) {
  time_ = tick;
  if (!line_ || line_->size() == 0 || slot < 0 || slot >= world.slots()) return {};
  const CarState &car = world.cars[slot];
  if (!car.active) return {};
  const RacingLine &line = *line_;
  const int n = line.size();

  if (respawnPending_) {
    // The world moved the car to its last passed checkpoint during the previous step.
    int checkpoint = respawnCheckpoint_;
    reset(world, slot, tick);
    // With no checkpoint passed yet, the respawn lands on the first checkpoint line itself,
    // which only counts when crossed from behind.
    if (line.gateCount > 0 && checkpoint == 0 && car.checkpoint == 0) {
      reverseUntil_ = tick + kRespawnBackUpTicks;
      reverseSteer_ = 0;
    }
  }

  locate(car);
  if (index_ < 0) return command(true, false, false, 0);

  // A gate passed outside its width never counts, so go back and take it properly.
  const int expected = line.expected[index_];
  const int gatesAhead =
      ((expected - car.checkpoint + line.gateCount + 1) % (line.gateCount + 1) + line.gateCount +
       1) %
      (line.gateCount + 1);
  const bool missed = !allowed(expected, car) && gatesAhead >= 1 &&
                      gatesAhead <= std::max(1, (line.gateCount + 1) / 2) &&
                      (gatesAhead > 1 || line.sinceGate[index_] > kMissedGateDistance);
  if (missed && !car.finished) {
    int gate = std::min(car.checkpoint, line.gateCount);
    index_ = line.gateEntry[gate];
    return requestRespawn(car, RespawnReason::MissedGate);
  }

  if (progress_ - progressMark_ > 150) {
    progressMark_ = progress_;
    progressMarkTime_ = time_;
  } else if (time_ - progressMarkTime_ > kNoProgressRespawn && !car.finished) {
    return requestRespawn(car, RespawnReason::NoProgress);
  }

  const Vec2 position = car.pos;
  const double heading = normalizeHeading(car.angle);
  const Vec2 forward = forwardOf(heading);
  const Vec2 right{-forward.y, forward.x};
  const double speed = car.speed();
  const double forwardSpeed = dot(car.vel, forward);

  const Ahead look = ahead(30 + speed * 6, position, true);
  const Vec2 lookNext = line.relative(line.points[(look.index + 2) % n], look.point);
  const Vec2 tangent = lookNext - look.point;
  double tangentLength = length(tangent);
  if (tangentLength == 0) tangentLength = 1;
  const Vec2 normal{-tangent.y / tangentLength, tangent.x / tangentLength};
  // Drive the exact line through gates; a personal line elsewhere spreads the field out.
  const double toGate = (((line.nextGate[index_] - index_) % n + n) % n) * line.spacing;
  double offset = lateral_ * std::min(1.0, std::max(0.0, toGate - 40) / 160);

  double targetSpeed =
      std::min(profile_.topSpeed,
               line.speed[ahead(speed * 3, position).index] * profile_.cornerFactor);

  // Pass slower cars on the side with more room, committing to that side until the car is
  // behind; follow when there is no room.
  const double range = kCarLength * 1.5 + speed * 8;
  auto sideClear = [&](int side) {
    Vec2 candidate = look.point + normal * (side * kPassOffset);
    return line.wallDistance(candidate) > 40 &&
           (!line.isAsphalt(look.point) || line.isAsphalt(candidate));
  };
  int blocker = -1;
  double blockerAcross = 0, blockerSpeed = 0, blockerAlong = 0;
  bool passingStillAlongside = false;
  for (int other = 0; other < world.slots(); ++other) {
    const CarState &car2 = world.cars[other];
    if (other == slot || !car2.active) continue;
    Vec2 otherPosition = line.relative(car2.pos, position);
    Vec2 delta = otherPosition - position;
    double along = dot(delta, forward);
    double across = dot(delta, right);
    if (other == passingSlot_) {
      passingStillAlongside = along > -kCarLength * 1.2 && along < range + kCarLength &&
                              std::fabs(across) < 110;
    }
    if (along <= 0 || along > range || std::fabs(across) > 45) continue;
    double otherSpeed = dot(car2.vel, forward);
    if (otherSpeed > forwardSpeed - 0.3) continue;
    if (blocker < 0 || along < blockerAlong) {
      blocker = other;
      blockerAcross = across;
      blockerSpeed = otherSpeed;
      blockerAlong = along;
    }
  }
  if (passingSlot_ >= 0 && !passingStillAlongside) passingSlot_ = -1;
  if (passingSlot_ < 0 && blocker >= 0) {
    int first = blockerAcross > 0 ? -1 : 1;
    if (sideClear(first)) {
      passingSlot_ = blocker;
      passingSide_ = first;
    } else if (sideClear(-first)) {
      passingSlot_ = blocker;
      passingSide_ = -first;
    }
  }
  if (passingSlot_ >= 0 && sideClear(passingSide_)) {
    offset = passingSide_ * kPassOffset;
  } else {
    passingSlot_ = -1;
    if (blocker >= 0) targetSpeed = std::min(targetSpeed, std::max(2.0, blockerSpeed - 0.5));
  }

  Vec2 target = look.point + normal * offset;
  if (offset != 0 && line.wallDistance(target) < 40) target = look.point;
  const double error = wrapAngle(headingOf(target - position) - heading);

  if (car.finished) targetSpeed = std::min(targetSpeed, 8.0);
  if (std::fabs(error) > 0.7) targetSpeed = std::min(targetSpeed, 6.0);

  // Reverse away from walls or other cars, then continue.
  if (time_ < reverseUntil_) return command(false, true, false, reverseSteer_);
  const bool facingAway = std::fabs(error) > 2 && speed < 3;
  if (speed < kStuckSpeed || facingAway) {
    if (stuckSince_ < 0) stuckSince_ = time_;
    if (time_ - stuckSince_ > (facingAway ? kFacingAwayTicks : kStuckTicks)) {
      stuckSince_ = -1;
      reverseUntil_ = time_ + kReverseTicks;
      // Steering is mirrored in reverse, so this swings the nose towards the target.
      reverseSteer_ = error > 0 ? -1 : 1;
      return command(false, true, false, reverseSteer_);
    }
  } else {
    stuckSince_ = -1;
  }

  const bool accelerate = forwardSpeed < targetSpeed - 0.2;
  const bool brake = forwardSpeed > targetSpeed + 1.2;
  const bool nitro = profile_.useNitro && accelerate && std::fabs(error) < 0.08 &&
                     car.nitro > 25 && line.speed[ahead(speed * 25, position).index] >= 19 &&
                     targetSpeed >= 19;
  return command(accelerate, brake, nitro, error * 3.5);
}

} // namespace cg
