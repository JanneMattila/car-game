/**
 * Console Client for Car Game
 * 
 * A headless client that mirrors the web client exactly:
 * - Client-side prediction (simulateStep on every input)
 * - Server reconciliation (replay pending inputs on server state)
 * - Continuous prediction frames at 60fps (predictFrame)
 * - Interpolation for remote cars (position lerping)
 * - Track bounds / wrap-around handling
 * 
 * Usage: npm run dev:console
 * 
 * Environment variables:
 *   SERVER_URL    - Server URL (default: http://localhost:3000)
 *   TRACK_ID      - Track ID to play (default: Forever track)
 *   NICKNAME      - Bot nickname (default: ConsoleBot)
 *   LAP_COUNT     - Number of laps (default: 5)
 *   AUTO_DRIVE    - Enable auto-drive (default: true, set to "false" for manual)
 *   LOG_LEVEL     - Logging verbosity: full | summary | minimal (default: summary)
 */

import { io, Socket } from 'socket.io-client';
import readline from 'readline';
import {
  ClientMessage,
  ServerMessage,
  GameStateSnapshot,
  CarStateSnapshot,
  CarState,
  PlayerInput,
  GameSettings,
  RaceResult,
  Track,
  RoomInfo,
  Player,
  GameEvent,
  InputState,
  DEFAULT_INPUT_STATE,
  GAME_CONSTANTS,
  PHYSICS_CONSTANTS,
  RENDER_CONSTANTS,
  deserializeCarState,
  vec2Lerp,
  lerpAngle,
  vec2Distance,
} from '../shared/index.js';

// ── Client-side prediction ──────────────────────────────────────────
// Mirrors client/src/game/clientPrediction.ts exactly

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

// Prediction state (mirrors clientPrediction.ts module state)
const pendingInputs: InputRecord[] = [];
let lastConfirmedSequence = 0;
let predictedState: PredictedState | null = null;
let currentInput: InputRecord | null = null;
let trackBounds: TrackBounds | null = null;

const DELTA_TIME = 1 / 60;
const MAX_PENDING_INPUTS = 120;
let physicsAccumulator = 0;

function vec2Len(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

function vec2Norm(x: number, y: number): { x: number; y: number } {
  const len = vec2Len(x, y);
  if (len < 0.0001) return { x: 0, y: 0 };
  return { x: x / len, y: y / len };
}

function unwrapPosition(
  pos: { x: number; y: number },
  reference: { x: number; y: number }
): { x: number; y: number } {
  if (!trackBounds || !trackBounds.wrapAround) return pos;
  const w = trackBounds.width;
  const h = trackBounds.height;
  const kx = Math.round((reference.x - pos.x) / w);
  const ky = Math.round((reference.y - pos.y) / h);
  return { x: pos.x + kx * w, y: pos.y + ky * h };
}

function simulateStep(state: PredictedState, input: InputRecord): PredictedState {
  let { x, y, rotation, vx, vy } = state;

  const forwardX = Math.sin(rotation);
  const forwardY = -Math.cos(rotation);
  const speed = vec2Len(vx, vy);
  const forwardSpeed = vx * forwardX + vy * forwardY;
  const maxSpeed = PHYSICS_CONSTANTS.MAX_SPEED;

  // Acceleration / braking
  if (input.accelerate && speed < maxSpeed) {
    const speedRatio = speed / maxSpeed;
    const accelerationFactor = Math.max(0.15, 1 - speedRatio * 0.85);
    let accel = PHYSICS_CONSTANTS.ENGINE_FORCE * accelerationFactor * 0.02;
    if (input.nitro) accel *= PHYSICS_CONSTANTS.NITRO_BOOST_MULTIPLIER;
    vx += forwardX * accel;
    vy += forwardY * accel;
  }

  if (input.brake) {
    if (forwardSpeed > 0.2) {
      const brakeFactor = Math.max(0.9, 1 - PHYSICS_CONSTANTS.BRAKE_FORCE * 0.01);
      vx *= brakeFactor;
      vy *= brakeFactor;
    } else if (forwardSpeed > -PHYSICS_CONSTANTS.MAX_REVERSE_SPEED) {
      const reverseAccel = PHYSICS_CONSTANTS.REVERSE_FORCE * 0.012;
      vx -= forwardX * reverseAccel;
      vy -= forwardY * reverseAccel;
    }
  }

  // Steering
  const newSpeed = vec2Len(vx, vy);
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
      const speedFactor = Math.max(0.3, 1 - (newSpeed / maxSpeed) * 0.7);
      const steerAngle = PHYSICS_CONSTANTS.MAX_STEERING_ANGLE * steerInput * speedFactor;
      const turnRate = steerAngle * (forwardSpeed > 0 ? 1 : -1) * 0.08;
      rotation += turnRate;

      const grip = input.handbrake ? 0.85 : 0.95;
      const currentDir = vec2Norm(vx, vy);
      const newForwardX = Math.sin(rotation);
      const newForwardY = -Math.cos(rotation);
      const blendedX = currentDir.x * (1 - grip) + newForwardX * grip;
      const blendedY = currentDir.y * (1 - grip) + newForwardY * grip;
      const blended = vec2Norm(blendedX, blendedY);
      vx = blended.x * newSpeed;
      vy = blended.y * newSpeed;
    }
  }

  // Drag — use tuned constant that approximates server's manual drag + Matter.js frictionAir
  const dragFactor = 1 - PHYSICS_CONSTANTS.DRAG_COEFFICIENT;
  vx *= dragFactor;
  vy *= dragFactor;

  // Rolling resistance (only when not accelerating)
  const finalSpeedCheck = vec2Len(vx, vy);
  if (finalSpeedCheck > 0.1 && !input.accelerate) {
    const resistFactor = 1 - PHYSICS_CONSTANTS.ROLLING_RESISTANCE;
    vx *= resistFactor;
    vy *= resistFactor;
  }

  // Clamp speed
  const clampedSpeed = vec2Len(vx, vy);
  if (clampedSpeed > maxSpeed) {
    const scale = maxSpeed / clampedSpeed;
    vx *= scale;
    vy *= scale;
  }

  // Update position — NO wrapping (continuous space)
  x += vx;
  y += vy;

  return { x, y, rotation, vx, vy };
}

function recordInput(input: InputRecord): void {
  pendingInputs.push({ ...input });
  currentInput = { ...input };
  while (pendingInputs.length > MAX_PENDING_INPUTS) {
    pendingInputs.shift();
  }
}

function predictLocalMovement(currentState: PredictedState, input: InputRecord): PredictedState {
  const result = simulateStep(currentState, input);
  predictedState = result;
  return result;
}

function predictFrame(deltaTime: number = DELTA_TIME): PredictedState | null {
  if (!predictedState || !currentInput) return predictedState;
  physicsAccumulator += deltaTime;
  while (physicsAccumulator >= DELTA_TIME) {
    predictedState = simulateStep(predictedState, currentInput);
    physicsAccumulator -= DELTA_TIME;
  }
  return predictedState;
}

function reconcileWithServer(serverState: PredictedState, serverSequence: number): PredictedState {
  while (pendingInputs.length > 0 && pendingInputs[0]!.sequence <= serverSequence) {
    pendingInputs.shift();
  }
  lastConfirmedSequence = serverSequence;

  let target = { ...serverState };
  if (predictedState && trackBounds?.wrapAround) {
    const unwrapped = unwrapPosition(
      { x: target.x, y: target.y },
      { x: predictedState.x, y: predictedState.y }
    );
    target.x = unwrapped.x;
    target.y = unwrapped.y;
  }

  if (!predictedState) {
    predictedState = target;
    return predictedState;
  }

  // Snap velocity & rotation, blend position (matches web client)
  predictedState.vx = target.vx;
  predictedState.vy = target.vy;
  const rotDiff = Math.atan2(
    Math.sin(target.rotation - predictedState.rotation),
    Math.cos(target.rotation - predictedState.rotation)
  );
  predictedState.rotation += rotDiff * 0.5;

  const dx = target.x - predictedState.x;
  const dy = target.y - predictedState.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist > 150) {
    predictedState.x = target.x;
    predictedState.y = target.y;
    predictedState.rotation = target.rotation;
  } else if (dist > 0.5) {
    predictedState.x += dx * 0.3;
    predictedState.y += dy * 0.3;
  }

  return predictedState;
}

function initializePrediction(state: PredictedState): void {
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

function clearPrediction(): void {
  predictedState = null;
  pendingInputs.length = 0;
  lastConfirmedSequence = 0;
  currentInput = null;
  trackBounds = null;
  physicsAccumulator = 0;
}

function resetPredictionVelocity(): void {
  if (predictedState) {
    predictedState.vx = 0;
    predictedState.vy = 0;
  }
  pendingInputs.length = 0;
}

// ── Interpolated car state (mirrors gameStore.ts) ───────────────────

interface InterpolatedCar extends CarState {
  targetPosition: { x: number; y: number };
  targetRotation: number;
  displayPosition: { x: number; y: number };
  displayRotation: number;
}

function unwrapForTrack(
  pos: { x: number; y: number },
  ref: { x: number; y: number },
  trackWidth: number,
  trackHeight: number
): { x: number; y: number } {
  const wrapX = trackWidth;
  const wrapY = trackHeight;
  let { x, y } = pos;
  if (x - ref.x > wrapX / 2) x -= wrapX;
  else if (x - ref.x < -wrapX / 2) x += wrapX;
  if (y - ref.y > wrapY / 2) y -= wrapY;
  else if (y - ref.y < -wrapY / 2) y += wrapY;
  return { x, y };
}

// ── Configuration ──────────────────────────────────────────────────
const SERVER_URL = process.env['SERVER_URL'] || 'http://localhost:3000';
const TRACK_ID = process.env['TRACK_ID'] || 'track-1769970584891'; // Forever track
const NICKNAME = process.env['NICKNAME'] || 'ConsoleBot';
const LAP_COUNT = parseInt(process.env['LAP_COUNT'] || '5', 10);
const INPUT_TICK_MS = Math.round(1000 / GAME_CONSTANTS.PHYSICS_TICK_RATE);
const PREDICTION_TICK_MS = Math.round(1000 / 60); // 60fps prediction frames
const LOG_INTERVAL_MS = 500;
const AUTO_DRIVE = process.env['AUTO_DRIVE'] !== 'false';
const LOG_LEVEL = (process.env['LOG_LEVEL'] || 'summary') as 'full' | 'summary' | 'minimal';

// ── ANSI colors ────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

// ── State ──────────────────────────────────────────────────────────
let socket: Socket;
let playerId: string | null = null;
let room: RoomInfo | null = null;
let track: Track | null = null;
let latency = 0;
let serverTimeOffset = 0;
let sequenceNumber = 0;
let lastStateTimestamp = 0;
let lastLogTime = 0;
let gamePhase: string = 'connecting';
let raceStartTime = 0;

// Car states — mirrors gameStore.ts
const cars = new Map<string, InterpolatedCar>();

// Manual input state
let manualInput = {
  accelerate: false,
  brake: false,
  steerLeft: false,
  steerRight: false,
  nitro: false,
  handbrake: false,
  respawn: false,
};

// Stats tracking
const stats = {
  messagesReceived: 0,
  messagesSent: 0,
  stateUpdates: 0,
  predictionFrames: 0,
  reconciliations: 0,
  checkpoints: 0,
  laps: 0,
  collisions: 0,
  respawns: 0,
  errors: 0,
  connectTime: 0,
  lastLapTime: 0,
  bestLapTime: Infinity,
  avgLatency: 0,
  latencySamples: [] as number[],
  stateDeltaTimes: [] as number[],
  reconciliationDeltas: [] as number[], // position delta between predicted and reconciled
  pendingInputCounts: [] as number[],
};

// ── Logging helpers ────────────────────────────────────────────────
function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function log(category: string, color: string, message: string, data?: Record<string, unknown>): void {
  const ts = `${C.gray}[${timestamp()}]${C.reset}`;
  const cat = `${color}[${category.padEnd(8)}]${C.reset}`;
  const dataStr = data ? ` ${C.dim}${JSON.stringify(data)}${C.reset}` : '';
  console.log(`${ts} ${cat} ${message}${dataStr}`);
}

function logNet(msg: string, data?: Record<string, unknown>): void { log('NET', C.blue, msg, data); }
function logGame(msg: string, data?: Record<string, unknown>): void { log('GAME', C.green, msg, data); }
function logPhysics(msg: string, data?: Record<string, unknown>): void { log('PHYSICS', C.cyan, msg, data); }
function logEvent(msg: string, data?: Record<string, unknown>): void { log('EVENT', C.yellow, msg, data); }
function logPredict(msg: string, data?: Record<string, unknown>): void { log('PREDICT', C.magenta, msg, data); }
function logError(msg: string, data?: Record<string, unknown>): void { log('ERROR', C.red, msg, data); stats.errors++; }

function logCarState(): void {
  if (!playerId) return;
  const car = cars.get(playerId);
  if (!car) return;

  const now = Date.now();
  if (now - lastLogTime < LOG_INTERVAL_MS) return;
  lastLogTime = now;

  const dp = car.displayPosition;
  const tp = car.targetPosition;
  const vel = car.velocity;
  const speed = vec2Len(vel.x, vel.y);
  const predicted = predictedState;

  // Display position (what would be rendered)
  console.log(
    `${C.gray}[${timestamp()}]${C.reset} ${C.magenta}[CAR     ]${C.reset} ` +
    `display=(${C.bright}${dp.x.toFixed(1)}, ${dp.y.toFixed(1)}${C.reset}) ` +
    `server=(${tp.x.toFixed(1)}, ${tp.y.toFixed(1)}) ` +
    `rot=${(car.displayRotation * 180 / Math.PI).toFixed(1)}° ` +
    `speed=${C.bright}${speed.toFixed(1)}${C.reset} ` +
    `vel=(${vel.x.toFixed(2)}, ${vel.y.toFixed(2)}) ` +
    `lap=${C.yellow}${car.lap}${C.reset} cp=${car.checkpoint} ` +
    `pending=${pendingInputs.length} ` +
    `${car.finished ? C.green + 'FINISHED' + C.reset : ''}`
  );

  // Log prediction vs server delta
  if (predicted && LOG_LEVEL === 'full') {
    const dxP = predicted.x - tp.x;
    const dyP = predicted.y - tp.y;
    const dist = Math.sqrt(dxP * dxP + dyP * dyP);
    logPredict(`Prediction delta: ${dist.toFixed(1)}px`, {
      predicted: `(${predicted.x.toFixed(1)}, ${predicted.y.toFixed(1)})`,
      server: `(${tp.x.toFixed(1)}, ${tp.y.toFixed(1)})`,
      pendingInputs: pendingInputs.length,
    });
  }

  // Network stats periodically
  if (stats.stateUpdates % 20 === 0 && stats.stateUpdates > 0 && LOG_LEVEL !== 'minimal') {
    const avgDelta = stats.stateDeltaTimes.length > 0
      ? (stats.stateDeltaTimes.reduce((a, b) => a + b, 0) / stats.stateDeltaTimes.length).toFixed(1)
      : '?';
    const avgReconDelta = stats.reconciliationDeltas.length > 0
      ? (stats.reconciliationDeltas.reduce((a, b) => a + b, 0) / stats.reconciliationDeltas.length).toFixed(1)
      : '?';
    logNet('Stats', {
      latencyMs: latency.toFixed(1),
      avgStateDeltaMs: avgDelta,
      avgReconDeltaPx: avgReconDelta,
      stateUpdates: stats.stateUpdates,
      predictionFrames: stats.predictionFrames,
      reconciliations: stats.reconciliations,
      errors: stats.errors,
    });
  }
}

function logRaceResults(results: RaceResult[]): void {
  console.log('\n' + C.bright + C.yellow + '═══════════════════════════════════════' + C.reset);
  console.log(C.bright + '  RACE RESULTS' + C.reset);
  console.log(C.yellow + '═══════════════════════════════════════' + C.reset);

  for (const r of results) {
    const time = r.finished ? `${(r.totalTime / 1000).toFixed(2)}s` : 'DNF';
    const best = r.bestLapTime < Infinity ? `${(r.bestLapTime / 1000).toFixed(2)}s` : '-';
    const marker = r.playerId === playerId ? ` ${C.cyan}<- YOU${C.reset}` : '';
    console.log(
      `  ${C.bright}P${r.position}${C.reset} ${r.nickname.padEnd(16)} ` +
      `time=${C.green}${time}${C.reset} best_lap=${best} laps=${r.laps.length}${marker}`
    );
  }
  console.log(C.yellow + '═══════════════════════════════════════' + C.reset + '\n');
}

// ── Game state update (mirrors gameStore.ts updateFromServer) ───────

function updateFromServer(snapshot: GameStateSnapshot): void {
  const MAX_VALID_POSITION = 5000;

  for (const carSnapshot of snapshot.cars) {
    const existingCar = cars.get(carSnapshot.playerId);
    const carState = deserializeCarState(carSnapshot, existingCar);
    const isLocalPlayer = carSnapshot.playerId === playerId;

    // Validate position
    const posIsInvalid = !Number.isFinite(carState.position.x) || !Number.isFinite(carState.position.y) ||
      Math.abs(carState.position.x) > MAX_VALID_POSITION ||
      Math.abs(carState.position.y) > MAX_VALID_POSITION;

    if (posIsInvalid) {
      logError('Invalid car position from server', {
        playerId: carSnapshot.playerId,
        pos: carState.position,
      });
      continue;
    }

    // Local player: server reconciliation (mirrors gameStore.ts)
    if (isLocalPlayer && existingCar) {
      const preReconX = predictedState?.x ?? 0;
      const preReconY = predictedState?.y ?? 0;

      const reconciled = reconcileWithServer(
        {
          x: carState.position.x,
          y: carState.position.y,
          rotation: carState.rotation,
          vx: carState.velocity.x,
          vy: carState.velocity.y,
        },
        carSnapshot.lastInputSequence ?? snapshot.sequence
      );

      stats.reconciliations++;
      const reconDelta = Math.sqrt(
        (reconciled.x - preReconX) ** 2 + (reconciled.y - preReconY) ** 2
      );
      stats.reconciliationDeltas.push(reconDelta);
      if (stats.reconciliationDeltas.length > 100) stats.reconciliationDeltas.shift();
      stats.pendingInputCounts.push(pendingInputs.length);
      if (stats.pendingInputCounts.length > 100) stats.pendingInputCounts.shift();

      const interpolatedCar: InterpolatedCar = {
        ...carState,
        position: { x: reconciled.x, y: reconciled.y },
        velocity: { x: reconciled.vx, y: reconciled.vy },
        rotation: reconciled.rotation,
        targetPosition: { x: reconciled.x, y: reconciled.y },
        targetRotation: reconciled.rotation,
        displayPosition: { x: reconciled.x, y: reconciled.y },
        displayRotation: reconciled.rotation,
      };

      cars.set(carSnapshot.playerId, interpolatedCar);
      continue;
    }

    // Remote players: interpolation (mirrors gameStore.ts)
    let serverPos = { ...carState.position };
    if (existingCar && track?.wrapAround) {
      serverPos = unwrapForTrack(
        serverPos,
        existingCar.displayPosition,
        track.width,
        track.height
      );
    }

    const shouldSnap = existingCar
      ? vec2Distance(existingCar.displayPosition, serverPos) > RENDER_CONSTANTS.TELEPORT_THRESHOLD
      : true;

    const interpolatedCar: InterpolatedCar = {
      ...carState,
      targetPosition: { ...serverPos },
      targetRotation: carState.rotation,
      displayPosition: shouldSnap
        ? { ...serverPos }
        : existingCar?.displayPosition ?? { ...serverPos },
      displayRotation: shouldSnap
        ? carState.rotation
        : existingCar?.displayRotation ?? carState.rotation,
    };

    cars.set(carSnapshot.playerId, interpolatedCar);
  }
}

// ── Interpolation loop (mirrors gameStore.ts interpolate) ──────────

function interpolate(deltaTime: number): void {
  const lerpFactor = RENDER_CONSTANTS.POSITION_LERP_FACTOR;
  const rotationLerpFactor = RENDER_CONSTANTS.ROTATION_LERP_FACTOR;
  const clampedDeltaTime = Math.min(deltaTime, 0.1);

  for (const [pid, car] of cars) {
    // Local player: continuous prediction (mirrors gameStore.ts)
    if (pid === playerId) {
      const predicted = predictFrame(clampedDeltaTime);
      if (predicted) {
        stats.predictionFrames++;
        cars.set(pid, {
          ...car,
          displayPosition: { x: predicted.x, y: predicted.y },
          displayRotation: predicted.rotation,
          velocity: { x: predicted.vx, y: predicted.vy },
        });
      }
      continue;
    }

    // Remote players: lerp toward target (mirrors gameStore.ts)
    if (!Number.isFinite(car.displayPosition.x) || !Number.isFinite(car.displayPosition.y)) {
      car.displayPosition = { ...car.targetPosition };
    }
    if (!Number.isFinite(car.targetPosition.x) || !Number.isFinite(car.targetPosition.y)) {
      continue;
    }

    const newDisplayPosition = vec2Lerp(
      car.displayPosition,
      car.targetPosition,
      Math.min(1, lerpFactor * clampedDeltaTime * 60)
    );

    const newDisplayRotation = lerpAngle(
      car.displayRotation,
      car.targetRotation,
      Math.min(1, rotationLerpFactor * clampedDeltaTime * 60)
    );

    let finalPosition = (Number.isFinite(newDisplayPosition.x) && Number.isFinite(newDisplayPosition.y))
      ? newDisplayPosition
      : car.targetPosition;

    const MAX_WORLD_COORD = 1000000;
    if (Math.abs(finalPosition.x) > MAX_WORLD_COORD || Math.abs(finalPosition.y) > MAX_WORLD_COORD) {
      finalPosition = {
        x: Math.max(-MAX_WORLD_COORD, Math.min(MAX_WORLD_COORD, finalPosition.x)),
        y: Math.max(-MAX_WORLD_COORD, Math.min(MAX_WORLD_COORD, finalPosition.y)),
      };
    }

    cars.set(pid, {
      ...car,
      displayPosition: finalPosition,
      displayRotation: Number.isFinite(newDisplayRotation) ? newDisplayRotation : car.targetRotation,
    });
  }
}

// ── Initialize cars (mirrors gameStore.ts initializeCars) ──────────

function initializeCars(carSnapshots: CarStateSnapshot[]): void {
  for (const carSnapshot of carSnapshots) {
    const carState = deserializeCarState(carSnapshot, undefined);
    const interpolatedCar: InterpolatedCar = {
      ...carState,
      targetPosition: { ...carState.position },
      targetRotation: carState.rotation,
      displayPosition: { ...carState.position },
      displayRotation: carState.rotation,
    };
    cars.set(carSnapshot.playerId, interpolatedCar);

    // Initialize prediction for local player
    if (carSnapshot.playerId === playerId) {
      initializePrediction({
        x: carState.position.x,
        y: carState.position.y,
        rotation: carState.rotation,
        vx: carState.velocity.x,
        vy: carState.velocity.y,
      });
    }
  }
}

// ── Input ──────────────────────────────────────────────────────────

function getAutoDriveInput(): PlayerInput {
  sequenceNumber++;
  return {
    playerId: playerId!,
    sequence: sequenceNumber,
    timestamp: Date.now(),
    accelerate: true,
    brake: false,
    steerLeft: false,
    steerRight: false,
    steerValue: 0,
    nitro: false,
    handbrake: false,
    respawn: false,
  };
}

function getManualInput(): PlayerInput {
  sequenceNumber++;
  return {
    playerId: playerId!,
    sequence: sequenceNumber,
    timestamp: Date.now(),
    accelerate: manualInput.accelerate,
    brake: manualInput.brake,
    steerLeft: manualInput.steerLeft,
    steerRight: manualInput.steerRight,
    steerValue: manualInput.steerLeft ? -1 : manualInput.steerRight ? 1 : 0,
    nitro: manualInput.nitro,
    handbrake: manualInput.handbrake,
    respawn: manualInput.respawn,
  };
}

function sendInputAndPredict(): void {
  if (gamePhase !== 'racing' || !playerId) return;

  const input = AUTO_DRIVE ? getAutoDriveInput() : getManualInput();
  sendMessage({ type: 'input', input });

  // Record input for reconciliation (mirrors InputHandler.ts)
  const inputRecord: InputRecord = {
    sequence: input.sequence,
    timestamp: input.timestamp,
    accelerate: input.accelerate,
    brake: input.brake,
    steerLeft: input.steerLeft,
    steerRight: input.steerRight,
    steerValue: input.steerValue,
    nitro: input.nitro,
    handbrake: input.handbrake,
  };
  recordInput(inputRecord);

  // Apply local prediction immediately (mirrors InputHandler.ts)
  const localCar = cars.get(playerId);
  if (localCar) {
    const predicted = predictLocalMovement(
      {
        x: localCar.displayPosition.x,
        y: localCar.displayPosition.y,
        rotation: localCar.displayRotation,
        vx: localCar.velocity.x,
        vy: localCar.velocity.y,
      },
      inputRecord
    );

    cars.set(playerId, {
      ...localCar,
      displayPosition: { x: predicted.x, y: predicted.y },
      displayRotation: predicted.rotation,
      velocity: { x: predicted.vx, y: predicted.vy },
    });
  }

  // Reset one-shot inputs
  if (!AUTO_DRIVE) {
    manualInput.respawn = false;
  }
}

// ── Socket message handler ─────────────────────────────────────────

function handleMessage(message: ServerMessage): void {
  stats.messagesReceived++;

  switch (message.type) {
    case 'welcome':
      playerId = message.playerId;
      serverTimeOffset = Date.now() - message.serverTime;
      logNet(`Welcome! playerId=${C.bright}${playerId}${C.reset}`, { serverTimeOffset });
      gamePhase = 'connected';
      createRoom();
      break;

    case 'room_joined':
      room = message.room;
      logGame(`Joined room ${C.bright}${room.code}${C.reset}`, {
        roomId: room.id,
        trackId: room.trackId,
        trackName: room.trackName,
        playerCount: room.playerCount,
        lapCount: room.lapCount,
      });
      gamePhase = 'lobby';
      sendMessage({ type: 'set_ready', ready: true });
      setTimeout(() => {
        logGame('Starting game...');
        sendMessage({ type: 'start_game' });
      }, 500);
      break;

    case 'room_left':
      logGame(`Left room: ${message.reason}`);
      room = null;
      gamePhase = 'connected';
      break;

    case 'player_joined':
      logGame(`Player joined: ${message.player.nickname}`, {
        id: message.player.id,
        color: message.player.color,
      });
      break;

    case 'player_left':
      logGame(`Player left: ${message.playerId}`, { reason: message.reason });
      break;

    case 'player_ready':
      logGame(`Player ready: ${message.playerId} -> ${message.ready}`);
      break;

    case 'game_starting':
      track = message.track;
      gamePhase = 'countdown';

      // Set track bounds for prediction wrap-around (mirrors networkStore.ts)
      if (track) {
        trackBounds = {
          width: track.width,
          height: track.height,
          wrapAround: track.wrapAround ?? false,
        };
      }

      logGame('Game starting!', {
        countdown: message.countdown,
        trackId: track?.id,
        trackName: track?.name,
        trackSize: track ? `${track.width}x${track.height}` : '?',
        wrapAround: track?.wrapAround,
        elements: track?.elements.length,
        cars: message.cars.length,
      });

      // Initialize cars with prediction (mirrors networkStore.ts game_starting handler)
      initializeCars(message.cars);

      for (const car of message.cars) {
        logPhysics('Initial car position', {
          carId: car.id,
          playerId: car.playerId,
          pos: `(${car.x}, ${car.y})`,
          rotation: (car.rotation * 180 / Math.PI).toFixed(1) + '°',
        });
      }
      break;

    case 'countdown':
      logGame(`Countdown: ${C.bright}${message.count}${C.reset}`);
      break;

    case 'game_started':
      gamePhase = 'racing';
      raceStartTime = message.startTime;
      logGame(`${C.bright}${C.green}GO!${C.reset} Race started`);
      startGameLoops();
      break;

    case 'game_state':
      handleGameState(message.state);
      break;

    case 'checkpoint_passed':
      stats.checkpoints++;
      if (LOG_LEVEL !== 'minimal') {
        logEvent('Checkpoint passed', {
          playerId: message.playerId,
          checkpoint: message.checkpoint,
          time: `${(message.time / 1000).toFixed(2)}s`,
          isMine: message.playerId === playerId,
        });
      }
      break;

    case 'lap_completed':
      stats.laps++;
      stats.lastLapTime = message.lapTime;
      if (message.lapTime < stats.bestLapTime) {
        stats.bestLapTime = message.lapTime;
      }
      logEvent(`${C.bright}Lap ${message.lap} completed!${C.reset}`, {
        playerId: message.playerId,
        lap: message.lap,
        lapTime: `${(message.lapTime / 1000).toFixed(2)}s`,
        bestLap: `${(stats.bestLapTime / 1000).toFixed(2)}s`,
        isMine: message.playerId === playerId,
      });
      break;

    case 'player_finished':
      logEvent(`${C.bright}Player finished!${C.reset}`, {
        playerId: message.playerId,
        position: message.position,
        totalTime: `${(message.totalTime / 1000).toFixed(2)}s`,
        isMine: message.playerId === playerId,
      });
      break;

    case 'race_finished':
      gamePhase = 'results';
      logRaceResults(message.results);
      stopGameLoops();
      break;

    case 'collision':
      stats.collisions++;
      if (LOG_LEVEL === 'full') {
        logEvent('Collision', {
          carA: message.event.carA,
          carB: message.event.carB,
          impulse: message.event.impulse.toFixed(2),
        });
      }
      break;

    case 'track_list':
      logNet(`Received track list (${message.tracks.length} tracks)`);
      break;

    case 'room_list':
      logNet(`Received room list (${message.rooms.length} rooms)`);
      break;

    case 'pong':
      latency = (Date.now() - message.clientTimestamp) / 2;
      serverTimeOffset = message.serverTimestamp - Date.now() + latency;
      stats.latencySamples.push(latency);
      if (stats.latencySamples.length > 100) stats.latencySamples.shift();
      stats.avgLatency = stats.latencySamples.reduce((a, b) => a + b, 0) / stats.latencySamples.length;
      break;

    case 'error':
      logError(`Server error: ${message.message}`, { code: message.code });
      break;

    default:
      logNet(`Unhandled message type: ${(message as ServerMessage).type}`);
  }
}

function handleGameState(state: GameStateSnapshot): void {
  stats.stateUpdates++;

  // Track time between state updates
  const now = Date.now();
  if (lastStateTimestamp > 0) {
    const delta = now - lastStateTimestamp;
    stats.stateDeltaTimes.push(delta);
    if (stats.stateDeltaTimes.length > 100) stats.stateDeltaTimes.shift();
  }
  lastStateTimestamp = now;

  // Run updateFromServer (mirrors gameStore.ts)
  updateFromServer(state);

  // Check for respawn events (mirrors networkStore.ts game_state handler)
  if (state.events) {
    for (const event of state.events) {
      if (event.type === 'respawn' && event.playerId === playerId) {
        resetPredictionVelocity();
        stats.respawns++;
        logEvent('Respawn', { playerId: event.playerId });
      }
      handleGameEvent(event);
    }
  }

  // Log car state periodically
  logCarState();
}

function handleGameEvent(event: GameEvent): void {
  switch (event.type) {
    case 'boost_used':
      if (LOG_LEVEL === 'full') logEvent('Boost used', { playerId: event.playerId });
      break;
    case 'layer_change':
      if (LOG_LEVEL !== 'minimal') logEvent('Layer change', { playerId: event.playerId, layer: event.layer });
      break;
    default:
      break;
  }
}

// ── Send helpers ───────────────────────────────────────────────────

function sendMessage(message: ClientMessage): void {
  if (!socket?.connected) {
    logError('Cannot send: not connected');
    return;
  }
  socket.emit('message', message);
  stats.messagesSent++;
}

function createRoom(): void {
  const settings: GameSettings = {
    maxPlayers: 1,
    lapCount: LAP_COUNT,
    trackId: TRACK_ID,
    isPrivate: true,
    allowMidRaceJoin: false,
    enableChat: false,
  };

  logGame(`Creating room with track ${C.bright}${TRACK_ID}${C.reset}`, {
    lapCount: LAP_COUNT,
    maxPlayers: 1,
  });

  sendMessage({
    type: 'create_room',
    settings,
    nickname: NICKNAME,
    preferredColor: 'blue',
  });
}

// ── Game loops (mirrors web client game loop architecture) ──────────
// The web client has:
//   1. InputHandler: on keydown → sendInput + recordInput + predictLocalMovement (event-driven)
//   2. GameRenderer ticker: every frame → gameStore.interpolate(dt) which calls predictFrame()
//   3. networkStore._handleMessage: on game_state → gameStore.updateFromServer → reconcileWithServer
//
// Console client mirrors this with:
//   1. inputInterval: every INPUT_TICK_MS → sendInputAndPredict (recordInput + predictLocalMovement)
//   2. predictionInterval: every PREDICTION_TICK_MS → interpolate(dt) which calls predictFrame()
//   3. handleMessage 'game_state' → updateFromServer → reconcileWithServer

let inputInterval: ReturnType<typeof setInterval> | null = null;
let predictionInterval: ReturnType<typeof setInterval> | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let lastPredictionTime: number = 0;

function startGameLoops(): void {
  logGame(`Loops started: input=${INPUT_TICK_MS}ms prediction=${PREDICTION_TICK_MS}ms auto_drive=${AUTO_DRIVE}`);

  // Input loop at physics tick rate (60Hz)
  inputInterval = setInterval(sendInputAndPredict, INPUT_TICK_MS);

  // Prediction/interpolation loop at 60fps
  lastPredictionTime = performance.now();
  predictionInterval = setInterval(() => {
    const now = performance.now();
    const deltaTime = (now - lastPredictionTime) / 1000;
    lastPredictionTime = now;
    interpolate(deltaTime);
  }, PREDICTION_TICK_MS);
}

function stopGameLoops(): void {
  if (inputInterval) {
    clearInterval(inputInterval);
    inputInterval = null;
  }
  if (predictionInterval) {
    clearInterval(predictionInterval);
    predictionInterval = null;
  }
  logGame('Game loops stopped');
}

// ── Keyboard input (manual mode) ───────────────────────────────────

function setupKeyboardInput(): void {
  if (AUTO_DRIVE) {
    console.log(`${C.dim}Auto-drive enabled. Set AUTO_DRIVE=false to control manually.${C.reset}`);
    console.log(`${C.dim}Press Ctrl+C to quit.${C.reset}\n`);
    return;
  }

  if (!process.stdin.isTTY) {
    console.log(`${C.dim}No TTY available for keyboard input, using auto-drive.${C.reset}\n`);
    return;
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);

  console.log(`${C.bright}Manual control mode:${C.reset}`);
  console.log(`  W/Up = Accelerate  S/Down = Brake`);
  console.log(`  A/Left = Steer Left  D/Right = Steer Right`);
  console.log(`  Space = Nitro  H = Handbrake  R = Respawn`);
  console.log(`  Q/Ctrl+C = Quit\n`);

  process.stdin.on('keypress', (_str: string, key: readline.Key) => {
    if (!key) return;
    if ((key.ctrl && key.name === 'c') || key.name === 'q') {
      shutdown();
      return;
    }

    switch (key.name) {
      case 'w': case 'up':
        manualInput.accelerate = !manualInput.accelerate;
        break;
      case 's': case 'down':
        manualInput.brake = !manualInput.brake;
        break;
      case 'a': case 'left':
        manualInput.steerLeft = !manualInput.steerLeft;
        if (manualInput.steerLeft) manualInput.steerRight = false;
        break;
      case 'd': case 'right':
        manualInput.steerRight = !manualInput.steerRight;
        if (manualInput.steerRight) manualInput.steerLeft = false;
        break;
      case 'space':
        manualInput.nitro = !manualInput.nitro;
        break;
      case 'h':
        manualInput.handbrake = !manualInput.handbrake;
        break;
      case 'r':
        manualInput.respawn = true;
        break;
    }
  });
}

// ── Connection ─────────────────────────────────────────────────────

function connect(): void {
  console.log(C.bright + C.cyan);
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║  Car Game Console Client (Full Prediction)    ║');
  console.log('║  Mirrors web client: prediction + recon + lerp║');
  console.log('╚═══════════════════════════════════════════════╝');
  console.log(C.reset);

  logNet(`Connecting to ${C.bright}${SERVER_URL}${C.reset}...`);
  stats.connectTime = Date.now();

  socket = io(SERVER_URL, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 2000,
  });

  socket.on('connect', () => {
    const elapsed = Date.now() - stats.connectTime;
    logNet(`${C.green}Connected!${C.reset} (${elapsed}ms)`, { socketId: socket.id });
  });

  socket.on('disconnect', (reason) => {
    logNet(`${C.red}Disconnected:${C.reset} ${reason}`);
    stopGameLoops();
    gamePhase = 'disconnected';
  });

  socket.on('connect_error', (err) => {
    logError(`Connection error: ${err.message}`);
  });

  socket.on('reconnect_attempt', (attempt) => {
    logNet(`Reconnecting... attempt ${attempt}`);
  });

  socket.on('reconnect', () => {
    logNet(`${C.green}Reconnected!${C.reset}`);
  });

  socket.on('message', (msg: ServerMessage) => {
    handleMessage(msg);
  });

  // Periodic ping
  pingInterval = setInterval(() => {
    if (socket?.connected) {
      sendMessage({ type: 'ping', timestamp: Date.now() });
    }
  }, 3000);
}

// ── Shutdown ───────────────────────────────────────────────────────

function shutdown(): void {
  console.log('\n');
  logNet('Shutting down...');

  stopGameLoops();
  if (pingInterval) clearInterval(pingInterval);

  console.log('\n' + C.bright + '═══ Session Stats ═══' + C.reset);
  console.log(`  Messages sent:       ${stats.messagesSent}`);
  console.log(`  Messages received:   ${stats.messagesReceived}`);
  console.log(`  State updates:       ${stats.stateUpdates}`);
  console.log(`  Prediction frames:   ${stats.predictionFrames}`);
  console.log(`  Reconciliations:     ${stats.reconciliations}`);
  console.log(`  Checkpoints:         ${stats.checkpoints}`);
  console.log(`  Laps:                ${stats.laps}`);
  console.log(`  Collisions:          ${stats.collisions}`);
  console.log(`  Respawns:            ${stats.respawns}`);
  console.log(`  Errors:              ${stats.errors}`);
  console.log(`  Avg latency:         ${stats.avgLatency.toFixed(1)}ms`);
  if (stats.bestLapTime < Infinity) {
    console.log(`  Best lap:            ${(stats.bestLapTime / 1000).toFixed(2)}s`);
  }
  if (stats.reconciliationDeltas.length > 0) {
    const avg = stats.reconciliationDeltas.reduce((a, b) => a + b, 0) / stats.reconciliationDeltas.length;
    const max = Math.max(...stats.reconciliationDeltas);
    console.log(`  Recon delta:         avg=${avg.toFixed(1)}px max=${max.toFixed(1)}px`);
  }
  if (stats.pendingInputCounts.length > 0) {
    const avg = stats.pendingInputCounts.reduce((a, b) => a + b, 0) / stats.pendingInputCounts.length;
    const max = Math.max(...stats.pendingInputCounts);
    console.log(`  Pending inputs:      avg=${avg.toFixed(1)} max=${max}`);
  }
  if (stats.stateDeltaTimes.length > 0) {
    const avg = stats.stateDeltaTimes.reduce((a, b) => a + b, 0) / stats.stateDeltaTimes.length;
    const min = Math.min(...stats.stateDeltaTimes);
    const max = Math.max(...stats.stateDeltaTimes);
    console.log(`  State delta:         avg=${avg.toFixed(1)}ms min=${min}ms max=${max}ms`);
  }
  console.log(C.bright + '═════════════════════' + C.reset + '\n');

  if (socket) {
    socket.disconnect();
  }
  process.exit(0);
}

// ── Main ───────────────────────────────────────────────────────────

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

setupKeyboardInput();
connect();
