// Input types

export interface InputState {
  accelerate: boolean;
  brake: boolean;
  steerLeft: boolean;
  steerRight: boolean;
  // Aliases for client convenience
  turnLeft?: boolean;
  turnRight?: boolean;
  steerValue: number; // -1 to 1 for analog/tilt
  nitro: boolean;
  boost?: boolean; // Alias for nitro
  handbrake: boolean;
  respawn: boolean;
  sequenceNumber?: number; // For client-side tracking
}

export interface TimestampedInput {
  input: InputState;
  sequence: number;
  timestamp: number;
  serverTimestamp?: number;
}

export interface InputBuffer {
  inputs: TimestampedInput[];
  lastProcessedSequence: number;
}

export const DEFAULT_INPUT_STATE: InputState = {
  accelerate: false,
  brake: false,
  steerLeft: false,
  steerRight: false,
  turnLeft: false,
  turnRight: false,
  steerValue: 0,
  nitro: false,
  boost: false,
  handbrake: false,
  respawn: false,
  sequenceNumber: 0,
};

export function cloneInputState(input: InputState): InputState {
  return { ...input };
}

export function areInputsEqual(a: InputState, b: InputState): boolean {
  return (
    a.accelerate === b.accelerate &&
    a.brake === b.brake &&
    a.steerLeft === b.steerLeft &&
    a.steerRight === b.steerRight &&
    Math.abs(a.steerValue - b.steerValue) < 0.01 &&
    a.nitro === b.nitro &&
    a.handbrake === b.handbrake &&
    a.respawn === b.respawn
  );
}

// Normalize input to standard format
export function normalizeInput(input: InputState): InputState {
  return {
    ...input,
    steerLeft: input.steerLeft || input.turnLeft || false,
    steerRight: input.steerRight || input.turnRight || false,
    nitro: input.nitro || input.boost || false,
  };
}
