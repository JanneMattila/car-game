import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInitialCarState, DEFAULT_INPUT_STATE, type Track } from '../shared/index';
import { PhysicsEngine } from '../server/game/physicsEngine';
import { clearPrediction, initializePrediction, predictLocalMovement } from '../client/src/game/clientPrediction';

const track: Track = {
  id: 'steering-test', version: 1, name: 'Steering test', author: 'Test',
  createdAt: 0, updatedAt: 0, difficulty: 'easy', defaultLapCount: 99,
  width: 800, height: 600, wrapAround: true, elements: [], scenery: [],
};

test('server and prediction follow the same steering path without corrective teleports', async t => {
  for (const [name, steering] of [
    ['left', { steerLeft: true, steerRight: false, steerValue: -1 }],
    ['right', { steerLeft: false, steerRight: true, steerValue: 1 }],
    ['both keys', { steerLeft: true, steerRight: true, steerValue: -1 }],
    ['both digital flags', { steerLeft: true, steerRight: true, steerValue: 0 }],
    ['analog left', { steerLeft: true, steerRight: false, steerValue: -0.4 }],
    ['analog right', { steerLeft: false, steerRight: true, steerValue: 0.4 }],
    ['analog without digital flags', { steerLeft: false, steerRight: false, steerValue: 0.5 }],
  ] as const) {
    await t.test(name, () => {
      const physics = new PhysicsEngine(track);
      const car = createInitialCarState('car', 'driver', { x: 240, y: 330 }, 0);
      physics.initialize([car]);
      const input = {
        ...DEFAULT_INPUT_STATE, ...steering, accelerate: true, sequence: 1, timestamp: 0,
      };
      physics.applyInput('driver', input);
      let prediction = { x: 240, y: 330, rotation: 0, vx: 0, vy: 0, angularVelocity: 0 };
      initializePrediction(prediction, track);
      try {
        for (let frame = 0; frame < 600; frame++) {
          prediction = predictLocalMovement(prediction, input);
          physics.update(1 / 60);
          physics.syncCarState(car);
          assert.ok(Math.abs(prediction.rotation - car.rotation) < 0.000001,
            `${name}: client and server must turn in the same direction at the same rate`);
          assert.ok(Math.hypot(prediction.x - car.position.x, prediction.y - car.position.y) < 0.000001,
            `${name}: steering must not create positional reconciliation error`);
        }
        assert.equal(Math.sign(car.rotation), Math.sign(steering.steerValue || (steering.steerLeft ? -1 : 1)));
      } finally {
        physics.reset();
        clearPrediction();
      }
    });

  }
});

test('steering is 25 percent gentler at every moving speed, in both directions', () => {
  clearPrediction();
  try {
    for (const speed of [1.5, 3, 10, 15, 20, 26]) {
      for (const steering of [-1, -0.4, 0.4, 1]) {
        for (const direction of [-1, 1]) {
          const state = {
            x: 240, y: 330, rotation: 0, vx: 0, vy: -speed * direction, angularVelocity: 0,
          };
          const input = {
            ...DEFAULT_INPUT_STATE, steerValue: steering, sequence: 1, timestamp: 0,
          };
          const next = predictLocalMovement(state, input);
          const speedFactor = speed < 3 ? speed / 3 : Math.max(0.5, Math.min(1, 15 / speed));
          const previousTurnRate = (Math.PI / 10) * 0.18 * speedFactor * 0.99 * steering * direction;
          assert.ok(Math.abs(next.angularVelocity - previousTurnRate * 0.75) < 0.000001);
          assert.ok(Math.abs(next.rotation - previousTurnRate * 0.75) < 0.000001);
        }
      }
    }
  } finally {
    clearPrediction();
  }
});

test('gentler steering preserves stationary behavior and release damping', () => {
  clearPrediction();
  try {
    for (const speed of [0, 0.5]) {
      const next = predictLocalMovement({
        x: 240, y: 330, rotation: 0, vx: 0, vy: -speed, angularVelocity: 0,
      }, { ...DEFAULT_INPUT_STATE, steerValue: 1, sequence: 1, timestamp: 0 });
      assert.equal(next.rotation, 0, 'a stationary car must not pivot');
    }
    const released = predictLocalMovement({
      x: 240, y: 330, rotation: 0, vx: 0, vy: -10, angularVelocity: 0.02,
    }, { ...DEFAULT_INPUT_STATE, sequence: 1, timestamp: 0 });
    assert.ok(Math.abs(released.angularVelocity - 0.02 * 0.85 * 0.99) < 0.000001);
  } finally {
    clearPrediction();
  }
});
