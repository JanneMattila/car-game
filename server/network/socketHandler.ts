import { Server, Socket } from 'socket.io';
import {
  ClientMessage,
  ServerMessage,
  Player,
  CarColor,
  GameSettings,
  EmoteType,
  GAME_CONSTANTS,
  Track,
  CarStateSnapshot,
  RoomPlayer,
} from '@shared';
import { validateNickname, sanitizeChatMessage, isValidRoomCode } from '@shared';
import { RoomManager } from '../game/roomManager.js';
import { GameRoom } from '../game/gameRoom.js';
import { logger } from '../utils/logger.js';

interface SocketData {
  playerId: string;
  nickname: string;
  lastEmoteTime: number;
}

export class SocketHandler {
  private io: Server;
  private roomManager: RoomManager;
  private socketToPlayer: Map<string, string> = new Map();
  private playerToSocket: Map<string, string> = new Map();

  constructor(io: Server, roomManager: RoomManager) {
    this.io = io;
    this.roomManager = roomManager;
  }

  initialize(): void {
    this.io.on('connection', (socket) => {
      console.log(`Client connected: ${socket.id}`);
      logger.log('SOCKET', `Client connected`, { socketId: socket.id });
      
      // Initialize socket data
      const socketData: SocketData = {
        playerId: socket.id,
        nickname: '',
        lastEmoteTime: 0,
      };
      (socket as unknown as { data: SocketData }).data = socketData;

      // Send welcome message
      this.send(socket, {
        type: 'welcome',
        playerId: socket.id,
        serverTime: Date.now(),
      });

      // Set up message handlers
      socket.on('message', (msg: ClientMessage) => {
        this.handleMessage(socket, msg);
      });

      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
      });
    });
  }

  private send(socket: Socket, message: ServerMessage): void {
    socket.emit('message', message);
  }

  private broadcast(room: string, message: ServerMessage, excludeSocket?: string): void {
    if (excludeSocket) {
      this.io.to(room).except(excludeSocket).emit('message', message);
    } else {
      this.io.to(room).emit('message', message);
    }
  }

  private handleMessage(socket: Socket, msg: ClientMessage): void {
    const socketData = (socket as unknown as { data: SocketData }).data;

    switch (msg.type) {
      case 'create_room':
        this.handleCreateRoom(socket, socketData, msg.settings, msg.nickname, msg.preferredColor);
        break;

      case 'join_room':
        this.handleJoinRoom(socket, socketData, msg.roomId, msg.code, msg.nickname, msg.preferredColor);
        break;

      case 'leave_room':
        this.handleLeaveRoom(socket, socketData);
        break;

      case 'set_ready':
        this.handleSetReady(socket, socketData, msg.ready);
        break;

      case 'start_game':
        this.handleStartGame(socket, socketData);
        break;

      case 'input':
        this.handleInput(socket, socketData, msg.input);
        break;

      case 'chat':
        this.handleChat(socket, socketData, msg.message);
        break;

      case 'emote':
        this.handleEmote(socket, socketData, msg.emote);
        break;

      case 'request_room_list':
        this.handleRequestRoomList(socket);
        break;

      case 'request_track_list':
        this.handleRequestTrackList(socket);
        break;

      case 'ping':
        this.send(socket, {
          type: 'pong',
          clientTimestamp: msg.timestamp,
          serverTimestamp: Date.now(),
        });
        break;
    }
  }

  private handleCreateRoom(
    socket: Socket,
    socketData: SocketData,
    settings: GameSettings,
    nickname: string,
    preferredColor: CarColor
  ): void {
    const validation = validateNickname(nickname);
    if (!validation.valid) {
      this.send(socket, { type: 'error', code: 'INVALID_NICKNAME', message: validation.error! });
      return;
    }

    socketData.nickname = nickname;

    const room = this.roomManager.createRoom(
      socketData.playerId,
      nickname,
      preferredColor,
      settings
    );

    if (!room) {
      this.send(socket, { type: 'error', code: 'CREATE_FAILED', message: 'Failed to create room' });
      return;
    }

    // Join socket to room
    socket.join(room.getId());
    this.socketToPlayer.set(socket.id, socketData.playerId);
    this.playerToSocket.set(socketData.playerId, socket.id);

    // Subscribe to room events
    this.subscribeToRoom(room);

    this.send(socket, {
      type: 'room_joined',
      room: room.getRoomInfo(),
      players: room.getPlayers(),
      playerId: socketData.playerId,
    });
  }

  private handleJoinRoom(
    socket: Socket,
    socketData: SocketData,
    roomId: string | undefined,
    code: string | undefined,
    nickname: string,
    preferredColor: CarColor
  ): void {
    const validation = validateNickname(nickname);
    if (!validation.valid) {
      this.send(socket, { type: 'error', code: 'INVALID_NICKNAME', message: validation.error! });
      return;
    }

    const identifier = roomId || code;
    if (!identifier) {
      this.send(socket, { type: 'error', code: 'NO_ROOM', message: 'Room ID or code required' });
      return;
    }

    socketData.nickname = nickname;

    const result = this.roomManager.joinRoom(
      identifier,
      socketData.playerId,
      nickname,
      preferredColor
    );

    if (!result.success) {
      this.send(socket, { type: 'error', code: 'JOIN_FAILED', message: result.error! });
      return;
    }

    const room = result.room!;
    
    // Join socket to room
    socket.join(room.getId());
    this.socketToPlayer.set(socket.id, socketData.playerId);
    this.playerToSocket.set(socketData.playerId, socket.id);

    // Subscribe to room events if not already
    this.subscribeToRoom(room);

    // Notify other players - convert Player to RoomPlayer format
    const player = result.player!;
    const roomPlayer: RoomPlayer = {
      id: player.id,
      nickname: player.nickname,
      color: player.color,
      ready: player.isReady,
      isHost: player.id === room.getHostId(),
      position: null,
      angle: 0,
      velocity: null,
      lap: 0,
      checkpointIndex: 0,
      finished: false,
      finishTime: null,
      bestLapTime: null,
    };
    this.broadcast(room.getId(), {
      type: 'player_joined',
      player: roomPlayer,
    }, socket.id);

    // Send room info to joining player
    this.send(socket, {
      type: 'room_joined',
      room: room.getRoomInfo(),
      players: room.getPlayers(),
      playerId: socketData.playerId,
    });
  }

  private handleLeaveRoom(socket: Socket, socketData: SocketData): void {
    const room = this.roomManager.getPlayerRoom(socketData.playerId);
    if (!room) return;

    const roomId = room.getId();
    
    this.roomManager.leaveRoom(socketData.playerId);
    socket.leave(roomId);

    this.send(socket, { type: 'room_left', reason: 'left' });
  }

  private handleSetReady(socket: Socket, socketData: SocketData, ready: boolean): void {
    const room = this.roomManager.getPlayerRoom(socketData.playerId);
    logger.log('SOCKET', 'handleSetReady', { playerId: socketData.playerId, ready, hasRoom: !!room });
    if (!room) return;

    room.setPlayerReady(socketData.playerId, ready);
  }

  private handleStartGame(socket: Socket, socketData: SocketData): void {
    const room = this.roomManager.getPlayerRoom(socketData.playerId);
    if (!room) return;

    // Only host can start
    if (room.getHostId() !== socketData.playerId) {
      this.send(socket, { type: 'error', code: 'NOT_HOST', message: 'Only host can start the game' });
      return;
    }

    if (!room.startGame()) {
      this.send(socket, { type: 'error', code: 'CANNOT_START', message: 'Cannot start game' });
    }
  }

  private handleInput(socket: Socket, socketData: SocketData, input: unknown): void {
    const room = this.roomManager.getPlayerRoom(socketData.playerId);
    if (!room) return;

    room.handleInput(socketData.playerId, input as import('@shared').PlayerInput);
  }

  private handleChat(socket: Socket, socketData: SocketData, message: string): void {
    const room = this.roomManager.getPlayerRoom(socketData.playerId);
    if (!room || !room.getSettings().enableChat) return;

    const sanitized = sanitizeChatMessage(message);
    if (!sanitized) return;

    this.broadcast(room.getId(), {
      type: 'chat',
      playerId: socketData.playerId,
      nickname: socketData.nickname,
      message: sanitized,
    });
  }

  private handleEmote(socket: Socket, socketData: SocketData, emote: EmoteType): void {
    const room = this.roomManager.getPlayerRoom(socketData.playerId);
    if (!room) return;

    // Check cooldown
    const now = Date.now();
    if (now - socketData.lastEmoteTime < GAME_CONSTANTS.EMOTE_COOLDOWN) {
      return;
    }
    socketData.lastEmoteTime = now;

    this.broadcast(room.getId(), {
      type: 'emote',
      playerId: socketData.playerId,
      emote,
    });
  }

  private handleRequestRoomList(socket: Socket): void {
    const rooms = this.roomManager.getPublicRooms();
    this.send(socket, { type: 'room_list', rooms });
  }

  private handleRequestTrackList(socket: Socket): void {
    const tracks = this.roomManager.getTrackManager().getTrackList();
    this.send(socket, { type: 'track_list', tracks });
  }

  private handleDisconnect(socket: Socket): void {
    const socketData = (socket as unknown as { data: SocketData }).data;
    
    console.log(`Client disconnected: ${socket.id}`);

    // Mark player as disconnected but don't remove immediately
    const room = this.roomManager.getPlayerRoom(socketData.playerId);
    if (room) {
      room.setPlayerConnected(socketData.playerId, false);
      
      // Remove after timeout if not reconnected
      setTimeout(() => {
        const currentRoom = this.roomManager.getPlayerRoom(socketData.playerId);
        if (currentRoom) {
          const player = currentRoom.getPlayer(socketData.playerId);
          if (player && !player.isConnected) {
            this.roomManager.leaveRoom(socketData.playerId);
            this.broadcast(currentRoom.getId(), {
              type: 'player_left',
              playerId: socketData.playerId,
              reason: 'disconnected',
            });
          }
        }
      }, GAME_CONSTANTS.PLAYER_DISCONNECT_TIMEOUT);
    }

    this.socketToPlayer.delete(socket.id);
    this.playerToSocket.delete(socketData.playerId);
  }

  private subscribeToRoom(room: GameRoom): void {
    const roomId = room.getId();

    // Check if already subscribed
    if ((room as unknown as { _socketSubscribed?: boolean })._socketSubscribed) {
      return;
    }
    (room as unknown as { _socketSubscribed?: boolean })._socketSubscribed = true;

    room.addEventListener((event, data) => {
      switch (event) {
        case 'player_joined':
          // Handled in handleJoinRoom
          break;

        case 'player_left':
          this.broadcast(roomId, {
            type: 'player_left',
            playerId: (data as { playerId: string }).playerId,
            reason: (data as { reason: string }).reason,
          });
          break;

        case 'player_ready':
          this.broadcast(roomId, {
            type: 'player_ready',
            playerId: (data as { playerId: string }).playerId,
            ready: (data as { ready: boolean }).ready,
          });
          break;

        case 'game_starting':
          logger.log('GAME', 'Broadcasting game_starting', {
            roomId,
            countdown: (data as { countdown: number }).countdown,
            trackId: (data as { track: Track }).track?.id,
            carCount: (data as { cars: CarStateSnapshot[] }).cars?.length
          });
          this.broadcast(roomId, {
            type: 'game_starting',
            countdown: (data as { countdown: number }).countdown,
            track: (data as { track: Track }).track,
            cars: (data as { cars: CarStateSnapshot[] }).cars,
          });
          break;

        case 'countdown':
          this.broadcast(roomId, {
            type: 'countdown',
            count: (data as { count: number }).count,
          });
          break;

        case 'game_started':
          this.broadcast(roomId, {
            type: 'game_started',
            startTime: (data as { startTime: number }).startTime,
          });
          break;

        case 'game_state':
          this.broadcast(roomId, {
            type: 'game_state',
            state: data as import('@shared').GameStateSnapshot,
          });
          break;

        case 'checkpoint_passed':
          this.broadcast(roomId, {
            type: 'checkpoint_passed',
            playerId: (data as { playerId: string; checkpoint: number; time: number }).playerId,
            checkpoint: (data as { playerId: string; checkpoint: number; time: number }).checkpoint,
            time: (data as { playerId: string; checkpoint: number; time: number }).time,
          });
          break;

        case 'lap_completed':
          this.broadcast(roomId, {
            type: 'lap_completed',
            playerId: (data as { playerId: string; lap: number; lapTime: number }).playerId,
            lap: (data as { playerId: string; lap: number; lapTime: number }).lap,
            lapTime: (data as { playerId: string; lap: number; lapTime: number }).lapTime,
          });
          break;

        case 'player_finished':
          this.broadcast(roomId, {
            type: 'player_finished',
            playerId: (data as { playerId: string; position: number; totalTime: number }).playerId,
            position: (data as { playerId: string; position: number; totalTime: number }).position,
            totalTime: (data as { playerId: string; position: number; totalTime: number }).totalTime,
          });
          break;

        case 'race_finished':
          this.broadcast(roomId, {
            type: 'race_finished',
            results: (data as { results: import('@shared').RaceResult[] }).results,
          });
          break;
      }
    });
  }
}
