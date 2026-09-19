import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInitialCarState, DEFAULT_INPUT_STATE, serializeCarState, type Track } from '../shared/index';
import { PhysicsEngine } from '../server/game/physicsEngine';

function track(): Track {
  return {
    id: 'infinite-world-test', version: 1, name: 'Infinite world test', author: 'Test',
    createdAt: 0, updatedAt: 0, difficulty: 'easy', defaultLapCount: 99,
    width: 800, height: 600, wrapAround: true, elements: [], scenery: [],
  };
}

test('cars keep their world position across many map tiles in every direction', async t => {
  for (const [name, angle, dx, dy] of [
    ['north', 0, 0, -1], ['south', Math.PI, 0, 1],
    ['east', Math.PI / 2, 1, 0], ['west', -Math.PI / 2, -1, 0],
  ] as const) {
    await t.test(name, () => {
      const physics = new PhysicsEngine(track());
      const car = createInitialCarState('car', 'driver', { x: 200, y: 300 }, angle);
      physics.initialize([car]);
      physics.applyInput('driver', {
        ...DEFAULT_INPUT_STATE, playerId: 'driver', sequence: 1, timestamp: 0, accelerate: true,
      });
      let previous = { ...car.position };
      for (let frame = 0; frame < 900; frame++) {
        physics.update(1 / 60);
        physics.syncCarState(car);
        const forward = (car.position.x - previous.x) * dx + (car.position.y - previous.y) * dy;
        assert.ok(forward >= 0 && forward < 30, `${name}: crossing a tile must not roll the car over`);
        const snapshot = serializeCarState(car);
        assert.ok(Math.abs(snapshot.x - car.position.x) < 0.01);
        assert.ok(Math.abs(snapshot.y - car.position.y) < 0.01);
        previous = { ...car.position };
      }
      assert.ok((car.position.x - 200) * dx + (car.position.y - 300) * dy > 10000);
      physics.reset();
    });
  }
});

test('cars in different map tiles do not collide with each other', () => {
  const physics = new PhysicsEngine(track());
  const observer = createInitialCarState('observer', 'observer', { x: 200, y: 300 }, 0);
  const driver = createInitialCarState('driver', 'driver', { x: 200, y: -300 }, 0);
  physics.initialize([observer, driver]);
  physics.applyInput('driver', {
    ...DEFAULT_INPUT_STATE, playerId: 'driver', sequence: 1, timestamp: 0, accelerate: true,
  });
  for (let frame = 0; frame < 600; frame++) physics.update(1 / 60);
  physics.syncCarState(observer);
  assert.deepEqual(observer.position, { x: 200, y: 300 });
  assert.deepEqual(observer.velocity, { x: 0, y: 0 });
  physics.reset();
});

test('walls repeat near distant cars only on infinite tracks', () => {
  for (const wrapAround of [true, false]) {
    const map = track();
    map.wrapAround = wrapAround;
    map.elements.push({
      id: 'wall', type: 'wall', x: 0, y: 400, position: { x: 0, y: 400 },
      width: 800, height: 20, rotation: 0,
    });
    const physics = new PhysicsEngine(map);
    const car = createInitialCarState('car', 'driver', { x: 200, y: 450 }, 0);
    physics.initialize([car]);
    physics.applyInput('driver', {
      ...DEFAULT_INPUT_STATE, playerId: 'driver', sequence: 1, timestamp: 0, accelerate: true,
    });
    for (const tile of [-20, 0, 20]) {
      const offset = tile * map.height;
      physics.resetCar('driver', { x: 200 + tile * map.width, y: offset + 450 }, 0);
      for (let frame = 0; frame < 120; frame++) physics.update(1 / 60);
      physics.syncCarState(car);
      if (wrapAround || tile === 0) {
        assert.ok(car.position.y >= offset + 420 && car.position.y < offset + 450);
      } else {
        assert.ok(car.position.y < offset + 350, 'finite tracks have no wall in distant tiles');
      }
    }
    physics.reset();
  }
});

test('cars at the same world location still collide', () => {
  const physics = new PhysicsEngine(track());
  const observer = createInitialCarState('observer', 'observer', { x: 8200, y: -5700 }, 0);
  const driver = createInitialCarState('driver', 'driver', { x: 8200, y: -5600 }, 0);
  physics.initialize([observer, driver]);
  physics.applyInput('driver', {
    ...DEFAULT_INPUT_STATE, playerId: 'driver', sequence: 1, timestamp: 0, accelerate: true,
  });
  for (let frame = 0; frame < 120; frame++) physics.update(1 / 60);
  physics.syncCarState(observer);
  assert.ok(observer.position.y < -5710, 'the approaching car must push the observer');
  physics.reset();
});

test('checkpoint and finish markers repeat without relocating the car', () => {
  const map = track();
  map.elements = [
    { id: 'checkpoint', type: 'checkpoint', checkpointIndex: 0, x: 150, y: 250,
      position: { x: 150, y: 250 }, width: 100, height: 100, rotation: 0 },
    { id: 'finish', type: 'finish', x: 150, y: 50,
      position: { x: 150, y: 50 }, width: 100, height: 100, rotation: 0 },
  ];
  const physics = new PhysicsEngine(map);
  const car = createInitialCarState('car', 'driver', { x: 5800, y: -6300 }, 0);
  physics.initialize([car]);
  assert.ok(physics.update(1 / 60).some(event => event.type === 'checkpoint'));
  physics.syncCarState(car);
  assert.deepEqual(car.position, { x: 5800, y: -6300 });
  physics.resetCar('driver', { x: 5800, y: -6500 }, 0);
  assert.ok(physics.update(1 / 60).some(event => event.type === 'lap' && event.lap === 1));
  physics.syncCarState(car);
  assert.deepEqual(car.position, { x: 5800, y: -6500 });
  physics.reset();
});
