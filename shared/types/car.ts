// Car types

import { Vector2 } from './physics';

export interface CarState {
  id: string;
  playerId: string;
  position: Vector2;
  rotation: number;
  velocity: Vector2;
  angularVelocity: number;
  steeringAngle: number;
  speed: number;
  nitroAmount: number;
  damage: DamageLevel;
  isAirborne: boolean;
  // Layer for bridges/overpasses: 0 = ground, 1 = bridge, -1 = tunnel
  layer: number;
  lap: number;
  checkpoint: number;
  lapTimes: number[];
  lastCheckpointTime: number;
  finished: boolean;
  finishTime: number;
  position_rank: number;
  lastInputSequence: number;
}

export type DamageLevel = 'none' | 'light' | 'medium' | 'heavy';

export interface CarStats {
  maxSpeed: number;
  acceleration: number;
  braking: number;
  handling: number;
  mass: number;
  width: number;
  height: number;
  wheelBase: number;
  maxSteeringAngle: number;
  nitroBoost: number;
  nitroDuration: number;
  nitroRechargeRate: number;
}

export interface CarConfig {
  id: string;
  name: string;
  stats: CarStats;
  sprite: string;
}

export const DEFAULT_CAR_STATS: CarStats = {
  maxSpeed: 500,
  acceleration: 300,
  braking: 400,
  handling: 3.5,
  mass: 1200,
  width: 40,
  height: 80,
  wheelBase: 50,
  maxSteeringAngle: Math.PI / 6,
  nitroBoost: 200,
  nitroDuration: 2000,
  nitroRechargeRate: 50,
};

export function createInitialCarState(id: string, playerId: string, position: Vector2, rotation: number): CarState {
  return {
    id,
    playerId,
    position: { ...position },
    rotation,
    velocity: { x: 0, y: 0 },
    angularVelocity: 0,
    steeringAngle: 0,
    speed: 0,
    nitroAmount: 100,
    damage: 'none',
    isAirborne: false,
    layer: 0, // Start at ground level
    lap: 0,
    checkpoint: 0,
    lapTimes: [],
    lastCheckpointTime: 0,
    finished: false,
    finishTime: 0,
    position_rank: 0,
    lastInputSequence: 0,
  };
}
