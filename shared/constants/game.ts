// Game constants

export const GAME_CONSTANTS = {
  // Server tick rates
  PHYSICS_TICK_RATE: 60, // Hz
  PHYSICS_DELTA: 1000 / 60, // ms
  STATE_BROADCAST_RATE: 20, // Hz
  STATE_BROADCAST_INTERVAL: 1000 / 20, // ms

  // Game settings
  DEFAULT_LAP_COUNT: 10,
  MAX_PLAYERS: 8,
  MIN_PLAYERS_TO_START: 1,
  COUNTDOWN_SECONDS: 3,
  FINISH_GRACE_PERIOD: 60000, // ms after first finisher
  
  // Room settings
  ROOM_CODE_LENGTH: 6,
  ROOM_IDLE_TIMEOUT: 300000, // 5 minutes
  PLAYER_DISCONNECT_TIMEOUT: 30000, // 30 seconds
  
  // Chat
  MAX_CHAT_MESSAGE_LENGTH: 200,
  EMOTE_COOLDOWN: 2000, // ms
  
  // Respawn
  RESPAWN_COOLDOWN: 3000, // ms
  RESPAWN_INVULNERABILITY: 2000, // ms
  STUCK_THRESHOLD: 5000, // ms without movement before auto-respawn option
} as const;

export const RENDER_CONSTANTS = {
  TARGET_FPS: 60,
  GAME_WIDTH: 1920,
  GAME_HEIGHT: 1080,
  MOBILE_ASPECT_RATIO: 16 / 9,
  
  // Smoothing
  POSITION_LERP_FACTOR: 0.15,
  ROTATION_LERP_FACTOR: 0.2,
  TELEPORT_THRESHOLD: 200, // pixels
  
  // Visual
  TIRE_MARK_LIFETIME: 10000, // ms
  MAX_TIRE_MARKS: 1000,
  PARTICLE_POOL_SIZE: 500,
  
  // Minimap
  MINIMAP_SIZE: 200,
  MINIMAP_PADDING: 10,
} as const;
