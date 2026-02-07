// Physics constants
// Tuned for smooth, natural driving with responsive but controllable behavior

export const PHYSICS_CONSTANTS = {
  // World
  WORLD_SCALE: 1, // pixels per meter
  
  // Wrap-around margin (buffer zone outside track bounds before coordinates wrap)
  WRAP_MARGIN: 50,
  
  // Car physics
  CAR_MASS: 1200, // kg
  CAR_INERTIA: 5000, // Higher inertia = more stable rotation, less twitchy
  CAR_WIDTH: 30,   // Matches visual sprite width
  CAR_HEIGHT: 50,  // Matches visual sprite height
  WHEEL_BASE: 35,  // Scaled proportionally
  
  // Forces - TUNED FOR PX/FRAME UNITS (Matter.js native)
  // Target: quick acceleration, high top speed
  ENGINE_FORCE: 12.0,     // Strong acceleration
  BRAKE_FORCE: 10.0,      // Strong brakes for control
  REVERSE_FORCE: 3.5,     // Moderate reverse
  DRAG_COEFFICIENT: 0.015, // Less air resistance for higher speeds
  ROLLING_RESISTANCE: 0.012, // Less coasting slowdown
  
  // Steering - balanced turning
  MAX_STEERING_ANGLE: Math.PI / 10, // ~18 degrees - moderate turns
  STEERING_SPEED: 3.0, // radians per second
  STEERING_RETURN_SPEED: 3,
  MAX_ANGULAR_VELOCITY: 2.0, // radians per second - balanced turning
  
  // Friction - high grip for predictable handling
  TIRE_FRICTION: 0.96,    // Almost no sliding
  DRIFT_FRICTION: 0.75,   // Still controllable when drifting
  HANDBRAKE_FRICTION: 0.40, // Handbrake allows some slide
  OIL_SLICK_FRICTION: 0.30, // Oil is slippery
  
  // Speed limits - IN PX/FRAME (at 60fps)
  // 20 px/frame = 1200 px/s = very fast arcade racing speed
  MAX_SPEED: 20,          // Max ~20 pixels per physics frame
  MAX_REVERSE_SPEED: 10,  // Faster reverse
  PIT_STOP_SPEED_LIMIT: 2.0,
  
  // Nitro
  NITRO_BOOST_MULTIPLIER: 1.3, // Slight boost, not overwhelming
  NITRO_MAX: 100,
  NITRO_DRAIN_RATE: 50, // per second
  NITRO_RECHARGE_RATE: 10, // per second
  
  // Boost pads - scaled for px/frame
  BOOST_PAD_FORCE: 0.5,  // Gentle speed bump
  BOOST_PAD_DURATION: 500, // ms
  
  // Ramps
  DEFAULT_LAUNCH_ANGLE: Math.PI / 8,
  DEFAULT_LAUNCH_FORCE: 0.8, // Scaled for px/frame
  AIRBORNE_CONTROL: 0.3, // reduced control while airborne
  LANDING_IMPACT: 0.85, // Less speed loss on landing
  
  // Collisions
  COLLISION_RESTITUTION: 0.3, // Lower bounce
  CAR_COLLISION_DAMAGE_THRESHOLD: 20, // Scaled for px/frame impulses
  WALL_COLLISION_DAMAGE_THRESHOLD: 15,
  
  // Damage
  LIGHT_DAMAGE_THRESHOLD: 200,
  MEDIUM_DAMAGE_THRESHOLD: 400,
  HEAVY_DAMAGE_THRESHOLD: 600,
  DAMAGE_SPEED_PENALTY: {
    none: 1.0,
    light: 0.95,
    medium: 0.85,
    heavy: 0.7,
  },
  
  // Pit stop
  PIT_REPAIR_RATE: 25, // damage points per second
} as const;
