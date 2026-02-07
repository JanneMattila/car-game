// Network message types

import { CarState } from './car';
import { GameState, GameSettings, RaceResult } from './game';
import { Player, PlayerInput, CarColor } from './player';
import { RoomInfo, RoomListItem, RoomPlayer } from './room';
import { TrackMetadata, Track } from './track';

// Client to Server messages
export type ClientMessage =
  | { type: 'join_room'; roomId?: string; code?: string; nickname: string; preferredColor: CarColor }
  | { type: 'create_room'; settings: GameSettings; nickname: string; preferredColor: CarColor }
  | { type: 'leave_room' }
  | { type: 'set_ready'; ready: boolean }
  | { type: 'start_game' }
  | { type: 'input'; input: PlayerInput }
  | { type: 'chat'; message: string }
  | { type: 'emote'; emote: EmoteType }
  | { type: 'request_room_list' }
  | { type: 'request_track_list' }
  | { type: 'ping'; timestamp: number };

// Server to Client messages
export type ServerMessage =
  | { type: 'welcome'; playerId: string; serverTime: number }
  | { type: 'room_joined'; room: RoomInfo; players: Player[]; playerId: string }
  | { type: 'room_left'; reason: string }
  | { type: 'player_joined'; player: RoomPlayer }
  | { type: 'player_left'; playerId: string; reason: string }
  | { type: 'player_ready'; playerId: string; ready: boolean }
  | { type: 'game_starting'; countdown: number; track: Track; cars: CarStateSnapshot[] }
  | { type: 'countdown'; count: number }
  | { type: 'game_started'; startTime: number }
  | { type: 'game_state'; state: GameStateSnapshot }
  | { type: 'race_finished'; results: RaceResult[] }
  | { type: 'checkpoint_passed'; playerId: string; checkpoint: number; time: number }
  | { type: 'lap_completed'; playerId: string; lap: number; lapTime: number }
  | { type: 'player_finished'; playerId: string; position: number; totalTime: number }
  | { type: 'collision'; event: CollisionNetworkEvent }
  | { type: 'chat'; playerId: string; nickname: string; message: string }
  | { type: 'emote'; playerId: string; emote: EmoteType }
  | { type: 'room_list'; rooms: RoomListItem[] }
  | { type: 'track_list'; tracks: TrackMetadata[] }
  | { type: 'track_data'; track: Track }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; clientTimestamp: number; serverTimestamp: number };

export interface GameStateSnapshot {
  sequence: number;
  timestamp: number;
  gameState: GameState;
  cars: CarStateSnapshot[];
  events: GameEvent[];
}

export interface CarStateSnapshot {
  id: string;
  playerId: string;
  x: number;
  y: number;
  rotation: number;
  vx: number;
  vy: number;
  angularVelocity: number;
  steeringAngle: number;
  speed: number;
  nitro: number;
  damage: number;
  lap: number;
  checkpoint: number;
  positionRank: number;
  finished: boolean;
  layer: number; // Layer for bridges/overpasses: 0 = ground, 1 = bridge, -1 = tunnel
  lastInputSequence: number; // Last input sequence processed by server (for reconciliation)
}

export interface CollisionNetworkEvent {
  carA: string;
  carB?: string;
  x: number;
  y: number;
  impulse: number;
}

export type GameEvent =
  | { type: 'checkpoint'; playerId: string; checkpoint: number }
  | { type: 'lap'; playerId: string; lap: number; time: number }
  | { type: 'finish'; playerId: string; position: number; time: number }
  | { type: 'collision'; carA: string; carB?: string; impulse: number }
  | { type: 'boost_used'; playerId: string }
  | { type: 'respawn'; playerId: string }
  | { type: 'layer_change'; playerId: string; layer: number };

export type EmoteType = 
  | 'gg'
  | 'nice'
  | 'sorry'
  | 'thanks'
  | 'wow'
  | 'lol';

export const EMOTE_LABELS: Record<EmoteType, string> = {
  gg: 'GG!',
  nice: 'Nice!',
  sorry: 'Sorry!',
  thanks: 'Thanks!',
  wow: 'Wow!',
  lol: 'LOL',
};

// Serialization helpers for bandwidth optimization
export function serializeCarState(car: CarState): CarStateSnapshot {
  return {
    id: car.id,
    playerId: car.playerId,
    x: Math.round(car.position.x * 100) / 100,
    y: Math.round(car.position.y * 100) / 100,
    rotation: Math.round(car.rotation * 1000) / 1000,
    vx: Math.round(car.velocity.x * 100) / 100,
    vy: Math.round(car.velocity.y * 100) / 100,
    angularVelocity: Math.round(car.angularVelocity * 1000) / 1000,
    steeringAngle: Math.round(car.steeringAngle * 1000) / 1000,
    speed: Math.round(car.speed * 10) / 10,
    nitro: Math.round(car.nitroAmount),
    damage: ['none', 'light', 'medium', 'heavy'].indexOf(car.damage),
    lap: car.lap,
    checkpoint: car.checkpoint,
    positionRank: car.position_rank,
    finished: car.finished,
    layer: car.layer ?? 0, // Include layer in serialization
    lastInputSequence: car.lastInputSequence ?? 0,
  };
}

export function deserializeCarState(snapshot: CarStateSnapshot, existing?: Partial<CarState>): CarState {
  const damageMap: CarState['damage'][] = ['none', 'light', 'medium', 'heavy'];
  return {
    id: snapshot.id,
    playerId: snapshot.playerId,
    position: { x: snapshot.x, y: snapshot.y },
    rotation: snapshot.rotation,
    velocity: { x: snapshot.vx, y: snapshot.vy },
    angularVelocity: snapshot.angularVelocity,
    steeringAngle: snapshot.steeringAngle,
    speed: snapshot.speed,
    nitroAmount: snapshot.nitro,
    damage: damageMap[snapshot.damage] ?? 'none',
    isAirborne: existing?.isAirborne ?? false,
    lap: snapshot.lap,
    checkpoint: snapshot.checkpoint,
    lapTimes: existing?.lapTimes ?? [],
    lastCheckpointTime: existing?.lastCheckpointTime ?? 0,
    finished: snapshot.finished,
    finishTime: existing?.finishTime ?? 0,
    position_rank: snapshot.positionRank,
    layer: snapshot.layer ?? 0,
    lastInputSequence: snapshot.lastInputSequence ?? 0,
  };
}
