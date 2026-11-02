import { spawn, type ChildProcess } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { COLOR_ORDER, type CarColor, type Track } from '@shared';
import type { Profile } from '../profiles/profileManager.js';

export type LobbyStatus = 'waiting' | 'starting' | 'running';

export interface NativeResultEntry {
  playerId: string;
  nickname: string;
  position: number;
  finished: boolean;
  totalMs: number;
  bestLapMs: number;
  laps: number;
  isBot: boolean;
}

export interface NativeRaceResult {
  matchId: string;
  trackId: string;
  lapCount: number;
  reason: string;
  finishedAt: number;
  results: NativeResultEntry[];
}

interface LobbyPlayer {
  profileId: string;
  nickname: string;
  color: CarColor;
  ready: boolean;
  lastSeen: number;
}

interface RunningMatch {
  id: string;
  port: number;
  process: ChildProcess;
  tokens: Map<string, string>;
  startedAt: number;
  ready: boolean;
  result: NativeRaceResult | null;
  failure: string | null;
  logs: string[];
  readyTimer: NodeJS.Timeout | null;
  lifetimeTimer: NodeJS.Timeout | null;
}

interface Lobby {
  id: string;
  name: string;
  hostId: string;
  trackId: string;
  trackName: string;
  lapCount: number;
  botCount: number;
  status: LobbyStatus;
  message: string;
  players: LobbyPlayer[];
  lastResult: NativeRaceResult | null;
  match: RunningMatch | null;
  createdAt: number;
}

export interface NativeLobbyView {
  id: string;
  name: string;
  hostId: string;
  trackId: string;
  trackName: string;
  lapCount: number;
  botCount: number;
  status: LobbyStatus;
  message: string;
  players: { profileId: string; nickname: string; color: CarColor; ready: boolean }[];
  lastResult: NativeRaceResult | null;
  connection?: { host: string; port: number; token: string; matchId: string };
}

export interface NativeMatchOptions {
  /** Shell command used to start a game server; `{port}` is replaced with the allocated port. */
  command?: string;
  /** Path to the cg_server executable (used when no command is given). */
  serverPath?: string;
  portBase: number;
  portCount: number;
  /** Host name clients should connect to; empty means "same host as the web API". */
  publicHost: string;
  readyTimeoutMs: number;
  maxMatchMs: number;
  idleTimeoutMs: number;
  /** Extra JSON merged into every match config (e.g. network conditions for testing). */
  extraConfig?: Record<string, unknown>;
}

export interface NativeMatchDependencies {
  getTrack(id: string): Track | null;
  submitLapTime(trackId: string, nickname: string, ms: number): Promise<unknown>;
  submitRaceTime(trackId: string, nickname: string, ms: number, laps: number): Promise<unknown>;
  log?(message: string): void;
}

export class NativeLobbyError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

const MAX_CARS = 8;
const MAX_LOG_LINES = 200;
const EVENT_PREFIX = '@@EVENT ';
const BOT_SKILLS = ['easy', 'medium', 'hard'];

/** Stops a game server and anything it started (a shell command may wrap the real process). */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

export function nativeOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): NativeMatchOptions {
  const int = (name: string, fallback: number) => {
    const value = Number.parseInt(env[name] ?? '', 10);
    return Number.isFinite(value) ? value : fallback;
  };
  let serverPath = env['NATIVE_SERVER_PATH'];
  if (!serverPath && !env['NATIVE_SERVER_COMMAND']) {
    const exe = process.platform === 'win32' ? 'cg_server.exe' : 'cg_server';
    const candidates = [
      path.resolve('native', 'build', 'msvc', exe),
      path.resolve('native', 'build', 'release', exe),
      path.resolve('native', 'build', exe),
      path.resolve('native-bin', exe),
    ];
    serverPath = candidates.find(candidate => fs.existsSync(candidate));
  }
  return {
    command: env['NATIVE_SERVER_COMMAND'] || undefined,
    serverPath,
    portBase: int('NATIVE_PORT_BASE', 5555),
    portCount: Math.max(1, int('NATIVE_PORT_COUNT', 50)),
    publicHost: env['NATIVE_PUBLIC_HOST'] ?? '',
    readyTimeoutMs: int('NATIVE_READY_TIMEOUT_MS', 10000),
    maxMatchMs: int('NATIVE_MAX_MATCH_MS', 30 * 60 * 1000),
    idleTimeoutMs: int('NATIVE_LOBBY_IDLE_MS', 60000),
  };
}

/**
 * Lobbies for the native client. Each started race runs in its own game server process which
 * reports progress as `@@EVENT {json}` lines on stdout. When the process exits, for any reason,
 * the players are returned to the lobby.
 */
export class NativeMatchManager {
  private lobbies = new Map<string, Lobby>();
  private usedPorts = new Set<number>();
  private sweepTimer: NodeJS.Timeout;

  constructor(
    private options: NativeMatchOptions,
    private deps: NativeMatchDependencies
  ) {
    this.sweepTimer = setInterval(() => this.sweepIdlePlayers(), 5000);
    this.sweepTimer.unref();
  }

  get configured(): boolean {
    return Boolean(this.options.command || this.options.serverPath);
  }

  list(): NativeLobbyView[] {
    return [...this.lobbies.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(lobby => this.view(lobby));
  }

  get(lobbyId: string, profileId?: string): NativeLobbyView {
    const lobby = this.require(lobbyId);
    if (profileId) {
      const player = lobby.players.find(p => p.profileId === profileId);
      if (player) player.lastSeen = Date.now();
    }
    return this.view(lobby, profileId);
  }

  create(
    profile: Profile,
    settings: { trackId?: unknown; lapCount?: unknown; botCount?: unknown }
  ) {
    this.leaveAll(profile.id);
    const track = this.resolveTrack(settings.trackId);
    const lobby: Lobby = {
      id: randomUUID().slice(0, 8),
      name: `${profile.nickname}'s race`,
      hostId: profile.id,
      trackId: track.id,
      trackName: track.name,
      lapCount: this.parseLapCount(settings.lapCount, track.defaultLapCount || 3),
      botCount: 0,
      status: 'waiting',
      message: '',
      players: [this.newPlayer(profile, [])],
      lastResult: null,
      match: null,
      createdAt: Date.now(),
    };
    lobby.botCount = this.parseBotCount(settings.botCount, lobby.players.length, 0);
    this.lobbies.set(lobby.id, lobby);
    this.log(`lobby ${lobby.id} created by ${profile.nickname} on ${track.id}`);
    return this.view(lobby, profile.id);
  }

  join(lobbyId: string, profile: Profile): NativeLobbyView {
    const lobby = this.require(lobbyId);
    const existing = lobby.players.find(p => p.profileId === profile.id);
    if (existing) {
      existing.lastSeen = Date.now();
      return this.view(lobby, profile.id);
    }
    if (lobby.status !== 'waiting') throw new NativeLobbyError('Race already in progress', 409);
    if (lobby.players.length + lobby.botCount >= MAX_CARS) {
      if (lobby.botCount === 0 || lobby.players.length >= MAX_CARS) {
        throw new NativeLobbyError('Lobby is full', 409);
      }
      lobby.botCount--;
    }
    this.leaveAll(profile.id);
    const used = lobby.players.map(p => p.color);
    lobby.players.push(this.newPlayer(profile, used));
    this.log(`${profile.nickname} joined lobby ${lobby.id}`);
    return this.view(lobby, profile.id);
  }

  leave(lobbyId: string, profileId: string): void {
    const lobby = this.require(lobbyId);
    this.removePlayer(lobby, profileId);
  }

  setReady(lobbyId: string, profileId: string, ready: boolean): NativeLobbyView {
    const lobby = this.require(lobbyId);
    const player = this.requirePlayer(lobby, profileId);
    player.ready = ready;
    player.lastSeen = Date.now();
    return this.view(lobby, profileId);
  }

  updateSettings(
    lobbyId: string,
    profileId: string,
    settings: { trackId?: unknown; lapCount?: unknown; botCount?: unknown }
  ): NativeLobbyView {
    const lobby = this.require(lobbyId);
    if (lobby.hostId !== profileId)
      throw new NativeLobbyError('Only the host can change settings', 403);
    if (lobby.status !== 'waiting') throw new NativeLobbyError('Race already in progress', 409);
    if (settings.trackId !== undefined) {
      const track = this.resolveTrack(settings.trackId);
      lobby.trackId = track.id;
      lobby.trackName = track.name;
    }
    if (settings.lapCount !== undefined) {
      lobby.lapCount = this.parseLapCount(settings.lapCount, lobby.lapCount);
    }
    if (settings.botCount !== undefined) {
      lobby.botCount = this.parseBotCount(settings.botCount, lobby.players.length, lobby.botCount);
    }
    for (const player of lobby.players) player.ready = false;
    return this.view(lobby, profileId);
  }

  start(lobbyId: string, profileId: string): NativeLobbyView {
    const lobby = this.require(lobbyId);
    if (lobby.hostId !== profileId)
      throw new NativeLobbyError('Only the host can start the race', 403);
    if (lobby.status !== 'waiting') throw new NativeLobbyError('Race already in progress', 409);
    const notReady = lobby.players.filter(p => p.profileId !== lobby.hostId && !p.ready);
    if (notReady.length > 0) {
      throw new NativeLobbyError(`Waiting for: ${notReady.map(p => p.nickname).join(', ')}`, 409);
    }
    if (!this.configured) {
      throw new NativeLobbyError('Native game server is not configured on this server', 503);
    }
    const track = this.deps.getTrack(lobby.trackId);
    if (!track) throw new NativeLobbyError('Track no longer exists', 404);
    const port = this.allocatePort();
    if (port === null) throw new NativeLobbyError('No free game server ports', 503);
    this.launch(lobby, track, port);
    return this.view(lobby, profileId);
  }

  /** Diagnostic view including process details and recent server output. */
  debug() {
    return {
      configured: this.configured,
      command: this.options.command ?? null,
      serverPath: this.options.serverPath ?? null,
      portBase: this.options.portBase,
      usedPorts: [...this.usedPorts],
      lobbies: [...this.lobbies.values()].map(lobby => ({
        ...this.view(lobby),
        match: lobby.match && {
          id: lobby.match.id,
          port: lobby.match.port,
          pid: lobby.match.process.pid ?? null,
          ready: lobby.match.ready,
          startedAt: lobby.match.startedAt,
          logs: lobby.match.logs.slice(-50),
        },
      })),
    };
  }

  shutdown(): void {
    clearInterval(this.sweepTimer);
    for (const lobby of this.lobbies.values()) {
      if (lobby.match) killTree(lobby.match.process);
    }
  }

  private launch(lobby: Lobby, track: Track, port: number): void {
    const matchId = `${lobby.id}-${Date.now().toString(36)}`;
    const tokens = new Map<string, string>();
    for (const player of lobby.players)
      tokens.set(player.profileId, randomBytes(16).toString('hex'));

    const usedColors = lobby.players.map(p => p.color);
    const botColors = COLOR_ORDER.filter(c => !usedColors.includes(c));
    const config = {
      ...this.options.extraConfig,
      matchId,
      port,
      lapCount: lobby.lapCount,
      track,
      players: lobby.players.map(p => ({
        id: p.profileId,
        nickname: p.nickname,
        color: p.color,
        token: tokens.get(p.profileId),
      })),
      bots: Array.from({ length: lobby.botCount }, (_, i) => ({
        id: `bot-${i + 1}`,
        nickname: `Bot ${i + 1}`,
        color: botColors[i % Math.max(1, botColors.length)] ?? 'silver',
        skill: BOT_SKILLS[i % BOT_SKILLS.length],
      })),
    };

    let child: ChildProcess;
    try {
      child = this.spawnServer(port);
    } catch (err) {
      this.usedPorts.delete(port);
      throw new NativeLobbyError(`Could not start game server: ${(err as Error).message}`, 500);
    }
    const match: RunningMatch = {
      id: matchId,
      port,
      process: child,
      tokens,
      startedAt: Date.now(),
      ready: false,
      result: null,
      failure: null,
      logs: [],
      readyTimer: null,
      lifetimeTimer: null,
    };
    lobby.match = match;
    lobby.status = 'starting';
    lobby.message = 'Starting game server...';
    this.log(`lobby ${lobby.id}: starting match ${matchId} on port ${port} (pid ${child.pid})`);

    const remember = (line: string) => {
      match.logs.push(line);
      if (match.logs.length > MAX_LOG_LINES) match.logs.shift();
    };
    readline.createInterface({ input: child.stdout! }).on('line', line => {
      if (line.startsWith(EVENT_PREFIX)) {
        remember(line);
        try {
          this.onEvent(lobby, match, JSON.parse(line.slice(EVENT_PREFIX.length)));
        } catch (err) {
          this.log(`lobby ${lobby.id}: bad event line: ${(err as Error).message}`);
        }
      } else if (line.trim()) {
        remember(line);
      }
    });
    readline.createInterface({ input: child.stderr! }).on('line', line => {
      remember(line);
      if (/\b(WARN|ERROR)\b/.test(line)) this.log(`[match ${matchId}] ${line}`);
    });

    child.on('error', err => {
      match.failure = `Could not start game server: ${err.message}`;
      this.log(`lobby ${lobby.id}: ${match.failure}`);
      // 'exit' may not follow a spawn failure.
      setImmediate(() => this.onExit(lobby, match, null, null));
    });
    child.on('exit', (code, signal) => this.onExit(lobby, match, code, signal));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(JSON.stringify(config));

    match.readyTimer = setTimeout(() => {
      if (!match.ready) {
        match.failure = 'Game server did not start in time';
        this.log(`lobby ${lobby.id}: ${match.failure}`);
        killTree(child);
      }
    }, this.options.readyTimeoutMs);
    match.lifetimeTimer = setTimeout(() => {
      match.failure = 'Race exceeded the maximum duration';
      killTree(child);
    }, this.options.maxMatchMs);
  }

  private spawnServer(port: number): ChildProcess {
    const stdio: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe'];
    if (this.options.command) {
      const command = this.options.command.replaceAll('{port}', String(port));
      return spawn(command, {
        shell: true,
        stdio,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    }
    return spawn(this.options.serverPath!, ['--config', '-', '--port', String(port)], {
      stdio,
      windowsHide: true,
    });
  }

  private onEvent(lobby: Lobby, match: RunningMatch, event: Record<string, unknown>): void {
    if (lobby.match !== match) return;
    switch (event['type']) {
      case 'ready':
        match.ready = true;
        lobby.status = 'running';
        lobby.message = '';
        this.log(`lobby ${lobby.id}: game server ready on port ${match.port}`);
        break;
      case 'result': {
        const result: NativeRaceResult = {
          matchId: match.id,
          trackId: lobby.trackId,
          lapCount: Number(event['lapCount']) || lobby.lapCount,
          reason: String(event['reason'] ?? ''),
          finishedAt: Date.now(),
          results: Array.isArray(event['results']) ? (event['results'] as NativeResultEntry[]) : [],
        };
        match.result = result;
        void this.submitLeaderboards(result);
        break;
      }
      case 'error':
        match.failure = `Game server error: ${String(event['message'] ?? 'unknown')}`;
        break;
      default:
        break;
    }
  }

  private async submitLeaderboards(result: NativeRaceResult): Promise<void> {
    for (const entry of result.results) {
      if (entry.isBot || !entry.finished) continue;
      try {
        if (entry.bestLapMs > 0) {
          await this.deps.submitLapTime(result.trackId, entry.nickname, entry.bestLapMs);
        }
        if (entry.totalMs > 0) {
          await this.deps.submitRaceTime(
            result.trackId,
            entry.nickname,
            entry.totalMs,
            result.lapCount
          );
        }
      } catch (err) {
        this.log(`leaderboard submit failed: ${(err as Error).message}`);
      }
    }
  }

  private onExit(lobby: Lobby, match: RunningMatch, code: number | null, signal: string | null) {
    if (lobby.match !== match) return;
    if (match.readyTimer) clearTimeout(match.readyTimer);
    if (match.lifetimeTimer) clearTimeout(match.lifetimeTimer);
    this.usedPorts.delete(match.port);
    lobby.match = null;
    lobby.status = 'waiting';
    const now = Date.now();
    for (const player of lobby.players) {
      player.ready = false;
      player.lastSeen = now;
    }
    if (match.result && code === 0) {
      lobby.lastResult = match.result;
      lobby.message = '';
    } else {
      if (match.result) lobby.lastResult = match.result;
      const how = signal ? `signal ${signal}` : `exit code ${code}`;
      lobby.message =
        match.failure ??
        (match.ready ? `Game server crashed (${how})` : `Game server failed to start (${how})`);
    }
    this.log(
      `lobby ${lobby.id}: match ${match.id} ended (${signal ?? code})${lobby.message ? ` - ${lobby.message}` : ''}`
    );
    if (lobby.players.length === 0) this.lobbies.delete(lobby.id);
  }

  private view(lobby: Lobby, profileId?: string): NativeLobbyView {
    const view: NativeLobbyView = {
      id: lobby.id,
      name: lobby.name,
      hostId: lobby.hostId,
      trackId: lobby.trackId,
      trackName: lobby.trackName,
      lapCount: lobby.lapCount,
      botCount: lobby.botCount,
      status: lobby.status,
      message: lobby.message,
      players: lobby.players.map(p => ({
        profileId: p.profileId,
        nickname: p.nickname,
        color: p.color,
        ready: p.ready,
      })),
      lastResult: lobby.lastResult,
    };
    const token = profileId ? lobby.match?.tokens.get(profileId) : undefined;
    if (lobby.status === 'running' && lobby.match && token) {
      view.connection = {
        host: this.options.publicHost,
        port: lobby.match.port,
        token,
        matchId: lobby.match.id,
      };
    }
    return view;
  }

  private sweepIdlePlayers(): void {
    const cutoff = Date.now() - this.options.idleTimeoutMs;
    for (const lobby of [...this.lobbies.values()]) {
      if (lobby.status !== 'waiting') continue;
      for (const player of [...lobby.players]) {
        if (player.lastSeen < cutoff) {
          this.log(`lobby ${lobby.id}: removing idle player ${player.nickname}`);
          this.removePlayer(lobby, player.profileId);
        }
      }
    }
  }

  private removePlayer(lobby: Lobby, profileId: string): void {
    const index = lobby.players.findIndex(p => p.profileId === profileId);
    if (index < 0) return;
    lobby.players.splice(index, 1);
    if (lobby.players.length === 0) {
      if (lobby.match) killTree(lobby.match.process);
      else this.lobbies.delete(lobby.id);
      return;
    }
    const nextHost = lobby.players[0];
    if (lobby.hostId === profileId && nextHost) lobby.hostId = nextHost.profileId;
  }

  private leaveAll(profileId: string): void {
    for (const lobby of [...this.lobbies.values()]) {
      if (lobby.status === 'waiting') this.removePlayer(lobby, profileId);
    }
  }

  private newPlayer(profile: Profile, usedColors: CarColor[]): LobbyPlayer {
    const color = usedColors.includes(profile.color)
      ? (COLOR_ORDER.find(c => !usedColors.includes(c)) ?? profile.color)
      : profile.color;
    return {
      profileId: profile.id,
      nickname: profile.nickname,
      color,
      ready: false,
      lastSeen: Date.now(),
    };
  }

  private allocatePort(): number | null {
    for (let i = 0; i < this.options.portCount; i++) {
      const port = this.options.portBase + i;
      if (!this.usedPorts.has(port)) {
        this.usedPorts.add(port);
        return port;
      }
    }
    return null;
  }

  private resolveTrack(trackId: unknown): Track {
    if (typeof trackId !== 'string' || !trackId) throw new NativeLobbyError('trackId is required');
    const track = this.deps.getTrack(trackId);
    if (!track) throw new NativeLobbyError(`Unknown track '${trackId}'`, 404);
    return track;
  }

  private parseLapCount(value: unknown, fallback: number): number {
    if (value === undefined) return fallback;
    const laps = Number(value);
    if (!Number.isInteger(laps) || laps < 1 || laps > 20) {
      throw new NativeLobbyError('lapCount must be between 1 and 20');
    }
    return laps;
  }

  private parseBotCount(value: unknown, humans: number, fallback: number): number {
    if (value === undefined) return fallback;
    const bots = Number(value);
    if (!Number.isInteger(bots) || bots < 0 || humans + bots > MAX_CARS) {
      throw new NativeLobbyError(`botCount must be between 0 and ${MAX_CARS - humans}`);
    }
    return bots;
  }

  private require(lobbyId: string): Lobby {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) throw new NativeLobbyError('Lobby not found', 404);
    return lobby;
  }

  private requirePlayer(lobby: Lobby, profileId: string): LobbyPlayer {
    const player = lobby.players.find(p => p.profileId === profileId);
    if (!player) throw new NativeLobbyError('You are not in this lobby', 403);
    return player;
  }

  private log(message: string): void {
    (this.deps.log ?? console.log)(`[native] ${message}`);
  }
}
