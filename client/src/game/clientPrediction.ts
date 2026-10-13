// Browser-side prediction state: one PredictionEngine for the local car.
// The engine itself lives in shared/ so the console client runs identical code.

import {
  PredictionEngine,
  type PredictedState,
  type PredictionControls,
  type PredictionInput,
  type PredictionOpponent,
  type ReconciliationDebugInfo,
  type Track,
} from '@shared';

export type { PredictedState, PredictionControls, PredictionInput, ReconciliationDebugInfo };

const engine = new PredictionEngine();

/** Get reconciliation debug info (read-only snapshot) */
export function getReconciliationDebug(): Readonly<ReconciliationDebugInfo> {
  return engine.debug;
}

export function setPredictionTrack(track: Track | null, reset = false): void {
  engine.setTrack(track, reset);
}

export function setPredictionOpponents(cars: readonly PredictionOpponent[]): void {
  engine.setOpponents(cars);
}

/** Controls currently held by the player (keyboard, touch or tilt). */
export function setCurrentInput(controls: PredictionControls): void {
  engine.setControls(controls);
}

/** Sends a respawn request with the next physics step's input. */
export function requestRespawn(): void {
  engine.requestRespawn();
}

/** Simulates one step from an explicit state. */
export function predictLocalMovement(
  currentState: PredictedState,
  input: PredictionControls
): PredictedState & { nitroAmount: number } {
  return engine.predictLocalMovement(currentState, input);
}

/**
 * Advances prediction in fixed 60 Hz steps, passing each step's input to `send`, and returns
 * the render-interpolated state to display.
 */
export function predictFrame(
  deltaTime?: number,
  send?: (input: PredictionInput) => void
): PredictedState | null {
  return engine.predictFrame(deltaTime, send);
}

/** Reconciles a server snapshot of the local car that includes inputs up to `serverSequence`. */
export function reconcileWithServer(
  serverState: PredictedState,
  serverSequence: number
): PredictedState {
  return engine.reconcile(serverState, serverSequence);
}

export function getPredictedState(): PredictedState | null {
  return engine.getPredictedState();
}

export function initializePrediction(state: PredictedState, track: Track | null = null): void {
  engine.initialize(state, track);
}

export function clearPrediction(): void {
  engine.clear();
}

/** A confirmed respawn of the local car. */
export function handlePredictionRespawn(): void {
  engine.handleRespawn();
}

/** Inputs sent but not yet acknowledged by the server. */
export function getPendingInputCount(): number {
  return engine.getPendingInputCount();
}

/**
 * Immediately simulates and sends one step with the held controls. Used when controls are
 * released while the page is being hidden, because hidden pages stop the render loop that
 * normally sends inputs and the server would otherwise keep the previous controls held.
 */
export function flushInputStep(send: (input: PredictionInput) => void): void {
  engine.predictFrame(undefined, send);
}
