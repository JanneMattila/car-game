// Physics types

export interface Vector2 {
  x: number;
  y: number;
}

export interface Transform {
  position: Vector2;
  rotation: number;
}

export interface PhysicsBody {
  position: Vector2;
  velocity: Vector2;
  rotation: number;
  angularVelocity: number;
  mass: number;
  friction: number;
  restitution: number;
}

export interface CollisionEvent {
  bodyA: string;
  bodyB: string;
  point: Vector2;
  normal: Vector2;
  impulse: number;
  timestamp: number;
}

export interface PhysicsConfig {
  gravity: Vector2;
  friction: number;
  airResistance: number;
  rollingResistance: number;
  tireFriction: number;
  driftFrictionMultiplier: number;
  maxAngularVelocity: number;
}

export const DEFAULT_PHYSICS_CONFIG: PhysicsConfig = {
  gravity: { x: 0, y: 0 },
  friction: 0.98,
  airResistance: 0.995,
  rollingResistance: 0.99,
  tireFriction: 0.85,
  driftFrictionMultiplier: 0.6,
  maxAngularVelocity: 8,
};

// Interpolation state for smooth rendering
export interface InterpolationState {
  previous: Transform;
  current: Transform;
  target: Transform;
  alpha: number;
}
