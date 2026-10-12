import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  DEFAULT_GAME_SETTINGS,
  GAME_CONSTANTS,
  computeStartGrid,
  createCircuitTrack,
} from '../shared/index';
import { GameRoom } from '../server/game/gameRoom';
import { prepareRacingLine } from '../server/game/racingLine';
import { LeaderboardManager } from '../server/leaderboards/leaderboardManager';
import { StorageService } from '../server/storage/storageService';

const track = createCircuitTrack('bristol-short-oval');

function createRoom(t: TestContext, maxPlayers = 8) {
  const leaderboard = new LeaderboardManager(new StorageService('unused-test-storage'));
  const lapTimes = t.mock.method(leaderboard, 'submitLapTime', async () => ({
    rank: 1,
    isNewRecord: true,
  }));
  const raceTimes = t.mock.method(leaderboard, 'submitRaceTime', async () => ({
    rank: 1,
    isNewRecord: true,
  }));
  const room = new GameRoom(
    'room',
    'ABCDEF',
    'host',
    { ...DEFAULT_GAME_SETTINGS, trackId: track.id, lapCount: 1, maxPlayers },
    track,
    leaderboard
  );
  room.addPlayer('host', 'Host', 'blue');
  t.after(() => room.shutdown());
  return { room, lapTimes, raceTimes };
}

test('AI players join ready, are listed as bots and never keep a room alive', t => {
  const { room } = createRoom(t, 3);
  const easy = room.addBot('easy')!;
  const hard = room.addBot('hard')!;
  assert.ok(easy && hard);
  assert.equal(room.addBot('medium'), null, 'bots respect the room size');
  assert.notEqual(easy.nickname, hard.nickname);
  assert.notEqual(easy.color, hard.color);
  const listed = room.getRoomInfo().players.filter(player => player.isBot);
  assert.deepEqual(
    listed.map(player => [player.ready, player.botDifficulty]),
    [
      [true, 'easy'],
      [true, 'hard'],
    ]
  );

  assert.equal(room.canStart(), false, 'ready bots alone cannot start a race');
  assert.equal(room.isEmpty(), false);
  assert.equal(room.canSeatHuman(), true, 'a human may take a bot seat');
  assert.ok(room.addPlayer('guest', 'Guest', 'red'));
  assert.equal(room.getPlayerCount(), 3);
  assert.equal(room.getPlayer(hard.id), null, 'the most recently added bot gives up its seat');

  assert.equal(room.removeBot('guest'), false, 'only bots can be removed as bots');
  room.removePlayer('host');
  assert.equal(room.getHostId(), 'guest', 'hosting passes to a human, never a bot');
  room.removePlayer('guest');
  assert.equal(room.isEmpty(), true);
});

test('AI players race a full lap through traffic with collisions and skip leaderboards', async t => {
  // Built before timers are mocked; the room reuses the cached line.
  assert.ok(await prepareRacingLine(track));
  const { room, lapTimes, raceTimes } = createRoom(t);
  const bots = ['hard', 'medium', 'easy'].map(level => room.addBot(level as 'hard')!);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 10000 });

  room.setPlayerReady('host', true);
  assert.equal(room.startGame(), true);
  // The idle human starts on pole, so every bot has to drive around a stationary car.
  const grid = computeStartGrid(track, 4);
  for (const [index, id] of ['host', ...bots.map(bot => bot.id)].entries()) {
    assert.deepEqual(room.getCar(id)!.position, grid[index]!.position, `grid slot ${index}`);
  }

  for (let i = 0; i < GAME_CONSTANTS.COUNTDOWN_SECONDS; i++) t.mock.timers.tick(1000);
  t.mock.timers.tick(500);
  assert.equal(room.getState(), 'racing');
  const limit = 60 * 40;
  for (let frame = 0; frame < limit && bots.some(bot => !room.getCar(bot.id)!.finished); frame++) {
    t.mock.timers.tick(GAME_CONSTANTS.PHYSICS_DELTA);
  }
  for (const bot of bots) {
    assert.equal(room.getCar(bot.id)!.finished, true, `${bot.nickname} finished the lap`);
  }
  assert.equal(room.getCar('host')!.finished, false);
  const finishTimes = Object.fromEntries(
    bots.map(bot => [bot.botDifficulty, room.getCar(bot.id)!.finishTime])
  );
  assert.ok(finishTimes.hard! < finishTimes.easy!, 'hard bots are faster than easy bots');
  assert.equal(lapTimes.mock.callCount(), 0, 'bot laps are not leaderboard entries');
  assert.equal(raceTimes.mock.callCount(), 0, 'bot races are not leaderboard entries');

  // The race still waits for the human until the finish grace period expires.
  for (let i = 0; i * 1000 <= GAME_CONSTANTS.FINISH_GRACE_PERIOD + 1000; i++) {
    t.mock.timers.tick(1000);
    if (room.getState() === 'results') break;
  }
  assert.equal(room.getState(), 'results');
  assert.deepEqual(
    room
      .getResults()
      .filter(result => result.finished)
      .map(result => result.playerId)
      .sort(),
    bots.map(bot => bot.id).sort()
  );
  room.resetToLobby();
  assert.ok(
    bots.every(bot => room.getPlayer(bot.id)!.isReady),
    'bots stay ready for a rematch'
  );
});
