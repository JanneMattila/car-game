#pragma once

#include <cstdint>
#include <memory>
#include <vector>

#include "math2d.h"
#include "track.h"

namespace cg {

// Closed driving line through every race gate in order, shared by all AI drivers on a track
// (port of server/game/racingLine.ts).
struct RacingLine {
  struct Gate {
    Vec2 center;
    Vec2 forward;
  };

  std::vector<Vec2> points;
  // Checkpoint progress (car.checkpoint) a car has while driving at each point.
  std::vector<int> expected;
  // Distance driven since the last gate centre, used to detect missed gates.
  std::vector<double> sinceGate;
  // Index shortly before each gate centre; the finish is the last gate.
  std::vector<int> gateEntry;
  // Index of the next gate centre point at or after each point.
  std::vector<int> nextGate;
  // Gate centres and crossing directions in race order; the finish is last.
  std::vector<Gate> gates;
  // Highest safe speed (px/frame) at each point, including braking for upcoming corners.
  std::vector<double> speed;
  double spacing = 16;
  int gateCount = 0;
  bool wrapAround = false;
  double trackWidth = 0;
  double trackHeight = 0;

  // Navigation grid layers kept for wall distance and surface queries.
  double cellSize = 16;
  int cols = 0;
  int rows = 0;
  std::vector<float> clearance;
  std::vector<uint8_t> asphalt;

  int size() const { return static_cast<int>(points.size()); }
  // Approximate distance from a point to the nearest wall or barrier.
  double wallDistance(const Vec2 &point) const;
  bool isAsphalt(const Vec2 &point) const;
  // Unwraps `point` next to `reference` on wrap-around tracks.
  Vec2 relative(const Vec2 &point, const Vec2 &reference) const;
};

// Highest speed whose full-lock turning circle fits inside the given radius.
double cornerSpeed(double radius);
// Car rotation that faces along a direction.
double headingOf(const Vec2 &direction);

// Returns nullptr if the track has no usable route.
std::shared_ptr<const RacingLine> buildRacingLine(const Track &track);

} // namespace cg
