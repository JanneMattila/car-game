import { Vector2 } from '../types/physics';
import { Track, TrackElement } from '../types/track';
import { effectiveRaceGate } from './raceGates';
import { boundsOverlap, polygonBounds, roadSurfaces } from './roadSurfaces';

export interface FinishMarking {
  white: boolean;
  points: Vector2[];
}

const cache = new WeakMap<Track, WeakMap<TrackElement, FinishMarking[]>>();

function clipPolygon(subject: Vector2[], clip: Vector2[]): Vector2[] {
  let result = subject;
  for (let i = 0; i < clip.length && result.length; i++) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    const tolerance = Math.hypot(b.x - a.x, b.y - a.y) * 1e-8;
    const side = (p: Vector2) => {
      const distance = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      return Math.abs(distance) <= tolerance ? 0 : distance;
    };
    const input = result;
    result = [];
    let previous = input[input.length - 1]!;
    let before = side(previous);
    for (const current of input) {
      const after = side(current);
      if (before >= 0 !== after >= 0) {
        const t = before / (before - after);
        result.push({
          x: previous.x + (current.x - previous.x) * t,
          y: previous.y + (current.y - previous.y) * t,
        });
      }
      if (after >= 0) result.push(current);
      previous = current;
      before = after;
    }
  }
  const points = result.filter((p, i) => {
    const previous = result[(i + result.length - 1) % result.length]!;
    return Math.hypot(p.x - previous.x, p.y - previous.y) > 1e-8;
  });
  if (points.length < 3) return [];
  const origin = points[0]!;
  const area = points.reduce((sum, p, i) => {
    const next = points[(i + 1) % points.length]!;
    return sum + (p.x - origin.x) * (next.y - origin.y) - (p.y - origin.y) * (next.x - origin.x);
  }, 0);
  return Math.abs(area) > 1e-8 ? points : [];
}

/** Materializing a fitted gate must not move or resize its visible markings. */
export function preserveFinishMarkings(original: TrackElement, fitted: TrackElement): TrackElement {
  if (original.type !== 'finish') return fitted;
  const dx = fitted.x + fitted.width / 2 - original.x - original.width / 2;
  const dy = fitted.y + fitted.height / 2 - original.y - original.height / 2;
  return {
    ...fitted,
    properties: {
      ...fitted.properties,
      finishVisibleWidth: original.properties?.finishVisibleWidth ?? original.width,
      finishVisibleOffset:
        (original.properties?.finishVisibleOffset ?? 0) -
        dx * Math.cos(original.rotation) -
        dy * Math.sin(original.rotation),
    },
  };
}

/** World-coordinate checkerboard polygons, clipped to asphalt and the detection gate. */
export function finishMarkings(track: Track, marker: TrackElement): FinishMarking[] {
  let trackCache = cache.get(track);
  if (!trackCache) {
    trackCache = new WeakMap();
    cache.set(track, trackCache);
  }
  const cached = trackCache.get(marker);
  if (cached) return cached;
  const width = marker.properties?.finishVisibleWidth ?? marker.width;
  const offset = marker.properties?.finishVisibleOffset ?? 0;
  if (!Number.isFinite(width) || width < 0 || !Number.isFinite(offset)) {
    throw new RangeError(`Invalid finish markings for ${marker.id}`);
  }
  const gate = effectiveRaceGate(track, marker);
  const cosine = Math.cos(marker.rotation);
  const sine = Math.sin(marker.rotation);
  const cx = marker.x + marker.width / 2;
  const cy = marker.y + marker.height / 2;
  const world = (x: number, y: number): Vector2 => ({
    x: cx + x * cosine - y * sine,
    y: cy + x * sine + y * cosine,
  });
  const rectangle = (left: number, top: number, right: number, bottom: number) => [
    world(left, top),
    world(right, top),
    world(right, bottom),
    world(left, bottom),
  ];
  const gateShift =
    (gate.x + gate.width / 2 - cx) * cosine + (gate.y + gate.height / 2 - cy) * sine;
  const left = Math.max(offset - width / 2, gateShift - gate.width / 2);
  const right = Math.min(offset + width / 2, gateShift + gate.width / 2);
  const markings: FinishMarking[] = [];
  if (width > 0 && right > left) {
    const bounds = polygonBounds(rectangle(left, -marker.height / 2, right, marker.height / 2));
    const offsets = track.wrapAround ? [-1, 0, 1] : [0];
    const polygons: Vector2[][] = [];
    for (const surface of roadSurfaces(track)) {
      if (surface.layer !== (marker.layer ?? 0)) continue;
      for (const tx of offsets) {
        for (const ty of offsets) {
          const dx = tx * track.width;
          const dy = ty * track.height;
          if (
            boundsOverlap(bounds, {
              minX: surface.minX + dx,
              maxX: surface.maxX + dx,
              minY: surface.minY + dy,
              maxY: surface.maxY + dy,
            })
          )
            polygons.push(surface.polygon().map(p => ({ x: p.x + dx, y: p.y + dy })));
        }
      }
    }
    // Iterate only the gate intersection, even when an authored marking is very wide.
    const firstColumn = Math.floor((left - offset + width / 2) / 10);
    const lastColumn = Math.ceil((right - offset + width / 2) / 10);
    for (let column = firstColumn; column < lastColumn; column++) {
      const x = offset - width / 2 + column * 10;
      for (let row = 0; row < Math.ceil(marker.height / 10); row++) {
        const y = -marker.height / 2 + row * 10;
        const cell = rectangle(
          Math.max(left, x),
          y,
          Math.min(right, x + 10),
          Math.min(marker.height / 2, y + 10)
        );
        const cellBounds = polygonBounds(cell);
        for (const polygon of polygons) {
          if (!boundsOverlap(cellBounds, polygonBounds(polygon))) continue;
          const points = clipPolygon(cell, polygon);
          if (points.length >= 3) markings.push({ white: (column + row) % 2 === 0, points });
        }
      }
    }
  }
  trackCache.set(marker, markings);
  return markings;
}
