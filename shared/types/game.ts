// Game state types

export type GamePhase = 'waiting' | 'countdown' | 'racing' | 'finished';

export interface GameState {
  phase: GamePhase;
  countdown: number;
  raceStartTime: number;
  elapsedTime: number;
  finishedPlayers: string[];
}

export interface RaceResult {
  playerId: string;
  nickname: string;
  position: number;
  totalTime: number;
  bestLapTime: number;
  laps: LapTime[];
  finished: boolean;
}

export interface LapTime {
  lap: number;
  time: number;
  checkpointTimes: number[];
}

export interface GameSettings {
  maxPlayers: number;
  lapCount: number;
  trackId: string;
  isPrivate: boolean;
  allowMidRaceJoin: boolean;
  enableChat: boolean;
}

export const DEFAULT_GAME_SETTINGS: GameSettings = {
  maxPlayers: 8,
  lapCount: 10,
  trackId: '',
  isPrivate: false,
  allowMidRaceJoin: true,
  enableChat: true,
};
