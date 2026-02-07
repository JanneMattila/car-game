import {
  Track,
  TrackMetadata,
  TrackValidationResult,
} from '@shared';
import { validateTrack, generateUUID } from '@shared';
import { StorageService } from '../storage/storageService.js';

export class TrackManager {
  private storage: StorageService;
  private tracks: Map<string, Track> = new Map();
  private trackMetadata: TrackMetadata[] = [];

  constructor(storage: StorageService) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    // Load all tracks from storage
    const trackIds = await this.storage.list('tracks');
    
    for (const id of trackIds) {
      const track = await this.storage.read<Track>('tracks', id);
      if (track) {
        this.tracks.set(id, track);
        this.trackMetadata.push(this.extractMetadata(track));
      }
    }

    console.log(`Loaded ${this.tracks.size} tracks`);
  }

  private extractMetadata(track: Track): TrackMetadata {
    return {
      id: track.id,
      name: track.name,
      author: track.author,
      difficulty: track.difficulty,
      defaultLapCount: track.defaultLapCount,
      createdAt: track.createdAt,
    };
  }

  getTrack(id: string): Track | null {
    return this.tracks.get(id) || null;
  }

  getTrackList(): TrackMetadata[] {
    return [...this.trackMetadata];
  }

  async saveTrack(track: Track): Promise<TrackValidationResult> {
    const validation = validateTrack(track);
    
    if (!validation.isValid) {
      return validation;
    }

    track.updatedAt = Date.now();
    
    await this.storage.write('tracks', track.id, track);
    this.tracks.set(track.id, track);
    
    // Update metadata
    const existingIndex = this.trackMetadata.findIndex(t => t.id === track.id);
    const metadata = this.extractMetadata(track);
    
    if (existingIndex >= 0) {
      this.trackMetadata[existingIndex] = metadata;
    } else {
      this.trackMetadata.push(metadata);
    }

    return validation;
  }

  async createTrack(name: string, author: string): Promise<Track> {
    const track: Track = {
      id: generateUUID(),
      name,
      author,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      difficulty: 'easy',
      defaultLapCount: 10,
      width: 2000,
      height: 1200,
      elements: [
        // Default spawn point
        {
          id: generateUUID(),
          type: 'spawn',
          x: 180,
          y: 470,
          position: { x: 180, y: 470 },
          width: 120,
          height: 60,
          rotation: 0,
          layer: 0
        },
        // Default finish line
        {
          id: generateUUID(),
          type: 'finish',
          x: 180,
          y: 420,
          position: { x: 180, y: 420 },
          width: 120,
          height: 20,
          rotation: 0,
          layer: 0
        }
      ],
      scenery: [],
    };

    this.tracks.set(track.id, track);
    this.trackMetadata.push(this.extractMetadata(track));

    return track;
  }

  async deleteTrack(id: string): Promise<boolean> {
    if (id === 'default-oval') {
      return false; // Cannot delete default track
    }

    const success = await this.storage.delete('tracks', id);
    
    if (success) {
      this.tracks.delete(id);
      this.trackMetadata = this.trackMetadata.filter(t => t.id !== id);
    }

    return success;
  }

  validateTrack(track: Track): TrackValidationResult {
    return validateTrack(track);
  }
}
