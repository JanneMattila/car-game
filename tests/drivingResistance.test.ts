import assert from 'node:assert/strict';
import { test } from 'node:test';
import Matter from 'matter-js';
import {
  CollisionResistance,
  RoadSurfaceIndex,
  circuitRectangle,
  createBezierRoad,
  createVehicleBody,
  createInitialCarState,
  DEFAULT_INPUT_STATE,
  PHYSICS_CONSTANTS,
  type Track,
} from '../shared/index';
import { PhysicsEngine } from '../server/game/physicsEngine';
import {
  clearPrediction,
  initializePrediction,
  predictLocalMovement,
  getReconciliationDebug,
} from '../client/src/game/clientPrediction';

const track: Track = {
  id: 'resistance-test',
  version: 1,
  name: 'Resistance test',
  author: 'Test',
  createdAt: 0,
  updatedAt: 0,
  difficulty: 'easy',
  defaultLapCount: 99,
  width: 2000,
  height: 2000,
  wrapAround: false,
  scenery: [],
  elements: [circuitRectangle('road', 'road', { x: 400, y: 0 }, 200, 200000, 0)],
};

test('asphalt queries match rotated rectangles, curves, joins, layers and repeating tiles', () => {
  const straight = new RoadSurfaceIndex(track);
  assert.ok(straight.isAsphalt({ x: 500, y: 100 }));
  assert.equal(straight.isAsphalt({ x: 500.1, y: 100 }), false);
  assert.equal(straight.isAsphalt({ x: 400, y: 100 }, 1), false);
  const road = createBezierRoad(
    'curve',
    {
      start: { x: 100, y: 100 },
      control1: { x: 300, y: 100 },
      control2: { x: 500, y: 100 },
      end: { x: 700, y: 100 },
    },
    180
  );
  const curved = new RoadSurfaceIndex({ ...track, elements: [road] });
  assert.ok(curved.isAsphalt({ x: 400, y: 189.9 }));
  assert.equal(curved.isAsphalt({ x: 400, y: 190.1 }), false);
  assert.ok(curved.isAsphalt({ x: 50, y: 100 }), 'round curve caps are asphalt');
  const bridge = {
    ...circuitRectangle('bridge', 'bridge', { x: 600, y: 600 }, 200, 1000, Math.PI / 2),
    layer: 1,
  };
  const rotated = new RoadSurfaceIndex({ ...track, elements: [bridge] });
  assert.ok(rotated.isAsphalt({ x: 1000, y: 600 }, 1));
  assert.equal(rotated.isAsphalt({ x: 600, y: 701 }, 1), false);
  const repeated = new RoadSurfaceIndex({ ...track, wrapAround: true });
  for (const tile of [-200, -1, 0, 1, 200]) {
    assert.ok(repeated.isAsphalt({ x: 400 + tile * 2000, y: 100 + tile * 2000 }));
    assert.equal(repeated.isAsphalt({ x: 601 + tile * 2000, y: 100 + tile * 2000 }), false);
  }
  const legacy = new RoadSurfaceIndex({
    ...track,
    elements: [
      {
        ...circuitRectangle('legacy', 'road_curve', { x: 200, y: 200 }, 400, 400, 0),
        properties: { roadWidth: 100 },
      },
    ],
  });
  assert.ok(legacy.isAsphalt({ x: 200, y: 0 }));
  assert.equal(legacy.isAsphalt({ x: 0, y: 0 }), false);
});

test('grass is modestly slower under throttle, nitro and reverse; re-entering asphalt restores power', () => {
  function drive(x: number, nitro: boolean, reverse: boolean) {
    const car = createInitialCarState('car', 'driver', { x, y: 50000 }, 0);
    const physics = new PhysicsEngine(track);
    physics.initialize([car]);
    try {
      for (let i = 0; i < 100; i++) {
        physics.applyInput('driver', {
          ...DEFAULT_INPUT_STATE,
          accelerate: !reverse,
          brake: reverse,
          nitro,
          sequence: i,
          timestamp: i,
        });
        physics.update(1 / 60);
        physics.syncCarState(car);
        if (i === 0) {
          const expected =
            ((PHYSICS_CONSTANTS.ENGINE_FORCE * (nitro ? 2.5 : 1) * 0.001) / 1.2) * (1000 / 60) ** 2;
          if (!reverse) assert.ok(Math.abs(car.speed - expected * (x === 400 ? 1 : 0.8)) < 1e-8);
        }
      }
      return car.speed;
    } finally {
      physics.reset();
    }
  }
  for (const [nitro, reverse] of [
    [false, false],
    [true, false],
    [false, true],
  ]) {
    const asphalt = drive(400, nitro!, reverse!);
    const grass = drive(650, nitro!, reverse!);
    assert.ok(grass < asphalt * 0.92, 'grass must measurably reduce speed');
    assert.ok(grass > asphalt * 0.65, 'grass slowdown must remain modest and drivable');
  }
  const physics = new PhysicsEngine(track);
  const car = createInitialCarState('car', 'driver', { x: 650, y: 50000 }, 0);
  physics.initialize([car]);
  physics.applyInput('driver', {
    ...DEFAULT_INPUT_STATE,
    accelerate: true,
    sequence: 0,
    timestamp: 0,
  });
  try {
    physics.update(1 / 60);
    physics.syncCarState(car);
    const grassAcceleration = car.speed;
    physics.resetCar('driver', { x: 400, y: 50000 }, 0);
    physics.update(1 / 60);
    physics.syncCarState(car);
    assert.ok(Math.abs(grassAcceleration / car.speed - 0.8) < 1e-8);
  } finally {
    physics.reset();
  }
});

test('impacts lose speed once per contact and reduce power until separation, including car contacts', () => {
  for (const otherCar of [false, true]) {
    const engine = Matter.Engine.create({ gravity: { x: 0, y: 0 } });
    const car = createVehicleBody({ x: 70, y: 100 }, Math.PI / 2);
    const other = otherCar
      ? createVehicleBody({ x: 110, y: 100 }, Math.PI / 2)
      : Matter.Bodies.rectangle(110, 100, 20, 1000, { isStatic: true, label: 'wall' });
    Matter.Body.setVelocity(car, { x: 8, y: 10 });
    Matter.World.add(engine.world, [car, other]);
    Matter.Engine.update(engine, 1000 / 60);
    const before = Matter.Vector.magnitude(car.velocity);
    const resistance = new CollisionResistance();
    resistance.apply(engine);
    assert.ok(before > 0);
    assert.ok(Math.abs(Matter.Vector.magnitude(car.velocity) - before * 0.65) < 1e-8);
    assert.equal(resistance.forceScale(car), 0.4);
    if (otherCar) assert.equal(resistance.forceScale(other), 0.4);
    resistance.apply(engine);
    assert.ok(Math.abs(Matter.Vector.magnitude(car.velocity) - before * 0.65) < 1e-8);
    Matter.Body.setPosition(car, { x: -1000, y: 0 });
    Matter.Engine.update(engine, 1000 / 60);
    resistance.apply(engine);
    assert.equal(resistance.forceScale(car), 1);
    resistance.reset();
    Matter.Engine.clear(engine);
    Matter.World.clear(engine.world, false);
  }
});

test('grass adds coasting drag without changing asphalt drag', () => {
  try {
    const velocities = [400, 650].map(x => {
      const state = { x, y: 50000, rotation: 0, vx: 0, vy: -10, angularVelocity: 0 };
      initializePrediction(state, track);
      return predictLocalMovement(state, {
        ...DEFAULT_INPUT_STATE,
        sequence: 0,
        timestamp: 0,
      }).vy;
    });
    const expected = -10 * (1 - 0.015 * 10 - 0.012) * 0.99;
    assert.ok(Math.abs(velocities[0]! - expected) < 1e-8);
    assert.ok(Math.abs(velocities[1]!) < Math.abs(velocities[0]!));
  } finally {
    clearPrediction();
  }
});

test('server and prediction match through asphalt exit, grass and sustained wall contact', () => {
  const course = {
    ...track,
    elements: [
      ...track.elements,
      circuitRectangle('wall', 'wall', { x: 700, y: 400 }, 20, 2000, 0),
    ],
  };
  const car = createInitialCarState('car', 'driver', { x: 400, y: 400 }, Math.PI / 2);
  const physics = new PhysicsEngine(course);
  physics.initialize([car]);
  let state = { x: 400, y: 400, rotation: Math.PI / 2, vx: 0, vy: 0, angularVelocity: 0 };
  initializePrediction(state, course);
  let asphalt = false,
    grass = false;
  const surface = new RoadSurfaceIndex(course);
  try {
    for (let frame = 0; frame < 300; frame++) {
      const input = {
        ...DEFAULT_INPUT_STATE,
        accelerate: true,
        nitro: frame < 100,
        sequence: frame,
        timestamp: frame,
      };
      const onRoad = surface.isAsphalt(car.position);
      asphalt ||= onRoad;
      grass ||= !onRoad;
      state = predictLocalMovement(state, input);
      physics.applyInput('driver', input);
      physics.update(1 / 60);
      physics.syncCarState(car);
      assert.ok(Math.hypot(state.x - car.position.x, state.y - car.position.y) < 1e-6);
      assert.ok(Math.hypot(state.vx - car.velocity.x, state.vy - car.velocity.y) < 1e-6);
    }
    assert.ok(asphalt && grass);
    assert.ok(getReconciliationDebug().wallCollisionSteps > 0);
    assert.ok(car.speed < 0.1, 'holding throttle against a wall must not preserve speed');
  } finally {
    physics.reset();
    clearPrediction();
  }
});
