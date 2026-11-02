#include "physics.h"

#include <algorithm>

namespace cg {

using namespace physics;

namespace {
constexpr double kContactMargin = 0.5;
constexpr int kSolverIterations = 4;
} // namespace

Obb carObb(const CarState &car) { return {car.pos, kCarWidth / 2, kCarHeight / 2, car.angle}; }

bool obbOverlap(const Obb &a, const Obb &b, Vec2 &normal, double &depth) {
  Vec2 axes[4] = {{std::cos(a.angle), std::sin(a.angle)},
                  {-std::sin(a.angle), std::cos(a.angle)},
                  {std::cos(b.angle), std::sin(b.angle)},
                  {-std::sin(b.angle), std::cos(b.angle)}};
  Vec2 delta = b.center - a.center;
  depth = 1e300;
  for (int i = 0; i < 4; ++i) {
    const Vec2 &axis = axes[i];
    double ra = a.halfW * std::fabs(dot(axes[0], axis)) + a.halfH * std::fabs(dot(axes[1], axis));
    double rb = b.halfW * std::fabs(dot(axes[2], axis)) + b.halfH * std::fabs(dot(axes[3], axis));
    double d = dot(delta, axis);
    double overlap = ra + rb - std::fabs(d);
    if (overlap < depth) {
      depth = overlap;
      normal = d >= 0 ? axis : -axis;
    }
  }
  return depth > 0;
}

World::World(std::shared_ptr<const Track> track)
    : track_(std::move(track)), surfaces_(*track_), walls_(*track_) {
  for (const auto &e : track_->elements) {
    if (e.type == ElementType::Checkpoint) rawCheckpoints_.push_back(e);
    if (e.type == ElementType::Finish && !hasFinish_) {
      finish_ = effectiveRaceGate(*track_, e);
      hasFinish_ = true;
    }
  }
  std::stable_sort(rawCheckpoints_.begin(), rawCheckpoints_.end(),
                   [](const TrackElement &a, const TrackElement &b) {
                     return a.checkpointIndex < b.checkpointIndex;
                   });
  for (const auto &c : rawCheckpoints_) checkpoints_.push_back(effectiveRaceGate(*track_, c));
}

void World::resize(int slots) { cars.resize(slots); }

void World::place(int slot, const Vec2 &position, double rotation) {
  CarState &car = cars[slot];
  car.active = true;
  car.pos = position;
  car.progressPos = position;
  car.angle = rotation;
  car.vel = {0, 0};
  car.angVel = 0;
  car.nitroActive = false;
  // A fresh body has no cached contacts.
  car.contactCount = 0;
}

void World::respawn(int slot) {
  CarState &car = cars[slot];
  if (car.finished || rawCheckpoints_.empty()) return;
  const TrackElement &cp = rawCheckpoints_[std::max(0, car.checkpoint - 1) %
                                           rawCheckpoints_.size()];
  Vec2 position = cp.center();
  if (track_->wrapAround)
    position = unwrapForTrack(position, car.pos, track_->width, track_->height);
  place(slot, position, cp.rotation);
}

void World::updateCar(CarState &car, const InputCmd &input) {
  car.onAsphalt = surfaces_.isAsphalt(car.pos, 0);
  double forceScale = (car.onAsphalt ? 1 : kOffroadForce) * (car.contactCount ? kContactForce : 1);
  double speedScale = car.onAsphalt ? 1 : kOffroadSpeed;
  double rolling = kRolling + (car.onAsphalt ? 0 : kOffroadRolling);

  double currentSpeed = car.speed();
  Vec2 forward = forwardOf(car.angle);
  double forwardSpeed = dot(car.vel, forward);
  bool movingForward = forwardSpeed > 0.5;
  bool movingBackward = forwardSpeed < -0.5;
  Vec2 force{0, 0};

  if (input.has(kInputAccelerate) && currentSpeed < kMaxSpeed)
    force += forward * (kEngineForce * 0.001 * forceScale);

  if (input.has(kInputBrake)) {
    if (movingForward && forwardSpeed > 1) {
      car.vel *= 0.95;
    } else if (currentSpeed < kMaxReverseSpeed) {
      force -= forward * (kReverseForce * 0.001 * forceScale);
    }
  }

  double steer = input.steering();
  if (steer != 0) {
    if (currentSpeed > 0.5) {
      double speedFactor = currentSpeed < 3    ? currentSpeed / 3
                           : currentSpeed < 15 ? 1.0
                                               : std::max(0.5, 15 / currentSpeed);
      car.angVel = steer * kMaxSteeringAngle * 0.18 * speedFactor * (movingBackward ? -1 : 1);
    }
  } else {
    car.angVel *= 0.85;
  }

  // Nitro (shared/utils/nitro.ts)
  double boostScale = 0;
  if (!input.has(kInputNitro)) {
    car.nitro = std::min(kNitroMax, car.nitro + kNitroRecharge * kDt);
  } else {
    double consumption = kNitroDrain * kDt;
    boostScale = std::min(1.0, car.nitro / consumption);
    car.nitro = std::max(0.0, car.nitro - consumption);
  }
  car.nitroActive = boostScale > 0;
  if (car.nitroActive) force += forward * (kEngineForce * 0.0015 * boostScale * forceScale);

  car.vel *= 1 - kDrag * currentSpeed - rolling;

  double maxSpeed = speedScale * (car.nitroActive ? kMaxSpeed * kNitroBoost : kMaxSpeed);
  if (currentSpeed > maxSpeed) car.vel *= maxSpeed / currentSpeed;

  car.angVel = clampd(car.angVel, -kMaxAngularVelocity, kMaxAngularVelocity);

  // Rigid body integration (Verlet with air friction, as in the reference engine).
  car.vel = car.vel * (1 - kFrictionAir) + force * (kDtSquaredMs / kCarMass);
  car.pos += car.vel;
  car.angVel *= 1 - kFrictionAir;
  car.angle += car.angVel;
}

void World::collide() {
  const int n = slots();
  std::vector<std::array<uint32_t, kMaxContacts>> found(n);
  std::vector<uint8_t> foundCount(n, 0);
  auto addContact = [&](int slot, uint32_t key) {
    for (int i = 0; i < foundCount[slot]; ++i)
      if (found[slot][i] == key) return;
    if (foundCount[slot] < kMaxContacts) found[slot][foundCount[slot]++] = key;
  };

  for (int iteration = 0; iteration < kSolverIterations; ++iteration) {
    bool any = false;
    for (int i = 0; i < n; ++i) {
      CarState &car = cars[i];
      if (!car.active) continue;
      walls_.query(car.pos, 80, scratch_);
      for (const auto &wall : scratch_) {
        Vec2 normal;
        double depth;
        obbOverlap(carObb(car), wall.second, normal, depth);
        if (depth < -kContactMargin) continue;
        addContact(i, wall.first);
        if (depth <= 0) continue;
        any = true;
        car.pos -= normal * depth;
        double vn = dot(car.vel, normal);
        if (vn > 0) car.vel -= normal * vn;
      }
      for (int j = i + 1; j < n; ++j) {
        CarState &other = cars[j];
        if (!other.active || distance(car.pos, other.pos) > 70) continue;
        Vec2 normal;
        double depth;
        obbOverlap(carObb(car), carObb(other), normal, depth);
        if (depth < -kContactMargin) continue;
        addContact(i, 0x80000000u | static_cast<uint32_t>(j));
        addContact(j, 0x80000000u | static_cast<uint32_t>(i));
        if (depth <= 0) continue;
        any = true;
        car.pos -= normal * (depth / 2);
        other.pos += normal * (depth / 2);
        double vn = dot(car.vel - other.vel, normal);
        if (vn > 0) {
          car.vel -= normal * (vn / 2);
          other.vel += normal * (vn / 2);
        }
      }
    }
    if (!any) break;
  }

  for (int i = 0; i < n; ++i) {
    CarState &car = cars[i];
    if (!car.active) continue;
    bool impacted = false;
    for (int k = 0; k < foundCount[i]; ++k) {
      bool existed = false;
      for (int m = 0; m < car.contactCount; ++m)
        if (car.contacts[m] == found[i][k]) existed = true;
      if (!existed) impacted = true;
    }
    // A barrier seam can produce several pairs; apply the impact loss only once per car.
    if (impacted) car.vel *= kCollisionRetention;
    car.contactCount = foundCount[i];
    car.contacts = found[i];
  }
}

void World::trackProgress(int slot, std::vector<RaceEvent> *events) {
  CarState &car = cars[slot];
  Vec2 previous = car.progressPos;
  Vec2 current = car.pos;
  double lastCrossing = -1;
  int count = checkpointCount();
  while (car.checkpoint < count) {
    double time = raceGateCrossing(*track_, checkpoints_[car.checkpoint], previous, current);
    if (time < 0 || time < lastCrossing) break;
    lastCrossing = time;
    if (events) events->push_back({RaceEvent::Type::Checkpoint, slot, car.checkpoint});
    car.checkpoint++;
  }
  if (hasFinish_ && car.checkpoint == count) {
    double finishTime = raceGateCrossing(*track_, finish_, previous, current);
    if (finishTime >= 0 && finishTime >= lastCrossing) {
      car.lap++;
      car.checkpoint = 0;
      if (events) events->push_back({RaceEvent::Type::Lap, slot, car.lap});
    }
  }
  car.progressPos = current;
}

void World::step(const std::vector<InputCmd> &inputs, std::vector<RaceEvent> *events) {
  static const InputCmd kNone;
  for (int i = 0; i < slots(); ++i) {
    if (!cars[i].active) continue;
    const InputCmd &input = i < static_cast<int>(inputs.size()) ? inputs[i] : kNone;
    if (input.has(kInputRespawn) && !cars[i].finished) respawn(i);
    updateCar(cars[i], input);
  }
  collide();
  for (int i = 0; i < slots(); ++i)
    if (cars[i].active) trackProgress(i, events);
}

} // namespace cg
