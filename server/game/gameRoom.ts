import {
  Room,
  RoomInfo,
  RoomState,
  Player,
  CarState,
  GameState,
  GameSettings,
  GamePhase,
  CarColor,
  Track,
  PlayerInput,
  RaceResult,
  GameStateSnapshot,
  GameEvent,
  createInitialCarState,
  serializeCarState,
  GAME_CONSTANTS,
  PHYSICS_CONSTANTS,
} from '@shared';
import { generateUUID, getAvailableColor } from '@shared';
import { PhysicsEngine } from './physicsEngine.js';
import { LeaderboardManager } from '../leaderboards/leaderboardManager.js';

type RoomEventListener = (event: string, data: unknown) => void;

export class GameRoom {
  private id: string;
  private code: string;
  private hostId: string;
  private settings: GameSettings;
  private track: Track;
  private players: Map<string, Player> = new Map();
  private spectators: Map<string, Player> = new Map();
  private cars: Map<string, CarState> = new Map();
  private state: RoomState = 'waiting';
  private gameState: GameState;
  private results: RaceResult[] = [];
  private createdAt: number;
  private lastActivity: number;
  private startedAt: number = 0;
  
  private physics: PhysicsEngine;
  private leaderboardManager: LeaderboardManager;
  private gameLoop: NodeJS.Timeout | null = null;
  private broadcastLoop: NodeJS.Timeout | null = null;
  private countdownTimer: NodeJS.Timeout | null = null;
  
  private eventListeners: RoomEventListener[] = [];
  private pendingEvents: GameEvent[] = [];
  private stateSequence: number = 0;

  constructor(
    id: string,
    code: string,
    hostId: string,
    settings: GameSettings,
    track: Track,
    leaderboardManager: LeaderboardManager
  ) {
    this.id = id;
    this.code = code;
    this.hostId = hostId;
    this.settings = settings;
    this.track = track;
    this.leaderboardManager = leaderboardManager;
    
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    
    this.gameState = {
      phase: 'waiting',
      countdown: 0,
      raceStartTime: 0,
      elapsedTime: 0,
      finishedPlayers: [],
    };

    console.log('🏁 GAME ROOM: Creating physics engine for track:', track.name);
    this.physics = new PhysicsEngine(track);
  }

  // Event handling
  addEventListener(listener: RoomEventListener): void {
    this.eventListeners.push(listener);
  }

  removeEventListener(listener: RoomEventListener): void {
    const index = this.eventListeners.indexOf(listener);
    if (index >= 0) {
      this.eventListeners.splice(index, 1);
    }
  }

  private emit(event: string, data: unknown): void {
    for (const listener of this.eventListeners) {
      listener(event, data);
    }
  }

  // Getters
  getId(): string { return this.id; }
  getCode(): string { return this.code; }
  getHostId(): string { return this.hostId; }
  getSettings(): GameSettings { return this.settings; }
  getTrack(): Track { return this.track; }
  getState(): RoomState { return this.state; }
  getGameState(): GameState { return this.gameState; }
  getResults(): RaceResult[] { return this.results; }
  
  getHostNickname(): string {
    return this.players.get(this.hostId)?.nickname || 'Unknown';
  }

  getPlayerCount(): number {
    return this.players.size;
  }

  getPlayerIds(): string[] {
    return Array.from(this.players.keys());
  }

  isFull(): boolean {
    return this.players.size >= this.settings.maxPlayers;
  }

  isEmpty(): boolean {
    return this.players.size === 0;
  }

  getIdleTime(now: number): number {
    return now - this.lastActivity;
  }

  getPlayers(): Player[] {
    return Array.from(this.players.values());
  }

  getPlayer(playerId: string): Player | null {
    return this.players.get(playerId) || null;
  }

  getCars(): CarState[] {
    return Array.from(this.cars.values());
  }

  getCar(playerId: string): CarState | null {
    return this.cars.get(playerId) || null;
  }

  getRoomInfo(): RoomInfo {
    return {
      id: this.id,
      code: this.code,
      hostNickname: this.getHostNickname(),
      trackName: this.track.name,
      trackId: this.track.id,
      playerCount: this.players.size,
      maxPlayers: this.settings.maxPlayers,
      state: this.state,
      isPrivate: this.settings.isPrivate,
      lapCount: this.settings.lapCount,
      players: Array.from(this.players.values()).map(p => {
        const car = this.cars.get(p.id);
        return {
          id: p.id,
          nickname: p.nickname,
          color: p.color,
          ready: p.isReady,
          isHost: p.id === this.hostId,
          position: car ? { x: car.position.x, y: car.position.y } : null,
          angle: car?.rotation ?? 0,
          velocity: car ? { x: car.velocity.x, y: car.velocity.y } : null,
          lap: car?.lap ?? 0,
          checkpointIndex: car?.checkpoint ?? 0,
          finished: car?.finished ?? false,
          finishTime: car?.finishTime ?? null,
          bestLapTime: null, // Will be tracked separately
        };
      }),
    };
  }

  // Player management
  addPlayer(playerId: string, nickname: string, preferredColor: CarColor): Player | null {
    if (this.players.has(playerId)) {
      return this.players.get(playerId)!;
    }

    if (this.isFull()) {
      return null;
    }

    // Assign color
    const usedColors = Array.from(this.players.values()).map(p => p.color);
    let color = preferredColor;
    if (usedColors.includes(color)) {
      color = getAvailableColor(usedColors) || 'red';
    }

    const player: Player = {
      id: playerId,
      nickname,
      color,
      isReady: false,
      isConnected: true,
      isSpectator: false,
      joinedAt: Date.now(),
      lastActivity: Date.now(),
    };

    this.players.set(playerId, player);
    this.lastActivity = Date.now();

    // Create car if race in progress
    if (this.state === 'racing' && this.settings.allowMidRaceJoin) {
      this.createCarForPlayer(player);
    }

    // Emit player in RoomPlayer format
    const car = this.cars.get(playerId);
    this.emit('player_joined', {
      id: player.id,
      nickname: player.nickname,
      color: player.color,
      ready: player.isReady,
      isHost: player.id === this.hostId,
      position: car ? { x: car.position.x, y: car.position.y } : null,
      angle: car?.rotation ?? 0,
      velocity: car ? { x: car.velocity.x, y: car.velocity.y } : null,
      lap: car?.lap ?? 0,
      checkpointIndex: car?.checkpoint ?? 0,
      finished: car?.finished ?? false,
      finishTime: car?.finishTime ?? null,
      bestLapTime: null,
    });

    return player;
  }

  removePlayer(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;

    this.players.delete(playerId);
    this.cars.delete(playerId);
    this.physics.removeCar(playerId);

    // Assign new host if needed
    if (playerId === this.hostId && this.players.size > 0) {
      this.hostId = Array.from(this.players.keys())[0]!;
    }

    this.emit('player_left', { playerId, reason: 'left' });
  }

  setPlayerReady(playerId: string, ready: boolean): void {
    const player = this.players.get(playerId);
    if (!player) return;

    player.isReady = ready;
    this.lastActivity = Date.now();

    this.emit('player_ready', { playerId, ready });
  }

  setPlayerConnected(playerId: string, connected: boolean): void {
    const player = this.players.get(playerId);
    if (player) {
      player.isConnected = connected;
      player.lastActivity = Date.now();
    }
  }

  // Game flow
  canStart(): boolean {
    if (this.state !== 'waiting') return false;
    if (this.players.size < GAME_CONSTANTS.MIN_PLAYERS_TO_START) return false;
    
    const readyCount = Array.from(this.players.values()).filter(p => p.isReady).length;
    return readyCount >= GAME_CONSTANTS.MIN_PLAYERS_TO_START;
  }

  startGame(): boolean {
    if (!this.canStart()) return false;

    this.state = 'countdown';
    this.gameState.phase = 'countdown';
    this.gameState.countdown = GAME_CONSTANTS.COUNTDOWN_SECONDS;

    // Create cars for all ready players
    for (const player of this.players.values()) {
      if (player.isReady) {
        this.createCarForPlayer(player);
      }
    }

    // Initialize physics
    this.physics.initialize(Array.from(this.cars.values()));

    // Start countdown - include track and initial car positions
    this.emit('game_starting', { 
      countdown: this.gameState.countdown,
      track: this.track,
      cars: Array.from(this.cars.values()).map(serializeCarState),
    });
    
    this.countdownTimer = setInterval(() => {
      this.gameState.countdown--;
      
      // Always emit countdown (including 0 for "GO!")
      this.emit('countdown', { count: this.gameState.countdown });
      
      if (this.gameState.countdown <= 0) {
        if (this.countdownTimer) {
          clearInterval(this.countdownTimer);
          this.countdownTimer = null;
        }
        // Brief delay to show "GO!" before race starts
        setTimeout(() => this.startRace(), 500);
      }
    }, 1000);

    return true;
  }

  private startRace(): void {
    this.state = 'racing';
    this.gameState.phase = 'racing';
    this.gameState.raceStartTime = Date.now();
    this.startedAt = Date.now();

    this.emit('game_started', { startTime: this.gameState.raceStartTime });

    // Start game loop
    this.gameLoop = setInterval(() => this.updateGame(), GAME_CONSTANTS.PHYSICS_DELTA);
    
    // Start state broadcast loop
    this.broadcastLoop = setInterval(
      () => this.broadcastState(),
      GAME_CONSTANTS.STATE_BROADCAST_INTERVAL
    );
  }

  private createCarForPlayer(player: Player): void {
    const spawnIndex = this.cars.size;
    const spawnElements = this.track.elements?.filter(el => el.type === 'spawn') || [];
    
    console.log('🚗 SPAWN DEBUG: Creating car for player', player.nickname);
    console.log('  Spawn index:', spawnIndex);
    console.log('  Available spawn elements:', spawnElements.length);
    
    if (spawnElements.length === 0) {
      console.log('❌ No spawn elements found!');
      return;
    }
    
    const spawnElement = spawnElements[spawnIndex % spawnElements.length];
    const spawn = {
      index: spawnIndex,
      position: { 
        x: spawnElement.x + spawnElement.width / 2, 
        y: spawnElement.y + spawnElement.height / 2 
      },
      rotation: spawnElement.rotation || 0
    };
    
    console.log('  Selected spawn:', spawn);
    
    if (!spawn) return;

    const car = createInitialCarState(
      generateUUID(),
      player.id,
      spawn.position,
      spawn.rotation
    );

    console.log('🚗 SPAWN DEBUG: Created car state:');
    console.log('  Car position:', car.position);
    console.log('  Car rotation:', car.rotation);

    this.cars.set(player.id, car);
    this.physics.addCar(car);
  }

  // Input handling
  handleInput(playerId: string, input: PlayerInput): void {
    // Allow input during countdown (for immediate response when race starts) and racing
    if (this.state !== 'countdown' && this.state !== 'racing') return;

    const car = this.cars.get(playerId);
    if (!car) return;

    // Handle manual respawn request
    if (input.respawn) {
      this.handleRespawn(playerId);
      return;
    }

    this.physics.applyInput(playerId, input);
    this.lastActivity = Date.now();
  }

  // Game update
  private updateGame(): void {
    if (this.state !== 'racing') return;

    const now = Date.now();
    this.gameState.elapsedTime = now - this.gameState.raceStartTime;

    // Update physics
    const events = this.physics.update(GAME_CONSTANTS.PHYSICS_DELTA / 1000);
    
    // Process physics events
    for (const event of events) {
      this.handlePhysicsEvent(event);
    }

    // Update car states from physics
    for (const car of this.cars.values()) {
      this.physics.syncCarState(car);
    }

    // Update positions/rankings
    this.updateRankings();

    // Check for race completion
    this.checkRaceCompletion();
  }

  private handlePhysicsEvent(event: GameEvent): void {
    this.pendingEvents.push(event);

    switch (event.type) {
      case 'checkpoint':
        this.handleCheckpoint(event.playerId, event.checkpoint);
        break;
      case 'lap':
        this.handleLapComplete(event.playerId, event.lap, event.time);
        break;
      case 'finish':
        this.handlePlayerFinish(event.playerId, event.position, event.time);
        break;
    }
  }

  private handleCheckpoint(playerId: string, checkpoint: number): void {
    const car = this.cars.get(playerId);
    if (!car) return;

    car.checkpoint = checkpoint;
    car.lastCheckpointTime = Date.now();

    this.emit('checkpoint_passed', {
      playerId,
      checkpoint,
      time: this.gameState.elapsedTime,
    });
  }

  private handleLapComplete(playerId: string, lap: number, _lapTime: number): void {
    const car = this.cars.get(playerId);
    if (!car) return;

    car.lap = lap;
    car.checkpoint = 0;

    // Calculate actual lap time from race elapsed time
    // For the first lap, time since race start; for subsequent laps, time since last lap
    const now = this.gameState.elapsedTime;
    const previousLapTotalTime = car.lapTimes.reduce((sum, t) => sum + t, 0);
    const actualLapTime = now - previousLapTotalTime;
    car.lapTimes.push(actualLapTime);

    console.log(`🏁 LAP COMPLETE: Player ${playerId}, lap ${lap}, lapTime ${actualLapTime}ms, total elapsed ${now}ms`);

    this.emit('lap_completed', { playerId, lap, lapTime: actualLapTime });

    // Submit to leaderboard
    const player = this.players.get(playerId);
    if (player) {
      this.leaderboardManager.submitLapTime(
        this.track.id,
        player.nickname,
        actualLapTime
      );
    }

    // Check if player has completed all required laps
    if (lap >= this.settings.lapCount) {
      const position = this.gameState.finishedPlayers.length + 1;
      const totalTime = this.gameState.elapsedTime;
      this.handlePlayerFinish(playerId, position, totalTime);
    }
  }

  private handlePlayerFinish(playerId: string, position: number, totalTime: number): void {
    const car = this.cars.get(playerId);
    const player = this.players.get(playerId);
    if (!car || !player) return;

    car.finished = true;
    car.finishTime = totalTime;
    car.position_rank = position;

    this.gameState.finishedPlayers.push(playerId);

    const result: RaceResult = {
      playerId,
      nickname: player.nickname,
      position,
      totalTime,
      bestLapTime: Math.min(...car.lapTimes),
      laps: car.lapTimes.map((time, index) => ({
        lap: index + 1,
        time,
        checkpointTimes: [],
      })),
      finished: true,
    };

    this.results.push(result);

    this.emit('player_finished', { playerId, position, totalTime });

    // Submit race time
    this.leaderboardManager.submitRaceTime(
      this.track.id,
      player.nickname,
      totalTime,
      this.settings.lapCount
    );
  }

  private updateRankings(): void {
    const carArray = Array.from(this.cars.values());
    
    // Sort by: finished status, lap count, checkpoint, then distance to next checkpoint
    carArray.sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.lap !== b.lap) return b.lap - a.lap;
      if (a.checkpoint !== b.checkpoint) return b.checkpoint - a.checkpoint;
      return 0;
    });

    // Assign rankings
    carArray.forEach((car, index) => {
      car.position_rank = index + 1;
    });
  }

  private checkRaceCompletion(): void {
    if (this.gameState.finishedPlayers.length === 0) return;

    const allFinished = Array.from(this.cars.values()).every(c => c.finished);
    const graceTimeExceeded = 
      this.gameState.elapsedTime - 
      (this.cars.get(this.gameState.finishedPlayers[0]!)?.finishTime ?? 0) > 
      GAME_CONSTANTS.FINISH_GRACE_PERIOD;

    if (allFinished || graceTimeExceeded) {
      this.endRace();
    }
  }

  private endRace(): void {
    this.state = 'results';
    this.gameState.phase = 'finished';

    // Stop loops
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
      this.gameLoop = null;
    }
    if (this.broadcastLoop) {
      clearInterval(this.broadcastLoop);
      this.broadcastLoop = null;
    }

    // Add unfinished players to results
    for (const [playerId, car] of this.cars) {
      if (!car.finished) {
        const player = this.players.get(playerId);
        if (player) {
          this.results.push({
            playerId,
            nickname: player.nickname,
            position: this.results.length + 1,
            totalTime: 0,
            bestLapTime: car.lapTimes.length > 0 ? Math.min(...car.lapTimes) : 0,
            laps: car.lapTimes.map((time, index) => ({
              lap: index + 1,
              time,
              checkpointTimes: [],
            })),
            finished: false,
          });
        }
      }
    }

    this.emit('race_finished', { results: this.results });
  }

  // State broadcasting
  private broadcastState(): void {
    const snapshot = this.createStateSnapshot();
    this.emit('game_state', snapshot);
    this.pendingEvents = [];
  }

  private createStateSnapshot(): GameStateSnapshot {
    return {
      sequence: ++this.stateSequence,
      timestamp: Date.now(),
      gameState: { ...this.gameState },
      cars: Array.from(this.cars.values()).map(serializeCarState),
      events: [...this.pendingEvents],
    };
  }

  // Respawn
  handleRespawn(playerId: string): void {
    const car = this.cars.get(playerId);
    if (!car || car.finished) return;

    // Find the last checkpoint position
    const checkpointIndex = Math.max(0, car.checkpoint - 1);
    const checkpointElements = this.track.elements?.filter(el => el.type === 'checkpoint') || [];
    // Sort by checkpointIndex
    checkpointElements.sort((a, b) => (a.checkpointIndex ?? 0) - (b.checkpointIndex ?? 0));
    
    const checkpointElement = checkpointElements[checkpointIndex];
    const checkpoint = checkpointElement ? {
      position: {
        x: checkpointElement.x + checkpointElement.width / 2,
        y: checkpointElement.y + checkpointElement.height / 2
      },
      rotation: checkpointElement.rotation || 0
    } : null;
    
    if (checkpoint) {
      car.position = { ...checkpoint.position };
      car.rotation = checkpoint.rotation;
      car.velocity = { x: 0, y: 0 };
      car.angularVelocity = 0;
      
      this.physics.resetCar(playerId, car.position, car.rotation);
    }

    this.pendingEvents.push({ type: 'respawn', playerId });
  }

  // Cleanup
  resetToLobby(): void {
    this.state = 'waiting';
    this.gameState = {
      phase: 'waiting',
      countdown: 0,
      raceStartTime: 0,
      elapsedTime: 0,
      finishedPlayers: [],
    };

    this.cars.clear();
    this.results = [];
    this.physics.reset();

    // Reset player ready states
    for (const player of this.players.values()) {
      player.isReady = false;
    }
  }

  shutdown(): void {
    if (this.gameLoop) clearInterval(this.gameLoop);
    if (this.broadcastLoop) clearInterval(this.broadcastLoop);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    
    this.physics.reset();
    this.eventListeners = [];
  }
}
