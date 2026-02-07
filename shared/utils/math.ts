// Math utilities

import { Vector2 } from '../types/physics';

export function vec2(x: number = 0, y: number = 0): Vector2 {
  return { x, y };
}

export function vec2Add(a: Vector2, b: Vector2): Vector2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function vec2Sub(a: Vector2, b: Vector2): Vector2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function vec2Scale(v: Vector2, s: number): Vector2 {
  return { x: v.x * s, y: v.y * s };
}

export function vec2Length(v: Vector2): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

export function vec2LengthSq(v: Vector2): number {
  return v.x * v.x + v.y * v.y;
}

export function vec2Normalize(v: Vector2): Vector2 {
  const len = vec2Length(v);
  if (len === 0) return { x: 0, y: 0 };
  return { x: v.x / len, y: v.y / len };
}

export function vec2Dot(a: Vector2, b: Vector2): number {
  return a.x * b.x + a.y * b.y;
}

export function vec2Cross(a: Vector2, b: Vector2): number {
  return a.x * b.y - a.y * b.x;
}

export function vec2Rotate(v: Vector2, angle: number): Vector2 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: v.x * cos - v.y * sin,
    y: v.x * sin + v.y * cos,
  };
}

export function vec2Lerp(a: Vector2, b: Vector2, t: number): Vector2 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

export function vec2Distance(a: Vector2, b: Vector2): number {
  return vec2Length(vec2Sub(a, b));
}

export function vec2DistanceSq(a: Vector2, b: Vector2): number {
  return vec2LengthSq(vec2Sub(a, b));
}

export function vec2Clone(v: Vector2): Vector2 {
  return { x: v.x, y: v.y };
}

export function vec2FromAngle(angle: number): Vector2 {
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

export function vec2ToAngle(v: Vector2): number {
  return Math.atan2(v.y, v.x);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

export function lerpAngle(a: number, b: number, t: number): number {
  let diff = normalizeAngle(b - a);
  return a + diff * t;
}

export function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function randomInt(min: number, max: number): number {
  return Math.floor(randomRange(min, max + 1));
}

export function pointInPolygon(point: Vector2, polygon: Vector2[]): boolean {
  let inside = false;
  const n = polygon.length;
  
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = polygon[i]!;
    const pj = polygon[j]!;
    
    if (
      pi.y > point.y !== pj.y > point.y &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x
    ) {
      inside = !inside;
    }
  }
  
  return inside;
}

export function lineIntersection(
  p1: Vector2,
  p2: Vector2,
  p3: Vector2,
  p4: Vector2
): Vector2 | null {
  const d1 = vec2Sub(p2, p1);
  const d2 = vec2Sub(p4, p3);
  const d3 = vec2Sub(p1, p3);
  
  const cross = vec2Cross(d1, d2);
  if (Math.abs(cross) < 0.0001) return null;
  
  const t = vec2Cross(d2, d3) / cross;
  const u = vec2Cross(d1, d3) / cross;
  
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return vec2Add(p1, vec2Scale(d1, t));
  }
  
  return null;
}

export function distanceToLine(point: Vector2, lineStart: Vector2, lineEnd: Vector2): number {
  const line = vec2Sub(lineEnd, lineStart);
  const len = vec2Length(line);
  if (len === 0) return vec2Distance(point, lineStart);
  
  const t = Math.max(0, Math.min(1, vec2Dot(vec2Sub(point, lineStart), line) / (len * len)));
  const projection = vec2Add(lineStart, vec2Scale(line, t));
  return vec2Distance(point, projection);
}

export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function generateRoomCode(length: number = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}
