#pragma once

#include <algorithm>
#include <cmath>

namespace cg {

constexpr double kPi = 3.14159265358979323846;

struct Vec2 {
  double x = 0;
  double y = 0;

  Vec2() = default;
  Vec2(double x_, double y_) : x(x_), y(y_) {}

  Vec2 operator+(const Vec2 &o) const { return {x + o.x, y + o.y}; }
  Vec2 operator-(const Vec2 &o) const { return {x - o.x, y - o.y}; }
  Vec2 operator*(double s) const { return {x * s, y * s}; }
  Vec2 operator/(double s) const { return {x / s, y / s}; }
  Vec2 operator-() const { return {-x, -y}; }
  Vec2 &operator+=(const Vec2 &o) {
    x += o.x;
    y += o.y;
    return *this;
  }
  Vec2 &operator-=(const Vec2 &o) {
    x -= o.x;
    y -= o.y;
    return *this;
  }
  Vec2 &operator*=(double s) {
    x *= s;
    y *= s;
    return *this;
  }
  bool operator==(const Vec2 &o) const { return x == o.x && y == o.y; }
  bool operator!=(const Vec2 &o) const { return !(*this == o); }
};

inline double dot(const Vec2 &a, const Vec2 &b) { return a.x * b.x + a.y * b.y; }
inline double cross(const Vec2 &a, const Vec2 &b) { return a.x * b.y - a.y * b.x; }
inline double length(const Vec2 &v) { return std::sqrt(v.x * v.x + v.y * v.y); }
inline double lengthSq(const Vec2 &v) { return v.x * v.x + v.y * v.y; }
inline double distance(const Vec2 &a, const Vec2 &b) { return length(a - b); }
inline Vec2 normalize(const Vec2 &v) {
  double l = length(v);
  return l > 0 ? v / l : Vec2{0, 0};
}
inline Vec2 rotate(const Vec2 &v, double angle) {
  double c = std::cos(angle), s = std::sin(angle);
  return {v.x * c - v.y * s, v.x * s + v.y * c};
}
// Car and gate forward direction for a rotation (0 = facing up / -Y).
inline Vec2 forwardOf(double rotation) { return {std::sin(rotation), -std::cos(rotation)}; }
inline double clampd(double v, double lo, double hi) { return std::max(lo, std::min(hi, v)); }
inline double lerp(double a, double b, double t) { return a + (b - a) * t; }
inline double wrapAngle(double a) {
  while (a > kPi) a -= 2 * kPi;
  while (a < -kPi) a += 2 * kPi;
  return a;
}
inline double positiveMod(double v, double m) {
  double r = std::fmod(v, m);
  return r < 0 ? r + m : r;
}

double distanceToSegment(const Vec2 &point, const Vec2 &a, const Vec2 &b);

} // namespace cg
