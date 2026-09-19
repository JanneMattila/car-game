import { DEFAULT_INPUT_STATE, type InputState } from '../shared/index.js';

const DRIVE_PATTERNS = ['straight', 'circle-left', 'circle-right', 'figure-eight'] as const;
export type DrivePattern = typeof DRIVE_PATTERNS[number];

export function parseDrivePattern(value = 'straight'): DrivePattern {
  const pattern = DRIVE_PATTERNS.find(pattern => pattern === value);
  if (!pattern) {
    throw new Error(`Invalid DRIVE_PATTERN "${value}". Use ${DRIVE_PATTERNS.join(', ')}.`);
  }
  return pattern;
}

export function getDrivingInput(pattern: DrivePattern, elapsedMs: number): InputState {
  let steerValue = 0;
  if (pattern === 'circle-left') steerValue = -1;
  if (pattern === 'circle-right') steerValue = 1;
  if (pattern === 'figure-eight') {
    steerValue = Math.floor(Math.max(0, elapsedMs) / 8000) % 2 === 0 ? 1 : -1;
  }
  return {
    ...DEFAULT_INPUT_STATE,
    accelerate: true,
    steerValue,
    steerLeft: steerValue < 0,
    steerRight: steerValue > 0,
  };
}
