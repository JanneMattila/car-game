import { useEffect, useCallback, useRef } from 'react';
import { useGameStore } from '../store/gameStore';
import { useNetworkStore } from '../store/networkStore';
import { InputState, DEFAULT_INPUT_STATE } from '@shared';
import { flushInputStep, requestRespawn, setCurrentInput } from './clientPrediction';

/** Returns true when the race is actively running (not countdown, not waiting, etc.) */
function isRacing(): boolean {
  const room = useNetworkStore.getState().room;
  return room?.state === 'racing';
}

/**
 * Every input device (keyboard, touch, tilt) reports the controls it currently holds here.
 * Prediction turns the held controls into one numbered input per 60 Hz physics step, simulates
 * it locally and sends it to the server, so all devices get the same responsive handling.
 */
function applyControls(input: InputState): void {
  useGameStore.getState().setInput(input);
  setCurrentInput(input);
}

/** Re-applies held controls when the race starts, since no new key/touch event may occur. */
function useReapplyOnRaceStart(apply: () => void): void {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const roomState = useNetworkStore(state => state.room?.state);
  useEffect(() => {
    if (roomState === 'racing') applyRef.current();
  }, [roomState]);
}

export function useKeyboardInput() {
  const keys = useRef<Record<string, boolean>>({});

  const updateInput = useCallback(() => {
    const keyState = keys.current;
    const steerLeft = keyState['KeyA'] || keyState['ArrowLeft'] || false;
    const steerRight = keyState['KeyD'] || keyState['ArrowRight'] || false;

    applyControls({
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
    });
  }, []);

  // Holding a key before the countdown ends never triggers a new keydown event.
  useReapplyOnRaceStart(updateInput);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in input
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      
      const code = e.code;
      if (!keys.current[code]) {
        keys.current[code] = true;
        if (code === 'KeyR' && isRacing()) requestRespawn();
        updateInput();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const code = e.code;
      if (keys.current[code]) {
        keys.current[code] = false;
        updateInput();
      }
    };

    const releaseKeys = () => {
      keys.current = {};
      updateInput();
      if (isRacing()) {
        flushInputStep(input => useNetworkStore.getState().sendPredictionInput(input));
      }
    };
    const handleVisibilityChange = () => {
      if (document.hidden) releaseKeys();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', releaseKeys);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', releaseKeys);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      releaseKeys();
    };
  }, [updateInput]);
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
  const updateTouchInput = useCallback(() => {
    const steerLeft = touchState.activeLeft;
    const steerRight = touchState.activeRight;

    applyControls({
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
    });
  }, []);

  useReapplyOnRaceStart(updateTouchInput);

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

        // Merge with the throttle/brake currently held on the touch controls.
        applyControls({
          ...useGameStore.getState().currentInput,
          steerLeft,
          steerRight,
          turnLeft: steerLeft,  // Alias
          turnRight: steerRight, // Alias
          steerValue: steerLeft || steerRight ? normalizedTilt : 0,
        });
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
  }, [enabled]);
}
