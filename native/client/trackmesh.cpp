#include "trackmesh.h"

#include <algorithm>

#include "../common/log.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

namespace cgc {

using namespace cg;

namespace {

Vertex vtx(const Vec2 &p, uint32_t color) {
  return {static_cast<float>(p.x), static_cast<float>(p.y), color};
}

int circleSegments(double radius) {
  return std::clamp(static_cast<int>(std::ceil(2 * kPi * radius / 6)), 12, 72);
}

void addFan(Vertices &out, const Vec2 &center, const Vec2 &from, const Vec2 &to, double radius,
            uint32_t color) {
  double a0 = std::atan2(from.y, from.x);
  double sweep = wrapAngle(std::atan2(to.y, to.x) - a0);
  int steps = std::max(1, static_cast<int>(std::ceil(std::fabs(sweep) / (kPi / 12))));
  Vec2 prev = center + from;
  for (int i = 1; i <= steps; ++i) {
    double a = a0 + sweep * i / steps;
    Vec2 next = center + Vec2{std::cos(a), std::sin(a)} * radius;
    addTriangle(out, center, prev, next, color);
    prev = next;
  }
}

} // namespace

void addTriangle(Vertices &out, const Vec2 &a, const Vec2 &b, const Vec2 &c, uint32_t color) {
  out.push_back(vtx(a, color));
  out.push_back(vtx(b, color));
  out.push_back(vtx(c, color));
}

void addQuad(Vertices &out, const Vec2 &a, const Vec2 &b, const Vec2 &c, const Vec2 &d,
             uint32_t color) {
  addTriangle(out, a, b, c, color);
  addTriangle(out, a, c, d, color);
}

void addRect(Vertices &out, const Frame &f, double x, double y, double w, double h,
             uint32_t color) {
  addQuad(out, f.apply(x, y), f.apply(x + w, y), f.apply(x + w, y + h), f.apply(x, y + h), color);
}

void addRoundRect(Vertices &out, const Frame &f, double x, double y, double w, double h,
                  double radius, uint32_t color) {
  radius = std::min({radius, w / 2, h / 2});
  if (radius <= 0.01) {
    addRect(out, f, x, y, w, h, color);
    return;
  }
  // Convex outline: four quarter arcs, then a triangle fan from the centre.
  std::vector<Vec2> ring;
  const int steps = 4;
  const double cx[4] = {x + w - radius, x + w - radius, x + radius, x + radius};
  const double cy[4] = {y + radius, y + h - radius, y + h - radius, y + radius};
  const double start[4] = {-kPi / 2, 0, kPi / 2, kPi};
  for (int corner = 0; corner < 4; ++corner)
    for (int i = 0; i <= steps; ++i) {
      double a = start[corner] + (kPi / 2) * i / steps;
      ring.push_back(f.apply(cx[corner] + std::cos(a) * radius, cy[corner] + std::sin(a) * radius));
    }
  Vec2 center = f.apply(x + w / 2, y + h / 2);
  for (size_t i = 0; i < ring.size(); ++i)
    addTriangle(out, center, ring[i], ring[(i + 1) % ring.size()], color);
}

void addEllipse(Vertices &out, const Frame &f, double cx, double cy, double rx, double ry,
                uint32_t color) {
  int n = circleSegments(std::max(rx, ry) * f.scale);
  Vec2 center = f.apply(cx, cy);
  Vec2 prev = f.apply(cx + rx, cy);
  for (int i = 1; i <= n; ++i) {
    double a = 2 * kPi * i / n;
    Vec2 next = f.apply(cx + std::cos(a) * rx, cy + std::sin(a) * ry);
    addTriangle(out, center, prev, next, color);
    prev = next;
  }
}

void addSegment(Vertices &out, const Vec2 &a, const Vec2 &b, double width, uint32_t color) {
  Vec2 d = b - a;
  double len = length(d);
  if (len < 1e-6) return;
  Vec2 n = Vec2{-d.y, d.x} * (width / 2 / len);
  addQuad(out, a + n, b + n, b - n, a - n, color);
}

void addStroke(Vertices &out, const std::vector<Vec2> &input, double width, uint32_t color,
               bool roundCaps) {
  std::vector<Vec2> pts;
  for (const Vec2 &p : input)
    if (pts.empty() || distance(pts.back(), p) > 0.01) pts.push_back(p);
  double h = width / 2;
  if (pts.size() == 1) {
    if (roundCaps) addEllipse(out, Frame(pts[0], 0), 0, 0, h, h, color);
    return;
  }
  std::vector<Vec2> normals;
  for (size_t i = 1; i < pts.size(); ++i) {
    Vec2 d = normalize(pts[i] - pts[i - 1]);
    Vec2 n{-d.y * h, d.x * h};
    normals.push_back(n);
    addQuad(out, pts[i - 1] + n, pts[i] + n, pts[i] - n, pts[i - 1] - n, color);
  }
  for (size_t i = 1; i + 1 < pts.size(); ++i) {
    addFan(out, pts[i], normals[i - 1], normals[i], h, color);
    addFan(out, pts[i], -normals[i - 1], -normals[i], h, color);
  }
  if (roundCaps) {
    addEllipse(out, Frame(pts.front(), 0), 0, 0, h, h, color);
    addEllipse(out, Frame(pts.back(), 0), 0, 0, h, h, color);
  }
}

void addOutline(Vertices &out, const Frame &f, double x, double y, double w, double h,
                double t, uint32_t color) {
  addRect(out, f, x, y, w, t, color);
  addRect(out, f, x, y + h - t, w, t, color);
  addRect(out, f, x, y + t, t, h - 2 * t, color);
  addRect(out, f, x + w - t, y + t, t, h - 2 * t, color);
}

void addCar(Vertices &out, const Vec2 &position, double angle, const CarLook &look) {
  Frame f(position, angle);
  float a = look.alpha;
  auto col = [&](uint32_t c) { return withAlpha(c, (((c >> 24) & 255) / 255.0f) * a); };
  addRoundRect(out, Frame(position + Vec2{3, 4}, angle), -15, -25, 30, 50, 5,
               col(rgba(0, 0, 0, 70)));
  if (look.nitro) {
    addTriangle(out, f.apply(-9, 24), f.apply(9, 24), f.apply(0, 46), col(hexColor(0xff7a1a, 220)));
    addTriangle(out, f.apply(-5, 24), f.apply(5, 24), f.apply(0, 36), col(hexColor(0xffe066, 240)));
  }
  addRoundRect(out, f, -15, -25, 30, 50, 5, col(look.color));
  addRoundRect(out, f, -10, -15, 20, 15, 3, col(hexColor(0x1a1a2e)));
  const uint32_t tyre = col(hexColor(0x1a1a1a));
  for (double side : {-15.0, 15.0}) {
    addRoundRect(out, f.child(side, 18, 0), -3, -5, 6, 10, 2, tyre);
    addRoundRect(out, f.child(side, -18, look.steer * 0.4), -3, -5, 6, 10, 2, tyre);
  }
  addEllipse(out, f, -8, -23, 3, 3, col(hexColor(0xffffcc)));
  addEllipse(out, f, 8, -23, 3, 3, col(hexColor(0xffffcc)));
  addRect(out, f, -12, 20, 6, 4, col(hexColor(0xff0000)));
  addRect(out, f, 6, 20, 6, 4, col(hexColor(0xff0000)));
}

void addCarGhost(Vertices &out, const Vec2 &position, double angle, uint32_t color) {
  Frame f(position, angle);
  addOutline(out, f, -15, -25, 30, 50, 2, color);
  addTriangle(out, f.apply(-6, -18), f.apply(6, -18), f.apply(0, -28), color);
}

namespace {

void addRoadCurveBase(Vertices &out, const TrackElement &e) {
  if (!e.kerbs) return;
  auto points = sampleRoadCurve(e);
  double w = roadStrokeWidth(e);
  addStroke(out, points, w + 24, hexColor(0xf4f1e9), true);
  for (const auto &dash : roadKerbDashes(points))
    addSegment(out, dash.first, dash.second, w + 24, hexColor(0xdf4349));
  addStroke(out, points, w + 4, hexColor(0xeceef1), true);
}

void addFinishMarkings(Vertices &out, const Track &track, const RoadSurfaceIndex &surfaces,
                       const TrackElement &marker) {
  TrackElement gate = effectiveRaceGate(track, marker);
  double c = std::cos(marker.rotation), s = std::sin(marker.rotation);
  Vec2 center = marker.center();
  Vec2 gateCenter = gate.center();
  double gateShift = (gateCenter.x - center.x) * c + (gateCenter.y - center.y) * s;
  double width = marker.width;
  double left = std::max(-width / 2, gateShift - gate.width / 2);
  double right = std::min(width / 2, gateShift + gate.width / 2);
  if (right <= left || marker.height <= 0) return;
  Frame f(center, marker.rotation);
  const double cell = 10;
  int firstColumn = static_cast<int>(std::floor((left + width / 2) / cell));
  int lastColumn = static_cast<int>(std::ceil((right + width / 2) / cell));
  int rows = static_cast<int>(std::ceil(marker.height / cell));
  for (int column = firstColumn; column < lastColumn; ++column) {
    double x = -width / 2 + column * cell;
    double x0 = std::max(left, x), x1 = std::min(right, x + cell);
    if (x1 <= x0) continue;
    for (int row = 0; row < rows; ++row) {
      double y0 = -marker.height / 2 + row * cell;
      double y1 = std::min(marker.height / 2, y0 + cell);
      Vec2 mid = f.apply((x0 + x1) / 2, (y0 + y1) / 2);
      if (!surfaces.isAsphalt(mid, marker.layer)) continue;
      uint32_t color = (column + row) % 2 == 0 ? hexColor(0xffffff) : hexColor(0x000000);
      addRect(out, f, x0, y0, x1 - x0, y1 - y0, color);
    }
  }
}

void addScenery(Vertices &out, const SceneryItem &item) {
  Frame f(item.position, item.rotation, item.scale);
  if (item.type == "tree") {
    addEllipse(out, f, 4, 6, 28, 28, hexColor(0x203f2b));
    addEllipse(out, f, 0, 0, 24, 24, hexColor(0x357343));
    addEllipse(out, f, -6, -6, 13, 13, hexColor(0x489655));
    return;
  }
  bool building = item.type == "building" || item.type == "grandstand";
  uint32_t defaultColor;
  if (item.type == "building") defaultColor = hexColor(0xbac7ce);
  else if (item.type == "grandstand") defaultColor = hexColor(0x7695ac);
  else if (item.type == "area") defaultColor = hexColor(0x879480);
  else if (item.type == "water") defaultColor = hexColor(0x287d99);
  else if (item.type == "sand") defaultColor = hexColor(0xd8c596);
  else if (item.type == "park") defaultColor = hexColor(0x628d57);
  else if (item.type == "runway") defaultColor = hexColor(0x343d46);
  else return;
  uint32_t color = item.color.empty() ? defaultColor : parseColor(item.color, defaultColor);
  double w = item.width > 0 ? item.width : 200;
  double h = item.height > 0 ? item.height : (building ? 60 : 200);
  addRect(out, f, -w / 2, -h / 2, w, h, building ? hexColor(0x263746) : color);
  if (building) {
    addRect(out, f, -w / 2 + 4, -h / 2 + 4, w - 8, h - 12, color);
    for (double y = -h / 2 + 12; y < h / 2 - 6; y += std::max(9.0, h / 10))
      addSegment(out, f.apply(-w / 2 + 6, y), f.apply(w / 2 - 6, y), 3 * item.scale,
                 hexColor(0x3d566a));
  } else if (item.type == "park") {
    addEllipse(out, f, 0, 0, w * 0.42, h * 0.42, hexColor(0x73985e));
  } else if (item.type == "runway") {
    for (double y = -h / 2 + 100; y < h / 2 - 100; y += 140)
      addSegment(out, f.apply(0, y), f.apply(0, y + 70), 8 * item.scale, hexColor(0xebeee6));
  }
}

} // namespace

TrackMeshData buildTrackMesh(const Track &track) {
  TrackMeshData mesh;
  mesh.background = parseColor(track.backgroundColor, hexColor(0x1a1a2e));
  Vertices layers[TrackMeshData::LayerCount];

  addRect(layers[TrackMeshData::Background], Frame(), 0, 0, track.width, track.height,
          mesh.background);

  for (const SceneryItem &item : track.scenery) {
    addScenery(layers[TrackMeshData::Scenery], item);
    if (!item.label.empty()) {
      TrackLabel label;
      label.text = widen(item.label);
      label.big = item.type == "label";
      label.position = item.position;
      label.rotation = item.rotation;
      label.scale = item.scale;
      mesh.labels.push_back(std::move(label));
    }
  }

  RoadSurfaceIndex surfaces(track);
  for (const TrackElement &e : track.elements) {
    Frame f(e.center(), e.rotation);
    double w = e.width > 0 ? e.width : 100, h = e.height > 0 ? e.height : 100;
    switch (e.type) {
    case ElementType::RoadCurve: {
      addRoadCurveBase(layers[TrackMeshData::Kerbs], e);
      addStroke(layers[TrackMeshData::Surface], sampleRoadCurve(e), roadStrokeWidth(e),
                e.hasBezier ? hexColor(0x444953) : hexColor(0x3a3a5e), true);
      break;
    }
    case ElementType::Road:
    case ElementType::Bridge:
      addRect(layers[TrackMeshData::Surface], f, -w / 2, -h / 2, w, h, hexColor(0x666699));
      break;
    case ElementType::Ramp:
      addRect(layers[TrackMeshData::Surface], f, -w / 2, -h / 2, w, h, hexColor(0x8B4513));
      break;
    case ElementType::Finish:
      addFinishMarkings(layers[TrackMeshData::Markings], track, surfaces, e);
      break;
    case ElementType::Wall:
    case ElementType::Barrier: {
      uint32_t fill = e.type == ElementType::Wall ? hexColor(0x666666) : hexColor(0x8B4513);
      auto &out = layers[TrackMeshData::Walls];
      addRect(out, f, -w / 2, -h / 2, w, h, fill);
      double border = std::min({1.5, w / 4, h / 4});
      if (border > 0.2) addOutline(out, f, -w / 2, -h / 2, w, h, border, mixColor(fill, rgba(0, 0, 0), 0.35f));
      break;
    }
    default: break;
    }
  }

  for (int i = 0; i < TrackMeshData::LayerCount; ++i) {
    mesh.start[i] = static_cast<UINT>(mesh.vertices.size());
    mesh.count[i] = static_cast<UINT>(layers[i].size());
    mesh.vertices.insert(mesh.vertices.end(), layers[i].begin(), layers[i].end());
  }
  CG_INFO("track mesh '%s': %zu vertices, %zu labels", track.name.c_str(), mesh.vertices.size(),
          mesh.labels.size());
  return mesh;
}

std::wstring widen(const std::string &utf8) {
  if (utf8.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), out.data(), n);
  return out;
}

std::string narrow(const std::wstring &wide) {
  if (wide.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), nullptr, 0,
                              nullptr, nullptr);
  std::string out(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), out.data(), n,
                      nullptr, nullptr);
  return out;
}

} // namespace cgc
