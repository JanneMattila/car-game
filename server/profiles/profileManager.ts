import { randomUUID } from 'crypto';
import { COLOR_ORDER, type CarColor } from '@shared';
import { StorageService } from '../storage/storageService.js';

export interface Profile {
  id: string;
  nickname: string;
  color: CarColor;
  createdAt: number;
  updatedAt: number;
}

export interface ProfileInput {
  nickname?: unknown;
  color?: unknown;
}

const NICKNAME_PATTERN = /^[a-zA-Z0-9_-]{2,16}$/;
const ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const COLLECTION = 'profiles';

export class ProfileError extends Error {}

export function validateNickname(value: unknown): string {
  if (typeof value !== 'string' || !NICKNAME_PATTERN.test(value)) {
    throw new ProfileError('Nickname must be 2-16 characters: letters, digits, _ or -');
  }
  return value;
}

export function validateColor(value: unknown, fallback: CarColor = 'red'): CarColor {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !COLOR_ORDER.includes(value as CarColor)) {
    throw new ProfileError(`Color must be one of: ${COLOR_ORDER.join(', ')}`);
  }
  return value as CarColor;
}

/** Player profiles used by the native client to identify itself in lobbies. */
export class ProfileManager {
  constructor(private storage: StorageService) {}

  async create(input: ProfileInput): Promise<Profile> {
    const now = Date.now();
    const profile: Profile = {
      id: randomUUID(),
      nickname: validateNickname(input.nickname),
      color: validateColor(input.color),
      createdAt: now,
      updatedAt: now,
    };
    await this.storage.write(COLLECTION, profile.id, profile);
    return profile;
  }

  async get(id: string): Promise<Profile | null> {
    if (!ID_PATTERN.test(id)) return null;
    return this.storage.read<Profile>(COLLECTION, id);
  }

  async update(id: string, input: ProfileInput): Promise<Profile | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const updated: Profile = {
      ...existing,
      nickname: input.nickname === undefined ? existing.nickname : validateNickname(input.nickname),
      color: validateColor(input.color, existing.color),
      updatedAt: Date.now(),
    };
    await this.storage.write(COLLECTION, id, updated);
    return updated;
  }
}

export function publicProfile(profile: Profile): Pick<Profile, 'id' | 'nickname' | 'color'> {
  return { id: profile.id, nickname: profile.nickname, color: profile.color };
}
