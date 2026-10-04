import { RoadBezier, TrackElement } from '../types/track';
import { Vector2 } from '../types/physics';

export type CurvePreset =
  | 'left45'
  | 'right45'
  | 'left90'
  | 'right90'
  | 'hairpinLeft'
  | 'hairpinRight'
  | 'esses'
  | 'custom';
export const CURVE_PRESETS: { id: CurvePreset; label: string }[] = [
  { id: 'left45', label: 'Left 45' },
  { id: 'right45', label: 'Right 45' },
  { id: 'left90', label: 'Left 90' },
  { id: 'right90', label: 'Right 90' },
  { id: 'hairpinLeft', label: 'Hairpin left' },
  { id: 'hairpinRight', label: 'Hairpin right' },
  { id: 'esses', label: 'S-bend' },
  { id: 'custom', label: 'Custom / straight' },
];

export function localToWorld(element: TrackElement, point: Vector2): Vector2 {
  const x = (point.x - 0.5) * element.width;
  const y = (point.y - 0.5) * element.height;
  const cos = Math.cos(element.rotation);
  const sin = Math.sin(element.rotation);
  return {
    x: element.x + element.width / 2 + x * cos - y * sin,
    y: element.y + element.height / 2 + x * sin + y * cos,
  };
}

export function getRoadBezier(element: TrackElement): RoadBezier | null {
  const curve = element.properties?.bezier;
  if (!curve) return null;
  return {
    start: localToWorld(element, curve.start),
    control1: localToWorld(element, curve.control1),
    control2: localToWorld(element, curve.control2),
    end: localToWorld(element, curve.end),
  };
}

export function bezierPoint(curve: RoadBezier, t: number): Vector2 {
  const u = 1 - t;
  return {
    x:
      u ** 3 * curve.start.x +
      3 * u ** 2 * t * curve.control1.x +
      3 * u * t ** 2 * curve.control2.x +
      t ** 3 * curve.end.x,
    y:
      u ** 3 * curve.start.y +
      3 * u ** 2 * t * curve.control1.y +
      3 * u * t ** 2 * curve.control2.y +
      t ** 3 * curve.end.y,
  };
}

export function bezierTangent(curve: RoadBezier, t: number): Vector2 {
  const u = 1 - t;
  return {
    x:
      3 * u ** 2 * (curve.control1.x - curve.start.x) +
      6 * u * t * (curve.control2.x - curve.control1.x) +
      3 * t ** 2 * (curve.end.x - curve.control2.x),
    y:
      3 * u ** 2 * (curve.control1.y - curve.start.y) +
      6 * u * t * (curve.control2.y - curve.control1.y) +
      3 * t ** 2 * (curve.end.y - curve.control2.y),
  };
}

export function createBezierRoad(
  id: string,
  curve: RoadBezier,
  roadWidth: number,
  layer = 0,
  kerbs = true
): TrackElement {
  const points = Object.values(curve);
  const padding = roadWidth / 2 + 16;
  const x = Math.min(...points.map(p => p.x)) - padding;
  const y = Math.min(...points.map(p => p.y)) - padding;
  const width = Math.max(...points.map(p => p.x)) - x + padding;
  const height = Math.max(...points.map(p => p.y)) - y + padding;
  const normalize = (p: Vector2) => ({ x: (p.x - x) / width, y: (p.y - y) / height });
  return {
    id,
    type: 'road_curve',
    x,
    y,
    position: { x, y },
    width,
    height,
    rotation: 0,
    layer,
    properties: {
      roadWidth,
      kerbs,
      bezier: {
        start: normalize(curve.start),
        control1: normalize(curve.control1),
        control2: normalize(curve.control2),
        end: normalize(curve.end),
      },
    },
  };
}

export function presetBezier(start: Vector2, end: Vector2, preset: CurvePreset): RoadBezier {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (preset === 'custom' || preset === 'esses') {
    const bend = preset === 'esses' ? 0.45 : 0;
    return {
      start,
      end,
      control1: { x: start.x + dx / 3 - dy * bend, y: start.y + dy / 3 + dx * bend },
      control2: { x: start.x + (2 * dx) / 3 + dy * bend, y: start.y + (2 * dy) / 3 - dx * bend },
    };
  }
  const sign = preset.includes('Left') || preset.startsWith('left') ? -1 : 1;
  const sweep =
    sign *
    (preset.startsWith('hairpin') ? Math.PI : preset.endsWith('45') ? Math.PI / 4 : Math.PI / 2);
  const heading = Math.atan2(dy, dx);
  const radius = Math.hypot(dx, dy) / (2 * Math.sin(Math.abs(sweep) / 2));
  const handle = (4 / 3) * Math.tan(Math.abs(sweep) / 4) * radius;
  return {
    start,
    end,
    control1: {
      x: start.x + Math.cos(heading - sweep / 2) * handle,
      y: start.y + Math.sin(heading - sweep / 2) * handle,
    },
    control2: {
      x: end.x - Math.cos(heading + sweep / 2) * handle,
      y: end.y - Math.sin(heading + sweep / 2) * handle,
    },
  };
}

export function sampleRoadCurve(element: TrackElement): Vector2[] {
  const curve = getRoadBezier(element);
  if (curve) {
    const polygon = [curve.start, curve.control1, curve.control2, curve.end];
    const length = polygon
      .slice(1)
      .reduce((sum, p, i) => sum + Math.hypot(p.x - polygon[i]!.x, p.y - polygon[i]!.y), 0);
    const steps = Math.min(512, Math.max(24, Math.ceil(length / 16)));
    return Array.from({ length: steps + 1 }, (_, i) => bezierPoint(curve, i / steps));
  }
  // Legacy quarter-circle geometry matches the original editor.
  const radius = Math.min(element.width, element.height) / 2;
  return Array.from({ length: 33 }, (_, i) => {
    const angle = ((i / 32) * Math.PI) / 2;
    return localToWorld(element, {
      x: (radius * Math.cos(angle)) / element.width,
      y: (radius * Math.sin(angle)) / element.height,
    });
  });
}

export function roadStrokeWidth(element: TrackElement): number {
  return element.properties?.roadWidth ?? Math.min(element.width, element.height) * 0.6;
}

export function roadKerbDashes(points: Vector2[], dashLength = 28): Vector2[][] {
  const dashes: Vector2[][] = [];
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1]!;
    const end = points[i]!;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    let offset = 0;
    while (offset < length) {
      const phase = Math.floor((travelled + 0.000001) / dashLength);
      const step = Math.min(length - offset, (phase + 1) * dashLength - travelled);
      if (phase % 2 === 0) {
        const point = (d: number) => ({
          x: start.x + ((end.x - start.x) * d) / length,
          y: start.y + ((end.y - start.y) * d) / length,
        });
        dashes.push([point(offset), point(offset + step)]);
      }
      offset += step;
      travelled += step;
    }
  }
  return dashes;
}

export function distanceToSegment(point: Vector2, start: Vector2, end: Vector2): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared)
        );
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
}

export function hitTestRoadCurve(point: Vector2, element: TrackElement, tolerance = 0): boolean {
  const points = sampleRoadCurve(element);
  return points
    .slice(1)
    .some(
      (p, i) => distanceToSegment(point, points[i]!, p) <= roadStrokeWidth(element) / 2 + tolerance
    );
}

export interface RoadEndpoint {
  point: Vector2;
  // Direction pointing away from the existing segment.
  outward: Vector2;
  elementId: string;
}

export function getRoadEndpoints(element: TrackElement): RoadEndpoint[] {
  if (element.type !== 'road' && element.type !== 'road_curve') return [];
  const curve = getRoadBezier(element);
  let start: Vector2;
  let end: Vector2;
  let startDirection: Vector2;
  let endDirection: Vector2;
  if (curve) {
    start = curve.start;
    end = curve.end;
    startDirection = { x: start.x - curve.control1.x, y: start.y - curve.control1.y };
    endDirection = { x: end.x - curve.control2.x, y: end.y - curve.control2.y };
  } else if (element.type === 'road_curve') {
    const points = sampleRoadCurve(element);
    start = points[0]!;
    end = points[points.length - 1]!;
    startDirection = { x: 0, y: -1 };
    endDirection = { x: -1, y: 0 };
    const rotate = (p: Vector2) => ({
      x: p.x * Math.cos(element.rotation) - p.y * Math.sin(element.rotation),
      y: p.x * Math.sin(element.rotation) + p.y * Math.cos(element.rotation),
    });
    startDirection = rotate(startDirection);
    endDirection = rotate(endDirection);
  } else {
    const horizontal = element.width >= element.height;
    start = localToWorld(element, horizontal ? { x: 0, y: 0.5 } : { x: 0.5, y: 0 });
    end = localToWorld(element, horizontal ? { x: 1, y: 0.5 } : { x: 0.5, y: 1 });
    startDirection = { x: start.x - end.x, y: start.y - end.y };
    endDirection = { x: -startDirection.x, y: -startDirection.y };
  }
  const unit = (p: Vector2) => {
    const length = Math.hypot(p.x, p.y);
    return length > 0 ? { x: p.x / length, y: p.y / length } : { x: 0, y: 0 };
  };
  return [
    { point: start, outward: unit(startDirection), elementId: element.id },
    { point: end, outward: unit(endDirection), elementId: element.id },
  ];
}

export function nearestRoadEndpoint(
  point: Vector2,
  elements: TrackElement[],
  threshold: number,
  excludeId?: string
): RoadEndpoint | null {
  let closest: RoadEndpoint | null = null;
  let distance = threshold;
  for (const element of elements) {
    if (element.id === excludeId) continue;
    for (const endpoint of getRoadEndpoints(element)) {
      const d = Math.hypot(point.x - endpoint.point.x, point.y - endpoint.point.y);
      if (d < distance) {
        distance = d;
        closest = endpoint;
      }
    }
  }
  return closest;
}

export function alignBezierEndpoint(
  curve: RoadBezier,
  endpoint: RoadEndpoint,
  atStart: boolean
): RoadBezier {
  const anchor = atStart ? 'start' : 'end';
  const control = atStart ? 'control1' : 'control2';
  const handle = Math.hypot(curve[control].x - curve[anchor].x, curve[control].y - curve[anchor].y);
  return {
    ...curve,
    [anchor]: { ...endpoint.point },
    [control]: {
      x: endpoint.point.x + endpoint.outward.x * handle,
      y: endpoint.point.y + endpoint.outward.y * handle,
    },
  };
}
