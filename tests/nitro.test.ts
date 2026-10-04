import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createInitialCarState,
  DEFAULT_INPUT_STATE,
  PHYSICS_CONSTANTS,
  stepNitro,
  type Track,
} from '../shared/index';
import { PhysicsEngine } from '../server/game/physicsEngine';
import {
  clearPrediction,
  initializePrediction,
  predictLocalMovement,
  reconcileWithServer,
} from '../client/src/game/clientPrediction';

const track: Track = {
  id: 'fuel-test',
  version: 1,
  name: 'Fuel test',
  author: 'Test',
  createdAt: 0,
  updatedAt: 0,
  difficulty: 'easy',
  defaultLapCount: 99,
  width: 800,
  height: 600,
  wrapAround: false,
  elements: [],
  scenery: [],
};

test('empty nitro stays empty while held; release recharges and respects tank capacity', () => {
  let amount = 0;
  for (let frame = 0; frame < 600; frame++) {
    const next = stepNitro(amount, true, 1 / 60);
    assert.equal(next.boostScale, 0);
    amount = next.amount;
  }
  assert.equal(amount, 0);
  assert.equal(stepNitro(0, false, 1).amount, 10);
  assert.equal(stepNitro(99, false, 1).amount, 100);
  assert.deepEqual(stepNitro(10, true, 0), { amount: 10, boostScale: 0 });
  assert.throws(() => stepNitro(NaN, true, 1 / 60), RangeError);
  assert.throws(() => stepNitro(100, true, -1), RangeError);
});

test('a fractional last tank tick supplies only its affordable boost force', () => {
  const final = stepNitro(0.2, true, 1 / 60);
  assert.equal(final.amount, 0);
  assert.ok(Math.abs(final.boostScale - 0.24) < 1e-10);
  assert.equal(stepNitro(final.amount, true, 1 / 60).boostScale, 0);
});

test('server and browser stay fuel/physics synchronized through depletion, hold and recharge', () => {
  const physics = new PhysicsEngine(track);
  const car = createInitialCarState('car', 'driver', { x: 400, y: 500 }, 0);
  physics.initialize([car]);
  let prediction = {
    x: 400,
    y: 500,
    rotation: 0,
    vx: 0,
    vy: 0,
    angularVelocity: 0,
    nitroAmount: 100,
  };
  initializePrediction(prediction, track);
  try {
    for (let frame = 0; frame < 720; frame++) {
      const input = {
        ...DEFAULT_INPUT_STATE,
        timestamp: frame,
        sequence: frame,
        nitro: frame < 300 || frame >= 420,
        accelerate: frame >= 600,
      };
      physics.applyInput('driver', input);
      const next = predictLocalMovement(prediction, input);
      prediction = next;
      const previousSpeed = car.speed;
      physics.update(1 / 60);
      physics.syncCarState(car);
      assert.ok(Math.abs(prediction.nitroAmount - car.nitroAmount) < 1e-8);
      assert.ok(Math.hypot(prediction.x - car.position.x, prediction.y - car.position.y) < 1e-6);
      if (frame >= 121 && frame < 300) {
        assert.equal(car.nitroAmount, 0);
        assert.ok(car.speed <= previousSpeed + 1e-8, 'empty nitro cannot add acceleration');
      }
    }
  } finally {
    physics.reset();
    clearPrediction();
  }
});

test('Space alone cannot move an empty car; normal throttle still works', () => {
  for (const accelerate of [false, true]) {
    const physics = new PhysicsEngine(track);
    const car = createInitialCarState('car', 'driver', { x: 400, y: 500 }, 0);
    car.nitroAmount = 0;
    physics.initialize([car]);
    let prediction = {
      x: 400,
      y: 500,
      rotation: 0,
      vx: 0,
      vy: 0,
      angularVelocity: 0,
      nitroAmount: 0,
    };
    initializePrediction(prediction, track);
    const input = { ...DEFAULT_INPUT_STATE, accelerate, nitro: true, timestamp: 0, sequence: 1 };
    physics.applyInput('driver', input);
    try {
      for (let frame = 0; frame < 300; frame++) {
        const next = predictLocalMovement(prediction, input);
        prediction = next;
        physics.update(1 / 60);
        physics.syncCarState(car);
        assert.equal(car.nitroAmount, 0);
        assert.equal(prediction.nitroAmount, 0);
        assert.ok(Math.hypot(prediction.x - car.position.x, prediction.y - car.position.y) < 1e-6);
      }
      if (accelerate) assert.ok(car.speed > 5);
      else {
        assert.equal(car.speed, 0);
        assert.deepEqual(car.position, { x: 400, y: 500 });
      }
    } finally {
      physics.reset();
      clearPrediction();
    }
  }
});

test('prediction honors authoritative fuel instead of granting a new tank on snapshots', () => {
  const state = { x: 400, y: 500, rotation: 0, vx: 0, vy: 0, angularVelocity: 0, nitroAmount: 100 };
  initializePrediction(state);
  try {
    const reconciled = reconcileWithServer({ ...state, nitroAmount: 0 }, 1);
    const next = predictLocalMovement(reconciled, {
      ...DEFAULT_INPUT_STATE,
      nitro: true,
      timestamp: 0,
      sequence: 2,
    });
    assert.equal(next.nitroAmount, 0);
    assert.equal(next.vy, 0);
    assert.equal(PHYSICS_CONSTANTS.NITRO_DRAIN_RATE, 50);
  } finally {
    clearPrediction();
  }
});
