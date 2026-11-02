#include "racingline.h"

#include <algorithm>
#include <cmath>
#include <limits>

#include "log.h"
#include "physics.h"

namespace cg {

namespace {

constexpr double kSpacing = 16;
constexpr double kGateApproach = 60;
constexpr int kGateSidePoints = 6;
// Minimum crossing angle of roughly 17 degrees through each gate.
constexpr double kGateSideSlope = 0.3;
constexpr int kGateEntryPoints = 10;
constexpr double kPassableClearance = physics::kCarWidth / 2 + 7;
constexpr double kLineClearance = 42;
constexpr double kPreferredClearance = 90;
constexpr double kOffroadCost = 4;
constexpr float kUnreachable = 1e9f;
constexpr double kSqrt2 = 1.41421356237309504880;
// Heading change per frame at full steering lock between 3 and 15 px/frame. The physics sets
// MAX_STEERING_ANGLE * 0.18, but integration and air friction leave about two thirds of that.
constexpr double kTurnRate = physics::kMaxSteeringAngle * 0.18 * 0.66;
constexpr double kFullTurnSpeed = 15;
const float kInfinity = std::numeric_limits<float>::infinity();

class MinHeap {
public:
  bool empty() const { return items_.empty(); }
  void clear() {
    items_.clear();
    priorities_.clear();
  }

  void push(int item, double priority) {
    size_t index = items_.size();
    items_.push_back(item);
    priorities_.push_back(priority);
    while (index > 0) {
      size_t parent = (index - 1) >> 1;
      if (priorities_[parent] <= priority) break;
      items_[index] = items_[parent];
      priorities_[index] = priorities_[parent];
      index = parent;
    }
    items_[index] = item;
    priorities_[index] = priority;
  }

  int pop() {
    int top = items_[0];
    int lastItem = items_.back();
    double lastPriority = priorities_.back();
    items_.pop_back();
    priorities_.pop_back();
    if (!items_.empty()) {
      size_t index = 0;
      size_t length = items_.size();
      for (size_t left = 1; left < length; left = index * 2 + 1) {
        size_t right = left + 1;
        size_t child = right < length && priorities_[right] < priorities_[left] ? right : left;
        if (priorities_[child] >= lastPriority) break;
        items_[index] = items_[child];
        priorities_[index] = priorities_[child];
        index = child;
      }
      items_[index] = lastItem;
      priorities_[index] = lastPriority;
    }
    return top;
  }

private:
  std::vector<int> items_;
  std::vector<double> priorities_;
};

class NavGrid {
public:
  explicit NavGrid(const Track &track) : track_(track), wrap_(track.wrapAround) {
    cellSize = std::max(16.0, std::ceil(std::sqrt(track.width * track.height / 250000)));
    cols = std::max(1, static_cast<int>(std::ceil(track.width / cellSize)));
    rows = std::max(1, static_cast<int>(std::ceil(track.height / cellSize)));
    size_t size = static_cast<size_t>(cols) * rows;
    gateLines.assign(size, 0);
    clearance.assign(size, 0);
    cost.assign(size, 0);
    asphalt.assign(size, 0);
  }

  double cellSize = 16;
  int cols = 0;
  int rows = 0;
  std::vector<float> clearance;
  std::vector<float> cost;
  std::vector<uint8_t> asphalt;
  // Gate lines A* may not cross, so routes never pass a gate backwards or out of order.
  std::vector<uint8_t> gateLines;

  void build(const std::vector<TrackElement> &gates, const RoadSurfaceIndex &surface) {
    double reach = cellSize * 0.75;
    std::vector<uint8_t> blocked(cost.size(), 0);
    for (const auto &wall : track_.elements) {
      if ((wall.type == ElementType::Wall || wall.type == ElementType::Barrier) && wall.layer == 0)
        rasterize(blocked, wall, reach);
    }
    for (const auto &gate : gates) {
      TrackElement line = gate;
      line.height = 0;
      line.y = gate.y + gate.height / 2;
      rasterize(gateLines, line, reach);
    }
    computeDistanceField(blocked);
    for (size_t cell = 0; cell < cost.size(); ++cell) {
      bool onRoad = surface.isAsphalt(center(static_cast<int>(cell)));
      asphalt[cell] = onRoad ? 1 : 0;
      double distance = clearance[cell] - cellSize / 2;
      if (distance < kPassableClearance) {
        cost[cell] = kInfinity;
        continue;
      }
      double wallPenalty = std::max(0.0, kPreferredClearance - distance) / kPreferredClearance;
      cost[cell] = static_cast<float>((onRoad ? 1 : kOffroadCost) + wallPenalty * 3);
    }
  }

  Vec2 center(int cell) const {
    return {(cell % cols + 0.5) * cellSize, (cell / cols + 0.5) * cellSize};
  }

  int cellAt(const Vec2 &point) const {
    return neighbor(static_cast<int>(std::floor(point.x / cellSize)),
                    static_cast<int>(std::floor(point.y / cellSize)));
  }

  int neighbor(int col, int row) const {
    if (wrap_) {
      col = ((col % cols) + cols) % cols;
      row = ((row % rows) + rows) % rows;
    } else if (col < 0 || row < 0 || col >= cols || row >= rows) {
      return -1;
    }
    return row * cols + col;
  }

  // Nearest passable cell, so gate approach points beside a barrier still route.
  int snap(const Vec2 &point) const {
    int start = cellAt(point);
    if (start < 0) return -1;
    if (std::isfinite(cost[start])) return start;
    int col = start % cols;
    int row = start / cols;
    for (int radius = 1; radius <= 8; ++radius) {
      int best = -1;
      int bestDistance = std::numeric_limits<int>::max();
      for (int dy = -radius; dy <= radius; ++dy) {
        for (int dx = -radius; dx <= radius; ++dx) {
          if (std::max(std::abs(dx), std::abs(dy)) != radius) continue;
          int cell = neighbor(col + dx, row + dy);
          if (cell < 0 || !std::isfinite(cost[cell])) continue;
          int distance = dx * dx + dy * dy;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = cell;
          }
        }
      }
      if (best >= 0) return best;
    }
    return start;
  }

  // A* over 8-connected cells; diagonal moves may not squeeze between blocked cells.
  bool findPath(int from, int to, std::vector<int> &path) {
    path.clear();
    if (from == to) {
      path.push_back(from);
      return true;
    }
    size_t size = cost.size();
    gScore_.assign(size, std::numeric_limits<double>::infinity());
    cameFrom_.assign(size, -1);
    closed_.assign(size, 0);
    heap_.clear();
    int toCol = to % cols;
    int toRow = to / cols;
    auto heuristic = [&](int cell) {
      int dx = std::abs(cell % cols - toCol);
      int dy = std::abs(cell / cols - toRow);
      if (wrap_) {
        dx = std::min(dx, cols - dx);
        dy = std::min(dy, rows - dy);
      }
      return std::max(dx, dy) + (kSqrt2 - 1) * std::min(dx, dy);
    };
    auto open = [&](int cell) {
      return cell >= 0 && std::isfinite(cost[cell]) && (!gateLines[cell] || cell == to);
    };
    gScore_[from] = 0;
    heap_.push(from, heuristic(from));
    while (!heap_.empty()) {
      int current = heap_.pop();
      if (current == to) {
        int cell = to;
        path.push_back(to);
        while (cameFrom_[cell] >= 0) {
          cell = cameFrom_[cell];
          path.push_back(cell);
        }
        std::reverse(path.begin(), path.end());
        return true;
      }
      if (closed_[current]) continue;
      closed_[current] = 1;
      int col = current % cols;
      int row = current / cols;
      for (int dy = -1; dy <= 1; ++dy) {
        for (int dx = -1; dx <= 1; ++dx) {
          if (dx == 0 && dy == 0) continue;
          int next = neighbor(col + dx, row + dy);
          if (next < 0 || closed_[next] || !open(next)) continue;
          if (dx != 0 && dy != 0) {
            if (!open(neighbor(col + dx, row)) || !open(neighbor(col, row + dy))) continue;
          }
          double currentCost = std::isfinite(cost[current]) ? cost[current] : cost[next];
          double step = ((dx != 0 && dy != 0) ? kSqrt2 : 1.0) * (currentCost + cost[next]) / 2;
          double score = gScore_[current] + step;
          if (score < gScore_[next]) {
            gScore_[next] = score;
            cameFrom_[next] = current;
            heap_.push(next, score + heuristic(next));
          }
        }
      }
    }
    return false;
  }

private:
  void rasterize(std::vector<uint8_t> &mask, const TrackElement &element, double reach) {
    double cx = element.x + element.width / 2;
    double cy = element.y + element.height / 2;
    double cosine = std::cos(element.rotation);
    double sine = std::sin(element.rotation);
    double halfW = element.width / 2;
    double halfH = element.height / 2;
    double extentX = std::fabs(halfW * cosine) + std::fabs(halfH * sine) + reach;
    double extentY = std::fabs(halfW * sine) + std::fabs(halfH * cosine) + reach;
    int minCol = static_cast<int>(std::floor((cx - extentX) / cellSize));
    int maxCol = static_cast<int>(std::floor((cx + extentX) / cellSize));
    int minRow = static_cast<int>(std::floor((cy - extentY) / cellSize));
    int maxRow = static_cast<int>(std::floor((cy + extentY) / cellSize));
    for (int row = minRow; row <= maxRow; ++row) {
      for (int col = minCol; col <= maxCol; ++col) {
        int cell = neighbor(col, row);
        if (cell < 0) continue;
        double dx = (col + 0.5) * cellSize - cx;
        double dy = (row + 0.5) * cellSize - cy;
        double localX = std::fabs(dx * cosine + dy * sine) - halfW;
        double localY = std::fabs(-dx * sine + dy * cosine) - halfH;
        if (std::hypot(std::max(0.0, localX), std::max(0.0, localY)) <= reach) mask[cell] = 1;
      }
    }
  }

  // Chamfer distance (px) from each cell centre to the nearest blocked cell centre.
  void computeDistanceField(const std::vector<uint8_t> &blocked) {
    std::vector<float> &field = clearance;
    for (size_t cell = 0; cell < field.size(); ++cell) field[cell] = blocked[cell] ? 0 : kUnreachable;
    const float straight = static_cast<float>(cellSize);
    const float diagonal = static_cast<float>(cellSize * kSqrt2);
    struct Step {
      int dx, dy;
      float cost;
    };
    const Step forwardMask[4] = {{-1, -1, diagonal}, {0, -1, straight}, {1, -1, diagonal},
                                 {-1, 0, straight}};
    const Step backwardMask[4] = {{1, 1, diagonal}, {0, 1, straight}, {-1, 1, diagonal},
                                  {1, 0, straight}};
    auto relax = [&](int col, int row, const Step *mask) {
      int cell = row * cols + col;
      for (int i = 0; i < 4; ++i) {
        int other = neighbor(col + mask[i].dx, row + mask[i].dy);
        if (other >= 0 && field[other] + mask[i].cost < field[cell])
          field[cell] = field[other] + mask[i].cost;
      }
    };
    // Repeating terrain needs a second sweep so distances propagate across tile seams.
    for (int sweep = 0; sweep < (wrap_ ? 2 : 1); ++sweep) {
      for (int row = 0; row < rows; ++row)
        for (int col = 0; col < cols; ++col) relax(col, row, forwardMask);
      for (int row = rows - 1; row >= 0; --row)
        for (int col = cols - 1; col >= 0; --col) relax(col, row, backwardMask);
    }
  }

  const Track &track_;
  bool wrap_ = false;
  std::vector<double> gScore_;
  std::vector<int> cameFrom_;
  std::vector<uint8_t> closed_;
  MinHeap heap_;
};

struct Vertex {
  Vec2 point;
  // Progress for the edge leaving this vertex.
  int expected = 0;
  // Gate whose centre line this vertex lies on, or -1.
  int gate = -1;
};

struct GateGeometry {
  Vec2 center;
  Vec2 across;
  double halfWidth = 0;
  Vec2 approach;
  Vec2 exit;
};

double circumradius(const Vec2 &a, const Vec2 &b, const Vec2 &c) {
  double ab = std::hypot(b.x - a.x, b.y - a.y);
  double bc = std::hypot(c.x - b.x, c.y - b.y);
  double ca = std::hypot(a.x - c.x, a.y - c.y);
  double area2 = std::fabs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  return area2 < 1e-6 ? std::numeric_limits<double>::infinity() : (ab * bc * ca) / (2 * area2);
}

// Uniformly spaced points along a closed polyline; gate vertices are always kept.
template <typename Relative>
std::vector<Vertex> resample(const std::vector<Vertex> &vertices, double spacing,
                             const Relative &relative) {
  std::vector<Vertex> result;
  double carry = 0;
  size_t count = vertices.size();
  for (size_t i = 0; i < count; ++i) {
    const Vertex &a = vertices[i];
    const Vertex &following = vertices[(i + 1) % count];
    Vec2 b = relative(a.point, following.point);
    if (a.gate >= 0) {
      result.push_back(a);
      carry = 0;
    }
    double length = std::hypot(b.x - a.point.x, b.y - a.point.y);
    // Avoid a near-duplicate point immediately before a kept gate vertex.
    double end = following.gate >= 0 ? length - spacing / 2 : length - 1e-6;
    double distance = a.gate >= 0 ? spacing : spacing - carry;
    while (distance < end) {
      double t = distance / length;
      Vertex v;
      v.point = {a.point.x + (b.x - a.point.x) * t, a.point.y + (b.y - a.point.y) * t};
      v.expected = a.expected;
      v.gate = -1;
      result.push_back(v);
      distance += spacing;
    }
    carry = length - (distance - spacing);
  }
  return result;
}

} // namespace

double RacingLine::wallDistance(const Vec2 &point) const {
  if (clearance.empty()) return 0;
  double gx = point.x / cellSize - 0.5;
  double gy = point.y / cellSize - 0.5;
  int col = static_cast<int>(std::floor(gx));
  int row = static_cast<int>(std::floor(gy));
  auto sample = [&](int c, int r) -> double {
    if (wrapAround) {
      c = ((c % cols) + cols) % cols;
      r = ((r % rows) + rows) % rows;
    } else {
      c = std::min(cols - 1, std::max(0, c));
      r = std::min(rows - 1, std::max(0, r));
    }
    return clearance[static_cast<size_t>(r) * cols + c];
  };
  double tx = gx - col;
  double ty = gy - row;
  double top = sample(col, row) * (1 - tx) + sample(col + 1, row) * tx;
  double bottom = sample(col, row + 1) * (1 - tx) + sample(col + 1, row + 1) * tx;
  return top * (1 - ty) + bottom * ty - cellSize / 2;
}

bool RacingLine::isAsphalt(const Vec2 &point) const {
  int col = static_cast<int>(std::floor(point.x / cellSize));
  int row = static_cast<int>(std::floor(point.y / cellSize));
  if (wrapAround) {
    col = ((col % cols) + cols) % cols;
    row = ((row % rows) + rows) % rows;
  } else if (col < 0 || row < 0 || col >= cols || row >= rows) {
    return false;
  }
  return asphalt[static_cast<size_t>(row) * cols + col] == 1;
}

Vec2 RacingLine::relative(const Vec2 &point, const Vec2 &reference) const {
  return wrapAround ? unwrapForTrack(point, reference, trackWidth, trackHeight) : point;
}

double cornerSpeed(double radius) {
  double lowSpeedRadius = 3 / kTurnRate;
  if (radius <= lowSpeedRadius) return 3;
  if (radius <= kFullTurnSpeed / kTurnRate) return radius * kTurnRate;
  return std::sqrt(radius * kTurnRate * kFullTurnSpeed);
}

double headingOf(const Vec2 &direction) {
  return wrapAngle(std::atan2(direction.x, -direction.y));
}

std::shared_ptr<const RacingLine> buildRacingLine(const Track &track) {
  if (track.width <= 0 || track.height <= 0) return nullptr;
  std::vector<TrackElement> checkpoints;
  const TrackElement *finish = nullptr;
  for (const auto &element : track.elements) {
    if (element.type == ElementType::Checkpoint) checkpoints.push_back(element);
    if (element.type == ElementType::Finish && !finish) finish = &element;
  }
  if (!finish) return nullptr;
  std::stable_sort(checkpoints.begin(), checkpoints.end(),
                   [](const TrackElement &a, const TrackElement &b) {
                     return a.checkpointIndex < b.checkpointIndex;
                   });
  std::vector<TrackElement> gates;
  for (const auto &checkpoint : checkpoints) gates.push_back(effectiveRaceGate(track, checkpoint));
  gates.push_back(effectiveRaceGate(track, *finish));
  const int gateCount = static_cast<int>(checkpoints.size());
  const int totalGates = static_cast<int>(gates.size());

  NavGrid grid(track);
  {
    RoadSurfaceIndex surface(track);
    grid.build(gates, surface);
  }
  auto wrapPoint = [&](const Vec2 &reference, const Vec2 &point) {
    return track.wrapAround ? unwrapForTrack(point, reference, track.width, track.height) : point;
  };

  std::vector<GateGeometry> gateGeometry;
  for (const auto &gate : gates) {
    GateGeometry g;
    g.center = {gate.x + gate.width / 2, gate.y + gate.height / 2};
    Vec2 forward = forwardOf(gate.rotation);
    g.across = {std::cos(gate.rotation), std::sin(gate.rotation)};
    // Keep the crossing point far enough from the gate ends for a whole car.
    g.halfWidth = std::max(0.0, gate.width / 2 - kLineClearance);
    g.approach = g.center - forward * kGateApproach;
    g.exit = g.center + forward * kGateApproach;
    gateGeometry.push_back(g);
  }

  // The lap starts just past the finish line, where every car has zero checkpoints.
  std::vector<Vertex> vertices;
  std::vector<int> path;
  Vec2 cursor = gateGeometry[totalGates - 1].exit;
  for (int gate = 0; gate < totalGates; ++gate) {
    const GateGeometry &geometry = gateGeometry[gate];
    int fromCell = grid.snap(cursor);
    int toCell = grid.snap(geometry.approach);
    if (fromCell < 0 || toCell < 0 || !grid.findPath(fromCell, toCell, path)) {
      CG_WARN("Racing line: no route to gate %d on %s", gate, track.name.c_str());
      return nullptr;
    }
    Vec2 point = cursor;
    vertices.push_back({point, gate, -1});
    for (size_t i = 1; i + 1 < path.size(); ++i) {
      point = wrapPoint(point, grid.center(path[i]));
      vertices.push_back({point, gate, -1});
    }
    Vec2 approach = wrapPoint(point, geometry.approach);
    Vec2 offset = approach - geometry.approach;
    vertices.push_back({approach, gate, -1});
    vertices.push_back({geometry.center + offset, gate == gateCount ? 0 : gate + 1, gate});
    cursor = geometry.exit + offset;
  }

  vertices = resample(vertices, kSpacing, wrapPoint);

  auto line = std::make_shared<RacingLine>();
  line->wrapAround = track.wrapAround;
  line->trackWidth = track.width;
  line->trackHeight = track.height;
  line->cellSize = grid.cellSize;
  line->cols = grid.cols;
  line->rows = grid.rows;
  line->clearance = std::move(grid.clearance);
  line->asphalt = std::move(grid.asphalt);
  const RacingLine &query = *line;

  std::vector<Vec2> gateForward;
  for (const auto &gate : gates) gateForward.push_back(forwardOf(gate.rotation));

  // Clearance-constrained relaxation pulls the line tight through corners. Gate vertices slide
  // along their gate line, so every lap still crosses each gate in order and inside its width.
  for (int iteration = 0; iteration < 200; ++iteration) {
    const int n = static_cast<int>(vertices.size());
    for (int i = 0; i < n; ++i) {
      Vertex &vertex = vertices[i];
      Vec2 current = vertex.point;
      Vec2 previous = wrapPoint(current, vertices[(i - 1 + n) % n].point);
      Vec2 next = wrapPoint(current, vertices[(i + 1) % n].point);
      Vec2 candidate = current + ((previous + next) / 2 - current) * 0.5;
      if (vertex.gate >= 0) {
        const GateGeometry &geometry = gateGeometry[vertex.gate];
        Vec2 center = wrapPoint(current, geometry.center);
        double lateral = clampd(dot(candidate - center, geometry.across), -geometry.halfWidth,
                                geometry.halfWidth);
        candidate = center + geometry.across * lateral;
      }
      double clearance = query.wallDistance(candidate);
      if (clearance < kLineClearance && clearance < query.wallDistance(current)) continue;
      if (query.isAsphalt(current) && !query.isAsphalt(candidate)) continue;
      vertex.point = candidate;
    }
    // Points next to a gate stay clearly on their side of it, so the line crosses each gate at
    // an angle instead of running along a gate that is parallel to the road.
    for (int i = 0; i < n; ++i) {
      int gate = vertices[i].gate;
      if (gate < 0) continue;
      const GateGeometry &geometry = gateGeometry[gate];
      const Vec2 &forward = gateForward[gate];
      Vec2 center = vertices[i].point;
      for (int step = -kGateSidePoints; step <= kGateSidePoints; ++step) {
        if (step == 0) continue;
        Vertex &vertex = vertices[((i + step) % n + n) % n];
        Vec2 point = wrapPoint(center, vertex.point);
        double along = dot(point - center, forward);
        double required = step * kSpacing * kGateSideSlope;
        double across = dot(point - center, geometry.across);
        if (std::fabs(across) > geometry.halfWidth + kLineClearance) continue;
        if (step < 0 ? along > required : along < required) {
          double shift = required - along;
          vertex.point = vertex.point + forward * shift;
        }
      }
    }
  }

  // Seamless unwrapped coordinates around the loop for distance calculations.
  for (size_t i = 1; i < vertices.size(); ++i)
    vertices[i].point = wrapPoint(vertices[i - 1].point, vertices[i].point);
  vertices = resample(vertices, kSpacing, wrapPoint);

  const int n = static_cast<int>(vertices.size());
  if (n < 3) return nullptr;
  line->points.resize(n);
  line->expected.resize(n);
  for (int i = 0; i < n; ++i) {
    line->points[i] = vertices[i].point;
    line->expected[i] = vertices[i].expected;
  }
  line->sinceGate.assign(n, 0);
  line->gateEntry.assign(totalGates, 0);
  int firstGate = -1;
  for (int i = 0; i < n && firstGate < 0; ++i)
    if (vertices[i].gate >= 0) firstGate = i;
  if (firstGate < 0) return nullptr;
  for (int step = 1; step <= n; ++step) {
    int i = (firstGate + step) % n;
    line->sinceGate[i] = vertices[i].gate >= 0 ? 0 : line->sinceGate[(i - 1 + n) % n] + kSpacing;
  }
  for (int i = 0; i < n; ++i)
    if (vertices[i].gate >= 0) line->gateEntry[vertices[i].gate] = (i - kGateEntryPoints + n) % n;
  line->nextGate.assign(n, firstGate);
  for (int step = n - 1; step >= 0; --step) {
    int i = (firstGate + step) % n;
    line->nextGate[i] = vertices[i].gate >= 0 ? i : line->nextGate[(i + 1) % n];
  }

  const int span = 4;
  const auto &points = line->points;
  line->speed.resize(n);
  for (int i = 0; i < n; ++i) {
    const Vec2 &current = points[i];
    Vec2 previous = wrapPoint(current, points[((i - span) % n + n) % n]);
    Vec2 next = wrapPoint(current, points[(i + span) % n]);
    line->speed[i] = std::min(physics::kMaxSpeed * physics::kNitroBoost,
                              cornerSpeed(circumradius(previous, current, next)));
  }
  // Speed a car can shed per pixel while braking, matching the physics drag and brakes.
  auto shed = [](double velocity) {
    return 0.6 * (physics::kDrag * velocity + physics::kRolling + 0.05);
  };
  for (int lap = 0; lap < 2; ++lap) {
    for (int i = n - 1; i >= 0; --i) {
      double next = line->speed[(i + 1) % n];
      line->speed[i] = std::min(line->speed[i], next + kSpacing * shed(next));
    }
  }

  for (int i = 0; i < totalGates; ++i)
    line->gates.push_back({gateGeometry[i].center, gateForward[i]});
  line->spacing = kSpacing;
  line->gateCount = gateCount;
  return line;
}

} // namespace cg
