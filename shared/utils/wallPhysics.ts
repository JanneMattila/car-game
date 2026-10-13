import Matter from 'matter-js';
import { Track, TrackElement } from '../types/track';
import { Vector2 } from '../types/physics';
import { PHYSICS_CONSTANTS } from '../constants/physics';
import { CollisionResistance } from './drivingResistance';
import { CarState } from '../types/car';

export type PredictionOpponent = Pick<
  CarState,
  'playerId' | 'position' | 'rotation' | 'velocity' | 'angularVelocity'
>;

export interface WallMotionState {
  x: number;
  y: number;
  rotation: number;
  vx: number;
  vy: number;
  angularVelocity: number;
}

export function createVehicleBody(position: Vector2, rotation: number): Matter.Body {
  return Matter.Bodies.rectangle(
    position.x,
    position.y,
    PHYSICS_CONSTANTS.CAR_WIDTH,
    PHYSICS_CONSTANTS.CAR_HEIGHT,
    {
      angle: rotation,
      label: 'car',
      friction: 0.001,
      frictionAir: 0.01,
      density:
        PHYSICS_CONSTANTS.CAR_BODY_MASS /
        (PHYSICS_CONSTANTS.CAR_WIDTH * PHYSICS_CONSTANTS.CAR_HEIGHT),
      inertia: Infinity,
    }
  );
}

export function createTrackWall(element: TrackElement, offset: Vector2): Matter.Body {
  return Matter.Bodies.rectangle(
    element.x + element.width / 2 + offset.x,
    element.y + element.height / 2 + offset.y,
    element.width,
    element.height,
    {
      angle: element.rotation || 0,
      isStatic: true,
      label: 'wall',
      render: {
        fillStyle: element.type === 'barrier' ? '#8B4513' : '#666',
        strokeStyle: '#333',
        lineWidth: 2,
      },
    }
  );
}

// Prediction only needs the walls a car can reach within a few frames. Keeping the rest out of
// the Matter world makes each step (and each reconciliation replay) independent of track size.
const WALL_WINDOW_RADIUS = 600;
const WALL_WINDOW_REFRESH = 150;

interface WallBounds {
  element: TrackElement;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function wallBounds(element: TrackElement): WallBounds {
  const cosine = Math.abs(Math.cos(element.rotation || 0));
  const sine = Math.abs(Math.sin(element.rotation || 0));
  const halfX = (element.width * cosine + element.height * sine) / 2;
  const halfY = (element.width * sine + element.height * cosine) / 2;
  const cx = element.x + element.width / 2;
  const cy = element.y + element.height / 2;
  return { element, minX: cx - halfX, maxX: cx + halfX, minY: cy - halfY, maxY: cy + halfY };
}

// Opponents are kinematic: the server, not local prediction, owns their motion.
export class WallPredictionWorld {
  private engine = Matter.Engine.create({
    gravity: { x: 0, y: 0 },
    positionIterations: 6,
    velocityIterations: 4,
  });
  private body = createVehicleBody({ x: 0, y: 0 }, 0);
  private wallElements: WallBounds[];
  private walls = new Map<string, Matter.Body>();
  private windowCenter: Vector2 | null = null;
  private opponents = new Map<string, Matter.Body>();
  contacts = 0;
  carContacts = 0;
  private resistance = new CollisionResistance();

  get forceScale(): number {
    return this.resistance.forceScale(this.body);
  }

  constructor(private track: Track | null) {
    this.wallElements = (
      track?.elements.filter(el => el.type === 'wall' || el.type === 'barrier') ?? []
    ).map(wallBounds);
    // Kinematics have already applied air resistance before this collision step.
    this.body.frictionAir = 0;
    Matter.World.add(this.engine.world, this.body);
  }

  /** Number of wall bodies currently simulated around the car. */
  get activeWallCount(): number {
    return this.walls.size;
  }

  private updateTiles(position: Vector2): void {
    if (!this.track) return;
    if (
      this.windowCenter &&
      Math.hypot(position.x - this.windowCenter.x, position.y - this.windowCenter.y) <
        WALL_WINDOW_REFRESH
    ) {
      return;
    }
    this.windowCenter = { x: position.x, y: position.y };
    const { width, height, wrapAround } = this.track;
    const offsets: Vector2[] = [];
    if (!wrapAround) {
      offsets.push({ x: 0, y: 0 });
    } else {
      // Repeating terrain: consider the copies of the tile around the car.
      const tx = Math.floor(position.x / width);
      const ty = Math.floor(position.y / height);
      for (let x = tx - 1; x <= tx + 1; x++) {
        for (let y = ty - 1; y <= ty + 1; y++) offsets.push({ x: x * width, y: y * height });
      }
    }
    const needed = new Map<string, { element: TrackElement; offset: Vector2 }>();
    const minX = position.x - WALL_WINDOW_RADIUS;
    const maxX = position.x + WALL_WINDOW_RADIUS;
    const minY = position.y - WALL_WINDOW_RADIUS;
    const maxY = position.y + WALL_WINDOW_RADIUS;
    for (const offset of offsets) {
      this.wallElements.forEach((wall, index) => {
        if (
          wall.maxX + offset.x < minX ||
          wall.minX + offset.x > maxX ||
          wall.maxY + offset.y < minY ||
          wall.minY + offset.y > maxY
        ) {
          return;
        }
        needed.set(`${index}:${offset.x}:${offset.y}`, { element: wall.element, offset });
      });
    }
    for (const [key, { element, offset }] of needed) {
      if (this.walls.has(key)) continue;
      const wall = createTrackWall(element, offset);
      Matter.World.add(this.engine.world, wall);
      this.walls.set(key, wall);
    }
    for (const [key, wall] of this.walls) {
      if (needed.has(key)) continue;
      Matter.World.remove(this.engine.world, wall);
      this.walls.delete(key);
    }
  }

  setOpponents(cars: readonly PredictionOpponent[]): void {
    const ids = new Set<string>();
    for (const car of cars) {
      if (
        ![
          car.position.x,
          car.position.y,
          car.rotation,
          car.velocity.x,
          car.velocity.y,
          car.angularVelocity,
        ].every(Number.isFinite)
      ) {
        throw new Error(`Invalid prediction opponent motion: ${car.playerId}`);
      }
      ids.add(car.playerId);
      let body = this.opponents.get(car.playerId);
      if (!body) {
        body = createVehicleBody(car.position, car.rotation);
        Matter.Body.setStatic(body, true);
        body.label = 'opponent';
        this.opponents.set(car.playerId, body);
        Matter.World.add(this.engine.world, body);
      }
      Matter.Body.setPosition(body, car.position);
      Matter.Body.setAngle(body, car.rotation);
      Matter.Body.setVelocity(body, car.velocity);
      Matter.Body.setAngularVelocity(body, car.angularVelocity);
    }
    for (const [id, body] of this.opponents) {
      if (ids.has(id)) continue;
      Matter.World.remove(this.engine.world, body);
      this.opponents.delete(id);
    }
    if (this.opponents.size === 0) this.carContacts = 0;
  }

  // Interpolation and incoming corrections must not reintroduce visible penetration
  // between physics ticks. Query the same rotated hulls without advancing time.
  constrain<T extends WallMotionState>(state: T): T {
    if (this.opponents.size === 0) return state;
    Matter.Body.setPosition(this.body, state);
    Matter.Body.setAngle(this.body, state.rotation);
    const opponents = [...this.opponents.values()];
    if (Matter.Query.collides(this.body, opponents).length === 0) return state;
    this.updateTiles(state);
    const obstacles = [...opponents, ...this.walls.values()];
    for (let iteration = 0; iteration < 12; iteration++) {
      const collisions = Matter.Query.collides(this.body, obstacles);
      if (collisions.length === 0) break;
      for (const collision of collisions) {
        const sign = collision.bodyA === this.body ? 1 : -1;
        Matter.Body.translate(this.body, {
          x: collision.normal.x * sign * (collision.depth + 0.001),
          y: collision.normal.y * sign * (collision.depth + 0.001),
        });
      }
    }
    return { ...state, x: this.body.position.x, y: this.body.position.y };
  }

  resolve(previous: WallMotionState, next: WallMotionState): WallMotionState {
    this.updateTiles({ x: previous.x, y: previous.y });
    Matter.Body.setPosition(this.body, { x: previous.x, y: previous.y });
    Matter.Body.setAngle(this.body, next.rotation - next.angularVelocity);
    Matter.Body.setVelocity(this.body, { x: next.vx, y: next.vy });
    Matter.Body.setAngularVelocity(this.body, next.angularVelocity);
    Matter.Engine.update(this.engine, 1000 / 60);
    this.resistance.apply(this.engine);
    const pairs: Matter.Pair[] = this.engine.pairs.list.filter(
      (pair: Matter.Pair) => pair.isActive && (pair.bodyA === this.body || pair.bodyB === this.body)
    );
    this.contacts = pairs.filter(
      pair => pair.bodyA.label === 'wall' || pair.bodyB.label === 'wall'
    ).length;
    this.carContacts = pairs.filter(
      pair => pair.bodyA.label === 'opponent' || pair.bodyB.label === 'opponent'
    ).length;
    return this.constrain({
      ...next,
      x: this.body.position.x,
      y: this.body.position.y,
      vx: this.body.velocity.x,
      vy: this.body.velocity.y,
    });
  }

  dispose(): void {
    Matter.World.clear(this.engine.world, false);
    Matter.Engine.clear(this.engine);
    this.walls.clear();
    this.windowCenter = null;
    this.opponents.clear();
    this.contacts = 0;
    this.carContacts = 0;
    this.resistance.reset();
  }

  reset(): void {
    this.dispose();
    this.body = createVehicleBody({ x: 0, y: 0 }, 0);
    this.body.frictionAir = 0;
    Matter.World.add(this.engine.world, this.body);
  }
}
