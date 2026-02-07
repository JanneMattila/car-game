import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';
import { useGameStore } from './gameStore';
import { debugLogger } from '../utils/debugLogger';
import { resetPredictionVelocity, setTrackBounds } from '../game/clientPrediction';
import {
  ServerMessage,
  ClientMessage,
  Player,
  RoomInfo,
  RoomListItem,
  TrackMetadata,
  GameStateSnapshot,
  RaceResult,
  CarColor,
  GameSettings,
  Track,
  InputState,
  PlayerInput,
} from '@shared';

interface NetworkState {
  socket: Socket | null;
  connected: boolean;
  playerId: string | null;
  localPlayerId: string | null; // Alias for playerId
  latency: number;
  serverTimeOffset: number;
  
  // Room state
  room: RoomInfo | null;
  players: Player[];
  track: Track | null;
  
  // Game state
  gameState: GameStateSnapshot | null;
  results: RaceResult[];
  
  // Lists
  roomList: RoomListItem[];
  trackList: TrackMetadata[];
  
  // Actions
  connect: () => void;
  disconnect: () => void;
  send: (message: ClientMessage) => void;
  
  // Room actions
  createRoom: (settings: Partial<GameSettings>, nickname: string, color: CarColor) => void;
  joinRoom: (roomIdOrCode: string, nickname: string, color: CarColor) => void;
  leaveRoom: () => void;
  setReady: (ready: boolean) => void;
  startGame: () => void;
  
  // In-game actions
  sendInput: (input: InputState) => void;
  sendChat: (message: string) => void;
  sendEmote: (emote: import('@shared').EmoteType) => void;
  
  // Requests
  requestRoomList: () => void;
  requestTrackList: () => void;
  
  // Internal
  _handleMessage: (message: ServerMessage) => void;
  _measureLatency: () => void;
}

export const useNetworkStore = create<NetworkState>((set, get) => ({
  socket: null,
  connected: false,
  playerId: null,
  localPlayerId: null,
  latency: 0,
  serverTimeOffset: 0,
  
  room: null,
  players: [],
  track: null,
  
  gameState: null,
  results: [],
  
  roomList: [],
  trackList: [],

  connect: () => {
    const existingSocket = get().socket;
    if (existingSocket?.connected) return;

    // Use relative URL in production, explicit localhost in development
    const serverUrl = typeof window !== 'undefined' && window.location.hostname === 'localhost'
      ? 'http://localhost:3000'
      : window.location.origin;

    const socket = io(serverUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socket.on('connect', () => {
      set({ connected: true });
      debugLogger.log('SOCKET', 'Connected to server');
    });

    socket.on('disconnect', () => {
      set({ connected: false });
      debugLogger.log('SOCKET', 'Disconnected from server');
    });

    socket.on('message', (msg: ServerMessage) => {
      get()._handleMessage(msg);
    });

    set({ socket });

    // Start latency measurement
    setInterval(() => get()._measureLatency(), 5000);
  },

  disconnect: () => {
    const { socket } = get();
    if (socket) {
      socket.disconnect();
      set({ socket: null, connected: false });
    }
  },

  send: (message: ClientMessage) => {
    const { socket, connected } = get();
    if (socket && connected) {
      socket.emit('message', message);
    }
  },

  createRoom: (settings, nickname, color) => {
    get().send({
      type: 'create_room',
      settings: settings as GameSettings,
      nickname,
      preferredColor: color,
    });
  },

  joinRoom: (roomIdOrCode, nickname, color) => {
    const isCode = roomIdOrCode.length === 6;
    get().send({
      type: 'join_room',
      roomId: isCode ? undefined : roomIdOrCode,
      code: isCode ? roomIdOrCode : undefined,
      nickname,
      preferredColor: color,
    });
  },

  leaveRoom: () => {
    get().send({ type: 'leave_room' });
    set({ room: null, players: [], gameState: null, results: [], track: null });
  },

  setReady: (ready) => {
    debugLogger.log('ROOM', 'setReady called', { ready, connected: get().connected });
    get().send({ type: 'set_ready', ready });
  },

  startGame: () => {
    get().send({ type: 'start_game' });
  },

  sendInput: (input) => {
    const { playerId } = get();
    if (!playerId) return;
    
    // Convert InputState to PlayerInput
    const playerInput: PlayerInput = {
      playerId,
      sequence: input.sequenceNumber || Date.now(),
      timestamp: Date.now(),
      accelerate: input.accelerate,
      brake: input.brake,
      steerLeft: input.steerLeft,
      steerRight: input.steerRight,
      steerValue: input.steerValue,
      nitro: input.nitro,
      handbrake: input.handbrake,
      respawn: input.respawn,
    };
    
    get().send({ type: 'input', input: playerInput });
  },

  sendChat: (message) => {
    get().send({ type: 'chat', message });
  },

  sendEmote: (emote) => {
    get().send({ type: 'emote', emote });
  },

  requestRoomList: () => {
    get().send({ type: 'request_room_list' });
  },

  requestTrackList: () => {
    get().send({ type: 'request_track_list' });
  },

  _handleMessage: (message) => {
    switch (message.type) {
      case 'welcome':
        set({ 
          playerId: message.playerId,
          localPlayerId: message.playerId,
          serverTimeOffset: Date.now() - message.serverTime,
        });
        // Sync localPlayerId to game store so prediction/reconciliation works
        useGameStore.getState().setLocalPlayer(message.playerId);
        break;

      case 'room_joined':
        set({ 
          room: message.room, 
          players: message.players,
        });
        break;

      case 'room_left':
        set({ room: null, players: [], gameState: null, track: null });
        break;

      case 'player_joined':
        set(state => ({
          room: state.room ? {
            ...state.room,
            players: [...state.room.players, message.player],
          } : null,
        }));
        break;

      case 'player_left':
        set(state => ({
          room: state.room ? {
            ...state.room,
            players: state.room.players.filter(p => p.id !== message.playerId),
          } : null,
        }));
        break;

      case 'player_ready':
        debugLogger.log('ROOM', 'player_ready received', { playerId: message.playerId, ready: message.ready });
        set(state => ({
          players: state.players.map(p =>
            p.id === message.playerId ? { ...p, isReady: message.ready } : p
          ),
          room: state.room ? {
            ...state.room,
            players: state.room.players.map(p =>
              p.id === message.playerId ? { ...p, ready: message.ready } : p
            ),
          } : null,
        }));
        break;

      case 'game_starting':
        debugLogger.log('GAME', 'game_starting received', { 
          hasRoom: !!get().room, 
          hasTrack: !!message.track, 
          trackId: message.track?.id,
          trackElements: message.track?.elements?.length,
          hasCars: !!message.cars,
          carsCount: message.cars?.length,
          countdown: message.countdown
        });
        set(state => state.room ? {
          room: { ...state.room, state: 'countdown' },
          track: message.track || state.track,
        } : {});
        // Set track bounds for client prediction wrap-around
        if (message.track) {
          setTrackBounds({
            width: message.track.width,
            height: message.track.height,
            wrapAround: message.track.wrapAround ?? false,
          });
        }
        // Initialize cars from message
        if (message.cars) {
          const { initializeCars, setCountdown } = useGameStore.getState();
          initializeCars(message.cars);
          setCountdown(message.countdown ?? 3);
        }
        break;

      case 'countdown':
        // Update countdown value (3, 2, 1, 0=GO!)
        useGameStore.getState().setCountdown(message.count);
        break;

      case 'game_started':
        set(state => state.room ? {
          room: { ...state.room, state: 'racing' },
        } : {});
        // Clear countdown and reset timer when race starts
        useGameStore.getState().setCountdown(null);
        useGameStore.getState().setRaceTimer(0);
        break;

      case 'lap_completed': {
        // Update the room player's lap count and best lap time
        const lapPlayerId = message.playerId;
        const lapTime = message.lapTime;
        const lapNum = message.lap;
        set(state => ({
          room: state.room ? {
            ...state.room,
            players: state.room.players.map(p =>
              p.id === lapPlayerId
                ? {
                    ...p,
                    lap: lapNum,
                    checkpointIndex: 0,
                    bestLapTime: p.bestLapTime === null ? lapTime : Math.min(p.bestLapTime, lapTime),
                  }
                : p
            ),
          } : null,
        }));
        // Also update game store car's lapTimes array
        {
          const gameState = useGameStore.getState();
          const car = gameState.cars.get(lapPlayerId);
          if (car) {
            gameState.setCarState(lapPlayerId, {
              lapTimes: [...(car.lapTimes ?? []), lapTime],
            });
          }
        }
        break;
      }

      case 'checkpoint_passed': {
        const cpPlayerId = message.playerId;
        const cpIndex = message.checkpoint;
        set(state => ({
          room: state.room ? {
            ...state.room,
            players: state.room.players.map(p =>
              p.id === cpPlayerId
                ? { ...p, checkpointIndex: cpIndex + 1 }
                : p
            ),
          } : null,
        }));
        break;
      }

      case 'player_finished': {
        const finPlayerId = message.playerId;
        set(state => ({
          room: state.room ? {
            ...state.room,
            players: state.room.players.map(p =>
              p.id === finPlayerId
                ? { ...p, finished: true, finishTime: message.totalTime }
                : p
            ),
          } : null,
        }));
        break;
      }

      case 'game_state':
        set({ gameState: message.state });
        // Update cars in game store for interpolation
        if (message.state) {
          const { updateFromServer, setRespawning, respawning } = useGameStore.getState();
          updateFromServer(message.state);

          // Sync room.players with live car data from the game state snapshot
          // so that HUD/leaderboard always show current lap/checkpoint values
          const currentRoom = get().room;
          if (currentRoom && message.state.cars) {
            const carMap = new Map(message.state.cars.map(c => [c.playerId, c]));
            const updatedPlayers = currentRoom.players.map(p => {
              const carSnap = carMap.get(p.id);
              if (!carSnap) return p;
              return {
                ...p,
                position: { x: carSnap.x, y: carSnap.y },
                angle: carSnap.rotation,
                velocity: { x: carSnap.vx, y: carSnap.vy },
                lap: carSnap.lap,
                checkpointIndex: carSnap.checkpoint,
                finished: carSnap.finished,
              };
            });
            set(state => ({
              room: state.room ? { ...state.room, players: updatedPlayers } : null,
            }));
          }
          
          // Check for respawn events for the local player
          if (message.state.events) {
            const localId = get().playerId;
            for (const event of message.state.events) {
              if (event.type === 'respawn' && event.playerId === localId) {
                // Reset client-side prediction velocity
                resetPredictionVelocity();
                
                // Show overlay only if not already showing
                if (!respawning) {
                  setRespawning(true);
                  setTimeout(() => useGameStore.getState().setRespawning(false), 2000);
                }
                break;
              }
            }
          }
        }
        break;

      case 'race_finished':
        set(state => ({
          results: message.results,
          room: state.room ? { ...state.room, state: 'results' as const } : null,
        }));
        break;

      case 'room_list':
        set({ roomList: message.rooms });
        break;

      case 'track_list':
        set({ trackList: message.tracks });
        break;

      case 'pong':
        const latency = (Date.now() - message.clientTimestamp) / 2;
        const serverTimeOffset = message.serverTimestamp - Date.now() + latency;
        set({ latency, serverTimeOffset });
        break;

      case 'error':
        debugLogger.log('ERROR', 'Server error', { code: message.code, message: message.message });
        // Could dispatch to a toast/notification system
        break;
    }
  },

  _measureLatency: () => {
    get().send({ type: 'ping', timestamp: Date.now() });
  },
}));
