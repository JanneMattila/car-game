import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  DEFAULT_GAME_SETTINGS,
  DEFAULT_INPUT_STATE,
  GAME_CONSTANTS,
  createInitialCarState,
  type GameStateSnapshot,
  type PlayerInput,
  type PredictionInput,
  type Track,
} from '../shared/index';
import { GameRoom } from '../server/game/gameRoom';
import { PhysicsEngine } from '../server/game/physicsEngine';
import { LeaderboardManager } from '../server/leaderboards/leaderboardManager';
import { StorageService } from '../server/storage/storageService';
import {
  clearPrediction,
  getPredictedState,
  getReconciliationDebug,
  initializePrediction,
  predictFrame,
  reconcileWithServer,
  setCurrentInput,
} from '../client/src/game/clientPrediction';

const FRAME_MS = 1000 / 60;
const start = { x: 50000, y: 50000 };
const track: Track = {
  id: 'latency-test',
  version: 1,
  name: 'Latency test',
  author: 'Test',
  createdAt: 0,
  updatedAt: 0,
  difficulty: 'easy',
  defaultLapCount: 1,
  width: 100000,
  height: 100000,
  scenery: [],
  elements: [
    {
      id: 'asphalt',
      type: 'road',
      x: 0,
      y: 0,
      position: { x: 0, y: 0 },
      width: 100000,
      height: 100000,
      rotation: 0,
    },
    {
      id: 'spawn',
      type: 'spawn',
      x: start.x - 15,
      y: start.y - 25,
      position: { x: start.x - 15, y: start.y - 25 },
      width: 30,
      height: 50,
      rotation: 0,
    },
  ],
};

// Throttle, a right then a left bend, then coasting to a stop.
function controls(frame: number) {
  const steer = frame >= 60 && frame < 96 ? 1 : frame >= 132 && frame < 168 ? -1 : 0;
  return {
    ...DEFAULT_INPUT_STATE,
    accelerate: frame < 204,
    steerLeft: steer < 0,
    steerRight: steer > 0,
    steerValue: steer,
  };
}

interface Result {
  meanError: number;
  maxError: number;
  serverError: number;
  replays: number;
}

/** Drives the real server room and the real client prediction over a delayed, jittery link. */
function race(t: TestContext, roundTripMs: number, jitterMs: number): Result {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 10000 });
  const leaderboard = new LeaderboardManager(new StorageService('unused-test-storage'));
  const room = new GameRoom(
    'room',
    'ABCDEF',
    'player',
    { ...DEFAULT_GAME_SETTINGS, trackId: track.id, lapCount: 1 },
    track,
    leaderboard
  );
  t.after(() => room.shutdown());
  room.addPlayer('player', 'Player', 'blue');

  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const delay = () => roundTripMs / 2 + random() * jitterMs;
  // TCP keeps order, so a message never arrives before the one sent ahead of it.
  const toServer: { at: number; input: PlayerInput }[] = [];
  const toClient: { at: number; snapshot: GameStateSnapshot }[] = [];
  const deliverAt = (queue: { at: number }[]) =>
    Math.max(Date.now() + delay(), queue[queue.length - 1]?.at ?? 0);
  let raceStartsForClient = Infinity;
  room.addEventListener((event, data) => {
    if (event === 'game_state') {
      toClient.push({ at: deliverAt(toClient), snapshot: data as GameStateSnapshot });
    }
    if (event === 'game_started') raceStartsForClient = Date.now() + delay();
  });

  room.setPlayerReady('player', true);
  assert.equal(room.startGame(), true);
  const car = room.getCar('player')!;
  initializePrediction(
    {
      x: car.position.x,
      y: car.position.y,
      rotation: car.rotation,
      vx: 0,
      vy: 0,
      angularVelocity: 0,
    },
    track
  );
  // The zero-latency path the player's inputs describe.
  const reference = new PhysicsEngine(track);
  const referenceCar = createInitialCarState('reference', 'player', car.position, car.rotation);
  reference.initialize([referenceCar]);

  let frame = -1;
  let errorSum = 0;
  let maxError = 0;
  for (let tick = 0; tick < 60 * 12; tick++) {
    t.mock.timers.tick(FRAME_MS);
    while (toServer.length && toServer[0]!.at <= Date.now()) {
      room.handleInput('player', toServer.shift()!.input);
    }
    while (toClient.length && toClient[0]!.at <= Date.now()) {
      const { snapshot } = toClient.shift()!;
      const local = snapshot.cars.find(snapshotCar => snapshotCar.playerId === 'player')!;
      reconcileWithServer(
        {
          x: local.x,
          y: local.y,
          rotation: local.rotation,
          vx: local.vx,
          vy: local.vy,
          angularVelocity: local.angularVelocity,
          nitroAmount: local.nitro,
          layer: local.layer,
        },
        local.lastInputSequence
      );
    }
    if (Date.now() < raceStartsForClient) continue;

    frame++;
    const held = controls(frame);
    setCurrentInput(held);
    predictFrame(FRAME_MS / 1000, (input: PredictionInput) =>
      toServer.push({
        at: deliverAt(toServer),
        input: { ...input, playerId: 'player', respawn: false },
      })
    );
    // Rendering interpolates one step behind; accuracy is judged on the predicted state.
    const shown = getPredictedState()!;
    reference.applyInput('player', {
      ...held,
      playerId: 'player',
      sequence: frame + 1,
      timestamp: 0,
    });
    reference.update(FRAME_MS / 1000);
    reference.syncCarState(referenceCar);
    if (frame >= 300) continue;
    const error = Math.hypot(shown.x - referenceCar.position.x, shown.y - referenceCar.position.y);
    errorSum += error;
    maxError = Math.max(maxError, error);
  }
  assert.equal(room.getState(), 'racing');
  const server = room.getCar('player')!;
  const result = {
    meanError: errorSum / 300,
    maxError,
    serverError: Math.hypot(
      server.position.x - referenceCar.position.x,
      server.position.y - referenceCar.position.y
    ),
    replays: getReconciliationDebug().replays,
  };
  clearPrediction();
  t.mock.timers.reset();
  return result;
}

test('the local car follows its own inputs at real-world latency and jitter', async t => {
  for (const [roundTrip, jitter] of [
    [0, 0],
    [50, 10],
    [100, 30],
    [250, 40],
  ] as const) {
    await t.test(`${roundTrip} ms round trip, ${jitter} ms jitter`, t => {
      const result = race(t, roundTrip, jitter);
      t.diagnostic(JSON.stringify(result));
      assert.ok(
        result.meanError < 2,
        `displayed car drifts ${result.meanError.toFixed(1)}px on average`
      );
      assert.ok(
        result.maxError < 10,
        `displayed car deviates up to ${result.maxError.toFixed(1)}px`
      );
      assert.ok(
        result.serverError < 5,
        `server ended ${result.serverError.toFixed(1)}px off course`
      );
    });
  }
});

test('a late burst of inputs is applied one per tick and a stalled link adds no lasting lag', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 10000 });
  const room = new GameRoom(
    'room',
    'ABCDEF',
    'player',
    { ...DEFAULT_GAME_SETTINGS, trackId: track.id, lapCount: 1 },
    track,
    new LeaderboardManager(new StorageService('unused-test-storage'))
  );
  t.after(() => room.shutdown());
  room.addPlayer('player', 'Player', 'blue');
  room.setPlayerReady('player', true);
  room.startGame();
  for (let i = 0; i < GAME_CONSTANTS.COUNTDOWN_SECONDS; i++) t.mock.timers.tick(1000);
  t.mock.timers.tick(500);
  assert.equal(room.getState(), 'racing');

  const input = (sequence: number): PlayerInput => ({
    ...DEFAULT_INPUT_STATE,
    accelerate: true,
    playerId: 'player',
    sequence,
    timestamp: 0,
  });
  for (let sequence = 1; sequence <= 4; sequence++) room.handleInput('player', input(sequence));
  room.handleInput('player', input(3));
  const acknowledged: number[] = [];
  for (let tick = 0; tick < 6; tick++) {
    t.mock.timers.tick(FRAME_MS);
    acknowledged.push(room.getCar('player')!.lastInputSequence);
  }
  assert.equal(acknowledged[acknowledged.length - 1], 4, 'every input applied, duplicate ignored');
  acknowledged.forEach((sequence, i) => {
    assert.ok(sequence - (acknowledged[i - 1] ?? 0) <= 1, `one input per tick: ${acknowledged}`);
  });

  // A 30-input burst after a stall is trimmed so the car never lags far behind its driver.
  for (let sequence = 5; sequence <= 34; sequence++) room.handleInput('player', input(sequence));
  t.mock.timers.tick(FRAME_MS);
  assert.ok(room.getCar('player')!.lastInputSequence >= 34 - 6);
});
