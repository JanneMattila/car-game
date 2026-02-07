import {
  TrackLeaderboard,
  LeaderboardEntry,
  GhostReplay,
  MAX_LEADERBOARD_ENTRIES,
} from '@shared';
import { generateUUID } from '@shared';
import { StorageService } from '../storage/storageService.js';

export class LeaderboardManager {
  private storage: StorageService;
  private leaderboards: Map<string, TrackLeaderboard> = new Map();

  constructor(storage: StorageService) {
    this.storage = storage;
  }

  async getLeaderboard(trackId: string): Promise<TrackLeaderboard> {
    // Check cache first
    let leaderboard = this.leaderboards.get(trackId);
    
    if (!leaderboard) {
      // Try to load from storage
      leaderboard = await this.storage.read<TrackLeaderboard>('leaderboards', trackId) ?? undefined;
      
      if (!leaderboard) {
        // Create new leaderboard
        leaderboard = {
          trackId,
          bestLapTimes: [],
          bestRaceTimes: [],
        };
      }
      
      this.leaderboards.set(trackId, leaderboard);
    }
    
    return leaderboard;
  }

  async submitLapTime(
    trackId: string,
    nickname: string,
    time: number,
    ghostId?: string
  ): Promise<{ rank: number; isNewRecord: boolean }> {
    const leaderboard = await this.getLeaderboard(trackId);
    
    const entry: LeaderboardEntry = {
      id: generateUUID(),
      nickname,
      time,
      date: Date.now(),
      ghostId,
    };

    // Find insertion position
    let rank = leaderboard.bestLapTimes.findIndex(e => e.time > time);
    if (rank === -1) {
      rank = leaderboard.bestLapTimes.length;
    }

    // Check if this beats the player's previous best
    const existingIndex = leaderboard.bestLapTimes.findIndex(
      e => e.nickname.toLowerCase() === nickname.toLowerCase()
    );
    
    let isNewRecord = false;
    
    if (existingIndex === -1 || leaderboard.bestLapTimes[existingIndex]!.time > time) {
      // Remove existing entry for this player
      if (existingIndex !== -1) {
        leaderboard.bestLapTimes.splice(existingIndex, 1);
        if (existingIndex < rank) rank--;
      }
      
      // Insert new entry
      leaderboard.bestLapTimes.splice(rank, 0, entry);
      
      // Trim to max entries
      if (leaderboard.bestLapTimes.length > MAX_LEADERBOARD_ENTRIES) {
        leaderboard.bestLapTimes = leaderboard.bestLapTimes.slice(0, MAX_LEADERBOARD_ENTRIES);
      }
      
      // Save
      await this.storage.write('leaderboards', trackId, leaderboard);
      
      isNewRecord = rank === 0;
    }

    return { rank: rank + 1, isNewRecord };
  }

  async submitRaceTime(
    trackId: string,
    nickname: string,
    time: number,
    lapCount: number
  ): Promise<{ rank: number; isNewRecord: boolean }> {
    const leaderboard = await this.getLeaderboard(trackId);
    
    const entry: LeaderboardEntry = {
      id: generateUUID(),
      nickname,
      time,
      date: Date.now(),
    };

    // Find insertion position
    let rank = leaderboard.bestRaceTimes.findIndex(e => e.time > time);
    if (rank === -1) {
      rank = leaderboard.bestRaceTimes.length;
    }

    // Check if this beats the player's previous best
    const existingIndex = leaderboard.bestRaceTimes.findIndex(
      e => e.nickname.toLowerCase() === nickname.toLowerCase()
    );
    
    let isNewRecord = false;
    
    if (existingIndex === -1 || leaderboard.bestRaceTimes[existingIndex]!.time > time) {
      // Remove existing entry for this player
      if (existingIndex !== -1) {
        leaderboard.bestRaceTimes.splice(existingIndex, 1);
        if (existingIndex < rank) rank--;
      }
      
      // Insert new entry
      leaderboard.bestRaceTimes.splice(rank, 0, entry);
      
      // Trim to max entries
      if (leaderboard.bestRaceTimes.length > MAX_LEADERBOARD_ENTRIES) {
        leaderboard.bestRaceTimes = leaderboard.bestRaceTimes.slice(0, MAX_LEADERBOARD_ENTRIES);
      }
      
      // Save
      await this.storage.write('leaderboards', trackId, leaderboard);
      
      isNewRecord = rank === 0;
    }

    return { rank: rank + 1, isNewRecord };
  }

  async saveGhostReplay(ghost: GhostReplay): Promise<void> {
    await this.storage.write('replays', ghost.id, ghost);
  }

  async getGhostReplay(id: string): Promise<GhostReplay | null> {
    return this.storage.read<GhostReplay>('replays', id);
  }

  async getTrackRecordGhost(trackId: string): Promise<GhostReplay | null> {
    const leaderboard = await this.getLeaderboard(trackId);
    
    if (leaderboard.bestLapTimes.length === 0) {
      return null;
    }

    const topEntry = leaderboard.bestLapTimes[0];
    if (!topEntry?.ghostId) {
      return null;
    }

    return this.getGhostReplay(topEntry.ghostId);
  }
}
