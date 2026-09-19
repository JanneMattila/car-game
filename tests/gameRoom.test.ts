import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DEFAULT_GAME_SETTINGS, GAME_CONSTANTS, type Track } from '../shared/index';
import { GameRoom } from '../server/game/gameRoom';
import { LeaderboardManager } from '../server/leaderboards/leaderboardManager';
import { StorageService } from '../server/storage/storageService';

function createRoom(t: TestContext) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 10000 });
  const leaderboard = new LeaderboardManager(new StorageService('unused-test-storage'));
  t.mock.method(leaderboard, 'submitLapTime', async () => ({ rank: 1, isNewRecord: true }));
  t.mock.method(leaderboard, 'submitRaceTime', async () => ({ rank: 1, isNewRecord: true }));
  // Overlapping race markers let real physics finish a one-lap race without driving.
  const track: Track = {
    id: 'rematch-test',
    version: 1,
    name: 'Rematch test',
    author: 'Test',
    createdAt: 0,
    updatedAt: 0,
    difficulty: 'easy',
    defaultLapCount: 1,
    width: 800,
    height: 600,
    scenery: [],
    elements: [
      {
        id: 'spawn',
        type: 'spawn',
        x: 100,
        y: 100,
        position: { x: 100, y: 100 },
        width: 30,
        height: 50,
        rotation: 0,
      },
      {
        id: 'checkpoint',
        type: 'checkpoint',
        checkpointIndex: 0,
        x: 50,
        y: 50,
        position: { x: 50, y: 50 },
        width: 200,
        height: 200,
        rotation: 0,
      },
      {
        id: 'finish',
        type: 'finish',
        x: 50,
        y: 50,
        position: { x: 50, y: 50 },
        width: 200,
        height: 200,
        rotation: 0,
      },
    ],
  };
  const room = new GameRoom(
    'room',
    'ABCDEF',
    'host',
    { ...DEFAULT_GAME_SETTINGS, trackId: track.id, lapCount: 1 },
    track,
    leaderboard
  );
  room.addPlayer('host', 'Host', 'blue');
  t.after(() => room.shutdown());
  return room;
}

function finishRace(t: TestContext, room: GameRoom) {
  for (let i = 0; i < GAME_CONSTANTS.COUNTDOWN_SECONDS; i++) t.mock.timers.tick(1000);
  t.mock.timers.tick(500);
  assert.equal(room.getState(), 'racing');
  assert.equal(room.startGame(), false, 'an active race cannot be restarted');
  t.mock.timers.tick(100);
  assert.equal(room.getState(), 'results');
  assert.equal(room.getResults().length, 1);
  assert.equal(room.getCar('host')?.finished, true);
}

test('a completed room can start and finish successive races with fresh race state', t => {
  const room = createRoom(t);
  room.setPlayerReady('host', true);
  assert.equal(room.startGame(), true);
  finishRace(t, room);

  for (let race = 0; race < 2; race++) {
    assert.equal(room.canStart(), true, 'ready players can start again after results');
    assert.equal(room.startGame(), true);
    assert.equal(room.getState(), 'countdown');
    assert.deepEqual(room.getResults(), []);
    assert.deepEqual(room.getGameState().finishedPlayers, []);
    assert.equal(room.getGameState().elapsedTime, 0);
    assert.equal(room.getGameState().raceStartTime, 0);
    assert.equal(room.getCars().length, 1);
    assert.equal(room.getCar('host')?.finished, false);
    assert.equal(room.getCar('host')?.lap, 0);
    assert.deepEqual(room.getCar('host')?.lapTimes, []);
    assert.equal(room.startGame(), false, 'a duplicate start must not reset the countdown');
    finishRace(t, room);
  }
});

test('rematches still require ready players and preserve results on rejected starts', t => {
  const room = createRoom(t);
  assert.equal(room.startGame(), false);
  room.setPlayerReady('host', true);
  assert.equal(room.startGame(), true);
  finishRace(t, room);
  const results = room.getResults();
  room.setPlayerReady('host', false);
  assert.equal(room.startGame(), false);
  assert.equal(room.getState(), 'results');
  assert.deepEqual(room.getResults(), results);
  room.setPlayerReady('host', true);
  assert.equal(room.startGame(), true);
});
