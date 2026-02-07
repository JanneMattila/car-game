import { useEffect, useCallback, useRef } from 'react';
import { useGameStore } from '../store/gameStore';
import { useNetworkStore } from '../store/networkStore';
import { InputState, DEFAULT_INPUT_STATE } from '@shared';
import { recordInput } from './clientPrediction';

/** Returns true when the race is actively running (not countdown, not waiting, etc.) */
function isRacing(): boolean {
  const room = useNetworkStore.getState().room;
  return room?.state === 'racing';
}

// Keyboard state
const keyState: Record<string, boolean> = {};
let inputSequence = 0;

export function useKeyboardInput() {
  const { sendInput } = useNetworkStore();
  const { setInput } = useGameStore();
  const updateInputRef = useRef<() => void>();

  const updateInput = useCallback(() => {
    const steerLeft = keyState['KeyA'] || keyState['ArrowLeft'] || false;
    const steerRight = keyState['KeyD'] || keyState['ArrowRight'] || false;
    
    inputSequence++;
    
    const input: InputState = {
      ...DEFAULT_INPUT_STATE,
      accelerate: keyState['KeyW'] || keyState['ArrowUp'] || false,
      brake: keyState['KeyS'] || keyState['ArrowDown'] || false,
      steerLeft,
      steerRight,
      turnLeft: steerLeft,  // Alias
      turnRight: steerRight, // Alias
      steerValue: steerLeft ? -1 : steerRight ? 1 : 0,
      nitro: keyState['Space'] || keyState['ShiftLeft'] || false,
      boost: keyState['Space'] || keyState['ShiftLeft'] || false, // Alias
      handbrake: keyState['KeyX'] || false,
      respawn: keyState['KeyR'] || false,
      sequenceNumber: inputSequence,
    };

    setInput(input);

    // Only send movement inputs when the race is actively running
    if (!isRacing()) return;

    sendInput(input);
    
    // Record input for server reconciliation
    // The render loop's predictFrame() handles all physics stepping —
    // we do NOT do prediction here to avoid double-step jitter.
    recordInput({
      sequence: inputSequence,
      timestamp: Date.now(),
      accelerate: input.accelerate,
      brake: input.brake,
      steerLeft: input.steerLeft,
      steerRight: input.steerRight,
      steerValue: input.steerValue,
      nitro: input.nitro,
      handbrake: input.handbrake,
    });
  }, [setInput, sendInput]);

  // Keep a stable ref so the racing-start effect can call it
  updateInputRef.current = updateInput;

  // When the room transitions to 'racing', re-evaluate and send the current
  // key state. This fixes the bug where holding a key BEFORE the countdown
  // ends never triggers a new keydown event, so the input is never sent.
  const roomState = useNetworkStore(state => state.room?.state);
  useEffect(() => {
    if (roomState === 'racing') {
      updateInputRef.current?.();
    }
  }, [roomState]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in input
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      
      const code = e.code;
      if (!keyState[code]) {
        keyState[code] = true;
        updateInput();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const code = e.code;
      if (keyState[code]) {
        keyState[code] = false;
        updateInput();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [updateInput]);

  // --- Continuous input sending at physics tick rate ---
  // The server runs physics at 60Hz using the most recent input.
  // Sending input only on key-change means the server might process
  // stale input for many ticks. A low-rate polling loop ensures the
  // server always has fresh state AND gives proper sequence numbers
  // that align with prediction ticks for accurate reconciliation.
  useEffect(() => {
    const TICK_MS = 1000 / 20; // 20Hz is enough to keep server in sync
    const id = setInterval(() => {
      if (!isRacing()) return;
      // Re-send current key state (updateInput increments sequence)
      updateInputRef.current?.();
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);
}

// Touch controls state
interface TouchState {
  accelerate: HTMLElement | null;
  brake: HTMLElement | null;
  leftZone: HTMLElement | null;
  rightZone: HTMLElement | null;
  activeLeft: boolean;
  activeRight: boolean;
  showControls: boolean;
}

const touchState: TouchState = {
  accelerate: null,
  brake: null,
  leftZone: null,
  rightZone: null,
  activeLeft: false,
  activeRight: false,
  showControls: false,
};

export function useTouchInput() {
  const { sendInput } = useNetworkStore();
  const { setInput } = useGameStore();

  const updateTouchInput = useCallback(() => {
    const steerLeft = touchState.activeLeft;
    const steerRight = touchState.activeRight;
    
    const input: InputState = {
      ...DEFAULT_INPUT_STATE,
      accelerate: touchState.accelerate !== null,
      brake: touchState.brake !== null,
      steerLeft,
      steerRight,
      turnLeft: steerLeft,  // Alias
      turnRight: steerRight, // Alias
      steerValue: steerLeft ? -1 : steerRight ? 1 : 0,
      nitro: false,
      boost: false,
      handbrake: false,
      respawn: false,
      sequenceNumber: Date.now(),
    };

    setInput(input);
    sendInput(input);
  }, [setInput, sendInput]);

  // Check if device supports touch
  useEffect(() => {
    touchState.showControls = 'ontouchstart' in window;
  }, []);

  return {
    showTouchControls: touchState.showControls,
    handleAccelerateStart: () => {
      touchState.accelerate = document.body;
      updateTouchInput();
    },
    handleAccelerateEnd: () => {
      touchState.accelerate = null;
      updateTouchInput();
    },
    handleBrakeStart: () => {
      touchState.brake = document.body;
      updateTouchInput();
    },
    handleBrakeEnd: () => {
      touchState.brake = null;
      updateTouchInput();
    },
    handleLeftStart: () => {
      touchState.activeLeft = true;
      updateTouchInput();
    },
    handleLeftEnd: () => {
      touchState.activeLeft = false;
      updateTouchInput();
    },
    handleRightStart: () => {
      touchState.activeRight = true;
      updateTouchInput();
    },
    handleRightEnd: () => {
      touchState.activeRight = false;
      updateTouchInput();
    },
  };
}

// Tilt-to-steer using device orientation
export function useTiltInput(enabled: boolean = false) {
  const { sendInput } = useNetworkStore();
  const { setInput, currentInput } = useGameStore();

  useEffect(() => {
    if (!enabled) return;

    let lastTiltValue = 0;

    const handleOrientation = (e: DeviceOrientationEvent) => {
      const gamma = e.gamma || 0; // -90 to 90 degrees (left-right tilt)
      const threshold = 5;
      const maxTilt = 30;

      // Normalize tilt to -1 to 1 range
      const normalizedTilt = Math.max(-1, Math.min(1, gamma / maxTilt));
      
      if (Math.abs(normalizedTilt - lastTiltValue) > 0.05) {
        lastTiltValue = normalizedTilt;

        const steerLeft = normalizedTilt < -threshold / maxTilt;
        const steerRight = normalizedTilt > threshold / maxTilt;

        const input: InputState = {
          ...currentInput,
          steerLeft,
          steerRight,
          turnLeft: steerLeft,  // Alias
          turnRight: steerRight, // Alias
          steerValue: normalizedTilt,
          sequenceNumber: Date.now(),
        };

        setInput(input);
        sendInput(input);
      }
    };

    // Request permission on iOS
    if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
      (DeviceOrientationEvent as any).requestPermission()
        .then((response: string) => {
          if (response === 'granted') {
            window.addEventListener('deviceorientation', handleOrientation);
          }
        })
        .catch(console.error);
    } else {
      window.addEventListener('deviceorientation', handleOrientation);
    }

    return () => {
      window.removeEventListener('deviceorientation', handleOrientation);
    };
  }, [enabled, setInput, sendInput, currentInput]);
}
