import {
  Room,
  RoomInfo,
  RoomListItem,
  RoomState,
  Player,
  CarState,
  GameState,
  GameSettings,
  DEFAULT_GAME_SETTINGS,
  GamePhase,
  CarColor,
} from '@shared';
import { generateUUID, generateRoomCode, getAvailableColor } from '@shared';
import { GameRoom } from './gameRoom.js';
import { TrackManager } from '../tracks/trackManager.js';
import { LeaderboardManager } from '../leaderboards/leaderboardManager.js';
import { GAME_CONSTANTS } from '@shared';
import { logger } from '../utils/logger.js';

export class RoomManager {
  private rooms: Map<string, GameRoom> = new Map();
  private roomsByCode: Map<string, GameRoom> = new Map();
  private playerRooms: Map<string, string> = new Map(); // playerId -> roomId
  private trackManager: TrackManager;
  private leaderboardManager: LeaderboardManager;
  private cleanupInterval: NodeJS.Timeout;

  constructor(trackManager: TrackManager, leaderboardManager: LeaderboardManager) {
    this.trackManager = trackManager;
    this.leaderboardManager = leaderboardManager;
    
    // Start cleanup timer
    this.cleanupInterval = setInterval(() => this.cleanupIdleRooms(), 60000);
  }

  createRoom(
    hostId: string,
    hostNickname: string,
    hostColor: CarColor,
    settings: Partial<GameSettings>
  ): GameRoom | null {
    // Validate track exists
    const trackId = settings.trackId || this.getDefaultTrackId();
    const track = this.trackManager.getTrack(trackId);
    
    if (!track) {
      return null;
    }

    const roomId = generateUUID();
    const code = this.generateUniqueCode();
    
    const fullSettings: GameSettings = {
      ...DEFAULT_GAME_SETTINGS,
      ...settings,
      trackId,
    };

    const room = new GameRoom(
      roomId,
      code,
      hostId,
      fullSettings,
      track,
      this.leaderboardManager
    );

    // Add host as first player
    const hostPlayer = room.addPlayer(hostId, hostNickname, hostColor);
    if (!hostPlayer) {
      return null;
    }

    this.rooms.set(roomId, room);
    this.roomsByCode.set(code, room);
    this.playerRooms.set(hostId, roomId);

    logger.log('ROOM', `Room created: ${roomId} (code: ${code}) by ${hostNickname}`, {
      roomId,
      code,
      hostId,
      hostNickname,
      trackId,
      settings: fullSettings
    });
    console.log(`Room created: ${roomId} (code: ${code}) by ${hostNickname}`);

    return room;
  }

  getRoom(roomId: string): GameRoom | null {
    return this.rooms.get(roomId) || null;
  }

  getRoomByCode(code: string): GameRoom | null {
    return this.roomsByCode.get(code.toUpperCase()) || null;
  }

  getPlayerRoom(playerId: string): GameRoom | null {
    const roomId = this.playerRooms.get(playerId);
    if (!roomId) return null;
    return this.rooms.get(roomId) || null;
  }

  joinRoom(
    roomIdOrCode: string,
    playerId: string,
    nickname: string,
    preferredColor: CarColor
  ): { success: boolean; room?: GameRoom; player?: Player; error?: string } {
    // Find room by ID or code
    let room = this.rooms.get(roomIdOrCode);
    if (!room) {
      room = this.roomsByCode.get(roomIdOrCode.toUpperCase());
    }

    if (!room) {
      return { success: false, error: 'Room not found' };
    }

    if (room.isFull()) {
      return { success: false, error: 'Room is full' };
    }

    if (room.getState() === 'racing' && !room.getSettings().allowMidRaceJoin) {
      return { success: false, error: 'Race already in progress' };
    }

    // Leave previous room if any
    const currentRoom = this.getPlayerRoom(playerId);
    if (currentRoom) {
      this.leaveRoom(playerId);
    }

    const player = room.addPlayer(playerId, nickname, preferredColor);
    if (!player) {
      return { success: false, error: 'Failed to join room' };
    }

    this.playerRooms.set(playerId, room.getId());

    logger.log('ROOM', `Player joined room`, {
      playerId,
      nickname,
      roomId: room.getId(),
      roomCode: room.getCode()
    });

    return { success: true, room, player };
  }

  leaveRoom(playerId: string): void {
    const room = this.getPlayerRoom(playerId);
    if (!room) return;

    room.removePlayer(playerId);
    this.playerRooms.delete(playerId);

    // Remove empty rooms
    if (room.isEmpty()) {
      this.removeRoom(room.getId());
    }
  }

  private removeRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.shutdown();
    this.rooms.delete(roomId);
    this.roomsByCode.delete(room.getCode());

    console.log(`Room removed: ${roomId}`);
  }

  getPublicRooms(): RoomListItem[] {
    const rooms: RoomListItem[] = [];

    for (const room of this.rooms.values()) {
      if (!room.getSettings().isPrivate) {
        const track = this.trackManager.getTrack(room.getSettings().trackId);
        rooms.push({
          id: room.getId(),
          hostNickname: room.getHostNickname(),
          trackName: track?.name || 'Unknown',
          playerCount: room.getPlayerCount(),
          maxPlayers: room.getSettings().maxPlayers,
          state: room.getState(),
          lapCount: room.getSettings().lapCount,
        });
      }
    }

    return rooms;
  }

  private generateUniqueCode(): string {
    let code: string;
    do {
      code = generateRoomCode(GAME_CONSTANTS.ROOM_CODE_LENGTH);
    } while (this.roomsByCode.has(code));
    return code;
  }

  private getDefaultTrackId(): string {
    const tracks = this.trackManager.getTrackList();
    return tracks[0]?.id || 'default-oval';
  }

  private cleanupIdleRooms(): void {
    const now = Date.now();
    const idleTimeout = GAME_CONSTANTS.ROOM_IDLE_TIMEOUT;

    for (const [roomId, room] of this.rooms) {
      if (room.isEmpty() || (room.getState() === 'waiting' && room.getIdleTime(now) > idleTimeout)) {
        // Remove players from tracking
        for (const playerId of room.getPlayerIds()) {
          this.playerRooms.delete(playerId);
        }
        this.removeRoom(roomId);
      }
    }
  }

  shutdown(): void {
    clearInterval(this.cleanupInterval);
    
    for (const room of this.rooms.values()) {
      room.shutdown();
    }
    
    this.rooms.clear();
    this.roomsByCode.clear();
    this.playerRooms.clear();
  }

  getTrackManager(): TrackManager {
    return this.trackManager;
  }
}
