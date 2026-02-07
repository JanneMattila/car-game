import { create } from 'zustand';
import {
  CarState,
  GameStateSnapshot,
  deserializeCarState,
  InputState,
  DEFAULT_INPUT_STATE,
  RENDER_CONSTANTS,
  PHYSICS_CONSTANTS,
} from '@shared';
import { useNetworkStore } from './networkStore';
import { vec2Lerp, lerpAngle, vec2Distance } from '@shared';
import { reconcileWithServer, initializePrediction, clearPrediction, predictFrame } from '../game/clientPrediction';

/**
 * Unwrap a position into the same coordinate space as a reference position.
 * Prevents false teleport-snaps and bad interpolation when positions straddle a wrap boundary.
 */
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
    const { cars: currentCars, localPlayerId, inputSequence } = get();
    const newCars = new Map<string, InterpolatedCar>();
    const MAX_VALID_POSITION = 5000; // Track is typically <3000

    for (const carSnapshot of snapshot.cars) {
      const existingCar = currentCars.get(carSnapshot.playerId);
      const carState = deserializeCarState(carSnapshot, existingCar);
      const isLocalPlayer = carSnapshot.playerId === localPlayerId;

      // Validate position - check for NaN, Infinity, or unreasonable values
      const posIsInvalid = !Number.isFinite(carState.position.x) || !Number.isFinite(carState.position.y) ||
                          Math.abs(carState.position.x) > MAX_VALID_POSITION || 
                          Math.abs(carState.position.y) > MAX_VALID_POSITION;
      
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

      // For remote players, use interpolation
      // For wrap-around tracks, unwrap server position relative to current display
      // so distance checks and lerp don't jump across the wrap boundary
      const track = useNetworkStore.getState().track;
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
    const lerpFactor = RENDER_CONSTANTS.POSITION_LERP_FACTOR;
    const rotationLerpFactor = RENDER_CONSTANTS.ROTATION_LERP_FACTOR;

    const updatedCars = new Map<string, InterpolatedCar>();

    // Clamp deltaTime to prevent issues with large time gaps
    const clampedDeltaTime = Math.min(deltaTime, 0.1); // Max 100ms

    for (const [playerId, car] of cars) {
      // For local player, run continuous prediction (only during racing)
      if (playerId === localPlayerId) {
        const room = useNetworkStore.getState().room;
        const predicted = room?.state === 'racing' ? predictFrame(clampedDeltaTime) : null;
        if (predicted) {
          updatedCars.set(playerId, {
            ...car,
            displayPosition: { x: predicted.x, y: predicted.y },
            displayRotation: predicted.rotation,
            velocity: { x: predicted.vx, y: predicted.vy },
          });
        } else {
          updatedCars.set(playerId, car);
        }
        continue;
      }
      
      // Validate existing values for remote players
      if (!Number.isFinite(car.displayPosition.x) || !Number.isFinite(car.displayPosition.y)) {
        console.error('Invalid displayPosition detected, resetting to target:', playerId, car.displayPosition);
        car.displayPosition = { ...car.targetPosition };
      }
      if (!Number.isFinite(car.targetPosition.x) || !Number.isFinite(car.targetPosition.y)) {
        console.error('Invalid targetPosition detected:', playerId, car.targetPosition);
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

      // Final validation - if values are invalid, keep existing
      // Also add a hard clamp to prevent runaway positions
      let finalPosition = (Number.isFinite(newDisplayPosition.x) && Number.isFinite(newDisplayPosition.y))
        ? newDisplayPosition
        : car.targetPosition;
      
      // Hard clamp position to reasonable world bounds
      // With continuous (unwrapped) positions on wrap-around tracks, positions grow over laps
      // (e.g., 100 laps × 600px = 60,000), so use a generous limit
      const MAX_WORLD_COORD = 1000000;
      if (Math.abs(finalPosition.x) > MAX_WORLD_COORD || Math.abs(finalPosition.y) > MAX_WORLD_COORD) {
        console.warn('Client position exceeded world bounds, clamping:', finalPosition);
        finalPosition = {
          x: Math.max(-MAX_WORLD_COORD, Math.min(MAX_WORLD_COORD, finalPosition.x)),
          y: Math.max(-MAX_WORLD_COORD, Math.min(MAX_WORLD_COORD, finalPosition.y)),
        };
      }

      updatedCars.set(playerId, {
        ...car,
        displayPosition: finalPosition,
        displayRotation: Number.isFinite(newDisplayRotation) ? newDisplayRotation : car.targetRotation,
      });
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
        });
      }
    }
    set({ cars: newCars });
  },

  reset: () => {
    clearPrediction();
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
