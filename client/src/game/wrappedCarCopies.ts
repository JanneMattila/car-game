import type { Vector2 } from '@shared';

interface Size {
  width: number;
  height: number;
}

export interface CarCopy extends Vector2 {
  key: string;
}

export function getVisibleCarCopies(
  position: Vector2,
  camera: Vector2,
  viewport: Size,
  track: Size
): CarCopy[] {
  // Include the rotated car and nickname before either enters the viewport.
  const padding = 128;
  const minX = Math.ceil((camera.x - viewport.width / 2 - padding - position.x) / track.width);
  const maxX = Math.floor((camera.x + viewport.width / 2 + padding - position.x) / track.width);
  const minY = Math.ceil((camera.y - viewport.height / 2 - padding - position.y) / track.height);
  const maxY = Math.floor((camera.y + viewport.height / 2 + padding - position.y) / track.height);
  const copies: CarCopy[] = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      copies.push({
        key: `${x}:${y}`,
        x: position.x + x * track.width,
        y: position.y + y * track.height,
      });
    }
  }
  return copies;
}
