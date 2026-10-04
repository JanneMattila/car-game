import { Vector2 } from '../types/physics';
import { Track, TrackElement } from '../types/track';

function wallInterval(origin: Vector2, direction: Vector2, wall: TrackElement) {
  const dx = origin.x - wall.x - wall.width / 2;
  const dy = origin.y - wall.y - wall.height / 2;
  const cosine = Math.cos(wall.rotation);
  const sine = Math.sin(wall.rotation);
  const axes: [number, number, number][] = [
    [dx * cosine + dy * sine, direction.x * cosine + direction.y * sine, wall.width / 2],
    [-dx * sine + dy * cosine, -direction.x * sine + direction.y * cosine, wall.height / 2],
  ];
  let low = -Infinity;
  let high = Infinity;
  for (const [position, velocity, halfSize] of axes) {
    if (Math.abs(velocity) < 1e-10) {
      if (Math.abs(position) > halfSize) return null;
    } else {
      const a = (-halfSize - position) / velocity;
      const b = (halfSize - position) / velocity;
      low = Math.max(low, Math.min(a, b));
      high = Math.min(high, Math.max(a, b));
      if (low > high) return null;
    }
  }
  return { low, high };
}

/** Nearby barrier faces define the entire legal corridor, including grass/runoff. */
export function fitRaceGate(track: Track, marker: TrackElement): TrackElement {
  if (marker.type !== 'finish' && marker.type !== 'checkpoint') return marker;
  const origin = { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 };
  const direction = { x: Math.cos(marker.rotation), y: Math.sin(marker.rotation) };
  const limit = marker.width / 2 + 150;
  let left = -Infinity;
  let right = Infinity;
  for (const wall of track.elements) {
    if (
      (wall.type !== 'wall' && wall.type !== 'barrier') ||
      (wall.layer ?? 0) !== (marker.layer ?? 0)
    )
      continue;
    const interval = wallInterval(origin, direction, wall);
    if (!interval) continue;
    if (interval.high < 0 && interval.high >= -limit) left = Math.max(left, interval.high);
    if (interval.low > 0 && interval.low <= limit) right = Math.min(right, interval.low);
  }
  if (!Number.isFinite(left) || !Number.isFinite(right)) return marker;
  const width = right - left;
  const shift = (right + left) / 2;
  const x = origin.x + direction.x * shift - width / 2;
  const y = origin.y + direction.y * shift - marker.height / 2;
  return { ...marker, x, y, position: { x, y }, width };
}

export function effectiveRaceGate(track: Track, marker: TrackElement): TrackElement {
  return marker.properties?.autoGateWidth === false ? marker : fitRaceGate(track, marker);
}

function crossingTime(previous: Vector2, current: Vector2, marker: TrackElement): number | null {
  const centerX = marker.x + marker.width / 2;
  const centerY = marker.y + marker.height / 2;
  const cosine = Math.cos(marker.rotation);
  const sine = Math.sin(marker.rotation);
  const beforeX = (previous.x - centerX) * cosine + (previous.y - centerY) * sine;
  const beforeY = -(previous.x - centerX) * sine + (previous.y - centerY) * cosine;
  const afterX = (current.x - centerX) * cosine + (current.y - centerY) * sine;
  const afterY = -(current.x - centerX) * sine + (current.y - centerY) * cosine;
  if (beforeY <= 0 || afterY > 0) return null;
  const time = beforeY / (beforeY - afterY);
  const lateral = beforeX + (afterX - beforeX) * time;
  return Math.abs(lateral) <= marker.width / 2 + 1e-7 ? time : null;
}

/** Cross the center plane in the marker's forward (-local Y) direction. */
export function raceGateCrossing(
  track: Track,
  marker: TrackElement,
  previous: Vector2,
  current: Vector2
): number | null {
  if (!track.wrapAround) return crossingTime(previous, current, marker);
  let earliest: number | null = null;
  const minX = Math.floor(Math.min(previous.x, current.x) / track.width) - 1;
  const maxX = Math.floor(Math.max(previous.x, current.x) / track.width) + 1;
  const minY = Math.floor(Math.min(previous.y, current.y) / track.height) - 1;
  const maxY = Math.floor(Math.max(previous.y, current.y) / track.height) + 1;
  for (let tileX = minX; tileX <= maxX; tileX++) {
    for (let tileY = minY; tileY <= maxY; tileY++) {
      const offsetX = tileX * track.width;
      const offsetY = tileY * track.height;
      const time = crossingTime(
        { x: previous.x - offsetX, y: previous.y - offsetY },
        { x: current.x - offsetX, y: current.y - offsetY },
        marker
      );
      if (time !== null && (earliest === null || time < earliest)) earliest = time;
    }
  }
  return earliest;
}
