#include "track.h"

#include <algorithm>
#include <limits>

#include "log.h"

namespace cg {

double distanceToSegment(const Vec2 &point, const Vec2 &a, const Vec2 &b) {
  Vec2 d = b - a;
  double ls = lengthSq(d);
  double t = ls == 0 ? 0 : clampd(dot(point - a, d) / ls, 0, 1);
  return length(point - a - d * t);
}

namespace {

ElementType parseType(const std::string &t) {
  if (t == "road") return ElementType::Road;
  if (t == "road_curve") return ElementType::RoadCurve;
  if (t == "bridge") return ElementType::Bridge;
  if (t == "ramp" || t == "ramp_up" || t == "ramp_down") return ElementType::Ramp;
  if (t == "wall") return ElementType::Wall;
  if (t == "barrier") return ElementType::Barrier;
  if (t == "checkpoint") return ElementType::Checkpoint;
  if (t == "finish") return ElementType::Finish;
  if (t == "spawn") return ElementType::Spawn;
  return ElementType::Other;
}

Vec2 readVec(const Json &j) { return {j["x"].number(), j["y"].number()}; }

bool isWall(const TrackElement &e) {
  return e.type == ElementType::Wall || e.type == ElementType::Barrier;
}

} // namespace

bool loadTrack(const Json &json, Track &track, std::string *error) {
  if (!json.isObject() || !json["elements"].isArray()) {
    if (error) *error = "track JSON must be an object with elements";
    return false;
  }
  track = Track{};
  track.id = json["id"].string();
  track.name = json["name"].string(track.id);
  track.width = json["width"].number(2000);
  track.height = json["height"].number(1200);
  track.wrapAround = json["wrapAround"].boolean(false);
  track.defaultLapCount = std::max(1, json["defaultLapCount"].integer(3));
  track.backgroundColor = json["backgroundColor"].string();
  for (const Json &e : json["elements"].items()) {
    TrackElement el;
    el.id = e["id"].string();
    el.typeName = e["type"].string();
    el.type = parseType(el.typeName);
    if (e["x"].isNumber()) {
      el.x = e["x"].number();
      el.y = e["y"].number();
    } else {
      el.x = e["position"]["x"].number();
      el.y = e["position"]["y"].number();
    }
    el.width = e["width"].number();
    el.height = e["height"].number();
    el.rotation = e["rotation"].number(0);
    el.layer = e["layer"].integer(0);
    el.checkpointIndex = e["checkpointIndex"].integer(0);
    const Json &props = e["properties"];
    el.roadWidth = props["roadWidth"].number(0);
    el.kerbs = props["kerbs"].boolean(false);
    el.autoGateWidth = !(props["autoGateWidth"].isBool() && !props["autoGateWidth"].boolean());
    if (props["bezier"].isObject()) {
      el.hasBezier = true;
      el.bezier.start = readVec(props["bezier"]["start"]);
      el.bezier.control1 = readVec(props["bezier"]["control1"]);
      el.bezier.control2 = readVec(props["bezier"]["control2"]);
      el.bezier.end = readVec(props["bezier"]["end"]);
    }
    track.elements.push_back(std::move(el));
  }
  for (const Json &s : json["scenery"].items()) {
    SceneryItem item;
    item.type = s["type"].string();
    item.label = s["label"].string();
    item.position = readVec(s["position"]);
    item.scale = s["scale"].number(1);
    item.rotation = s["rotation"].number(0);
    item.width = s["width"].number(0);
    item.height = s["height"].number(0);
    item.color = s["color"].string();
    track.scenery.push_back(std::move(item));
  }
  return true;
}

bool loadTrackFile(const std::string &path, Track &track, std::string *error) {
  std::string text;
  if (!readFile(path, text)) {
    if (error) *error = "cannot read " + path;
    return false;
  }
  std::string parseError;
  Json json = Json::parse(text, &parseError);
  if (json.isNull()) {
    if (error) *error = parseError;
    return false;
  }
  return loadTrack(json, track, error);
}

Vec2 localToWorld(const TrackElement &element, const Vec2 &point) {
  double x = (point.x - 0.5) * element.width;
  double y = (point.y - 0.5) * element.height;
  double c = std::cos(element.rotation), s = std::sin(element.rotation);
  return {element.x + element.width / 2 + x * c - y * s,
          element.y + element.height / 2 + x * s + y * c};
}

Bezier worldBezier(const TrackElement &element) {
  return {localToWorld(element, element.bezier.start),
          localToWorld(element, element.bezier.control1),
          localToWorld(element, element.bezier.control2),
          localToWorld(element, element.bezier.end)};
}

Vec2 bezierPoint(const Bezier &c, double t) {
  double u = 1 - t;
  double a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return {a * c.start.x + b * c.control1.x + d * c.control2.x + e * c.end.x,
          a * c.start.y + b * c.control1.y + d * c.control2.y + e * c.end.y};
}

std::vector<Vec2> sampleRoadCurve(const TrackElement &element) {
  std::vector<Vec2> points;
  if (element.hasBezier) {
    Bezier curve = worldBezier(element);
    double len = distance(curve.start, curve.control1) + distance(curve.control1, curve.control2) +
                 distance(curve.control2, curve.end);
    int steps = static_cast<int>(std::min(512.0, std::max(24.0, std::ceil(len / 16))));
    points.reserve(steps + 1);
    for (int i = 0; i <= steps; ++i) points.push_back(bezierPoint(curve, double(i) / steps));
    return points;
  }
  // Legacy quarter-circle geometry matches the original editor.
  double radius = std::min(element.width, element.height) / 2;
  for (int i = 0; i <= 32; ++i) {
    double angle = (double(i) / 32) * kPi / 2;
    points.push_back(localToWorld(element, {radius * std::cos(angle) / element.width,
                                            radius * std::sin(angle) / element.height}));
  }
  return points;
}

double roadStrokeWidth(const TrackElement &element) {
  return element.roadWidth > 0 ? element.roadWidth
                               : std::min(element.width, element.height) * 0.6;
}

std::vector<std::pair<Vec2, Vec2>> roadKerbDashes(const std::vector<Vec2> &points,
                                                   double dashLength) {
  std::vector<std::pair<Vec2, Vec2>> dashes;
  double travelled = 0;
  for (size_t i = 1; i < points.size(); ++i) {
    Vec2 start = points[i - 1], end = points[i];
    double len = distance(start, end);
    double offset = 0;
    while (offset < len) {
      double phase = std::floor((travelled + 0.000001) / dashLength);
      double step = std::min(len - offset, (phase + 1) * dashLength - travelled);
      if (static_cast<long long>(phase) % 2 == 0) {
        auto at = [&](double d) { return start + (end - start) * (d / len); };
        dashes.emplace_back(at(offset), at(offset + step));
      }
      offset += step;
      travelled += step;
    }
  }
  return dashes;
}

namespace {

bool wallInterval(const Vec2 &origin, const Vec2 &direction, const TrackElement &wall, double &low,
                  double &high) {
  double dx = origin.x - wall.x - wall.width / 2;
  double dy = origin.y - wall.y - wall.height / 2;
  double c = std::cos(wall.rotation), s = std::sin(wall.rotation);
  double axes[2][3] = {{dx * c + dy * s, direction.x * c + direction.y * s, wall.width / 2},
                       {-dx * s + dy * c, -direction.x * s + direction.y * c, wall.height / 2}};
  low = -std::numeric_limits<double>::infinity();
  high = std::numeric_limits<double>::infinity();
  for (auto &axis : axes) {
    double position = axis[0], velocity = axis[1], half = axis[2];
    if (std::fabs(velocity) < 1e-10) {
      if (std::fabs(position) > half) return false;
    } else {
      double a = (-half - position) / velocity;
      double b = (half - position) / velocity;
      low = std::max(low, std::min(a, b));
      high = std::min(high, std::max(a, b));
      if (low > high) return false;
    }
  }
  return true;
}

double crossingTime(const Vec2 &previous, const Vec2 &current, const TrackElement &marker) {
  double cx = marker.x + marker.width / 2, cy = marker.y + marker.height / 2;
  double c = std::cos(marker.rotation), s = std::sin(marker.rotation);
  double beforeX = (previous.x - cx) * c + (previous.y - cy) * s;
  double beforeY = -(previous.x - cx) * s + (previous.y - cy) * c;
  double afterX = (current.x - cx) * c + (current.y - cy) * s;
  double afterY = -(current.x - cx) * s + (current.y - cy) * c;
  if (beforeY <= 0 || afterY > 0) return -1;
  double time = beforeY / (beforeY - afterY);
  double lateral = beforeX + (afterX - beforeX) * time;
  return std::fabs(lateral) <= marker.width / 2 + 1e-7 ? time : -1;
}

} // namespace

TrackElement effectiveRaceGate(const Track &track, const TrackElement &marker) {
  if (!marker.autoGateWidth) return marker;
  if (marker.type != ElementType::Finish && marker.type != ElementType::Checkpoint) return marker;
  Vec2 origin = marker.center();
  Vec2 direction{std::cos(marker.rotation), std::sin(marker.rotation)};
  double limit = marker.width / 2 + 150;
  double left = -std::numeric_limits<double>::infinity();
  double right = std::numeric_limits<double>::infinity();
  for (const auto &wall : track.elements) {
    if (!isWall(wall) || wall.layer != marker.layer) continue;
    double low, high;
    if (!wallInterval(origin, direction, wall, low, high)) continue;
    if (high < 0 && high >= -limit) left = std::max(left, high);
    if (low > 0 && low <= limit) right = std::min(right, low);
  }
  if (!std::isfinite(left) || !std::isfinite(right)) return marker;
  TrackElement out = marker;
  double width = right - left;
  double shift = (right + left) / 2;
  out.x = origin.x + direction.x * shift - width / 2;
  out.y = origin.y + direction.y * shift - marker.height / 2;
  out.width = width;
  return out;
}

double raceGateCrossing(const Track &track, const TrackElement &marker, const Vec2 &previous,
                        const Vec2 &current) {
  if (!track.wrapAround) return crossingTime(previous, current, marker);
  double earliest = -1;
  int minX = static_cast<int>(std::floor(std::min(previous.x, current.x) / track.width)) - 1;
  int maxX = static_cast<int>(std::floor(std::max(previous.x, current.x) / track.width)) + 1;
  int minY = static_cast<int>(std::floor(std::min(previous.y, current.y) / track.height)) - 1;
  int maxY = static_cast<int>(std::floor(std::max(previous.y, current.y) / track.height)) + 1;
  for (int tx = minX; tx <= maxX; ++tx) {
    for (int ty = minY; ty <= maxY; ++ty) {
      Vec2 offset{tx * track.width, ty * track.height};
      double time = crossingTime(previous - offset, current - offset, marker);
      if (time >= 0 && (earliest < 0 || time < earliest)) earliest = time;
    }
  }
  return earliest;
}

Vec2 unwrapForTrack(const Vec2 &point, const Vec2 &reference, double width, double height) {
  return {point.x + std::round((reference.x - point.x) / width) * width,
          point.y + std::round((reference.y - point.y) / height) * height};
}

std::vector<GridSlot> computeStartGrid(const Track &track, int count) {
  const double carW = 30, carH = 50;
  const double minRow = carH + 30;
  const double minSlot = std::hypot(carW, carH) + 4;
  std::vector<const TrackElement *> spawns;
  const TrackElement *finish = nullptr;
  for (const auto &e : track.elements) {
    if (e.type == ElementType::Spawn) spawns.push_back(&e);
    if (e.type == ElementType::Finish && !finish) finish = &e;
  }
  if (count <= 0 || spawns.empty()) return {};
  Vec2 reference = forwardOf(finish ? finish->rotation : spawns[0]->rotation);
  struct Indexed {
    GridSlot slot;
    size_t index;
  };
  std::vector<Indexed> indexed;
  for (size_t i = 0; i < spawns.size(); ++i)
    indexed.push_back({{spawns[i]->center(), spawns[i]->rotation}, i});
  auto ahead = [&](const GridSlot &s) { return dot(s.position, reference); };
  std::stable_sort(indexed.begin(), indexed.end(), [&](const Indexed &a, const Indexed &b) {
    double difference = ahead(b.slot) - ahead(a.slot);
    if (std::fabs(difference) > 1) return difference < 0;
    return a.index < b.index;
  });
  std::vector<GridSlot> slots;
  for (auto &i : indexed) slots.push_back(i.slot);
  size_t columns = std::min<size_t>(2, slots.size());
  double rowSpacing = minRow;
  if (slots.size() > columns)
    rowSpacing = std::max(minRow, distance(slots[columns].position, slots[0].position));
  while (static_cast<int>(slots.size()) < count) {
    GridSlot base = slots[slots.size() - columns];
    Vec2 back = forwardOf(base.rotation);
    double dist = rowSpacing;
    GridSlot candidate;
    bool overlapping;
    do {
      candidate = {base.position - back * dist, base.rotation};
      dist += minRow / 2;
      overlapping = false;
      for (auto &s : slots)
        if (distance(s.position, candidate.position) < minSlot) overlapping = true;
    } while (overlapping);
    slots.push_back(candidate);
  }
  slots.resize(count);
  return slots;
}

bool RoadSurfaceIndex::Surface::contains(const Vec2 &p) const {
  if (segment) return distanceToSegment(p, a, b) <= radius;
  double dx = p.x - center.x, dy = p.y - center.y;
  return std::fabs(dx * cosine + dy * sine) <= halfW && std::fabs(-dx * sine + dy * cosine) <= halfH;
}

RoadSurfaceIndex::RoadSurfaceIndex(const Track &track) : track_(track) {
  auto add = [&](const Surface &s, double minX, double minY, double maxX, double maxY) {
    int index = static_cast<int>(surfaces_.size());
    surfaces_.push_back(s);
    for (int64_t x = static_cast<int64_t>(std::floor(minX / cellSize_));
         x <= static_cast<int64_t>(std::floor(maxX / cellSize_)); ++x)
      for (int64_t y = static_cast<int64_t>(std::floor(minY / cellSize_));
           y <= static_cast<int64_t>(std::floor(maxY / cellSize_)); ++y)
        cells_[cellKey(x, y)].push_back(index);
  };
  for (const auto &e : track.elements) {
    if (e.type == ElementType::RoadCurve) {
      auto points = sampleRoadCurve(e);
      double radius = roadStrokeWidth(e) / 2;
      for (size_t i = 1; i < points.size(); ++i) {
        Surface s;
        s.layer = e.layer;
        s.segment = true;
        s.a = points[i - 1];
        s.b = points[i];
        s.radius = radius;
        add(s, std::min(s.a.x, s.b.x) - radius, std::min(s.a.y, s.b.y) - radius,
            std::max(s.a.x, s.b.x) + radius, std::max(s.a.y, s.b.y) + radius);
      }
    } else if (e.type == ElementType::Road || e.type == ElementType::Bridge ||
               e.type == ElementType::Ramp) {
      Surface s;
      s.layer = e.layer;
      s.center = e.center();
      s.halfW = e.width / 2;
      s.halfH = e.height / 2;
      s.cosine = std::cos(e.rotation);
      s.sine = std::sin(e.rotation);
      Vec2 corners[4] = {localToWorld(e, {0, 0}), localToWorld(e, {1, 0}),
                         localToWorld(e, {1, 1}), localToWorld(e, {0, 1})};
      double minX = corners[0].x, maxX = minX, minY = corners[0].y, maxY = minY;
      for (auto &c : corners) {
        minX = std::min(minX, c.x);
        maxX = std::max(maxX, c.x);
        minY = std::min(minY, c.y);
        maxY = std::max(maxY, c.y);
      }
      add(s, minX, minY, maxX, maxY);
    }
  }
}

bool RoadSurfaceIndex::isAsphalt(const Vec2 &position, int layer) const {
  double w = track_.width, h = track_.height;
  bool wrap = track_.wrapAround;
  double x = wrap ? positiveMod(position.x, w) : position.x;
  double y = wrap ? positiveMod(position.y, h) : position.y;
  int range = wrap ? 1 : 0;
  for (int tx = -range; tx <= range; ++tx) {
    for (int ty = -range; ty <= range; ++ty) {
      Vec2 p{x + tx * w, y + ty * h};
      auto it = cells_.find(cellKey(static_cast<int64_t>(std::floor(p.x / cellSize_)),
                                    static_cast<int64_t>(std::floor(p.y / cellSize_))));
      if (it == cells_.end()) continue;
      for (int index : it->second) {
        const Surface &s = surfaces_[index];
        if (s.layer == layer && s.contains(p)) return true;
      }
    }
  }
  return false;
}

WallIndex::WallIndex(const Track &track) : track_(track) {
  for (const auto &e : track.elements) {
    if (!isWall(e)) continue;
    Obb obb{e.center(), e.width / 2, e.height / 2, e.rotation};
    double c = std::fabs(std::cos(e.rotation)), s = std::fabs(std::sin(e.rotation));
    double hx = obb.halfW * c + obb.halfH * s, hy = obb.halfW * s + obb.halfH * c;
    int index = static_cast<int>(walls_.size());
    walls_.push_back(obb);
    radius_.push_back(std::hypot(obb.halfW, obb.halfH));
    for (int64_t x = static_cast<int64_t>(std::floor((obb.center.x - hx) / cellSize_));
         x <= static_cast<int64_t>(std::floor((obb.center.x + hx) / cellSize_)); ++x)
      for (int64_t y = static_cast<int64_t>(std::floor((obb.center.y - hy) / cellSize_));
           y <= static_cast<int64_t>(std::floor((obb.center.y + hy) / cellSize_)); ++y)
        cells_[cellKey(x, y)].push_back(index);
  }
}

void WallIndex::query(const Vec2 &center, double radius,
                      std::vector<std::pair<uint32_t, Obb>> &out) const {
  out.clear();
  if (walls_.empty()) return;
  auto scan = [&](const Vec2 &local, const Vec2 &offset, uint32_t tile) {
    int64_t x0 = static_cast<int64_t>(std::floor((local.x - radius) / cellSize_));
    int64_t x1 = static_cast<int64_t>(std::floor((local.x + radius) / cellSize_));
    int64_t y0 = static_cast<int64_t>(std::floor((local.y - radius) / cellSize_));
    int64_t y1 = static_cast<int64_t>(std::floor((local.y + radius) / cellSize_));
    size_t first = out.size();
    for (int64_t x = x0; x <= x1; ++x) {
      for (int64_t y = y0; y <= y1; ++y) {
        auto it = cells_.find(cellKey(x, y));
        if (it == cells_.end()) continue;
        for (int index : it->second) {
          const Obb &w = walls_[index];
          if (distance(w.center, local) > radius + radius_[index]) continue;
          uint32_t key = (static_cast<uint32_t>(index) << 8) | tile;
          bool seen = false;
          for (size_t i = first; i < out.size(); ++i)
            if (out[i].first == key) seen = true;
          if (seen) continue;
          Obb copy = w;
          copy.center += offset;
          out.emplace_back(key, copy);
        }
      }
    }
  };
  if (!track_.wrapAround) {
    scan(center, {0, 0}, 0);
  } else {
    double w = track_.width, h = track_.height;
    double tx = std::floor(center.x / w), ty = std::floor(center.y / h);
    // Walls of the neighbouring repeated tiles are reached by shifting the query point.
    for (int dx = -1; dx <= 1; ++dx) {
      for (int dy = -1; dy <= 1; ++dy) {
        Vec2 offset{(tx + dx) * w, (ty + dy) * h};
        uint32_t tile = ((static_cast<uint32_t>(static_cast<int64_t>(tx) + dx) & 15u) << 4) |
                        (static_cast<uint32_t>(static_cast<int64_t>(ty) + dy) & 15u);
        scan(center - offset, offset, tile);
      }
    }
  }
  std::sort(out.begin(), out.end(),
            [](const auto &a, const auto &b) { return a.first < b.first; });
}

} // namespace cg
