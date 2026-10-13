/**
 * Console Client for Car Game
 * 
 * A headless client that mirrors the web client exactly:
 * - Client-side prediction (shared PredictionEngine, one input per 60 Hz step)
 * - Server reconciliation (replay unacknowledged inputs when the server disagrees)
 * - Continuous prediction frames at 60fps (predictFrame)
 * - Snapshot interpolation for remote cars
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
 *   ROOM_CODE     - Join an existing room and wait for its host instead of creating a solo race
 *   DRIVE_PATTERN - straight | circle-left | circle-right | figure-eight (default: straight)
 *   LOG_LEVEL     - Logging verbosity: full | summary | minimal (default: summary)
 */

import { io, Socket } from 'socket.io-client';
import readline from 'readline';
import { getDrivingInput, parseDrivePattern } from './driving.js';
import {
  ClientMessage,
  ServerMessage,
  GameStateSnapshot,
  CarStateSnapshot,
  CarState,
  GameSettings,
  RaceResult,
  Track,
  RoomInfo,
  Player,
  GameEvent,
  GAME_CONSTANTS,
  INTERPOLATION_DELAY_MS,
  PredictionEngine,
  PredictionOpponent,
  ServerClock,
  SnapshotInterpolator,
  deserializeCarState,
} from '../shared/index.js';

// ── Client-side prediction and remote interpolation ─────────────────
// The same shared engine as the browser (client/src/game/clientPrediction.ts): one input per
// 60 Hz step is simulated, remembered and sent; server snapshots that disagree are replayed.
const prediction = new PredictionEngine();
// Remote cars are drawn from timestamped snapshots slightly in the past (mirrors gameStore.ts).
const remoteMotion = new SnapshotInterpolator();
const serverClock = new ServerClock();
// Opponent collisions are predicted at most this far ahead of the newest snapshot.
const MAX_OPPONENT_LEAD_MS = 250;

function vec2Len(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

// ── Interpolated car state (mirrors gameStore.ts) ───────────────────

interface InterpolatedCar extends CarState {
  targetPosition: { x: number; y: number };
  targetRotation: number;
  displayPosition: { x: number; y: number };
  displayRotation: number;
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
const ROOM_CODE = process.env['ROOM_CODE']?.trim().toUpperCase();
const DRIVE_PATTERN = parseDrivePattern(process.env['DRIVE_PATTERN']);
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
  const predicted = prediction.getPredictedState();

  // Display position (what would be rendered)
  console.log(
    `${C.gray}[${timestamp()}]${C.reset} ${C.magenta}[CAR     ]${C.reset} ` +
    `display=(${C.bright}${dp.x.toFixed(1)}, ${dp.y.toFixed(1)}${C.reset}) ` +
    `server=(${tp.x.toFixed(1)}, ${tp.y.toFixed(1)}) ` +
    `rot=${(car.displayRotation * 180 / Math.PI).toFixed(1)}° ` +
    `speed=${C.bright}${speed.toFixed(1)}${C.reset} ` +
    `vel=(${vel.x.toFixed(2)}, ${vel.y.toFixed(2)}) ` +
    `lap=${C.yellow}${car.lap}${C.reset} cp=${car.checkpoint} ` +
    `pending=${prediction.getPendingInputCount()} replays=${prediction.debug.replays} ` +
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
      pendingInputs: prediction.getPendingInputCount(),
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
  const activeIds = new Set(snapshot.cars.map(car => car.playerId));
  for (const id of cars.keys()) {
    if (!activeIds.has(id)) cars.delete(id);
  }
  serverClock.observe(snapshot.timestamp);
  remoteMotion.retain(activeIds);
  for (const carSnapshot of snapshot.cars) {
    const existingCar = cars.get(carSnapshot.playerId);
    const carState = deserializeCarState(carSnapshot, existingCar);
    const isLocalPlayer = carSnapshot.playerId === playerId;

    // Validate position
    const posIsInvalid = !Number.isFinite(carState.position.x) || !Number.isFinite(carState.position.y);

    if (posIsInvalid) {
      logError('Invalid car position from server', {
        playerId: carSnapshot.playerId,
        pos: carState.position,
      });
      continue;
    }

    // Local player: server reconciliation (mirrors gameStore.ts)
    if (isLocalPlayer && existingCar) {
      const preRecon = prediction.getPredictedState();
      const reconciled = prediction.reconcile(
        {
          x: carState.position.x,
          y: carState.position.y,
          rotation: carState.rotation,
          vx: carState.velocity.x,
          vy: carState.velocity.y,
          angularVelocity: carState.angularVelocity ?? 0,
          nitroAmount: carState.nitroAmount,
          layer: carState.layer,
        },
        carSnapshot.lastInputSequence ?? snapshot.sequence
      );

      stats.reconciliations++;
      const reconDelta = Math.sqrt(
        (reconciled.x - (preRecon?.x ?? reconciled.x)) ** 2 +
        (reconciled.y - (preRecon?.y ?? reconciled.y)) ** 2
      );
      stats.reconciliationDeltas.push(reconDelta);
      if (stats.reconciliationDeltas.length > 100) stats.reconciliationDeltas.shift();
      stats.pendingInputCounts.push(prediction.getPendingInputCount());
      if (stats.pendingInputCounts.length > 100) stats.pendingInputCounts.shift();

      cars.set(carSnapshot.playerId, {
        ...carState,
        position: { x: reconciled.x, y: reconciled.y },
        velocity: { x: reconciled.vx, y: reconciled.vy },
        rotation: reconciled.rotation,
        targetPosition: { x: carState.position.x, y: carState.position.y },
        targetRotation: carState.rotation,
        displayPosition: existingCar.displayPosition,
        displayRotation: existingCar.displayRotation,
      });
      continue;
    }

    // Remote players: timestamped snapshot buffer (mirrors gameStore.ts)
    const serverPos = carState.position;
    remoteMotion.push(carSnapshot.playerId, {
      time: snapshot.timestamp,
      x: serverPos.x,
      y: serverPos.y,
      rotation: carState.rotation,
      vx: carState.velocity.x,
      vy: carState.velocity.y,
      angularVelocity: carState.angularVelocity ?? 0,
    });
    cars.set(carSnapshot.playerId, {
      ...carState,
      targetPosition: { ...serverPos },
      targetRotation: carState.rotation,
      displayPosition: existingCar?.displayPosition ?? { ...serverPos },
      displayRotation: existingCar?.displayRotation ?? carState.rotation,
    });
  }
}

// ── Interpolation loop (mirrors gameStore.ts interpolate) ──────────

function interpolate(deltaTime: number): void {
  const clampedDeltaTime = Math.min(deltaTime, 0.1);
  const synchronized = serverClock.synchronized;
  const renderTime = serverClock.serverTime() - INTERPOLATION_DELAY_MS;
  // The local car is predicted about one round trip ahead of the newest snapshot.
  const opponentTime = serverClock.serverTime() + 2 * latency;
  const opponents: PredictionOpponent[] = [];

  for (const [pid, car] of cars) {
    if (pid === playerId) continue;
    const shown = synchronized ? remoteMotion.sample(pid, renderTime) : null;
    const ahead = synchronized ? remoteMotion.sample(pid, opponentTime, MAX_OPPONENT_LEAD_MS) : null;
    const displayPosition = shown?.position ?? car.displayPosition;
    const displayRotation = shown?.rotation ?? car.displayRotation;
    cars.set(pid, { ...car, displayPosition, displayRotation });
    opponents.push(ahead ? { playerId: pid, ...ahead } : {
      playerId: pid,
      position: displayPosition,
      rotation: displayRotation,
      velocity: car.velocity,
      angularVelocity: car.angularVelocity ?? 0,
    });
  }
  prediction.setOpponents(opponents);

  const localCar = playerId ? cars.get(playerId) : null;
  if (localCar && playerId && gamePhase === 'racing') {
    const predicted = prediction.predictFrame(clampedDeltaTime, input => {
      sendMessage({ type: 'input', input: { ...input, playerId: playerId!, respawn: !!input.respawn } });
    });
    if (predicted) {
      stats.predictionFrames++;
      cars.set(playerId, {
        ...localCar,
        displayPosition: { x: predicted.x, y: predicted.y },
        displayRotation: predicted.rotation,
        velocity: { x: predicted.vx, y: predicted.vy },
      });
    }
  }
}

// ── Initialize cars (mirrors gameStore.ts initializeCars) ──────────

function initializeCars(carSnapshots: CarStateSnapshot[]): void {
  remoteMotion.clear();
  serverClock.reset();
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
      prediction.initialize({
        x: carState.position.x,
        y: carState.position.y,
        rotation: carState.rotation,
        vx: carState.velocity.x,
        vy: carState.velocity.y,
        angularVelocity: carState.angularVelocity ?? 0,
        nitroAmount: carState.nitroAmount,
        layer: carState.layer,
      }, track);
    }
  }
}

// ── Input ──────────────────────────────────────────────────────────

/**
 * Updates the held controls (mirrors InputHandler.ts). Prediction turns them into one input per
 * physics step and sends it, exactly like the browser.
 */
function updateControls(): void {
  if (gamePhase !== 'racing' || !playerId) return;
  if (AUTO_DRIVE) {
    prediction.setControls(getDrivingInput(DRIVE_PATTERN, Date.now() - raceStartTime));
    return;
  }
  prediction.setControls({
    accelerate: manualInput.accelerate,
    brake: manualInput.brake,
    steerLeft: manualInput.steerLeft,
    steerRight: manualInput.steerRight,
    steerValue: manualInput.steerLeft ? -1 : manualInput.steerRight ? 1 : 0,
    nitro: manualInput.nitro,
    handbrake: manualInput.handbrake,
  });
  if (manualInput.respawn) {
    prediction.requestRespawn();
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
      if (ROOM_CODE) {
        sendMessage({
          type: 'join_room',
          code: ROOM_CODE,
          nickname: NICKNAME,
          preferredColor: 'blue',
        });
      } else {
        createRoom();
      }
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
      if (!ROOM_CODE) {
        setTimeout(() => {
          logGame('Starting game...');
          sendMessage({ type: 'start_game' });
        }, 500);
      }
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
      prediction.clear();
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
        prediction.handleRespawn();
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
//   1. InputHandler: on key/touch/tilt changes → setCurrentInput (held controls)
//   2. GameRenderer ticker: every frame → gameStore.interpolate(dt) → predictFrame(dt, send),
//      which simulates and sends one input per 60 Hz step
//   3. networkStore._handleMessage: on game_state → gameStore.updateFromServer → reconcile
//
// Console client mirrors this with:
//   1. inputInterval: every INPUT_TICK_MS → updateControls (held controls)
//   2. predictionInterval: every PREDICTION_TICK_MS → interpolate(dt) → predictFrame(dt, send)
//   3. handleMessage 'game_state' → updateFromServer → reconcile

let inputInterval: ReturnType<typeof setInterval> | null = null;
let predictionInterval: ReturnType<typeof setInterval> | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let lastPredictionTime: number = 0;

function startGameLoops(): void {
  stopGameLoops();
  logGame(`Loops started: input=${INPUT_TICK_MS}ms prediction=${PREDICTION_TICK_MS}ms auto_drive=${AUTO_DRIVE}`);
  if (AUTO_DRIVE) logGame(`Driving pattern: ${DRIVE_PATTERN}`);

  // Held-controls loop at physics tick rate (60Hz)
  updateControls();
  inputInterval = setInterval(updateControls, INPUT_TICK_MS);

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
  prediction.clear();
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
