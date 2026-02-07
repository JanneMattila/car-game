// Client-side prediction with server reconciliation
// Provides smooth movement by predicting locally and correcting when server responds

import { PHYSICS_CONSTANTS } from '@shared';

interface PredictedState {
  x: number;
  y: number;
  rotation: number;
  vx: number;
  vy: number;
}

interface InputRecord {
  sequence: number;
  timestamp: number;
  accelerate: boolean;
  brake: boolean;
  steerLeft: boolean;
  steerRight: boolean;
  steerValue: number;
  nitro: boolean;
  handbrake: boolean;
}

interface TrackBounds {
  width: number;
  height: number;
  wrapAround: boolean;
}

// Store pending inputs that haven't been confirmed by server
const pendingInputs: InputRecord[] = [];
let lastConfirmedSequence = 0;
let predictedState: PredictedState | null = null;
let currentInput: InputRecord | null = null; // Current held input for continuous simulation
let trackBounds: TrackBounds | null = null; // Track dimensions for wrap-around
let physicsAccumulator = 0; // Accumulates real time, drained in fixed DELTA_TIME steps

// Physics constants for local prediction (simplified)
const DELTA_TIME = 1 / 60; // 60fps physics
const MAX_PENDING_INPUTS = 120; // ~2 seconds at 60fps

// Helper functions
function vec2Length(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

function vec2Normalize(x: number, y: number): { x: number; y: number } {
  const len = vec2Length(x, y);
  if (len < 0.0001) return { x: 0, y: 0 };
  return { x: x / len, y: y / len };
}

/**
 * Set the track bounds for wrap-around calculations
 */
export function setTrackBounds(bounds: TrackBounds | null): void {
  trackBounds = bounds;
}

// Client prediction does NOT wrap positions.
// Positions are kept in continuous (unbounded) space so the camera can follow
// smoothly without jumps. The tile renderer generates infinite visual tiles
// around the camera, so the car always sees a seamless track.
// Only the SERVER wraps positions (for physics collision checks).

/**
 * Adjust a position to be in the same "wrap space" as a reference position
 * This prevents jumps during reconciliation when positions are on opposite sides of a wrap boundary
 */
/**
 * Find the copy of `pos` closest to `reference` in wrap space.
 * Uses Math.round to handle positions that have accumulated many wrap cycles
 * (e.g., continuous prediction at y=-3000 vs server-wrapped y=580).
 */
function unwrapPosition(pos: { x: number; y: number }, reference: { x: number; y: number }): { x: number; y: number } {
  if (!trackBounds || !trackBounds.wrapAround) return pos;
  
  const w = trackBounds.width;
  const h = trackBounds.height;
  
  const kx = Math.round((reference.x - pos.x) / w);
  const ky = Math.round((reference.y - pos.y) / h);
  
  return { x: pos.x + kx * w, y: pos.y + ky * h };
}

/**
 * Set the current input state (called when input changes)
 */
export function setCurrentInput(input: InputRecord): void {
  currentInput = { ...input };
}

/**
 * Record an input for later reconciliation
 */
export function recordInput(input: InputRecord): void {
  pendingInputs.push({ ...input });
  currentInput = { ...input };
  
  // Trim old inputs to prevent memory growth
  while (pendingInputs.length > MAX_PENDING_INPUTS) {
    pendingInputs.shift();
  }
}

/**
 * Apply local prediction for immediate responsiveness
 * Call this after recording input
 */
export function predictLocalMovement(
  currentState: PredictedState,
  input: InputRecord
): PredictedState {
  const result = simulateStep(currentState, input);
  predictedState = result;
  return result;
}

/**
 * Run one frame of prediction using current held input.
 * Uses a fixed-timestep accumulator so physics always steps at 60 Hz
 * regardless of the display refresh rate.
 */
export function predictFrame(deltaTime: number = DELTA_TIME): PredictedState | null {
  if (!predictedState || !currentInput) return predictedState;
  
  physicsAccumulator += deltaTime;
  
  // Step at a fixed rate; consume all accumulated time
  while (physicsAccumulator >= DELTA_TIME) {
    predictedState = simulateStep(predictedState, currentInput);
    physicsAccumulator -= DELTA_TIME;
  }
  
  return predictedState;
}

/**
 * Simulate one physics step with given input
 */
function simulateStep(state: PredictedState, input: InputRecord): PredictedState {
  let { x, y, rotation, vx, vy } = state;
  
  // Calculate forward direction
  const forwardX = Math.sin(rotation);
  const forwardY = -Math.cos(rotation);
  
  const speed = vec2Length(vx, vy);
  const forwardSpeed = vx * forwardX + vy * forwardY;
  
  // Max speed for prediction
  const maxSpeed = PHYSICS_CONSTANTS.MAX_SPEED;
  
  // === ACCELERATION / BRAKING ===
  if (input.accelerate && speed < maxSpeed) {
    const speedRatio = speed / maxSpeed;
    const accelerationFactor = Math.max(0.15, 1 - speedRatio * 0.85);
    let accel = PHYSICS_CONSTANTS.ENGINE_FORCE * accelerationFactor * 0.02;
    
    // Apply nitro boost if active
    if (input.nitro) {
      accel *= PHYSICS_CONSTANTS.NITRO_BOOST_MULTIPLIER;
    }
    
    vx += forwardX * accel;
    vy += forwardY * accel;
  }
  
  if (input.brake) {
    if (forwardSpeed > 0.2) {
      // Braking
      const brakeFactor = Math.max(0.9, 1 - PHYSICS_CONSTANTS.BRAKE_FORCE * 0.01);
      vx *= brakeFactor;
      vy *= brakeFactor;
    } else if (forwardSpeed > -PHYSICS_CONSTANTS.MAX_REVERSE_SPEED) {
      // Reversing
      const reverseAccel = PHYSICS_CONSTANTS.REVERSE_FORCE * 0.012;
      vx -= forwardX * reverseAccel;
      vy -= forwardY * reverseAccel;
    }
  }
  
  // === STEERING ===
  const newSpeed = vec2Length(vx, vy);
  if (newSpeed > 0.1) {
    let steerInput = 0;
    if (input.steerValue !== undefined && input.steerValue !== 0) {
      steerInput = input.steerValue;
    } else if (input.steerLeft) {
      steerInput = -1;
    } else if (input.steerRight) {
      steerInput = 1;
    }
    
    if (steerInput !== 0) {
      // Speed-based steering effectiveness (more grip at lower speeds)
      const speedFactor = Math.max(0.3, 1 - (newSpeed / maxSpeed) * 0.7);
      const steerAngle = PHYSICS_CONSTANTS.MAX_STEERING_ANGLE * steerInput * speedFactor;
      
      // Apply rotation
      const turnRate = steerAngle * (forwardSpeed > 0 ? 1 : -1) * 0.08;
      rotation += turnRate;
      
      // Rotate velocity to follow car direction (grip)
      const grip = input.handbrake ? 0.85 : 0.95;
      const currentDir = vec2Normalize(vx, vy);
      const newForwardX = Math.sin(rotation);
      const newForwardY = -Math.cos(rotation);
      
      // Blend current velocity direction toward new car direction
      const blendedX = currentDir.x * (1 - grip) + newForwardX * grip;
      const blendedY = currentDir.y * (1 - grip) + newForwardY * grip;
      const blended = vec2Normalize(blendedX, blendedY);
      
      vx = blended.x * newSpeed;
      vy = blended.y * newSpeed;
    }
  }
  
  // === DRAG ===
  // Use a tuned constant drag that approximates the combined effect of
  // server's manual drag (DRAG_COEFFICIENT * speed) + Matter.js frictionAir.
  // The server has two damping stages; the client has only this one.
  const dragFactor = 1 - PHYSICS_CONSTANTS.DRAG_COEFFICIENT;
  vx *= dragFactor;
  vy *= dragFactor;
  
  // === ROLLING RESISTANCE ===
  const finalSpeed = vec2Length(vx, vy);
  if (finalSpeed > 0.1 && !input.accelerate) {
    const resistFactor = 1 - PHYSICS_CONSTANTS.ROLLING_RESISTANCE;
    vx *= resistFactor;
    vy *= resistFactor;
  }
  
  // === CLAMP SPEED ===
  const clampedSpeed = vec2Length(vx, vy);
  if (clampedSpeed > maxSpeed) {
    const scale = maxSpeed / clampedSpeed;
    vx *= scale;
    vy *= scale;
  }
  
  // === UPDATE POSITION ===
  x += vx;
  y += vy;
  
  // Do NOT wrap — keep positions continuous for smooth camera/rendering.
  // Server wraps positions; reconciliation unwraps server state to match.
  return { x, y, rotation, vx, vy };
}

/**
 * Reconcile server state with client prediction.
 *
 * Instead of replaying individual inputs (which doesn't work well because
 * pendingInputs are key-change events, not per-tick entries), we use
 * smooth error correction:
 *  - Velocity & rotation: snap to server (authoritative, ensures correct
 *    future prediction direction).
 *  - Position: blend toward server to avoid visible jumps.
 *  - Large errors (e.g. respawn, teleport): hard snap.
 */
export function reconcileWithServer(
  serverState: PredictedState,
  serverSequence: number
): PredictedState {
  // Remove all inputs that have been processed by server
  while (pendingInputs.length > 0 && pendingInputs[0]!.sequence <= serverSequence) {
    pendingInputs.shift();
  }
  
  lastConfirmedSequence = serverSequence;
  
  // Unwrap server state into the same coordinate space as our current prediction
  let target = { ...serverState };
  if (predictedState && trackBounds?.wrapAround) {
    const unwrapped = unwrapPosition(
      { x: target.x, y: target.y },
      { x: predictedState.x, y: predictedState.y }
    );
    target.x = unwrapped.x;
    target.y = unwrapped.y;
  }
  
  // If no prior prediction, just accept server state
  if (!predictedState) {
    predictedState = target;
    return predictedState;
  }
  
  // --- Velocity & rotation: snap to server ---
  predictedState.vx = target.vx;
  predictedState.vy = target.vy;
  // Blend rotation to avoid visual snapping (normalise via atan2)
  const rotDiff = Math.atan2(
    Math.sin(target.rotation - predictedState.rotation),
    Math.cos(target.rotation - predictedState.rotation)
  );
  predictedState.rotation += rotDiff * 0.5;
  
  // --- Position: smooth correction ---
  const dx = target.x - predictedState.x;
  const dy = target.y - predictedState.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  
  const SNAP_THRESHOLD = 150; // px  – respawn, stuck reset, etc.
  const BLEND_FACTOR   = 0.3; // 30 % correction per server update (~20 Hz)
  
  if (dist > SNAP_THRESHOLD) {
    // Large discrepancy – hard snap
    predictedState.x = target.x;
    predictedState.y = target.y;
    predictedState.rotation = target.rotation;
  } else if (dist > 0.5) {
    // Gradual correction
    predictedState.x += dx * BLEND_FACTOR;
    predictedState.y += dy * BLEND_FACTOR;
  }
  // else: <0.5 px – no correction needed
  
  return predictedState;
}

/**
 * Get the current predicted state
 */
export function getPredictedState(): PredictedState | null {
  return predictedState;
}

/**
 * Initialize prediction with server state
 */
export function initializePrediction(state: PredictedState): void {
  predictedState = { ...state };
  pendingInputs.length = 0;
  lastConfirmedSequence = 0;
  physicsAccumulator = 0;
  currentInput = {
    sequence: 0,
    timestamp: Date.now(),
    accelerate: false,
    brake: false,
    steerLeft: false,
    steerRight: false,
    steerValue: 0,
    nitro: false,
    handbrake: false,
  };
}

/**
 * Clear all prediction state
 */
export function clearPrediction(): void {
  predictedState = null;
  pendingInputs.length = 0;
  lastConfirmedSequence = 0;
  currentInput = null;
  trackBounds = null;
  physicsAccumulator = 0;
}

/**
 * Reset prediction velocity to zero (used on respawn)
 * Keeps position but clears velocity and pending inputs
 */
export function resetPredictionVelocity(): void {
  if (predictedState) {
    predictedState.vx = 0;
    predictedState.vy = 0;
  }
  // Clear pending inputs since they contained old velocity
  pendingInputs.length = 0;
}

/**
 * Get count of pending inputs (for debugging)
 */
export function getPendingInputCount(): number {
  return pendingInputs.length;
}
