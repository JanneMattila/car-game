import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  circuitRectangle,
  createInitialCarState,
  DEFAULT_INPUT_STATE,
  effectiveRaceGate,
  fitRaceGate,
  raceGateCrossing,
  validateTrack,
  type Track,
} from '../shared/index';
import { PhysicsEngine } from '../server/game/physicsEngine';

const checkpoint = circuitRectangle('checkpoint', 'checkpoint', { x: 500, y: 600 }, 280, 80, 0);
checkpoint.checkpointIndex = 0;
const finish = circuitRectangle('finish', 'finish', { x: 500, y: 300 }, 240, 40, 0);
const track: Track = {
  id: 'gate-test',
  version: 1,
  name: 'Gate test',
  author: 'Test',
  createdAt: 0,
  updatedAt: 0,
  difficulty: 'easy',
  defaultLapCount: 99,
  width: 1000,
  height: 1200,
  wrapAround: false,
  scenery: [],
  elements: [
    checkpoint,
    finish,
    circuitRectangle('left', 'wall', { x: 290, y: 600 }, 14, 1200, 0),
    circuitRectangle('right', 'wall', { x: 710, y: 600 }, 14, 1200, 0),
  ],
};

test('gates span grass/runoff between barrier faces without extending beyond the course', () => {
  const fitted = effectiveRaceGate(track, finish);
  assert.equal(fitted.width, 406);
  assert.equal(fitted.x + fitted.width / 2, 500);
  assert.equal(raceGateCrossing(track, fitted, { x: 666, y: 340 }, { x: 666, y: 260 }), 0.5);
  assert.equal(raceGateCrossing(track, fitted, { x: 750, y: 340 }, { x: 750, y: 260 }), null);
  assert.equal(finish.width, 240, 'auto-fit must not mutate stored track data');
});

test('swept gates catch fast crossings, reject reverse/stationary movement and require the center plane', () => {
  assert.equal(raceGateCrossing(track, finish, { x: 500, y: 500 }, { x: 500, y: 100 }), 0.5);
  assert.equal(raceGateCrossing(track, finish, { x: 500, y: 100 }, { x: 500, y: 500 }), null);
  assert.equal(raceGateCrossing(track, finish, { x: 500, y: 300 }, { x: 500, y: 300 }), null);
  assert.equal(raceGateCrossing(track, finish, { x: 500, y: 350 }, { x: 500, y: 310 }), null);
  assert.equal(raceGateCrossing(track, finish, { x: 500, y: 301 }, { x: 500, y: 300 }), 1);
  assert.equal(raceGateCrossing(track, finish, { x: 500, y: 300 }, { x: 500, y: 299 }), null);
});

test('rotated and asymmetric corridors are fitted in world coordinates', () => {
  const angle = 0.73;
  const point = (x: number, y: number) => ({
    x: 500 + x * Math.cos(angle) - y * Math.sin(angle),
    y: 500 + x * Math.sin(angle) + y * Math.cos(angle),
  });
  const marker = circuitRectangle('angled', 'finish', point(0, 0), 240, 40, angle);
  const rotated = {
    ...track,
    elements: [
      marker,
      circuitRectangle('left', 'wall', point(-200, 0), 14, 1200, angle),
      circuitRectangle('right', 'wall', point(230, 0), 14, 1200, angle),
    ],
  };
  const fitted = fitRaceGate(rotated, marker);
  assert.ok(Math.abs(fitted.width - 416) < 1e-7);
  const crossing = raceGateCrossing(rotated, fitted, point(180, 100), point(180, -100));
  assert.ok(crossing !== null && Math.abs(crossing - 0.5) < 1e-7);
});

test('manual narrow gates warn about runoff coverage and invalid geometry is rejected', () => {
  const manual = { ...finish, properties: { autoGateWidth: false } };
  const modified = {
    ...track,
    elements: track.elements.map(el => (el.id === finish.id ? manual : el)),
  };
  assert.equal(effectiveRaceGate(modified, manual).width, 240);
  assert.ok(validateTrack(modified).warnings.some(warning => warning.includes('runoff uncovered')));
  const invalid = { ...track, elements: [{ ...finish, width: NaN }] };
  assert.ok(validateTrack(invalid).errors.some(error => error.code === 'INVALID_RACE_GATE'));
});

test('infinite gates use continuous motion, including negative tiles, not modulo jumps', () => {
  const repeated = { ...track, height: 600, wrapAround: true };
  const seam = circuitRectangle('seam', 'finish', { x: 500, y: 0 }, 240, 10, 0);
  assert.equal(raceGateCrossing(repeated, seam, { x: 500, y: 8 }, { x: 500, y: -8 }), 0.5);
  assert.equal(raceGateCrossing(repeated, seam, { x: -500, y: -592 }, { x: -500, y: -608 }), 0.5);
  assert.equal(raceGateCrossing(repeated, finish, { x: 500, y: 595 }, { x: 500, y: 605 }), null);
});

test('a physics-driven lap on the grass counts exactly once', () => {
  const physics = new PhysicsEngine(track);
  const car = createInitialCarState('car', 'driver', { x: 666, y: 710 }, 0);
  physics.initialize([car]);
  physics.applyInput('driver', {
    ...DEFAULT_INPUT_STATE,
    accelerate: true,
    timestamp: 0,
    sequence: 1,
  });
  const events = [];
  try {
    for (let frame = 0; frame < 160; frame++) events.push(...physics.update(1 / 60));
    physics.syncCarState(car);
    assert.equal(car.lap, 1);
    assert.equal(events.filter(event => event.type === 'checkpoint').length, 1);
    assert.equal(events.filter(event => event.type === 'lap').length, 1);
  } finally {
    physics.reset();
  }
});

test('missing checkpoints and wrong-way driving cannot award a lap', () => {
  for (const [position, rotation] of [
    [{ x: 666, y: 350 }, 0],
    [{ x: 666, y: 250 }, Math.PI],
  ] as const) {
    const physics = new PhysicsEngine(track);
    const car = createInitialCarState('car', 'driver', position, rotation);
    physics.initialize([car]);
    physics.applyInput('driver', {
      ...DEFAULT_INPUT_STATE,
      accelerate: true,
      timestamp: 0,
      sequence: 1,
    });
    try {
      for (let frame = 0; frame < 160; frame++) physics.update(1 / 60);
      physics.syncCarState(car);
      assert.equal(car.lap, 0);
      assert.equal(car.checkpoint, 0);
    } finally {
      physics.reset();
    }
  }
});

test('respawns do not sweep through checkpoints or an eligible finish', () => {
  const physics = new PhysicsEngine(track);
  const car = createInitialCarState('car', 'driver', { x: 500, y: 610 }, 0);
  physics.initialize([car]);
  const neutral = { ...DEFAULT_INPUT_STATE, timestamp: 0, sequence: 1 };
  try {
    physics.resetCar('driver', { x: 500, y: 590 }, 0);
    physics.applyInput('driver', neutral);
    physics.update(1 / 60);
    physics.syncCarState(car);
    assert.equal(car.checkpoint, 0);
    physics.resetCar('driver', { x: 500, y: 610 }, 0);
    physics.applyInput('driver', { ...neutral, accelerate: true });
    for (let frame = 0; frame < 20; frame++) physics.update(1 / 60);
    physics.syncCarState(car);
    assert.equal(car.checkpoint, 1);
    physics.resetCar('driver', { x: 500, y: 290 }, 0);
    physics.applyInput('driver', neutral);
    physics.update(1 / 60);
    physics.syncCarState(car);
    assert.equal(car.lap, 0);
    assert.equal(car.checkpoint, 1);
  } finally {
    physics.reset();
  }
});

test('several gates crossed in one step preserve travel order, including the finish', () => {
  for (const finishY of [599, 600.5]) {
    const first = {
      ...circuitRectangle('first', 'checkpoint', { x: 500, y: 601 }, 240, 1, 0),
      checkpointIndex: 0,
    };
    const second = {
      ...circuitRectangle('second', 'checkpoint', { x: 500, y: 600 }, 240, 1, 0),
      checkpointIndex: 1,
    };
    const closeTrack = {
      ...track,
      elements: [
        first,
        second,
        circuitRectangle('finish', 'finish', { x: 500, y: finishY }, 240, 1, 0),
      ],
    };
    const car = createInitialCarState('car', 'driver', { x: 500, y: 610 }, 0);
    const physics = new PhysicsEngine(closeTrack);
    physics.initialize([car]);
    physics.applyInput('driver', {
      ...DEFAULT_INPUT_STATE,
      accelerate: true,
      timestamp: 0,
      sequence: 1,
    });
    try {
      const checkpoints: number[] = [];
      for (let frame = 0; frame < 30; frame++) {
        for (const event of physics.update(1 / 60)) {
          if (event.type === 'checkpoint') checkpoints.push(event.checkpoint);
        }
      }
      physics.syncCarState(car);
      assert.deepEqual(checkpoints, [0, 1]);
      assert.equal(car.lap, finishY === 599 ? 1 : 0);
    } finally {
      physics.reset();
    }
  }
});
