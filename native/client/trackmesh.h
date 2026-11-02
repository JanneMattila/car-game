#pragma once

#include <cmath>
#include <string>
#include <vector>

#include "../common/track.h"
#include "renderer.h"

namespace cgc {

using cg::Vec2;

// Local-to-world placement: rotate by `rotation`, scale, then translate to `origin`.
struct Frame {
  Vec2 origin;
  double rotation = 0;
  double scale = 1;
  double c = 1, s = 0;

  Frame() = default;
  Frame(const Vec2 &o, double rot, double sc = 1)
      : origin(o), rotation(rot), scale(sc), c(std::cos(rot)), s(std::sin(rot)) {}
  Vec2 apply(double x, double y) const {
    x *= scale;
    y *= scale;
    return {origin.x + x * c - y * s, origin.y + x * s + y * c};
  }
  // A child frame positioned at local (x, y) and rotated further by `rot`.
  Frame child(double x, double y, double rot) const {
    return Frame(apply(x, y), rotation + rot, scale);
  }
};

using Vertices = std::vector<Vertex>;

void addTriangle(Vertices &out, const Vec2 &a, const Vec2 &b, const Vec2 &c, uint32_t color);
void addQuad(Vertices &out, const Vec2 &a, const Vec2 &b, const Vec2 &c, const Vec2 &d,
             uint32_t color);
void addRect(Vertices &out, const Frame &f, double x, double y, double w, double h,
             uint32_t color);
void addRoundRect(Vertices &out, const Frame &f, double x, double y, double w, double h,
                  double radius, uint32_t color);
void addEllipse(Vertices &out, const Frame &f, double cx, double cy, double rx, double ry,
                uint32_t color);
void addSegment(Vertices &out, const Vec2 &a, const Vec2 &b, double width, uint32_t color);
// Thick polyline with bevel joins and optional round caps.
void addStroke(Vertices &out, const std::vector<Vec2> &points, double width, uint32_t color,
               bool roundCaps);
void addOutline(Vertices &out, const Frame &f, double x, double y, double w, double h,
                double thickness, uint32_t color);

struct CarLook {
  uint32_t color = hexColor(0xDC2626);
  double steer = 0; // -1..1, front wheel angle
  bool nitro = false;
  float alpha = 1;
};
// Car body matching the browser renderer (30 x 50, facing -Y at rotation 0).
void addCar(Vertices &out, const Vec2 &position, double angle, const CarLook &look);
void addCarGhost(Vertices &out, const Vec2 &position, double angle, uint32_t color);

struct TrackLabel {
  std::wstring text;
  Vec2 position;
  double rotation = 0;
  double scale = 1;
  bool big = false;
};

struct TrackMeshData {
  enum Layer { Background, Scenery, Kerbs, Surface, Markings, Walls, LayerCount };
  Vertices vertices;
  UINT start[LayerCount] = {};
  UINT count[LayerCount] = {};
  std::vector<TrackLabel> labels;
  uint32_t background = hexColor(0x1a1a2e);
};

TrackMeshData buildTrackMesh(const cg::Track &track);

std::wstring widen(const std::string &utf8);
std::string narrow(const std::wstring &wide);

} // namespace cgc
