// Player types

export interface Player {
  id: string;
  nickname: string;
  color: CarColor;
  isReady: boolean;
  isConnected: boolean;
  isSpectator: boolean;
  joinedAt: number;
  lastActivity: number;
}

export type CarColor = 
  | 'red'
  | 'blue'
  | 'black'
  | 'white'
  | 'silver'
  | 'green'
  | 'yellow'
  | 'orange';

export interface PlayerInput {
  playerId: string;
  sequence: number;
  timestamp: number;
  accelerate: boolean;
  brake: boolean;
  steerLeft: boolean;
  steerRight: boolean;
  steerValue: number; // -1 to 1 for analog/tilt
  nitro: boolean;
  handbrake: boolean;
  respawn: boolean;
}

export interface PlayerSettings {
  nickname: string;
  preferredColor: CarColor;
  controlType: ControlType;
  tiltSensitivity: number;
  soundEnabled: boolean;
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
}

export type ControlType = 'keyboard' | 'touch' | 'tilt';

export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = {
  nickname: '',
  preferredColor: 'red',
  controlType: 'keyboard',
  tiltSensitivity: 0.5,
  soundEnabled: true,
  masterVolume: 0.8,
  sfxVolume: 0.8,
  musicVolume: 0.5,
};
