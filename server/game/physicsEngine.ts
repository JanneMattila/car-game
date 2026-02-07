import Matter from 'matter-js';
import { Track, CarState, PlayerInput, GameEvent, Vector2, PHYSICS_CONSTANTS, vec2, vec2Sub, vec2Length } from '@shared';

interface CarPhysicsState {
  body: Matter.Body;
  playerId: string;
  input: PlayerInput | null;
  nitroActive: boolean;
  nitroEndTime: number;
  nitroAmount: number;
  lastCheckpoint: number;
  lap: number;
  passedFinishLine: boolean;
  layer: number;
  stuckStartTime: number;
  lastPosition: { x: number; y: number };
  lastPositionTime: number;
  lastInputSequence: number;
}

export class PhysicsEngine {
  private engine: Matter.Engine;
  private world: Matter.World;
  private track: Track;
  private cars: Map<string, CarPhysicsState> = new Map();
  private walls: Matter.Body[] = [];
  private trackElements: Map<string, Matter.Body> = new Map();
  private pendingEvents: GameEvent[] = [];
  private _frameCount: number = 0;

  constructor(track: Track) {
    console.log('🚀 PHYSICS ENGINE: Constructing with track:', track.name);
    console.log('  Track has spawn elements:', track.elements?.filter(el => el.type === 'spawn')?.length || 0);
    console.log('  Track has finish elements:', track.elements?.filter(el => el.type === 'finish')?.length || 0);
    
    this.track = track;
    this.engine = Matter.Engine.create({
      gravity: { x: 0, y: 0 },
      positionIterations: 6,
      velocityIterations: 4,
    });
    this.world = this.engine.world;
    
    // @ts-expect-error - slop exists on world but not in types
    this.world.slop = 3;
  }

  initialize(cars: CarState[]): void {
    this.reset();
    this.createWalls();
    this.createTrackElements();
    
    for (const car of cars) {
      this.addCar(car);
    }
    
    this.setupCollisionHandlers();
  }

  reset(): void {
    Matter.World.clear(this.world, false);
    Matter.Engine.clear(this.engine);
    this.cars.clear();
    this.walls = [];
    this.trackElements.clear();
    this.pendingEvents = [];
  }

  private createWalls(): void {
    const wallElements = this.track.elements?.filter(el => el.type === 'wall' || el.type === 'barrier') || [];
    console.log('🏗️ WALLS: Creating walls from elements:', wallElements.length);
    
    for (const wallEl of wallElements) {
      const wall = Matter.Bodies.rectangle(
        wallEl.x + wallEl.width / 2,
        wallEl.y + wallEl.height / 2,
        wallEl.width,
        wallEl.height,
        {
          isStatic: true,
          label: 'wall',
          render: {
            fillStyle: wallEl.type === 'barrier' ? '#8B4513' : '#666',
            strokeStyle: '#333',
            lineWidth: 2
          }
        }
      );
      
      // @ts-expect-error - Adding custom property
      wall.layer = wallEl.layer ?? 0;
      
      this.walls.push(wall);
      Matter.World.add(this.world, wall);
    }
    
    console.log('🏗️ WALLS: Created', this.walls.length, 'wall bodies');
  }

  private getSpawnPoints() {
    return this.track.elements
      ?.filter(el => el.type === 'spawn')
      ?.map((el, index) => ({
        index,
        position: { 
          x: el.x + el.width / 2, 
          y: el.y + el.height / 2 
        },
        rotation: el.rotation || 0
      })) || [];
  }

  private createTrackElements(): void {
    // Create other track elements like boost pads, etc here if needed
  }

  addCar(carState: CarState): void {
    console.log('🏁 PHYSICS: Adding car for player:', carState.playerId);
    console.log('  Using carState position:', carState.position, 'rotation:', carState.rotation);
    
    // Use the position and rotation from carState (already computed from spawn points by gameRoom)
    const body = Matter.Bodies.rectangle(
      carState.position.x,
      carState.position.y,
      30,
      20,
      {
        angle: carState.rotation,
        friction: 0.001,
        frictionAir: 0.01,
        density: 0.002,
        inertia: Infinity,
        render: {
          fillStyle: carState.color || '#ff0000',
          strokeStyle: '#000',
          lineWidth: 2
        }
      }
    );
    
    const physicsState: CarPhysicsState = {
      body,
      playerId: carState.playerId,
      input: null,
      nitroActive: false,
      nitroEndTime: 0,
      nitroAmount: PHYSICS_CONSTANTS.NITRO_MAX,
      lastCheckpoint: 0,
      lap: 0,
      passedFinishLine: false,
      layer: 0,
      stuckStartTime: 0,
      lastPosition: { x: carState.position.x, y: carState.position.y },
      lastPositionTime: Date.now(),
      lastInputSequence: 0,
    };
    
    this.cars.set(carState.playerId, physicsState);
    Matter.World.add(this.world, body);
  }

  removeCar(playerId: string): void {
    const carState = this.cars.get(playerId);
    if (carState) {
      Matter.World.remove(this.world, carState.body);
      this.cars.delete(playerId);
    }
  }

  resetCar(playerId: string, position: { x: number; y: number }, rotation: number): void {
    const carState = this.cars.get(playerId);
    if (!carState) return;

    // Reset physics body position and rotation
    Matter.Body.setPosition(carState.body, position);
    Matter.Body.setAngle(carState.body, rotation);
    
    // Reset velocities
    Matter.Body.setVelocity(carState.body, { x: 0, y: 0 });
    Matter.Body.setAngularVelocity(carState.body, 0);
    
    // Reset car state properties
    carState.nitroActive = false;
    carState.nitroEndTime = 0;
    carState.stuckStartTime = 0;
    carState.lastPosition = { x: position.x, y: position.y };
    carState.lastPositionTime = Date.now();
    
    console.log('🔄 PHYSICS: Reset car for player', playerId, 'to position', position);
  }

  applyInput(playerId: string, input: PlayerInput): void {
    const carState = this.cars.get(playerId);
    if (carState) {
      carState.input = input;
      if (input.sequence !== undefined) {
        carState.lastInputSequence = input.sequence;
      }
    }
  }

  update(deltaTime: number): GameEvent[] {
    this.pendingEvents = [];
    this._frameCount++;

    // Process car physics
    for (const [playerId, carState] of this.cars) {
      this.updateCar(carState, deltaTime);
    }

    // Step physics engine
    Matter.Engine.update(this.engine, deltaTime * 1000);

    // Apply wrap-around if enabled
    if (this.track.wrapAround) {
      for (const [playerId, carState] of this.cars) {
        this.applyWrapAround(carState);
      }
    }

    // Check checkpoints and lap completion
    this.checkTrackProgress();

    return this.pendingEvents;
  }

  private applyWrapAround(carState: CarPhysicsState): void {
    const { body } = carState;
    const w = this.track.width;
    const h = this.track.height;
    let x = body.position.x;
    let y = body.position.y;
    let wrapped = false;

    // Clean modulo wrap at exact track boundaries
    // Positions always stay in [0, width) x [0, height)
    if (x < 0 || x >= w) {
      x = ((x % w) + w) % w;
      wrapped = true;
    }
    if (y < 0 || y >= h) {
      y = ((y % h) + h) % h;
      wrapped = true;
    }

    if (wrapped) {
      Matter.Body.setPosition(body, { x, y });
      // Update last position to prevent stuck detection from triggering
      carState.lastPosition = { x, y };
    }
  }

  private updateCar(carState: CarPhysicsState, deltaTime: number): void {
    const { body, input } = carState;
    
    if (!input) return;

    // Get current speed
    const currentSpeed = Matter.Vector.magnitude(body.velocity);

    // Get forward direction
    const forwardDir = Matter.Vector.create(Math.sin(body.angle), -Math.cos(body.angle));
    const forwardSpeed = Matter.Vector.dot(body.velocity, forwardDir);
    const isMovingForward = forwardSpeed > 0.5;
    const isMovingBackward = forwardSpeed < -0.5;

    // Apply acceleration only if under speed limit
    if (input.accelerate && currentSpeed < PHYSICS_CONSTANTS.MAX_SPEED) {
      const force = Matter.Vector.create(0, -PHYSICS_CONSTANTS.ENGINE_FORCE * 0.001);
      const worldForce = Matter.Vector.rotate(force, body.angle);
      Matter.Body.applyForce(body, body.position, worldForce);
    }

    // Reverse when pressing brake while stopped or moving slowly forward
    if (input.brake) {
      if (isMovingForward && forwardSpeed > 1) {
        // Apply brakes when moving forward
        Matter.Body.setVelocity(body, {
          x: body.velocity.x * 0.95,
          y: body.velocity.y * 0.95
        });
      } else if (currentSpeed < PHYSICS_CONSTANTS.MAX_REVERSE_SPEED) {
        // Reverse when stopped or moving slowly
        const reverseForce = Matter.Vector.create(0, PHYSICS_CONSTANTS.REVERSE_FORCE * 0.001);
        const worldForce = Matter.Vector.rotate(reverseForce, body.angle);
        Matter.Body.applyForce(body, body.position, worldForce);
      }
    }

    let steerInput = 0;
    if (input.steerLeft) steerInput = -1;
    if (input.steerRight) steerInput = 1;

    if (steerInput !== 0) {
      // Turning requires movement - scale turn rate by speed
      // Minimum speed threshold prevents turning while stationary
      const minTurnSpeed = 0.5;
      if (currentSpeed > minTurnSpeed) {
        // At low speeds: more responsive turning
        // At high speeds: wider turn radius (less angular velocity)
        const lowSpeedThreshold = 3;
        const highSpeedThreshold = 15;
        let speedFactor;
        if (currentSpeed < lowSpeedThreshold) {
          // Low speed: turn rate increases with speed
          speedFactor = currentSpeed / lowSpeedThreshold;
        } else if (currentSpeed < highSpeedThreshold) {
          // Medium speed: full turn rate
          speedFactor = 1.0;
        } else {
          // High speed: reduce turn rate but not too much
          speedFactor = Math.max(0.5, highSpeedThreshold / currentSpeed);
        }
        const turnForce = steerInput * PHYSICS_CONSTANTS.MAX_STEERING_ANGLE * 0.18 * speedFactor;
        // Reverse turning direction when going backwards
        const reverseMult = isMovingBackward ? -1 : 1;
        Matter.Body.setAngularVelocity(body, turnForce * reverseMult);
      }
    } else {
      // No steering input - gradually return wheels to center (reduce angular velocity)
      const returnRate = 0.85; // How quickly wheels center (lower = faster centering)
      Matter.Body.setAngularVelocity(body, body.angularVelocity * returnRate);
    }

    // Nitro boost
    if (input.nitro && carState.nitroAmount > 0) {
      if (!carState.nitroActive) {
        carState.nitroActive = true;
      }
      // Drain nitro
      carState.nitroAmount = Math.max(0, carState.nitroAmount - PHYSICS_CONSTANTS.NITRO_DRAIN_RATE * deltaTime);
      
      // Apply boost force in forward direction
      const boostForce = Matter.Vector.create(0, -PHYSICS_CONSTANTS.ENGINE_FORCE * 0.0015);
      const worldBoostForce = Matter.Vector.rotate(boostForce, body.angle);
      Matter.Body.applyForce(body, body.position, worldBoostForce);
    } else {
      carState.nitroActive = false;
      // Recharge nitro when not using it
      carState.nitroAmount = Math.min(PHYSICS_CONSTANTS.NITRO_MAX, carState.nitroAmount + PHYSICS_CONSTANTS.NITRO_RECHARGE_RATE * deltaTime);
    }

    // Apply drag and rolling resistance
    const dragForce = PHYSICS_CONSTANTS.DRAG_COEFFICIENT * currentSpeed;
    const rollingResistance = PHYSICS_CONSTANTS.ROLLING_RESISTANCE;
    
    Matter.Body.setVelocity(body, {
      x: body.velocity.x * (1 - dragForce - rollingResistance),
      y: body.velocity.y * (1 - dragForce - rollingResistance)
    });

    // Enforce maximum speed limit (higher with nitro) (higher with nitro)
    const maxSpeed = carState.nitroActive ? PHYSICS_CONSTANTS.MAX_SPEED * PHYSICS_CONSTANTS.NITRO_BOOST_MULTIPLIER : PHYSICS_CONSTANTS.MAX_SPEED;
    if (currentSpeed > maxSpeed) {
      const speedRatio = maxSpeed / currentSpeed;
      Matter.Body.setVelocity(body, {
        x: body.velocity.x * speedRatio,
        y: body.velocity.y * speedRatio
      });
    }

    // Limit angular velocity to prevent excessive spinning
    if (Math.abs(body.angularVelocity) > PHYSICS_CONSTANTS.MAX_ANGULAR_VELOCITY) {
      const sign = body.angularVelocity > 0 ? 1 : -1;
      Matter.Body.setAngularVelocity(body, PHYSICS_CONSTANTS.MAX_ANGULAR_VELOCITY * sign);
    }
  }

  private setupCollisionHandlers(): void {
    Matter.Events.on(this.engine, 'collisionStart', (event) => {
      for (const pair of event.pairs) {
        this.handleCollision(pair);
      }
    });
  }

  private handleCollision(pair: Matter.Pair): void {
    // Handle collisions here
  }

  // ── Checkpoint / Finish detection ───────────────────────────────────

  private getCheckpoints() {
    const checkpointElements = this.track.elements?.filter(el => el.type === 'checkpoint') || [];
    // Sort by checkpointIndex to ensure proper order
    checkpointElements.sort((a, b) => (a.checkpointIndex ?? 0) - (b.checkpointIndex ?? 0));

    return checkpointElements.map((el, index) => ({
      id: el.id,
      index: el.checkpointIndex ?? index,
      position: {
        x: el.x + el.width / 2,
        y: el.y + el.height / 2,
      },
      width: Math.max(el.width || 100, 50),
      height: Math.max(el.height || 100, 50),
      rotation: el.rotation || 0,
    }));
  }

  private getFinishLine() {
    const finishElements = this.track.elements?.filter(el => el.type === 'finish') || [];
    if (finishElements.length === 0) return null;

    const finishEl = finishElements[0]!;
    return {
      position: {
        x: finishEl.x + finishEl.width / 2,
        y: finishEl.y + finishEl.height / 2,
      },
      width: finishEl.width || 100,
      height: finishEl.height || 100,
      rotation: finishEl.rotation || 0,
    };
  }

  private checkTrackProgress(): void {
    for (const [playerId, carState] of this.cars) {
      const position = vec2(carState.body.position.x, carState.body.position.y);
      this.checkCheckpoints(playerId, carState, position);
      this.checkFinishLine(playerId, carState, position);
    }
  }

  private checkCheckpoints(playerId: string, carState: CarPhysicsState, position: Vector2): void {
    const expectedCheckpoint = carState.lastCheckpoint;
    const checkpoints = this.getCheckpoints();
    const checkpoint = checkpoints[expectedCheckpoint];

    if (!checkpoint) return;

    const dist = vec2Length(vec2Sub(position, checkpoint.position));
    const threshold = Math.max(checkpoint.width, checkpoint.height) / 2;

    if (dist < threshold) {
      carState.lastCheckpoint = expectedCheckpoint + 1;

      console.log(`📍 CHECKPOINT: Player ${playerId} passed checkpoint ${expectedCheckpoint}, next: ${expectedCheckpoint + 1}/${checkpoints.length}`);

      this.pendingEvents.push({
        type: 'checkpoint',
        playerId,
        checkpoint: expectedCheckpoint,
      });
    }
  }

  private checkFinishLine(playerId: string, carState: CarPhysicsState, position: Vector2): void {
    const finishLine = this.getFinishLine();
    if (!finishLine) return;

    const dist = vec2Length(vec2Sub(position, finishLine.position));
    const isNearFinish = dist < Math.max(finishLine.width, finishLine.height) / 2;

    // Must pass all checkpoints first
    const checkpoints = this.getCheckpoints();
    const allCheckpointsPassed = carState.lastCheckpoint >= checkpoints.length;

    if (isNearFinish && allCheckpointsPassed && !carState.passedFinishLine) {
      carState.passedFinishLine = true;
      carState.lap++;
      carState.lastCheckpoint = 0;

      console.log(`🏁 FINISH LINE: Player ${playerId} crossed finish, lap ${carState.lap}, dist=${dist.toFixed(1)}`);

      this.pendingEvents.push({
        type: 'lap',
        playerId,
        lap: carState.lap,
        time: 0, // Will be calculated in game room
      });
    } else if (!isNearFinish) {
      carState.passedFinishLine = false;
    }
  }

  syncCarState(carState: CarState): void {
    const physicsState = this.cars.get(carState.playerId);
    if (!physicsState) return;

    const { body } = physicsState;
    
    // Update position and rotation from physics
    carState.position.x = body.position.x;
    carState.position.y = body.position.y;
    carState.rotation = body.angle;
    
    // Update velocity
    carState.velocity.x = body.velocity.x;
    carState.velocity.y = body.velocity.y;
    carState.angularVelocity = body.angularVelocity;
    
    // Calculate speed
    carState.speed = Matter.Vector.magnitude(body.velocity);
    
    // Update physics-related properties
    carState.nitroAmount = physicsState.nitroAmount;
    carState.checkpoint = physicsState.lastCheckpoint;
    carState.lap = physicsState.lap;
    carState.layer = physicsState.layer;
    carState.lastInputSequence = physicsState.lastInputSequence;
    
    // Calculate steering angle from angular velocity (approximation)
    carState.steeringAngle = Math.max(-1, Math.min(1, body.angularVelocity * 2));
  }

  getCarStates(): CarState[] {
    return Array.from(this.cars.entries()).map(([playerId, carState]) => ({
      id: '',
      playerId,
      position: { x: carState.body.position.x, y: carState.body.position.y },
      rotation: carState.body.angle,
      velocity: { x: carState.body.velocity.x, y: carState.body.velocity.y },
      angularVelocity: carState.body.angularVelocity,
      steeringAngle: Math.max(-1, Math.min(1, carState.body.angularVelocity * 2)),
      speed: Matter.Vector.magnitude(carState.body.velocity),
      nitroAmount: carState.nitroAmount,
      damage: 'none',
      isAirborne: false,
      layer: carState.layer,
      lap: carState.lap,
      checkpoint: carState.lastCheckpoint,
      lapTimes: [],
      lastCheckpointTime: 0,
      finished: false,
      finishTime: 0,
      position_rank: 0,
      lastInputSequence: carState.lastInputSequence,
    }));
  }
}