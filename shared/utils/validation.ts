// Validation utilities

import { Track, TrackValidationResult, TrackValidationError, CURRENT_TRACK_VERSION } from '../types/track';
import { GameSettings } from '../types/game';
import { GAME_CONSTANTS } from '../constants/game';
import { vec2Distance } from './math';

export function validateNickname(nickname: string): { valid: boolean; error?: string } {
  if (!nickname || nickname.trim().length === 0) {
    return { valid: false, error: 'Nickname cannot be empty' };
  }
  
  const trimmed = nickname.trim();
  
  if (trimmed.length < 2) {
    return { valid: false, error: 'Nickname must be at least 2 characters' };
  }
  
  if (trimmed.length > 16) {
    return { valid: false, error: 'Nickname must be 16 characters or less' };
  }
  
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return { valid: false, error: 'Nickname can only contain letters, numbers, underscore, and hyphen' };
  }
  
  return { valid: true };
}

export function validateGameSettings(settings: GameSettings): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (settings.maxPlayers < 1 || settings.maxPlayers > GAME_CONSTANTS.MAX_PLAYERS) {
    errors.push(`Max players must be between 1 and ${GAME_CONSTANTS.MAX_PLAYERS}`);
  }
  
  if (settings.lapCount < 1 || settings.lapCount > 100) {
    errors.push('Lap count must be between 1 and 100');
  }
  
  if (!settings.trackId) {
    errors.push('Track must be selected');
  }
  
  return { valid: errors.length === 0, errors };
}

export function validateTrack(track: Track): TrackValidationResult {
  const errors: TrackValidationError[] = [];
  const warnings: string[] = [];

  // Check track version
  if (track.version === undefined || track.version === null) {
    warnings.push('Track has no version number, assuming version 1');
  } else if (track.version > CURRENT_TRACK_VERSION) {
    errors.push({
      code: 'UNSUPPORTED_VERSION',
      message: `Track version ${track.version} is not supported. Maximum supported version is ${CURRENT_TRACK_VERSION}.`,
    });
  }

  // Check for required elements in the track elements array
  const finishElements = track.elements?.filter(el => el.type === 'finish') || [];
  if (finishElements.length === 0) {
    errors.push({ code: 'NO_FINISH', message: 'Track must have a finish line element' });
  }

  // Check for spawn point elements
  const spawnElements = track.elements?.filter(el => el.type === 'spawn') || [];
  if (spawnElements.length < 2) {
    errors.push({ code: 'INSUFFICIENT_SPAWNS', message: 'Track must have at least 2 spawn point elements' });
  }

  if (spawnElements.length < 8) {
    warnings.push(`Track has only ${spawnElements.length} spawn points, some players may not be able to join`);
  }

  // Check for checkpoint elements
  const checkpointElements = track.elements?.filter(el => el.type === 'checkpoint') || [];
  if (checkpointElements.length < 1) {
    errors.push({ code: 'NO_CHECKPOINTS', message: 'Track must have at least 1 checkpoint element' });
  }

  // Check for wall elements as boundaries
  const wallElements = track.elements?.filter(el => el.type === 'wall' || el.type === 'barrier') || [];
  if (wallElements.length === 0) {
    warnings.push('Consider adding wall or barrier elements to define track boundaries');
  }

  // Check for overlapping spawn points
  for (let i = 0; i < spawnElements.length; i++) {
    for (let j = i + 1; j < spawnElements.length; j++) {
      const spawn1 = spawnElements[i]!;
      const spawn2 = spawnElements[j]!;
      const dist = vec2Distance(
        { x: spawn1.x, y: spawn1.y }, 
        { x: spawn2.x, y: spawn2.y }
      );
      if (dist < 60) {
        errors.push({
          code: 'OVERLAPPING_SPAWNS',
          message: `Spawn points ${i + 1} and ${j + 1} are too close together`,
          element: `spawn_${i}_${j}`,
        });
      }
    }
  }
  
  // Check checkpoints are properly indexed
  if (checkpointElements.length > 0) {
    const indices = checkpointElements.map(cp => cp.checkpointIndex ?? 0).sort((a, b) => a - b);
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] !== i) {
        errors.push({
          code: 'INVALID_CHECKPOINT_INDEX',
          message: `Checkpoint indices must be sequential starting from 0`,
        });
        break;
      }
    }
  }
  
  // Track dimensions
  if (track.width < 500 || track.height < 500) {
    warnings.push('Track is very small, consider making it larger');
  }
  
  if (track.width > 10000 || track.height > 10000) {
    warnings.push('Track is very large, this may impact performance');
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

export function sanitizeChatMessage(message: string): string {
  // Basic sanitization - remove HTML tags and trim
  let sanitized = message
    .replace(/<[^>]*>/g, '')
    .trim()
    .substring(0, GAME_CONSTANTS.MAX_CHAT_MESSAGE_LENGTH);
  
  // Basic profanity filter (placeholder - would be more comprehensive in production)
  const profanityList = ['badword1', 'badword2']; // Placeholder
  for (const word of profanityList) {
    const regex = new RegExp(word, 'gi');
    sanitized = sanitized.replace(regex, '*'.repeat(word.length));
  }
  
  return sanitized;
}

export function isValidRoomCode(code: string): boolean {
  if (!code || code.length !== GAME_CONSTANTS.ROOM_CODE_LENGTH) {
    return false;
  }
  return /^[A-Z0-9]+$/.test(code);
}
