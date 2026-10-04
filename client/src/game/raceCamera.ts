import { PHYSICS_CONSTANTS, Vector2 } from '@shared';

export interface RaceCamera {
  x: number;
  y: number;
  zoom: number;
  initialized: boolean;
}

export function createRaceCamera(): RaceCamera {
  return { x: 0, y: 0, zoom: 1, initialized: false };
}

export function cameraZoomForSpeed(speed: number): number {
  const fullZoomSpeed = PHYSICS_CONSTANTS.MAX_SPEED * 0.75;
  const t = Math.max(0, Math.min(1, (speed - 3) / (fullZoomSpeed - 3)));
  const smooth = t * t * (3 - 2 * t);
  return 1 - smooth * 0.45;
}

export function updateRaceCamera(
  camera: RaceCamera,
  position: Vector2,
  velocity: Vector2,
  deltaTime: number
): RaceCamera {
  const speed = Math.hypot(velocity.x, velocity.y);
  const targetZoom = cameraZoomForSpeed(speed);
  if (!camera.initialized) {
    return { x: position.x, y: position.y, zoom: 1, initialized: true };
  }
  const zoomBlend = 1 - Math.exp(-(targetZoom < camera.zoom ? 6 : 2) * deltaTime);
  return {
    x: position.x,
    y: position.y,
    zoom: camera.zoom + (targetZoom - camera.zoom) * zoomBlend,
    initialized: true,
  };
}
