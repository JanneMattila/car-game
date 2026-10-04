import { Vector2 } from '../types/physics';
import { Track } from '../types/track';
import { distanceToSegment, localToWorld, roadStrokeWidth, sampleRoadCurve } from './roadGeometry';

export interface SurfaceBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RoadSurface extends SurfaceBounds {
  layer: number;
  contains: (point: Vector2) => boolean;
  polygon: () => Vector2[];
}

export function polygonBounds(points: Vector2[]): SurfaceBounds {
  return {
    minX: Math.min(...points.map(p => p.x)),
    minY: Math.min(...points.map(p => p.y)),
    maxX: Math.max(...points.map(p => p.x)),
    maxY: Math.max(...points.map(p => p.y)),
  };
}

export function boundsOverlap(a: SurfaceBounds, b: SurfaceBounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** The same asphalt footprints serve driving resistance and finish clipping. */
export function roadSurfaces(track: Track): RoadSurface[] {
  const surfaces: RoadSurface[] = [];
  for (const element of track.elements) {
    const layer = element.layer ?? 0;
    if (element.type === 'road_curve') {
      const points = sampleRoadCurve(element);
      const radius = roadStrokeWidth(element) / 2;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!;
        const b = points[i]!;
        surfaces.push({
          layer,
          minX: Math.min(a.x, b.x) - radius,
          minY: Math.min(a.y, b.y) - radius,
          maxX: Math.max(a.x, b.x) + radius,
          maxY: Math.max(a.y, b.y) + radius,
          contains: point => distanceToSegment(point, a, b) <= radius,
          polygon: () => {
            const angle = Math.atan2(b.y - a.y, b.x - a.x);
            const polygon: Vector2[] = [];
            // Inscribed caps stay inside the asphalt, never in the kerbs or grass.
            for (const [center, start] of [
              [a, angle + Math.PI / 2],
              [b, angle - Math.PI / 2],
            ] as const) {
              for (let j = 0; j <= 24; j++) {
                const theta = start + (Math.PI * j) / 24;
                polygon.push({
                  x: center.x + radius * Math.cos(theta),
                  y: center.y + radius * Math.sin(theta),
                });
              }
            }
            return polygon;
          },
        });
      }
    } else if (['road', 'bridge', 'ramp', 'ramp_up', 'ramp_down'].includes(element.type)) {
      const corners = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ].map(point => localToWorld(element, point));
      const cosine = Math.cos(element.rotation);
      const sine = Math.sin(element.rotation);
      surfaces.push({
        layer,
        ...polygonBounds(corners),
        polygon: () => corners,
        contains: point => {
          const dx = point.x - element.x - element.width / 2;
          const dy = point.y - element.y - element.height / 2;
          return (
            Math.abs(dx * cosine + dy * sine) <= element.width / 2 &&
            Math.abs(-dx * sine + dy * cosine) <= element.height / 2
          );
        },
      });
    }
  }
  return surfaces;
}
