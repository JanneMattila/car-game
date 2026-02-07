import { create } from 'zustand';
import {
  PlayerSettings,
  DEFAULT_PLAYER_SETTINGS,
  CarColor,
  ControlType,
} from '@shared';

const STORAGE_KEY = 'car-game-settings';

interface ExtendedSettings extends PlayerSettings {
  showMinimap: boolean;
  showParticles: boolean;
}

interface SettingsState extends ExtendedSettings {
  // Computed aliases for convenience
  musicEnabled: boolean;
  
  // Actions
  setNickname: (nickname: string) => void;
  setPreferredColor: (color: CarColor) => void;
  setControlType: (type: ControlType) => void;
  setTiltSensitivity: (sensitivity: number) => void;
  setSoundEnabled: (enabled: boolean) => void;
  setMasterVolume: (volume: number) => void;
  setSfxVolume: (volume: number) => void;
  setMusicVolume: (volume: number) => void;
  setShowMinimap: (show: boolean) => void;
  setShowParticles: (show: boolean) => void;
  loadFromStorage: () => void;
  saveToStorage: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULT_PLAYER_SETTINGS,
  showMinimap: true,
  showParticles: true,
  
  // musicEnabled is an alias - sound+music enabled when masterVolume > 0 and musicVolume > 0
  get musicEnabled() {
    const state = get();
    return state.soundEnabled && state.musicVolume > 0;
  },

  setNickname: (nickname) => {
    set({ nickname });
    get().saveToStorage();
  },

  setPreferredColor: (preferredColor) => {
    set({ preferredColor });
    get().saveToStorage();
  },

  setControlType: (controlType) => {
    set({ controlType });
    get().saveToStorage();
  },

  setTiltSensitivity: (tiltSensitivity) => {
    set({ tiltSensitivity });
    get().saveToStorage();
  },

  setSoundEnabled: (soundEnabled) => {
    set({ soundEnabled });
    get().saveToStorage();
  },

  setMasterVolume: (masterVolume) => {
    set({ masterVolume });
    get().saveToStorage();
  },

  setSfxVolume: (sfxVolume) => {
    set({ sfxVolume });
    get().saveToStorage();
  },

  setMusicVolume: (musicVolume) => {
    set({ musicVolume });
    get().saveToStorage();
  },

  setShowMinimap: (showMinimap) => {
    set({ showMinimap });
    get().saveToStorage();
  },

  setShowParticles: (showParticles) => {
    set({ showParticles });
    get().saveToStorage();
  },

  loadFromStorage: () => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const settings = JSON.parse(stored) as Partial<ExtendedSettings>;
        set({ 
          ...DEFAULT_PLAYER_SETTINGS, 
          showMinimap: true,
          showParticles: true,
          ...settings,
        });
      }
    } catch (e) {
      console.warn('Failed to load settings:', e);
    }
  },

  saveToStorage: () => {
    try {
      const state = get();
      const settings: ExtendedSettings = {
        nickname: state.nickname,
        preferredColor: state.preferredColor,
        controlType: state.controlType,
        tiltSensitivity: state.tiltSensitivity,
        soundEnabled: state.soundEnabled,
        masterVolume: state.masterVolume,
        sfxVolume: state.sfxVolume,
        musicVolume: state.musicVolume,
        showMinimap: state.showMinimap,
        showParticles: state.showParticles,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      console.warn('Failed to save settings:', e);
    }
  },
}));
