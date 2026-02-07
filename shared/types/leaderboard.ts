// Leaderboard types

export interface LeaderboardEntry {
  id: string;
  nickname: string;
  time: number;
  date: number;
  ghostId?: string;
}

export interface TrackLeaderboard {
  trackId: string;
  bestLapTimes: LeaderboardEntry[];
  bestRaceTimes: LeaderboardEntry[];
}

export interface GhostReplay {
  id: string;
  trackId: string;
  nickname: string;
  totalTime: number;
  lapTime: number;
  recordedAt: number;
  frames: GhostFrame[];
}

export interface GhostFrame {
  t: number; // timestamp offset from start
  x: number;
  y: number;
  r: number; // rotation
  s: number; // steering angle
}

export const MAX_LEADERBOARD_ENTRIES = 100;
export const GHOST_RECORD_INTERVAL = 50; // ms between ghost frames
