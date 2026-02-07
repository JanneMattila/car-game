// Room types

import { GameSettings, GameState, RaceResult } from './game';
import { Player } from './player';
import { CarState } from './car';

export interface Room {
  id: string;
  code: string;
  hostId: string;
  settings: GameSettings;
  players: Map<string, Player>;
  spectators: Map<string, Player>;
  state: RoomState;
  gameState: GameState;
  cars: Map<string, CarState>;
  results: RaceResult[];
  createdAt: number;
  startedAt: number;
}

export type RoomState = 'waiting' | 'countdown' | 'racing' | 'results';

export interface RoomInfo {
  id: string;
  code: string;
  hostNickname: string;
  trackName: string;
  trackId: string;
  playerCount: number;
  maxPlayers: number;
  state: RoomState;
  isPrivate: boolean;
  lapCount: number;
  players: RoomPlayer[];
  raceResults?: RaceResult[];
}

export interface RoomPlayer {
  id: string;
  nickname: string;
  color: string;
  ready: boolean;
  isHost: boolean;
  position: { x: number; y: number } | null;
  angle: number;
  velocity: { x: number; y: number } | null;
  lap: number;
  checkpointIndex: number;
  finished: boolean;
  finishTime: number | null;
  bestLapTime: number | null;
}

export interface RoomListItem {
  id: string;
  hostNickname: string;
  trackName: string;
  playerCount: number;
  maxPlayers: number;
  state: RoomState;
  lapCount: number;
}

export interface JoinRoomResult {
  success: boolean;
  room?: RoomInfo;
  playerId?: string;
  error?: string;
}
