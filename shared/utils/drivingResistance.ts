import Matter from 'matter-js';
import { PHYSICS_CONSTANTS } from '../constants/physics';
import { Vector2 } from '../types/physics';
import { Track } from '../types/track';
import { roadSurfaces } from './roadSurfaces';

type Surface = {
  layer: number;
  contains: (point: Vector2) => boolean;
};

export class RoadSurfaceIndex {
  private cells = new Map<string, Surface[]>();
  private cellSize = 256;

  constructor(private track: Track) {
    for (const surface of roadSurfaces(track)) {
      this.add(surface, surface.minX, surface.minY, surface.maxX, surface.maxY);
    }
  }

  private add(surface: Surface, minX: number, minY: number, maxX: number, maxY: number) {
    for (let x = Math.floor(minX / this.cellSize); x <= Math.floor(maxX / this.cellSize); x++) {
      for (let y = Math.floor(minY / this.cellSize); y <= Math.floor(maxY / this.cellSize); y++) {
        const key = `${x}:${y}`;
        const cell = this.cells.get(key);
        if (cell) cell.push(surface);
        else this.cells.set(key, [surface]);
      }
    }
  }

  isAsphalt(position: Vector2, layer = 0): boolean {
    const { width, height, wrapAround } = this.track;
    const x = wrapAround ? ((position.x % width) + width) % width : position.x;
    const y = wrapAround ? ((position.y % height) + height) % height : position.y;
    const offsets = wrapAround ? [-1, 0, 1] : [0];
    for (const tx of offsets) {
      for (const ty of offsets) {
        const point = { x: x + tx * width, y: y + ty * height };
        const key = `${Math.floor(point.x / this.cellSize)}:${Math.floor(point.y / this.cellSize)}`;
        if (
          this.cells.get(key)?.some(surface => surface.layer === layer && surface.contains(point))
        ) {
          return true;
        }
      }
    }
    return false;
  }
}

export function drivingResistance(onAsphalt: boolean, contactForceScale = 1) {
  return {
    forceScale: (onAsphalt ? 1 : PHYSICS_CONSTANTS.OFFROAD_FORCE_MULTIPLIER) * contactForceScale,
    speedScale: onAsphalt ? 1 : PHYSICS_CONSTANTS.OFFROAD_SPEED_MULTIPLIER,
    rollingResistance:
      PHYSICS_CONSTANTS.ROLLING_RESISTANCE +
      (onAsphalt ? 0 : PHYSICS_CONSTANTS.OFFROAD_ROLLING_RESISTANCE),
  };
}

export class CollisionResistance {
  private pairs = new Set<string>();
  private bodies = new Set<Matter.Body>();

  forceScale(body: Matter.Body): number {
    return this.bodies.has(body) ? PHYSICS_CONSTANTS.CONTACT_FORCE_MULTIPLIER : 1;
  }

  apply(engine: Matter.Engine): void {
    const pairs = new Set<string>();
    const bodies = new Set<Matter.Body>();
    const impacted = new Set<Matter.Body>();
    for (const pair of engine.pairs.list) {
      if (!pair.isActive) continue;
      pairs.add(pair.id);
      for (const body of [pair.bodyA, pair.bodyB]) {
        if (body.isStatic || body.label !== 'car') continue;
        bodies.add(body);
        if (!this.pairs.has(pair.id)) impacted.add(body);
      }
    }
    // A barrier seam can produce several pairs; apply the impact loss only once per car.
    for (const body of impacted) {
      Matter.Body.setVelocity(body, {
        x: body.velocity.x * PHYSICS_CONSTANTS.COLLISION_SPEED_RETENTION,
        y: body.velocity.y * PHYSICS_CONSTANTS.COLLISION_SPEED_RETENTION,
      });
    }
    this.pairs = pairs;
    this.bodies = bodies;
  }

  reset(): void {
    this.pairs.clear();
    this.bodies.clear();
  }
}
