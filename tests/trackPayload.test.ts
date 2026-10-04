import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApiRoutes } from '../server/routes/api';
import {
  trackJsonParser,
  trackPayloadErrorHandler,
  MAX_TRACK_JSON_BYTES,
} from '../server/routes/trackPayload';
import { StorageService } from '../server/storage/storageService';
import { TrackManager } from '../server/tracks/trackManager';
import { LeaderboardManager } from '../server/leaderboards/leaderboardManager';
import { RoomManager } from '../server/game/roomManager';
import { createSilverstoneTrack } from '../scripts/generateSilverstoneTrack';

test('detailed circuit saves and reloads through the API without changing existing tracks', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'car-game-track-test-'));
  const storage = new StorageService(directory);
  await storage.initialize();
  const manager = new TrackManager(storage);
  await manager.initialize();
  const leaderboard = new LeaderboardManager(storage);
  const rooms = new RoomManager(manager, leaderboard);
  const app = express();
  app.use('/api/tracks', trackJsonParser());
  app.use(express.json());
  app.use('/api', createApiRoutes(manager, leaderboard, rooms));
  app.use(trackPayloadErrorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/tracks`;
  try {
    const circuit = createSilverstoneTrack();
    const body = JSON.stringify(circuit);
    assert.ok(Buffer.byteLength(body) > 100 * 1024, 'Exercise the old default body-size limit');
    assert.ok(Buffer.byteLength(body) < MAX_TRACK_JSON_BYTES);
    const save = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(save.status, 200);
    const loaded = await fetch(`${url}/${circuit.id}`);
    const saved = await loaded.json();
    assert.deepEqual({ ...saved, updatedAt: circuit.updatedAt }, circuit);
    const list = await (await fetch(url)).json();
    assert.equal(list.length, 1);
    const tooLarge = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(MAX_TRACK_JSON_BYTES) }),
    });
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json()).errors[0].code, 'TRACK_TOO_LARGE');
    assert.equal((await (await fetch(url)).json()).length, 1);
  } finally {
    rooms.shutdown();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
    await rm(directory, { recursive: true, force: true });
  }
});
