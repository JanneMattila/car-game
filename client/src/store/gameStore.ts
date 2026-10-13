import { create } from 'zustand';
import {
  CarState,
  GameStateSnapshot,
  deserializeCarState,
  InputState,
  DEFAULT_INPUT_STATE,
  INTERPOLATION_DELAY_MS,
  PredictionOpponent,
  ServerClock,
  SnapshotInterpolator,
} from '@shared';
import { useNetworkStore } from './networkStore';
import { reconcileWithServer, initializePrediction, clearPrediction, predictFrame, setPredictionTrack, setPredictionOpponents } from '../game/clientPrediction';

// Opponent collisions are predicted at most this far ahead of the newest snapshot.
const MAX_OPPONENT_LEAD_MS = 250;

// Remote cars are rendered from timestamped snapshots, slightly in the past.
const remoteMotion = new SnapshotInterpolator();
const serverClock = new ServerClock();

interface InterpolatedCar extends CarState {
  targetPosition: { x: number; y: number };
  targetRotation: number;
  displayPosition: { x: number; y: number };
  displayRotation: number;
}

interface PredictedState {
  x: number;
  y: number;
  rotation: number;
  vx: number;
  vy: number;
  angularVelocity: number;
}

interface GameState {
  // Car states
  cars: Map<string, InterpolatedCar>;
  localPlayerId: string | null;
  
  // Race timing
  countdown: number | null; // null = no countdown, 3, 2, 1, 0 = GO!
  raceTimer: number; // Elapsed race time in ms
  
  // Overlay messages
  respawning: boolean; // Show respawning overlay
  
  // Input
  currentInput: InputState;
  inputSequence: number;
  
  // Timing
  lastServerUpdate: number;
  interpolationAlpha: number;
  
  // Actions
  setLocalPlayer: (playerId: string) => void;
  updateFromServer: (snapshot: GameStateSnapshot) => void;
  applyLocalPrediction: (predicted: PredictedState) => void;
  setInput: (input: Partial<InputState>) => void;
  resetInput: () => void;
  interpolate: (deltaTime: number) => void;
  interpolateCars: (deltaTime: number) => void; // Alias for interpolate
  getLocalCar: () => InterpolatedCar | null;
  getCar: (playerId: string) => InterpolatedCar | null;
  getAllCars: () => InterpolatedCar[];
  
  // Direct setters for testing/debugging
  setCars: (cars: Map<string, InterpolatedCar>) => void;
  setCarState: (playerId: string, state: Partial<InterpolatedCar>) => void;
  setCountdown: (value: number | null) => void;
  setRaceTimer: (value: number) => void;
  setRespawning: (value: boolean) => void;
  initializeCars: (carSnapshots: import('@shared').CarStateSnapshot[]) => void;
  
  reset: () => void;
}

export const useGameStore = create<GameState>((set, get) => ({
  cars: new Map(),
  localPlayerId: null,
  countdown: null,
  raceTimer: 0,
  respawning: false,
  currentInput: { ...DEFAULT_INPUT_STATE },
  inputSequence: 0,
  lastServerUpdate: 0,
  interpolationAlpha: 0,

  setLocalPlayer: (playerId) => {
    set({ localPlayerId: playerId });
  },

  updateFromServer: (snapshot) => {
    setPredictionTrack(useNetworkStore.getState().track);
    const { cars: currentCars, localPlayerId } = get();
    const newCars = new Map<string, InterpolatedCar>();
    serverClock.observe(snapshot.timestamp);
    remoteMotion.retain(new Set(snapshot.cars.map(car => car.playerId)));

    for (const carSnapshot of snapshot.cars) {
      const existingCar = currentCars.get(carSnapshot.playerId);
      const carState = deserializeCarState(carSnapshot, existingCar);
      const isLocalPlayer = carSnapshot.playerId === localPlayerId;

      const posIsInvalid = !Number.isFinite(carState.position.x) || !Number.isFinite(carState.position.y);
      
      if (posIsInvalid) {
        console.warn('Invalid/OOB car position from server:', {
          playerId: carSnapshot.playerId,
          pos: carState.position,
        });
        // Use existing position if available, otherwise skip
        if (existingCar) {
          newCars.set(carSnapshot.playerId, existingCar);
        }
        continue;
      }

      // For local player, use server reconciliation
      if (isLocalPlayer && existingCar) {
        // Reconcile with server state and replay unconfirmed inputs
        const reconciled = reconcileWithServer(
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
        
        const interpolatedCar: InterpolatedCar = {
          ...carState,
          position: { x: reconciled.x, y: reconciled.y },
          velocity: { x: reconciled.vx, y: reconciled.vy },
          rotation: reconciled.rotation,
          targetPosition: { x: reconciled.x, y: reconciled.y },
          targetRotation: reconciled.rotation,
          // Use reconciled position directly for smooth display
          displayPosition: { x: reconciled.x, y: reconciled.y },
          displayRotation: reconciled.rotation,
        };
        
        newCars.set(carSnapshot.playerId, interpolatedCar);
        continue;
      }

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

      const interpolatedCar: InterpolatedCar = {
        ...carState,
        targetPosition: { ...serverPos },
        targetRotation: carState.rotation,
        displayPosition: existingCar?.displayPosition ?? { ...serverPos },
        displayRotation: existingCar?.displayRotation ?? carState.rotation,
      };

      newCars.set(carSnapshot.playerId, interpolatedCar);
    }

    set({
      cars: newCars,
      lastServerUpdate: Date.now(),
      raceTimer: snapshot.gameState?.elapsedTime || 0,
    });
  },

  // Apply local prediction for immediate responsiveness
  applyLocalPrediction: (predicted) => {
    const { cars, localPlayerId } = get();
    if (!localPlayerId) return;
    
    const localCar = cars.get(localPlayerId);
    if (!localCar) return;
    
    const updatedCars = new Map(cars);
    updatedCars.set(localPlayerId, {
      ...localCar,
      displayPosition: { x: predicted.x, y: predicted.y },
      displayRotation: predicted.rotation,
      velocity: { x: predicted.vx, y: predicted.vy },
    });
    
    set({ cars: updatedCars });
  },

  setInput: (input) => {
    set(state => ({
      currentInput: { ...state.currentInput, ...input },
      inputSequence: state.inputSequence + 1,
    }));
  },

  resetInput: () => {
    set({ currentInput: { ...DEFAULT_INPUT_STATE } });
  },

  interpolate: (deltaTime) => {
    const { cars, localPlayerId } = get();
    const updatedCars = new Map<string, InterpolatedCar>();

    // Clamp deltaTime to prevent issues with large time gaps
    const clampedDeltaTime = Math.min(deltaTime, 0.1); // Max 100ms
    const synchronized = serverClock.synchronized;
    const renderTime = serverClock.serverTime() - INTERPOLATION_DELAY_MS;
    // The local car is predicted about one round trip ahead of the newest snapshot, so
    // opponents are extrapolated to the same moment for collision prediction.
    const opponentTime = serverClock.serverTime() + 2 * useNetworkStore.getState().latency;
    const opponents: PredictionOpponent[] = [];

    for (const [playerId, car] of cars) {
      if (playerId === localPlayerId) continue;

      const shown = synchronized ? remoteMotion.sample(playerId, renderTime) : null;
      const ahead = synchronized
        ? remoteMotion.sample(playerId, opponentTime, MAX_OPPONENT_LEAD_MS)
        : null;
      const displayPosition = shown && Number.isFinite(shown.position.x) && Number.isFinite(shown.position.y)
        ? shown.position
        : car.displayPosition;
      const displayRotation = shown && Number.isFinite(shown.rotation)
        ? shown.rotation
        : car.displayRotation;

      updatedCars.set(playerId, { ...car, displayPosition, displayRotation });
      opponents.push(ahead ? { playerId, ...ahead } : {
        playerId,
        position: displayPosition,
        rotation: displayRotation,
        velocity: car.velocity,
        angularVelocity: car.angularVelocity ?? 0,
      });
    }

    setPredictionTrack(useNetworkStore.getState().track);
    setPredictionOpponents(opponents);
    const localCar = localPlayerId ? cars.get(localPlayerId) : null;
    if (localCar && localPlayerId) {
      const predicted = useNetworkStore.getState().room?.state === 'racing'
        ? predictFrame(clampedDeltaTime, input => useNetworkStore.getState().sendPredictionInput(input))
        : null;
      updatedCars.set(localPlayerId, predicted ? {
        ...localCar,
        displayPosition: { x: predicted.x, y: predicted.y },
        displayRotation: predicted.rotation,
        velocity: { x: predicted.vx, y: predicted.vy },
      } : localCar);
    }
    set({ cars: updatedCars });
  },

  // Alias for interpolate - for component compatibility
  interpolateCars: (deltaTime) => {
    get().interpolate(deltaTime);
  },

  getLocalCar: () => {
    const { cars, localPlayerId } = get();
    if (!localPlayerId) return null;
    return cars.get(localPlayerId) || null;
  },

  getCar: (playerId) => {
    return get().cars.get(playerId) || null;
  },

  getAllCars: () => {
    return Array.from(get().cars.values());
  },

  setCars: (cars) => {
    set({ cars });
  },

  setCarState: (playerId, state) => {
    const { cars } = get();
    const existingCar = cars.get(playerId);
    if (existingCar) {
      const updatedCars = new Map(cars);
      updatedCars.set(playerId, { ...existingCar, ...state });
      set({ cars: updatedCars });
    }
  },

  setCountdown: (value) => {
    set({ countdown: value });
  },

  setRaceTimer: (value) => {
    set({ raceTimer: value });
  },

  setRespawning: (value) => {
    set({ respawning: value });
  },

  initializeCars: (carSnapshots) => {
    const { localPlayerId } = get();
    const newCars = new Map<string, InterpolatedCar>();
    for (const carSnapshot of carSnapshots) {
      const carState = deserializeCarState(carSnapshot, undefined);
      const interpolatedCar: InterpolatedCar = {
        ...carState,
        targetPosition: { ...carState.position },
        targetRotation: carState.rotation,
        displayPosition: { ...carState.position },
        displayRotation: carState.rotation,
      };
      newCars.set(carSnapshot.playerId, interpolatedCar);
      
      // Initialize prediction for local player
      if (carSnapshot.playerId === localPlayerId) {
        initializePrediction({
          x: carState.position.x,
          y: carState.position.y,
          rotation: carState.rotation,
          vx: carState.velocity.x,
          vy: carState.velocity.y,
          angularVelocity: carState.angularVelocity ?? 0,
          nitroAmount: carState.nitroAmount,
          layer: carState.layer,
        }, useNetworkStore.getState().track);
      }
    }
    set({ cars: newCars });
  },

  reset: () => {
    clearPrediction();
    remoteMotion.clear();
    serverClock.reset();
    set({
      cars: new Map(),
      currentInput: { ...DEFAULT_INPUT_STATE },
      inputSequence: 0,
      lastServerUpdate: 0,
      countdown: null,
      raceTimer: 0,
      respawning: false,
    });
  },
}));
