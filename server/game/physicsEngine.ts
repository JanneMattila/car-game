import Matter from 'matter-js';
import {
  Track, TrackElement, CarState, PlayerInput, GameEvent, PHYSICS_CONSTANTS,
  getSteeringInput, createVehicleBody, createTrackWall, stepNitro,
  effectiveRaceGate, raceGateCrossing,
  RoadSurfaceIndex, CollisionResistance, drivingResistance,
  DEFAULT_INPUT_STATE,
} from '@shared';

interface CarPhysicsState {
  body: Matter.Body;
  playerId: string;
  input: PlayerInput | null;
  nitroActive: boolean;
  nitroEndTime: number;
  nitroAmount: number;
  lastCheckpoint: number;
  lap: number;
  progressPosition: { x: number; y: number };
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
  private wallTiles = new Map<string, Matter.Body[]>();
  private trackElements: Map<string, Matter.Body> = new Map();
  private pendingEvents: GameEvent[] = [];
  private _frameCount: number = 0;
  private checkpoints: TrackElement[];
  private finishLine: TrackElement | null;
  private roadSurface: RoadSurfaceIndex;
  private collisionResistance = new CollisionResistance();

  constructor(track: Track) {
    console.log('🚀 PHYSICS ENGINE: Constructing with track:', track.name);
    console.log('  Track has spawn elements:', track.elements?.filter(el => el.type === 'spawn')?.length || 0);
    console.log('  Track has finish elements:', track.elements?.filter(el => el.type === 'finish')?.length || 0);
    
    this.track = track;
    this.roadSurface = new RoadSurfaceIndex(track);
    this.checkpoints = track.elements.filter(el => el.type === 'checkpoint')
      .sort((a, b) => (a.checkpointIndex ?? 0) - (b.checkpointIndex ?? 0))
      .map(el => effectiveRaceGate(track, el));
    const finish = track.elements.find(el => el.type === 'finish');
    this.finishLine = finish ? effectiveRaceGate(track, finish) : null;
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
    this.createTrackElements();
    
    for (const car of cars) {
      this.addCar(car);
    }
    this.updateWallTiles();
    
  }

  reset(): void {
    Matter.World.clear(this.world, false);
    Matter.Engine.clear(this.engine);
    this.cars.clear();
    this.wallTiles.clear();
    this.trackElements.clear();
    this.pendingEvents = [];
    this.collisionResistance.reset();
  }

  private createWalls(tileX: number, tileY: number): Matter.Body[] {
    const wallElements = this.track.elements?.filter(el => el.type === 'wall' || el.type === 'barrier') || [];
    const walls: Matter.Body[] = [];
    
    for (const wallEl of wallElements) {
      const wall = createTrackWall(wallEl, {
        x: tileX * this.track.width, y: tileY * this.track.height,
      });
      
      // @ts-expect-error - Adding custom property
      wall.layer = wallEl.layer ?? 0;
      
      walls.push(wall);
      Matter.World.add(this.world, wall);
    }
    
    return walls;
  }

  private updateWallTiles(): void {
    const needed = new Map<string, { x: number; y: number }>();
    if (!this.track.wrapAround) {
      needed.set('0:0', { x: 0, y: 0 });
    } else {
      for (const { body } of this.cars.values()) {
        const tileX = Math.floor(body.position.x / this.track.width);
        const tileY = Math.floor(body.position.y / this.track.height);
        // Neighboring terrain exists before a car reaches a tile boundary.
        for (let x = tileX - 1; x <= tileX + 1; x++) {
          for (let y = tileY - 1; y <= tileY + 1; y++) {
            needed.set(`${x}:${y}`, { x, y });
          }
        }
      }
    }
    for (const [key, tile] of needed) {
      if (!this.wallTiles.has(key)) {
        this.wallTiles.set(key, this.createWalls(tile.x, tile.y));
      }
    }
    for (const [key, walls] of this.wallTiles) {
      if (!needed.has(key)) {
        for (const wall of walls) Matter.World.remove(this.world, wall);
        this.wallTiles.delete(key);
      }
    }
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
    const body = createVehicleBody(carState.position, carState.rotation);
    
    const physicsState: CarPhysicsState = {
      body,
      playerId: carState.playerId,
      input: null,
      nitroActive: false,
      nitroEndTime: 0,
      nitroAmount: carState.nitroAmount,
      lastCheckpoint: 0,
      lap: 0,
      progressPosition: { ...carState.position },
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

    // A fresh body prevents cached contact impulses from following a teleported car.
    Matter.World.remove(this.world, carState.body);
    carState.body = createVehicleBody(position, rotation);
    Matter.World.add(this.world, carState.body);
    
    // Reset car state properties
    carState.nitroActive = false;
    carState.nitroEndTime = 0;
    carState.stuckStartTime = 0;
    carState.lastPosition = { x: position.x, y: position.y };
    carState.progressPosition = { ...position };
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
    this.updateWallTiles();

    // Process car physics
    for (const [playerId, carState] of this.cars) {
      this.updateCar(carState, deltaTime);
    }

    // Step physics engine
    Matter.Engine.update(this.engine, deltaTime * 1000);
    this.collisionResistance.apply(this.engine);

    // Check checkpoints and lap completion
    this.checkTrackProgress();

    return this.pendingEvents;
  }

  private updateCar(carState: CarPhysicsState, deltaTime: number): void {
    const { body } = carState;
    const input = carState.input ?? DEFAULT_INPUT_STATE;
    const resistance = drivingResistance(
      this.roadSurface.isAsphalt(body.position, carState.layer),
      this.collisionResistance.forceScale(body)
    );

    // Get current speed
    const currentSpeed = Matter.Vector.magnitude(body.velocity);

    // Get forward direction
    const forwardDir = Matter.Vector.create(Math.sin(body.angle), -Math.cos(body.angle));
    const forwardSpeed = Matter.Vector.dot(body.velocity, forwardDir);
    const isMovingForward = forwardSpeed > 0.5;
    const isMovingBackward = forwardSpeed < -0.5;

    // Apply acceleration only if under speed limit
    if (input.accelerate && currentSpeed < PHYSICS_CONSTANTS.MAX_SPEED) {
      const force = Matter.Vector.create(0, -PHYSICS_CONSTANTS.ENGINE_FORCE * 0.001 * resistance.forceScale);
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
        const reverseForce = Matter.Vector.create(0, PHYSICS_CONSTANTS.REVERSE_FORCE * 0.001 * resistance.forceScale);
        const worldForce = Matter.Vector.rotate(reverseForce, body.angle);
        Matter.Body.applyForce(body, body.position, worldForce);
      }
    }

    const steerInput = getSteeringInput(input);

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

    const nitro = stepNitro(carState.nitroAmount, input.nitro, deltaTime);
    carState.nitroAmount = nitro.amount;
    carState.nitroActive = nitro.boostScale > 0;
    if (carState.nitroActive) {
      const boostForce = Matter.Vector.create(
        0, -PHYSICS_CONSTANTS.ENGINE_FORCE * 0.0015 * nitro.boostScale * resistance.forceScale
      );
      const worldBoostForce = Matter.Vector.rotate(boostForce, body.angle);
      Matter.Body.applyForce(body, body.position, worldBoostForce);
    }

    // Apply drag and rolling resistance
    const dragForce = PHYSICS_CONSTANTS.DRAG_COEFFICIENT * currentSpeed;
    const rollingResistance = resistance.rollingResistance;
    
    Matter.Body.setVelocity(body, {
      x: body.velocity.x * (1 - dragForce - rollingResistance),
      y: body.velocity.y * (1 - dragForce - rollingResistance)
    });

    // Enforce maximum speed limit (higher with nitro) (higher with nitro)
    const maxSpeed = resistance.speedScale * (carState.nitroActive ? PHYSICS_CONSTANTS.MAX_SPEED * PHYSICS_CONSTANTS.NITRO_BOOST_MULTIPLIER : PHYSICS_CONSTANTS.MAX_SPEED);
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

  // ── Checkpoint / Finish detection ───────────────────────────────────

  private checkTrackProgress(): void {
    for (const [playerId, carState] of this.cars) {
      const previous = carState.progressPosition;
      const current = { ...carState.body.position };
      let lastCrossing = -1;
      while (carState.lastCheckpoint < this.checkpoints.length) {
        const checkpoint = this.checkpoints[carState.lastCheckpoint]!;
        const time = raceGateCrossing(this.track, checkpoint, previous, current);
        if (time === null || time < lastCrossing) break;
        lastCrossing = time;
        this.pendingEvents.push({
          type: 'checkpoint',
          playerId,
          checkpoint: carState.lastCheckpoint++,
        });
      }
      const finishTime = this.finishLine
        ? raceGateCrossing(this.track, this.finishLine, previous, current) : null;
      if (carState.lastCheckpoint === this.checkpoints.length &&
          finishTime !== null && finishTime >= lastCrossing) {
        carState.lap++;
        carState.lastCheckpoint = 0;
        this.pendingEvents.push({ type: 'lap', playerId, lap: carState.lap, time: 0 });
      }
      carState.progressPosition = current;
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