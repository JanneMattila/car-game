import { PHYSICS_CONSTANTS } from '../constants/physics';
import { getSteeringInput } from '../types/input';
import { Track } from '../types/track';
import { RoadSurfaceIndex, drivingResistance } from './drivingResistance';
import { stepNitro } from './nitro';
import { PredictionOpponent, WallPredictionWorld } from './wallPhysics';

export interface PredictedState {
  x: number;
  y: number;
  rotation: number;
  vx: number;
  vy: number;
  angularVelocity: number;
  /** Omitted only by legacy callers starting with a full tank. */
  nitroAmount?: number;
  layer?: number;
}

/** Controls held by the player, independent of which device produced them. */
export interface PredictionControls {
  accelerate: boolean;
  brake: boolean;
  steerLeft: boolean;
  steerRight: boolean;
  steerValue: number;
  nitro: boolean;
  handbrake: boolean;
}

/** Input for exactly one 60 Hz physics step; the server applies one per tick as well. */
export interface PredictionInput extends PredictionControls {
  sequence: number;
  timestamp: number;
  respawn?: boolean;
}

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
  /** Server updates that disagreed with the local prediction and required a replay. */
  replays: number;
  wallContacts: number;
  wallCollisionSteps: number;
  carContacts: number;
  carCollisionSteps: number;
}

interface HistoryEntry {
  input: PredictionInput;
  /** Predicted state after applying the input, compared with the server's result. */
  state: PredictedState;
}

export const PREDICTION_STEP_SECONDS = 1 / 60;
// About 3 seconds of unacknowledged inputs.
const MAX_HISTORY = 180;
// Corrections larger than this are teleports (respawns), shown immediately.
const SNAP_THRESHOLD = 150;
// Small corrections are blended out of the display over roughly this time.
const ERROR_SMOOTHING_SECONDS = 0.1;
// Snapshots are rounded (0.01 px, 0.01 px/frame, 0.001 rad); smaller differences are noise.
const POSITION_TOLERANCE = 0.25;
const VELOCITY_TOLERANCE = 0.05;
const ROTATION_TOLERANCE = 0.005;

// ── Server-matching constants ──────────────────────────────────────
const SERVER_BODY_MASS = PHYSICS_CONSTANTS.CAR_BODY_MASS;
const MATTER_DT = 1000 / 60; // ms – same as baseDelta
const MATTER_DT_SQUARED = MATTER_DT * MATTER_DT; // ≈ 277.78
const MATTER_FRICTION_AIR = 1 - 0.01; // 0.99 – body.frictionAir = 0.01

const NEUTRAL_CONTROLS: PredictionControls = {
  accelerate: false,
  brake: false,
  steerLeft: false,
  steerRight: false,
  steerValue: 0,
  nitro: false,
  handbrake: false,
};

function angleDifference(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

/**
 * Client-side prediction with server reconciliation.
 *
 * Every 60 Hz step consumes the held controls as one numbered input, which is simulated locally,
 * remembered with its resulting state and sent to the server. The server applies the same inputs
 * one per tick and reports the last one applied. When a snapshot disagrees with what was
 * predicted for that input, prediction restarts from the authoritative state and replays the
 * inputs the server has not processed yet. The visible car eases out of small corrections.
 */
export class PredictionEngine {
  private history: HistoryEntry[] = [];
  private predictedState: PredictedState | null = null;
  private previousState: PredictedState | null = null;
  private controls: PredictionControls | null = null;
  private sequence = 0;
  private respawnRequested = false;
  private accumulator = 0;
  private offset = { x: 0, y: 0, rotation: 0 };
  private track: Track | null = null;
  private wallWorld: WallPredictionWorld | null = null;
  private roadSurface: RoadSurfaceIndex | null = null;

  readonly debug: ReconciliationDebugInfo = {
    lastCorrectionDist: 0,
    lastCorrectionX: 0,
    lastCorrectionY: 0,
    lastVelocityDeltaX: 0,
    lastVelocityDeltaY: 0,
    lastRotationDelta: 0,
    snapped: false,
    serverUpdateCount: 0,
    lastServerUpdateTime: 0,
    replays: 0,
    wallContacts: 0,
    wallCollisionSteps: 0,
    carContacts: 0,
    carCollisionSteps: 0,
  };

  setTrack(track: Track | null, reset = false): void {
    if (this.track === track && !reset) return;
    this.wallWorld?.dispose();
    this.track = track;
    this.roadSurface = track ? new RoadSurfaceIndex(track) : null;
    this.wallWorld = track ? new WallPredictionWorld(track) : null;
    this.debug.wallContacts = 0;
    this.debug.carContacts = 0;
  }

  setOpponents(cars: readonly PredictionOpponent[]): void {
    if (!this.wallWorld && cars.length > 0) this.wallWorld = new WallPredictionWorld(this.track);
    this.wallWorld?.setOpponents(cars);
    this.debug.carContacts = this.wallWorld?.carContacts ?? 0;
  }

  /** Controls held from now on, from any input device. */
  setControls(controls: PredictionControls): void {
    this.controls = {
      accelerate: controls.accelerate,
      brake: controls.brake,
      steerLeft: controls.steerLeft,
      steerRight: controls.steerRight,
      steerValue: controls.steerValue,
      nitro: controls.nitro,
      handbrake: controls.handbrake,
    };
  }

  /** Respawn is a one-shot request carried by the next step's input. */
  requestRespawn(): void {
    this.respawnRequested = true;
  }

  getPredictedState(): PredictedState | null {
    return this.predictedState;
  }

  getPendingInputCount(): number {
    return this.history.length;
  }

  /** Simulates one step from an explicit state, e.g. for tests or immediate feedback. */
  predictLocalMovement(
    state: PredictedState,
    input: PredictionControls
  ): PredictedState & { nitroAmount: number } {
    const result = this.simulateStep(state, input);
    this.predictedState = result;
    return result;
  }

  /**
   * Advances prediction by real elapsed time in fixed 60 Hz steps, sending one input per step.
   * Returns the state to display, interpolated between steps and eased out of corrections.
   */
  predictFrame(
    deltaTime: number = PREDICTION_STEP_SECONDS,
    send?: (input: PredictionInput) => void
  ): PredictedState | null {
    if (!this.predictedState || !this.controls) return this.predictedState;

    this.accumulator += deltaTime;
    while (this.accumulator >= PREDICTION_STEP_SECONDS) {
      const input: PredictionInput = {
        ...this.controls,
        sequence: ++this.sequence,
        timestamp: Date.now(),
        respawn: this.respawnRequested,
      };
      this.respawnRequested = false;
      this.previousState = { ...this.predictedState };
      this.predictedState = this.simulateStep(this.predictedState, input);
      this.history.push({ input, state: this.predictedState });
      if (this.history.length > MAX_HISTORY) this.history.shift();
      send?.(input);
      this.accumulator -= PREDICTION_STEP_SECONDS;
    }

    const decay = Math.exp(-deltaTime / ERROR_SMOOTHING_SECONDS);
    this.offset.x *= decay;
    this.offset.y *= decay;
    this.offset.rotation *= decay;

    const current = this.predictedState;
    const previous = this.previousState ?? current;
    const alpha = this.accumulator / PREDICTION_STEP_SECONDS;
    const display: PredictedState = {
      x: previous.x + (current.x - previous.x) * alpha + this.offset.x,
      y: previous.y + (current.y - previous.y) * alpha + this.offset.y,
      rotation:
        previous.rotation + (current.rotation - previous.rotation) * alpha + this.offset.rotation,
      vx: current.vx,
      vy: current.vy,
      angularVelocity: current.angularVelocity,
      nitroAmount: current.nitroAmount,
      layer: current.layer,
    };
    return this.wallWorld?.constrain(display) ?? display;
  }

  /**
   * Reconciles a server snapshot of the local car, which reflects all inputs up to and
   * including `serverSequence`. Returns the corrected predicted state.
   */
  reconcile(serverState: PredictedState, serverSequence: number): PredictedState {
    this.debug.serverUpdateCount++;
    this.debug.lastServerUpdateTime = performance.now();
    const authoritative: PredictedState = {
      ...serverState,
      angularVelocity: serverState.angularVelocity ?? 0,
    };

    if (!this.predictedState) {
      this.predictedState = authoritative;
      this.debug.snapped = true;
      this.debug.lastCorrectionDist = 0;
      return this.predictedState;
    }

    let predictedAtServer: PredictedState | null = null;
    while (this.history.length > 0 && this.history[0]!.input.sequence <= serverSequence) {
      const entry = this.history.shift()!;
      if (entry.input.sequence === serverSequence) predictedAtServer = entry.state;
    }

    // What the client believed the server state would be, for diagnostics and the decision.
    const reference = predictedAtServer ?? this.predictedState;
    this.debug.lastVelocityDeltaX = authoritative.vx - reference.vx;
    this.debug.lastVelocityDeltaY = authoritative.vy - reference.vy;
    this.debug.lastRotationDelta = angleDifference(authoritative.rotation, reference.rotation);

    if (predictedAtServer && this.matches(predictedAtServer, authoritative)) {
      this.debug.lastCorrectionDist = 0;
      this.debug.lastCorrectionX = 0;
      this.debug.lastCorrectionY = 0;
      this.debug.snapped = false;
      return this.predictedState;
    }

    const before = this.predictedState;
    const teleported =
      Math.hypot(authoritative.x - reference.x, authoritative.y - reference.y) > SNAP_THRESHOLD;
    if (teleported) {
      // Respawns must not carry contacts from the previous location.
      this.wallWorld?.reset();
      this.debug.wallContacts = 0;
      this.debug.carContacts = 0;
    }

    let state = authoritative;
    let previous: PredictedState | null = null;
    for (const entry of this.history) {
      previous = state;
      state = this.simulateStep(state, entry.input);
      entry.state = state;
    }
    this.predictedState = state;
    this.debug.replays++;

    const dx = state.x - before.x;
    const dy = state.y - before.y;
    const distance = Math.hypot(dx, dy);
    this.debug.lastCorrectionX = dx;
    this.debug.lastCorrectionY = dy;
    this.debug.lastCorrectionDist = distance;

    if (teleported || distance > SNAP_THRESHOLD) {
      this.offset = { x: 0, y: 0, rotation: 0 };
      this.previousState = previous;
      this.debug.snapped = true;
    } else {
      // Keep the displayed car where it was and ease the difference out over a few frames.
      const rotation = angleDifference(state.rotation, before.rotation);
      this.offset.x -= dx;
      this.offset.y -= dy;
      this.offset.rotation -= rotation;
      if (this.previousState) {
        this.previousState = {
          ...this.previousState,
          x: this.previousState.x + dx,
          y: this.previousState.y + dy,
          rotation: this.previousState.rotation + rotation,
        };
      }
      this.debug.snapped = false;
    }
    return this.predictedState;
  }

  private matches(predicted: PredictedState, server: PredictedState): boolean {
    return (
      Math.abs(predicted.x - server.x) <= POSITION_TOLERANCE &&
      Math.abs(predicted.y - server.y) <= POSITION_TOLERANCE &&
      Math.abs(predicted.vx - server.vx) <= VELOCITY_TOLERANCE &&
      Math.abs(predicted.vy - server.vy) <= VELOCITY_TOLERANCE &&
      Math.abs(angleDifference(predicted.rotation, server.rotation)) <= ROTATION_TOLERANCE &&
      Math.abs(predicted.angularVelocity - server.angularVelocity) <= ROTATION_TOLERANCE
    );
  }

  initialize(state: PredictedState, track: Track | null = null): void {
    this.setTrack(null, true);
    this.setTrack(track);
    this.debug.wallCollisionSteps = 0;
    this.debug.carCollisionSteps = 0;
    this.debug.replays = 0;
    this.predictedState = { ...state, angularVelocity: state.angularVelocity ?? 0 };
    this.previousState = null;
    this.history = [];
    this.sequence = 0;
    this.respawnRequested = false;
    this.accumulator = 0;
    this.offset = { x: 0, y: 0, rotation: 0 };
    this.controls = { ...NEUTRAL_CONTROLS };
  }

  clear(): void {
    this.setTrack(null, true);
    this.debug.wallCollisionSteps = 0;
    this.debug.carCollisionSteps = 0;
    this.predictedState = null;
    this.previousState = null;
    this.history = [];
    this.sequence = 0;
    this.respawnRequested = false;
    this.controls = null;
    this.accumulator = 0;
    this.offset = { x: 0, y: 0, rotation: 0 };
  }

  /** A confirmed respawn: drop contacts from the old location and any easing toward it. */
  handleRespawn(): void {
    this.wallWorld?.reset();
    this.debug.wallContacts = 0;
    this.debug.carContacts = 0;
    this.offset = { x: 0, y: 0, rotation: 0 };
  }

  /**
   * One physics step. This MUST match the server's pipeline (PhysicsEngine.updateCar followed by
   * Matter's Verlet integration with frictionAir) to keep reconciliation replays rare.
   */
  private simulateStep(
    state: PredictedState,
    input: PredictionControls
  ): PredictedState & { nitroAmount: number } {
    let { x, y, rotation, vx, vy, angularVelocity } = state;
    const nitro = stepNitro(
      state.nitroAmount ?? PHYSICS_CONSTANTS.NITRO_MAX,
      input.nitro,
      PREDICTION_STEP_SECONDS
    );
    const resistance = drivingResistance(
      this.roadSurface ? this.roadSurface.isAsphalt({ x, y }, state.layer ?? 0) : true,
      this.wallWorld?.forceScale ?? 1
    );

    const forwardX = Math.sin(rotation);
    const forwardY = -Math.cos(rotation);
    const speed = Math.hypot(vx, vy);
    const forwardSpeed = vx * forwardX + vy * forwardY;
    const isMovingForward = forwardSpeed > 0.5;
    const isMovingBackward = forwardSpeed < -0.5;

    // 1. Forces, consumed by the Verlet step below.
    let forceX = 0;
    let forceY = 0;
    if (input.accelerate && speed < PHYSICS_CONSTANTS.MAX_SPEED) {
      forceX += forwardX * PHYSICS_CONSTANTS.ENGINE_FORCE * 0.001 * resistance.forceScale;
      forceY += forwardY * PHYSICS_CONSTANTS.ENGINE_FORCE * 0.001 * resistance.forceScale;
    }
    if (nitro.boostScale > 0) {
      const boost =
        PHYSICS_CONSTANTS.ENGINE_FORCE * 0.0015 * nitro.boostScale * resistance.forceScale;
      forceX += forwardX * boost;
      forceY += forwardY * boost;
    }

    // 2. Direct velocity changes (setVelocity on the server).
    if (input.brake) {
      if (isMovingForward && forwardSpeed > 1) {
        vx *= 0.95;
        vy *= 0.95;
      } else if (speed < PHYSICS_CONSTANTS.MAX_REVERSE_SPEED) {
        forceX -= forwardX * PHYSICS_CONSTANTS.REVERSE_FORCE * 0.001 * resistance.forceScale;
        forceY -= forwardY * PHYSICS_CONSTANTS.REVERSE_FORCE * 0.001 * resistance.forceScale;
      }
    }

    // 3. Steering.
    const steerInput = getSteeringInput(input);
    if (steerInput !== 0) {
      if (speed > 0.5) {
        let speedFactor: number;
        if (speed < 3) speedFactor = speed / 3;
        else if (speed < 15) speedFactor = 1.0;
        else speedFactor = Math.max(0.5, 15 / speed);
        const turnForce = steerInput * PHYSICS_CONSTANTS.MAX_STEERING_ANGLE * 0.18 * speedFactor;
        angularVelocity = turnForce * (isMovingBackward ? -1 : 1);
      }
    } else {
      angularVelocity *= 0.85;
    }
    if (Math.abs(angularVelocity) > PHYSICS_CONSTANTS.MAX_ANGULAR_VELOCITY) {
      angularVelocity = Math.sign(angularVelocity) * PHYSICS_CONSTANTS.MAX_ANGULAR_VELOCITY;
    }

    // 4. Drag, 5. speed clamp (both use the speed at the start of the step, like the server).
    const dragFactor =
      1 - PHYSICS_CONSTANTS.DRAG_COEFFICIENT * speed - resistance.rollingResistance;
    vx *= dragFactor;
    vy *= dragFactor;
    const maxSpeed =
      resistance.speedScale *
      (nitro.boostScale > 0
        ? PHYSICS_CONSTANTS.MAX_SPEED * PHYSICS_CONSTANTS.NITRO_BOOST_MULTIPLIER
        : PHYSICS_CONSTANTS.MAX_SPEED);
    if (speed > maxSpeed) {
      const ratio = maxSpeed / speed;
      vx *= ratio;
      vy *= ratio;
    }

    // 6. Verlet integration (Matter's Body.update): v = v·frictionAir + (F/m)·dt².
    vx = vx * MATTER_FRICTION_AIR + (forceX / SERVER_BODY_MASS) * MATTER_DT_SQUARED;
    vy = vy * MATTER_FRICTION_AIR + (forceY / SERVER_BODY_MASS) * MATTER_DT_SQUARED;
    angularVelocity *= MATTER_FRICTION_AIR;
    rotation += angularVelocity;
    x += vx;
    y += vy;

    const next = { x, y, rotation, vx, vy, angularVelocity };
    const result = this.wallWorld ? this.wallWorld.resolve(state, next) : next;
    this.debug.wallContacts = this.wallWorld?.contacts ?? 0;
    if (this.debug.wallContacts > 0) this.debug.wallCollisionSteps++;
    this.debug.carContacts = this.wallWorld?.carContacts ?? 0;
    if (this.debug.carContacts > 0) this.debug.carCollisionSteps++;
    return { ...result, nitroAmount: nitro.amount, layer: state.layer ?? 0 };
  }
}
