// Client-side prediction with server reconciliation
// Provides smooth movement by predicting locally and correcting when server responds

import { PHYSICS_CONSTANTS } from '@shared';

interface PredictedState {
  x: number;
  y: number;
  rotation: number;
  vx: number;
  vy: number;
  angularVelocity: number;
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

// Debug telemetry – readable by the debug overlay
export interface ReconciliationDebugInfo {
  lastCorrectionDist: number;
  lastCorrectionX: number;
  lastCorrectionY: number;
  lastVelocityDeltaX: number;
  lastVelocityDeltaY: number;
  lastRotationDelta: number;
  snapped: boolean;
  serverUpdateCount: number;
  lastServerUpdateTime: number;
}

const _debugInfo: ReconciliationDebugInfo = {
  lastCorrectionDist: 0,
  lastCorrectionX: 0,
  lastCorrectionY: 0,
  lastVelocityDeltaX: 0,
  lastVelocityDeltaY: 0,
  lastRotationDelta: 0,
  snapped: false,
  serverUpdateCount: 0,
  lastServerUpdateTime: 0,
};

/** Get reconciliation debug info (read-only snapshot) */
export function getReconciliationDebug(): Readonly<ReconciliationDebugInfo> {
  return _debugInfo;
}

// Physics constants for local prediction (simplified)
const DELTA_TIME = 1 / 60; // 60fps physics
const MAX_PENDING_INPUTS = 120; // ~2 seconds at 60fps

// Helper functions
function vec2Length(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
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
 * Simulate one physics step with given input.
 *
 * This MUST match the server's physics pipeline exactly to minimise
 * server-reconciliation correction distance.  The server does:
 *
 *   1. updateCar()  – accumulate forces via Matter.Body.applyForce(),
 *                     apply braking / drag / speed-clamp via setVelocity()
 *   2. Matter.Engine.update()  – Verlet integration with frictionAir
 *        v_new = v_prev × (1 – frictionAir × dt/baseDt)
 *              + (F / m) × dt²
 *
 * Key server constants baked in:
 *   body { density: 0.002, 30×20 rect → mass = 1.2,
 *          frictionAir: 0.01, inertia: Infinity }
 *   Engine.update(engine, 1000/60)  → dt = baseDt → time-correction = 1
 */

// ── Server-matching constants ──────────────────────────────────────
const SERVER_BODY_MASS  = 1.2;           // density(0.002) × area(30×20)
const MATTER_DT         = 1000 / 60;     // ms – same as baseDelta
const MATTER_DT_SQUARED = MATTER_DT * MATTER_DT; // ≈ 277.78
const MATTER_FRICTION_AIR = 1 - 0.01;    // 0.99 – body.frictionAir = 0.01

function simulateStep(state: PredictedState, input: InputRecord): PredictedState {
  let { x, y, rotation, vx, vy, angularVelocity } = state;

  // Forward direction (same convention as server)
  const forwardX = Math.sin(rotation);
  const forwardY = -Math.cos(rotation);

  // Speed measured at start of tick (matches server's `currentSpeed`)
  const speed = vec2Length(vx, vy);
  const forwardSpeed = vx * forwardX + vy * forwardY;
  const isMovingForward  = forwardSpeed > 0.5;
  const isMovingBackward = forwardSpeed < -0.5;

  // ── 1. Accumulate forces (consumed in Verlet step below) ────────
  let forceX = 0;
  let forceY = 0;

  // Acceleration – server: applyForce( rotate((0, -ENGINE_FORCE*0.001), angle) )
  if (input.accelerate && speed < PHYSICS_CONSTANTS.MAX_SPEED) {
    forceX += forwardX * PHYSICS_CONSTANTS.ENGINE_FORCE * 0.001;
    forceY += forwardY * PHYSICS_CONSTANTS.ENGINE_FORCE * 0.001;
  }

  // Nitro boost – server: applyForce( rotate((0, -ENGINE_FORCE*0.0015), angle) )
  if (input.nitro) {
    forceX += forwardX * PHYSICS_CONSTANTS.ENGINE_FORCE * 0.0015;
    forceY += forwardY * PHYSICS_CONSTANTS.ENGINE_FORCE * 0.0015;
  }

  // ── 2. Direct velocity modifications (setVelocity on server) ────

  // Braking
  if (input.brake) {
    if (isMovingForward && forwardSpeed > 1) {
      // Server: setVelocity(v * 0.95)
      vx *= 0.95;
      vy *= 0.95;
    } else if (speed < PHYSICS_CONSTANTS.MAX_REVERSE_SPEED) {
      // Server: reverse via applyForce
      forceX -= forwardX * PHYSICS_CONSTANTS.REVERSE_FORCE * 0.001;
      forceY -= forwardY * PHYSICS_CONSTANTS.REVERSE_FORCE * 0.001;
    }
  }

  // ── 3. Steering (angular velocity) ─────────────────────────────
  let steerInput = 0;
  if (input.steerValue !== undefined && input.steerValue !== 0) {
    steerInput = input.steerValue;
  } else if (input.steerLeft) {
    steerInput = -1;
  } else if (input.steerRight) {
    steerInput = 1;
  }

  if (steerInput !== 0) {
    const minTurnSpeed = 0.5;
    if (speed > minTurnSpeed) {
      // Server's 3-tier speed factor
      let speedFactor: number;
      if (speed < 3) {
        speedFactor = speed / 3;
      } else if (speed < 15) {
        speedFactor = 1.0;
      } else {
        speedFactor = Math.max(0.5, 15 / speed);
      }
      const turnForce = steerInput * PHYSICS_CONSTANTS.MAX_STEERING_ANGLE * 0.18 * speedFactor;
      const reverseMult = isMovingBackward ? -1 : 1;
      angularVelocity = turnForce * reverseMult;
    }
  } else {
    // Server: setAngularVelocity(body.angularVelocity * 0.85)
    angularVelocity *= 0.85;
  }

  // Server: angular velocity clamp
  if (Math.abs(angularVelocity) > PHYSICS_CONSTANTS.MAX_ANGULAR_VELOCITY) {
    angularVelocity = Math.sign(angularVelocity) * PHYSICS_CONSTANTS.MAX_ANGULAR_VELOCITY;
  }

  // ── 4. Drag (matches server: setVelocity *= (1 − drag·speed − rolling)) ─
  const dragForce = PHYSICS_CONSTANTS.DRAG_COEFFICIENT * speed;
  const rollingResistance = PHYSICS_CONSTANTS.ROLLING_RESISTANCE;
  const dragFactor = 1 - dragForce - rollingResistance;
  vx *= dragFactor;
  vy *= dragFactor;

  // ── 5. Speed clamp (server uses pre-drag `speed` for comparison) ─
  const maxSpeed = input.nitro
    ? PHYSICS_CONSTANTS.MAX_SPEED * PHYSICS_CONSTANTS.NITRO_BOOST_MULTIPLIER
    : PHYSICS_CONSTANTS.MAX_SPEED;
  if (speed > maxSpeed) {
    const ratio = maxSpeed / speed;
    vx *= ratio;
    vy *= ratio;
  }

  // ── 6. Verlet integration (replaces Matter.js Body.update) ──────
  // v = v_prev × frictionAir + (F / m) × dt²
  vx = vx * MATTER_FRICTION_AIR + (forceX / SERVER_BODY_MASS) * MATTER_DT_SQUARED;
  vy = vy * MATTER_FRICTION_AIR + (forceY / SERVER_BODY_MASS) * MATTER_DT_SQUARED;

  // Angular: angVel × frictionAir  (torque / inertia = 0 due to Infinity inertia)
  angularVelocity *= MATTER_FRICTION_AIR;
  rotation += angularVelocity;

  // ── 7. Position update ──────────────────────────────────────────
  x += vx;
  y += vy;

  // Do NOT wrap — keep positions continuous for smooth camera/rendering.
  // Server wraps positions; reconciliation unwraps server state to match.
  return { x, y, rotation, vx, vy, angularVelocity };
}

/**
 * Reconcile server state with client prediction.
 *
 * Instead of replaying individual inputs (which doesn't work well because
 * pendingInputs are key-change events, not per-tick entries), we use
 * smooth error correction:
 *  - Velocity & rotation: blended toward server to avoid jarring snaps
 *    while keeping future prediction on track.
 *  - Position: gently blended toward server to avoid visible jumps.
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
    predictedState = { ...target, angularVelocity: target.angularVelocity ?? 0 };
    _debugInfo.serverUpdateCount++;
    _debugInfo.lastServerUpdateTime = performance.now();
    _debugInfo.snapped = true;
    _debugInfo.lastCorrectionDist = 0;
    return predictedState;
  }
  
  // --- Record debug deltas BEFORE correction ---
  const dvx = target.vx - predictedState.vx;
  const dvy = target.vy - predictedState.vy;
  const rotDiff = Math.atan2(
    Math.sin(target.rotation - predictedState.rotation),
    Math.cos(target.rotation - predictedState.rotation)
  );
  const dx = target.x - predictedState.x;
  const dy = target.y - predictedState.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  
  _debugInfo.lastVelocityDeltaX = dvx;
  _debugInfo.lastVelocityDeltaY = dvy;
  _debugInfo.lastRotationDelta = rotDiff;
  _debugInfo.lastCorrectionX = dx;
  _debugInfo.lastCorrectionY = dy;
  _debugInfo.lastCorrectionDist = dist;
  _debugInfo.serverUpdateCount++;
  _debugInfo.lastServerUpdateTime = performance.now();
  
  // --- Velocity: blend toward server (not hard snap) ---
  // A gentle blend keeps prediction smooth while drifting toward authority.
  const VEL_BLEND = 0.15; // 15 % correction per server update (~20 Hz)
  predictedState.vx += dvx * VEL_BLEND;
  predictedState.vy += dvy * VEL_BLEND;
  
  // --- Angular velocity: blend toward server ---
  const serverAngVel = target.angularVelocity ?? 0;
  const angVelDelta = serverAngVel - (predictedState.angularVelocity ?? 0);
  predictedState.angularVelocity = (predictedState.angularVelocity ?? 0) + angVelDelta * VEL_BLEND;
  
  // --- Rotation: blend toward server ---
  predictedState.rotation += rotDiff * 0.3;
  
  // --- Position: smooth correction ---
  const SNAP_THRESHOLD = 150; // px  – respawn, stuck reset, etc.
  const BLEND_FACTOR   = 0.1; // 10 % correction per server update (~20 Hz)
  
  if (dist > SNAP_THRESHOLD) {
    // Large discrepancy – hard snap
    predictedState.x = target.x;
    predictedState.y = target.y;
    predictedState.rotation = target.rotation;
    predictedState.vx = target.vx;
    predictedState.vy = target.vy;
    predictedState.angularVelocity = target.angularVelocity ?? 0;
    _debugInfo.snapped = true;
  } else if (dist > 0.5) {
    // Gradual correction
    predictedState.x += dx * BLEND_FACTOR;
    predictedState.y += dy * BLEND_FACTOR;
    _debugInfo.snapped = false;
  } else {
    _debugInfo.snapped = false;
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
  predictedState = { ...state, angularVelocity: state.angularVelocity ?? 0 };
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
    predictedState.angularVelocity = 0;
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
