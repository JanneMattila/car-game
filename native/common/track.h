#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "json.h"
#include "math2d.h"

namespace cg {

enum class ElementType {
  Unknown,
  Road,
  RoadCurve,
  Bridge,
  Ramp,
  Wall,
  Barrier,
  Checkpoint,
  Finish,
  Spawn,
  Other
};

struct Bezier {
  Vec2 start, control1, control2, end;
};

struct TrackElement {
  std::string id;
  std::string typeName;
  ElementType type = ElementType::Unknown;
  double x = 0, y = 0, width = 0, height = 0, rotation = 0;
  int layer = 0;
  int checkpointIndex = 0;
  double roadWidth = 0; // 0 = default from size
  bool kerbs = false;
  bool hasBezier = false;
  Bezier bezier; // normalized local coordinates
  bool autoGateWidth = true;

  Vec2 center() const { return {x + width / 2, y + height / 2}; }
};

struct SceneryItem {
  std::string type;
  std::string label;
  Vec2 position;
  double scale = 1;
  double rotation = 0;
  double width = 0;  // 0 = default
  double height = 0; // 0 = default
  std::string color;
};

struct Track {
  std::string id;
  std::string name;
  double width = 0;
  double height = 0;
  bool wrapAround = false;
  int defaultLapCount = 3;
  std::string backgroundColor;
  std::vector<TrackElement> elements;
  std::vector<SceneryItem> scenery;
};

bool loadTrack(const Json &json, Track &track, std::string *error = nullptr);
bool loadTrackFile(const std::string &path, Track &track, std::string *error = nullptr);

// Geometry shared with the TypeScript implementation (shared/utils/roadGeometry.ts etc.).
Vec2 localToWorld(const TrackElement &element, const Vec2 &point);
Bezier worldBezier(const TrackElement &element);
Vec2 bezierPoint(const Bezier &curve, double t);
std::vector<Vec2> sampleRoadCurve(const TrackElement &element);
double roadStrokeWidth(const TrackElement &element);
std::vector<std::pair<Vec2, Vec2>> roadKerbDashes(const std::vector<Vec2> &points,
                                                   double dashLength = 28);
TrackElement effectiveRaceGate(const Track &track, const TrackElement &marker);
// Returns crossing fraction in [0,1] or a negative value when the gate is not crossed forwards.
double raceGateCrossing(const Track &track, const TrackElement &marker, const Vec2 &previous,
                        const Vec2 &current);
Vec2 unwrapForTrack(const Vec2 &point, const Vec2 &reference, double width, double height);

struct GridSlot {
  Vec2 position;
  double rotation = 0;
};
std::vector<GridSlot> computeStartGrid(const Track &track, int count);

struct RoadSurfaceIndex {
  explicit RoadSurfaceIndex(const Track &track);
  bool isAsphalt(const Vec2 &position, int layer = 0) const;

private:
  struct Surface {
    int layer = 0;
    bool segment = false;
    Vec2 a, b;      // segment endpoints
    double radius = 0;
    Vec2 center;    // rect
    double halfW = 0, halfH = 0, cosine = 1, sine = 0;
    bool contains(const Vec2 &p) const;
  };
  const Track &track_;
  double cellSize_ = 256;
  std::vector<Surface> surfaces_;
  std::unordered_map<int64_t, std::vector<int>> cells_;
};

// Oriented rectangle (center, half extents, rotation).
struct Obb {
  Vec2 center;
  double halfW = 0, halfH = 0, angle = 0;
};

struct WallIndex {
  explicit WallIndex(const Track &track);
  // Collect wall OBBs (already offset for wrap tiles) overlapping the circle; key identifies the
  // wall instance uniquely and deterministically.
  void query(const Vec2 &center, double radius, std::vector<std::pair<uint32_t, Obb>> &out) const;
  size_t size() const { return walls_.size(); }
  const std::vector<Obb> &walls() const { return walls_; }

private:
  const Track &track_;
  double cellSize_ = 256;
  std::vector<Obb> walls_;
  std::vector<double> radius_;
  std::unordered_map<int64_t, std::vector<int>> cells_;
};

inline int64_t cellKey(int64_t x, int64_t y) { return (x << 32) ^ (y & 0xffffffffLL); }

} // namespace cg
