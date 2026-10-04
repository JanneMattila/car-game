import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createInitialCarState,
  createVehicleBody,
  DEFAULT_INPUT_STATE,
  PHYSICS_CONSTANTS,
  type Track,
} from '../shared/index';
import { PhysicsEngine } from '../server/game/physicsEngine';
import {
  clearPrediction,
  getReconciliationDebug,
  initializePrediction,
  predictLocalMovement,
} from '../client/src/game/clientPrediction';

function collisionTrack(rotation = 0, wrapAround = false, seam = false): Track {
  return {
    id: 'wall-test',
    version: 1,
    name: 'Wall test',
    author: 'Test',
    createdAt: 0,
    updatedAt: 0,
    difficulty: 'easy',
    defaultLapCount: 99,
    width: 800,
    height: 600,
    wrapAround,
    scenery: [],
    elements: (seam ? [0, 400] : [-200]).map((x, index) => ({
      id: `wall-${index}`,
      type: 'wall',
      x,
      y: 200,
      position: { x, y: 200 },
      width: seam ? 400 : 1200,
      height: 20,
      rotation,
    })),
  };
}

test('vehicle collider matches the visible footprint without changing driving mass', () => {
  const body = createVehicleBody({ x: 0, y: 0 }, 0);
  assert.equal(body.bounds.max.x - body.bounds.min.x, PHYSICS_CONSTANTS.CAR_WIDTH);
  assert.equal(body.bounds.max.y - body.bounds.min.y, PHYSICS_CONSTANTS.CAR_HEIGHT);
  assert.equal(body.mass, 1.2);
  assert.equal(body.inertia, Infinity);
});

test('predicted wall contacts match authoritative physics without snap-back', async t => {
  for (const scenario of [
    { name: 'sustained head-on contact' },
    { name: 'glancing slide', angle: 0.35 },
    { name: 'rotated wall', rotation: 0.42 },
    { name: 'adjoining barrier seam', seam: true },
    { name: 'nitro impact', nitro: true },
    { name: 'steering while touching wall', steer: true },
    { name: 'distant repeating tile', wrapAround: true, tile: 20 },
    { name: 'negative repeating tile', wrapAround: true, tile: -20 },
    { name: 'respawn after sustained wall contact', respawn: true },
  ]) {
    await t.test(scenario.name, () => {
      const track = collisionTrack(scenario.rotation, scenario.wrapAround, scenario.seam);
      const tile = scenario.tile ?? 0;
      const position = { x: 400 + tile * track.width, y: 450 + tile * track.height };
      const car = createInitialCarState('car', 'driver', position, scenario.angle ?? 0);
      const physics = new PhysicsEngine(track);
      physics.initialize([car]);
      let prediction = {
        x: position.x,
        y: position.y,
        rotation: car.rotation,
        vx: 0,
        vy: 0,
        angularVelocity: 0,
      };
      initializePrediction(prediction, track);
      let maxError = 0;
      let maxStep = 0;
      try {
        for (let frame = 0; frame < 300; frame++) {
          if (scenario.respawn && frame === 150) {
            physics.resetCar('driver', position, scenario.angle ?? 0);
            prediction = {
              x: position.x,
              y: position.y,
              rotation: scenario.angle ?? 0,
              vx: 0,
              vy: 0,
              angularVelocity: 0,
            };
            initializePrediction(prediction, track);
          }
          const steer = scenario.steer && frame > 70 && frame < 130 ? 0.25 : 0;
          const input = {
            ...DEFAULT_INPUT_STATE,
            accelerate: true,
            nitro: !!scenario.nitro && frame < 80,
            steerRight: steer > 0,
            steerValue: steer,
            sequence: frame,
            timestamp: 0,
          };
          const previous = prediction;
          prediction = predictLocalMovement(prediction, input);
          physics.applyInput('driver', input);
          physics.update(1 / 60);
          physics.syncCarState(car);
          maxError = Math.max(
            maxError,
            Math.hypot(prediction.x - car.position.x, prediction.y - car.position.y)
          );
          maxStep = Math.max(
            maxStep,
            Math.hypot(prediction.x - previous.x, prediction.y - previous.y)
          );
          assert.ok(Math.abs(prediction.rotation - car.rotation) < 0.000001);
        }
        assert.ok(getReconciliationDebug().wallCollisionSteps > 0, 'must actually hit a wall');
        assert.ok(maxError < 0.000001, `wall prediction diverged by ${maxError} units`);
        assert.ok(maxStep < 30, `unexpected collision jump of ${maxStep} units`);
        if (!scenario.angle && !scenario.steer && !scenario.rotation) {
          assert.ok(
            car.position.y >= 244.9 + tile * track.height,
            'the entire 50-unit car must stay outside the barrier'
          );
        }
      } finally {
        physics.reset();
        clearPrediction();
      }
    });
  }
});

test('clearing prediction disposes wall contacts before a new race', () => {
  const track = collisionTrack();
  let state = { x: 400, y: 245, rotation: 0, vx: 0, vy: 0, angularVelocity: 0 };
  initializePrediction(state, track);
  const input = { ...DEFAULT_INPUT_STATE, accelerate: true, sequence: 1, timestamp: 0 };
  for (let frame = 0; frame < 10; frame++) state = predictLocalMovement(state, input);
  assert.ok(getReconciliationDebug().wallCollisionSteps > 0);
  clearPrediction();
  assert.equal(getReconciliationDebug().wallContacts, 0);
  assert.equal(getReconciliationDebug().wallCollisionSteps, 0);
  initializePrediction(state);
  const next = predictLocalMovement(state, input);
  assert.ok(next.y < state.y, 'no old wall should block a race without a track');
  clearPrediction();
});
