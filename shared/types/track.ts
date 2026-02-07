// Track types

import { Vector2 } from './physics';

/** Current track format version supported by the system */
export const CURRENT_TRACK_VERSION = 1;

export interface Track {
  id: string;
  version: number;
  name: string;
  author: string;
  createdAt: number;
  updatedAt: number;
  difficulty: TrackDifficulty;
  defaultLapCount: number;
  width: number;
  height: number;
  // Infinite scroll: when enabled, cars wrap around to opposite edge
  wrapAround?: boolean;
  elements: TrackElement[];
  scenery: SceneryItem[];
}

export type TrackDifficulty = 'easy' | 'medium' | 'hard' | 'extreme';



// Simple track element types for editor and rendering
export type TrackElementType = 
  | 'select'       // Selection tool (does not create elements)
  | 'road'
  | 'road_curve'
  | 'wall'
  | 'checkpoint'
  | 'finish'
  | 'boost'
  | 'oil'
  | 'spawn'
  | 'boost_pad'
  | 'ramp'
  | 'ramp_up'      // Transitions car to layer+1
  | 'ramp_down'    // Transitions car to layer-1
  | 'bridge'       // Road segment at elevated layer
  | 'oil_slick'
  | 'barrier'
  | 'car'          // Visual reference tool (not saved)
  | 'tire_stack'
  | 'pit_stop';

export interface TrackElement {
  id: string;
  type: TrackElementType;
  // Direct position properties for simple access
  x: number;
  y: number;
  // Position object for backward compatibility
  position: Vector2;
  width: number;
  height: number;
  rotation: number;
  checkpointIndex?: number;
  // Layer for bridges/overpasses: 0 = ground, 1 = bridge, -1 = tunnel
  layer?: number;
  properties?: TrackElementProperties;
}

export interface TrackElementProperties {
  // Boost pad
  boostAmount?: number;
  boostDuration?: number;
  
  // Ramp
  launchAngle?: number;
  launchForce?: number;
  
  // Oil slick
  frictionMultiplier?: number;
  
  // Pit stop
  repairRate?: number;
  speedLimit?: number;
}

export interface SceneryItem {
  id: string;
  type: string;
  position: Vector2;
  rotation: number;
  scale: number;
}

export interface TrackMetadata {
  id: string;
  name: string;
  author: string;
  difficulty: TrackDifficulty;
  defaultLapCount: number;
  createdAt: number;
}

export interface TrackValidationResult {
  isValid: boolean;
  errors: TrackValidationError[];
  warnings: string[];
}

export interface TrackValidationError {
  code: string;
  message: string;
  element?: string;
}

// Default track template with minimum required elements
export const DEFAULT_TRACK: Track = {
  id: 'new-track',
  version: CURRENT_TRACK_VERSION,
  name: 'New Track',
  author: 'Unknown',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  difficulty: 'easy',
  defaultLapCount: 5,
  width: 2000,
  height: 1200,
  elements: [
    // Default spawn point
    {
      id: 'default-spawn',
      type: 'spawn',
      x: 180,
      y: 470,
      position: { x: 180, y: 470 },
      width: 30,
      height: 50,
      rotation: 0,
      layer: 0
    },
    // Default finish line
    {
      id: 'default-finish',
      type: 'finish',
      x: 180,
      y: 420,
      position: { x: 180, y: 420 },
      width: 120,
      height: 20,
      rotation: 0,
      layer: 0
    }
  ],
  scenery: [],
};
