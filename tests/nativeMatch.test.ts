import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Track } from '../shared/index';
import { NativeMatchManager, type NativeMatchOptions } from '../server/native/nativeMatchManager';
import { ProfileManager } from '../server/profiles/profileManager';
import { StorageService } from '../server/storage/storageService';
import { createNativeApiRoutes } from '../server/routes/nativeApi';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-match-'));
after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

// Stand-in for cg_server: reads the match config from stdin and behaves according to argv[2].
const fakeServer = path.join(tempDir, 'fake-server.mjs');
fs.writeFileSync(
  fakeServer,
  `
let input = '';
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('end', () => {
  const config = JSON.parse(input);
  const mode = process.argv[2];
  const port = Number(process.argv[3]);
  const emit = event => console.log('@@EVENT ' + JSON.stringify(event));
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  emit({ type: 'ready', matchId: config.matchId, port });
  if (mode === 'crash') { setTimeout(() => process.exit(7), 150); return; }
  setTimeout(() => {
    const results = config.players.map((p, i) => ({
      playerId: p.id, nickname: p.nickname, position: i + 1, finished: true,
      totalMs: 30000 + i * 1000, bestLapMs: 10000 + i * 100, laps: config.lapCount, isBot: false,
    }));
    for (const [i, b] of config.bots.entries()) {
      results.push({ playerId: b.id, nickname: b.nickname, position: results.length + 1,
        finished: true, totalMs: 40000 + i, bestLapMs: 12000, laps: config.lapCount, isBot: true });
    }
    emit({ type: 'result', matchId: config.matchId, lapCount: config.lapCount, reason: 'race complete', results });
    emit({ type: 'ended', matchId: config.matchId, reason: 'race complete' });
    process.exit(0);
  }, 300);
});
`
);

const track = {
  id: 'test-track',
  name: 'Test Track',
  defaultLapCount: 2,
  elements: [],
  scenery: [],
} as unknown as Track;

interface Harness {
  manager: NativeMatchManager;
  profiles: ProfileManager;
  laps: string[];
  races: string[];
}

async function createHarness(
  mode: string,
  overrides: Partial<NativeMatchOptions> = {}
): Promise<Harness> {
  const storage = new StorageService(fs.mkdtempSync(path.join(tempDir, 'data-')));
  await storage.initialize();
  const laps: string[] = [];
  const races: string[] = [];
  const manager = new NativeMatchManager(
    {
      command: `"${process.execPath}" "${fakeServer}" ${mode} {port}`,
      portBase: 6100,
      portCount: 2,
      publicHost: '',
      readyTimeoutMs: 2000,
      maxMatchMs: 60000,
      idleTimeoutMs: 60000,
      ...overrides,
    },
    {
      getTrack: id => (id === track.id ? track : null),
      submitLapTime: async (trackId, nickname, ms) => laps.push(`${trackId}:${nickname}:${ms}`),
      submitRaceTime: async (trackId, nickname, ms, lapCount) =>
        races.push(`${trackId}:${nickname}:${ms}:${lapCount}`),
      log: () => undefined,
    }
  );
  after(() => manager.shutdown());
  return { manager, profiles: new ProfileManager(storage), laps, races };
}

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('race in a native game server returns players to the lobby with results', async () => {
  const { manager, profiles, laps, races } = await createHarness('ok');
  const host = await profiles.create({ nickname: 'Alpha', color: 'red' });
  const guest = await profiles.create({ nickname: 'Beta', color: 'red' });

  const lobby = manager.create(host, { trackId: track.id, lapCount: 3, botCount: 1 });
  manager.join(lobby.id, guest);
  assert.throws(() => manager.start(lobby.id, guest.id), /Only the host/);
  assert.throws(() => manager.start(lobby.id, host.id), /Waiting for: Beta/);
  manager.setReady(lobby.id, guest.id, true);

  const started = manager.start(lobby.id, host.id);
  assert.equal(started.status, 'starting');

  const running = await waitFor(() => {
    const view = manager.get(lobby.id, guest.id);
    return view.status === 'running' && view;
  });
  assert.equal(running.connection?.port, 6100);
  assert.match(running.connection?.token ?? '', /^[0-9a-f]{32}$/);
  assert.notEqual(manager.get(lobby.id, host.id).connection?.token, running.connection?.token);
  assert.equal(manager.list()[0]?.connection, undefined, 'tokens are not listed publicly');
  assert.notEqual(running.players[1]?.color, 'red', 'duplicate colors are reassigned');

  const finished = await waitFor(() => {
    const view = manager.get(lobby.id, host.id);
    return view.status === 'waiting' && view;
  });
  assert.equal(finished.message, '');
  assert.equal(finished.connection, undefined);
  assert.deepEqual(
    finished.lastResult?.results.map(r => [r.nickname, r.position, r.isBot]),
    [
      ['Alpha', 1, false],
      ['Beta', 2, false],
      ['Bot 1', 3, true],
    ]
  );
  assert.ok(
    finished.players.every(p => !p.ready),
    'ready flags reset after a race'
  );
  await waitFor(() => races.length === 2);
  assert.deepEqual(races, ['test-track:Alpha:30000:3', 'test-track:Beta:31000:3']);
  assert.deepEqual(laps, ['test-track:Alpha:10000', 'test-track:Beta:10100']);
  assert.deepEqual(manager.debug().usedPorts, []);
});

test('a crashing game server moves players back to the lobby', async () => {
  const { manager, profiles } = await createHarness('crash');
  const host = await profiles.create({ nickname: 'Solo' });
  const lobby = manager.create(host, { trackId: track.id });
  manager.start(lobby.id, host.id);

  const back = await waitFor(() => {
    const view = manager.get(lobby.id, host.id);
    return view.status === 'waiting' && view;
  });
  assert.match(back.message, /Game server crashed \(exit code 7\)/);
  assert.equal(back.lastResult, null);
  assert.deepEqual(manager.debug().usedPorts, []);
});

test('a game server that never becomes ready is stopped', async () => {
  const { manager, profiles } = await createHarness('hang', { readyTimeoutMs: 300 });
  const host = await profiles.create({ nickname: 'Waiter' });
  const lobby = manager.create(host, { trackId: track.id });
  manager.start(lobby.id, host.id);
  const back = await waitFor(() => {
    const view = manager.get(lobby.id, host.id);
    return view.status === 'waiting' && view;
  });
  assert.equal(back.message, 'Game server did not start in time');
});

test('native lobby HTTP API validates input and exposes the lobby flow', async () => {
  const { manager, profiles } = await createHarness('ok');
  const app = express();
  app.use(express.json());
  app.use('/api', createNativeApiRoutes(profiles, manager));
  const server = app.listen(0);
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  assert.equal((await call('POST', '/profiles', { nickname: 'x' })).status, 400);
  assert.equal((await call('POST', '/profiles', { nickname: 'Valid', color: 'pink' })).status, 400);
  const created = await call('POST', '/profiles', { nickname: 'Gamma', color: 'green' });
  assert.equal(created.status, 201);
  const id = String(created.json['id']);
  assert.equal((await call('GET', `/profiles/${id}`)).json['nickname'], 'Gamma');
  assert.equal((await call('PUT', `/profiles/${id}`, { color: 'blue' })).json['color'], 'blue');
  assert.equal((await call('GET', '/profiles/missing')).status, 404);

  assert.equal(
    (await call('POST', '/native/lobbies', { profileId: id, trackId: 'nope' })).status,
    404
  );
  const lobby = await call('POST', '/native/lobbies', {
    profileId: id,
    trackId: track.id,
    botCount: 2,
  });
  assert.equal(lobby.status, 201);
  assert.equal(lobby.json['lapCount'], 2);
  const lobbyId = String(lobby.json['id']);
  assert.equal(
    (await call('POST', `/native/lobbies/${lobbyId}/start`, { profileId: 'bad' })).status,
    404
  );
  assert.equal(
    (await call('POST', `/native/lobbies/${lobbyId}/start`, { profileId: id })).status,
    200
  );
  const running = await waitFor(() => {
    const view = manager.get(lobbyId, id);
    return view.connection && view;
  });
  assert.equal(running.connection?.host, '');
  await waitFor(() => manager.get(lobbyId).status === 'waiting');
  assert.equal(
    (await call('POST', `/native/lobbies/${lobbyId}/leave`, { profileId: id })).status,
    200
  );
  assert.equal((await call('GET', `/native/lobbies/${lobbyId}`)).status, 404);
});
