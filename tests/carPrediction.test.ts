import assert from 'node:assert/strict';
import { test } from 'node:test';
import Matter from 'matter-js';
import {
  createInitialCarState,
  createVehicleBody,
  DEFAULT_INPUT_STATE,
  WallPredictionWorld,
  type Track,
} from '../shared/index';
import { PhysicsEngine } from '../server/game/physicsEngine';
import {
  clearPrediction,
  initializePrediction,
  predictLocalMovement,
  predictFrame,
  setPredictionOpponents,
  getReconciliationDebug,
  reconcileWithServer,
} from '../client/src/game/clientPrediction';

const track: Track = {
  id: 'car-contact-test',
  version: 1,
  name: 'Car contact test',
  author: 'Test',
  createdAt: 0,
  updatedAt: 0,
  difficulty: 'easy',
  defaultLapCount: 99,
  width: 2000,
  height: 2000,
  wrapAround: false,
  scenery: [],
  elements: [],
};

function depth(
  a: { x: number; y: number; rotation: number },
  b: { x: number; y: number; rotation: number }
): number {
  const bodyA = createVehicleBody(a, a.rotation);
  const bodyB = createVehicleBody(b, b.rotation);
  return Matter.Query.collides(bodyA, [bodyB])[0]?.depth ?? 0;
}

test('authoritative cars collide rather than passing through one another', () => {
  const rear = createInitialCarState('rear', 'rear', { x: 500, y: 500 }, 0);
  const front = createInitialCarState('front', 'front', { x: 500, y: 400 }, 0);
  const physics = new PhysicsEngine(track);
  physics.initialize([rear, front]);
  try {
    let touched = false;
    for (let i = 0; i < 180; i++) {
      physics.applyInput('rear', {
        ...DEFAULT_INPUT_STATE,
        accelerate: true,
        sequence: i,
        timestamp: i,
      });
      physics.update(1 / 60);
      physics.syncCarState(rear);
      physics.syncCarState(front);
      const overlap = depth(
        { ...rear.position, rotation: rear.rotation },
        { ...front.position, rotation: front.rotation }
      );
      touched ||= overlap > 0;
      assert.ok(overlap < 0.1, `server overlap ${overlap}`);
      assert.ok(rear.position.y > front.position.y, 'rear car must not pass through front car');
    }
    assert.ok(touched);
    assert.ok(front.position.y < 400, 'server must transfer motion to the other car');
  } finally {
    physics.reset();
  }
});

test('prediction cannot drive through a parked opponent, even on a track without walls', () => {
  let state = { x: 500, y: 500, rotation: 0, vx: 0, vy: 0, angularVelocity: 0 };
  initializePrediction(state, track);
  setPredictionOpponents([
    {
      playerId: 'other',
      position: { x: 500, y: 400 },
      rotation: 0,
      velocity: { x: 0, y: 0 },
      angularVelocity: 0,
    },
  ]);
  try {
    let maxOverlap = 0;
    for (let i = 0; i < 40; i++) {
      state = predictLocalMovement(state, {
        ...DEFAULT_INPUT_STATE,
        accelerate: true,
        sequence: i,
        timestamp: i,
      });
      maxOverlap = Math.max(maxOverlap, depth(state, { x: 500, y: 400, rotation: 0 }));
    }
    assert.ok(maxOverlap < 0.1, `car overlap ${maxOverlap}`);
    assert.ok(state.y > 449.9, 'prediction must remain behind the other car');
    assert.ok(getReconciliationDebug().carCollisionSteps > 0);
    assert.equal(getReconciliationDebug().wallCollisionSteps, 0);
  } finally {
    clearPrediction();
  }
});

test('nitro, reverse and rotated side contacts use the full opponent hull', () => {
  for (const scenario of [
    { rotation: 0, otherRotation: 0, reverse: false, nitro: true },
    { rotation: Math.PI, otherRotation: 0.7, reverse: true, nitro: false },
    { rotation: 0.35, otherRotation: Math.PI / 2, reverse: false, nitro: false },
  ]) {
    let state = { x: 500, y: 500, rotation: scenario.rotation, vx: 0, vy: 0, angularVelocity: 0 };
    initializePrediction(state, track);
    setPredictionOpponents([
      {
        playerId: 'other',
        position: { x: 500, y: 400 },
        rotation: scenario.otherRotation,
        velocity: { x: 0, y: 0 },
        angularVelocity: 0,
      },
    ]);
    try {
      for (let i = 0; i < 120; i++) {
        state = predictLocalMovement(state, {
          ...DEFAULT_INPUT_STATE,
          accelerate: !scenario.reverse,
          brake: scenario.reverse,
          nitro: scenario.nitro,
          sequence: i,
          timestamp: i,
        });
        const overlap = depth(state, { x: 500, y: 400, rotation: scenario.otherRotation });
        assert.ok(overlap < 0.001, `overlap ${overlap} at frame ${i}, angle ${scenario.rotation}`);
      }
      assert.ok(getReconciliationDebug().carCollisionSteps > 0, 'must actually contact opponent');
    } finally {
      clearPrediction();
    }
  }
});

test('moving opponents and render interpolation remain separated at 30, 60 and 144 FPS', () => {
  for (const fps of [30, 60, 144]) {
    const state = { x: 500, y: 500, rotation: 0, vx: 0, vy: 0, angularVelocity: 0 };
    initializePrediction(state, track);
    try {
      for (let frame = 0; frame < fps; frame++) {
        const other = { x: 500, y: 400 + (120 * frame) / fps, rotation: Math.PI };
        setPredictionOpponents([
          {
            playerId: 'other',
            position: other,
            rotation: other.rotation,
            velocity: { x: 0, y: 2 },
            angularVelocity: 0,
          },
        ]);
        const display = predictFrame(1 / fps)!;
        assert.ok(depth(display, other) < 0.001, `${fps} FPS overlap at frame ${frame}`);
        assert.ok(display.y > other.y, 'incoming opponent must push, not pass through, local car');
      }
    } finally {
      clearPrediction();
    }
  }
});

test('interpolated correction cannot put a car inside a rotated opponent or nearby wall', () => {
  const world = new WallPredictionWorld({
    ...track,
    elements: [
      {
        id: 'wall',
        type: 'wall',
        x: 0,
        y: 200,
        position: { x: 0, y: 200 },
        width: 1000,
        height: 20,
        rotation: 0,
      },
    ],
  });
  const other = { x: 470, y: 250, rotation: 0.5 };
  world.setOpponents([
    {
      playerId: 'other',
      position: other,
      rotation: other.rotation,
      velocity: { x: 0, y: 0 },
      angularVelocity: 0,
    },
  ]);
  try {
    const display = world.constrain({
      x: 500,
      y: 245,
      rotation: -0.2,
      vx: 0,
      vy: 0,
      angularVelocity: 0,
    });
    assert.ok(depth(display, other) < 0.001);
    const hull = createVehicleBody(display, display.rotation);
    assert.ok(hull.bounds.min.y > 219.9, 'opponent correction must not push the car into a wall');
  } finally {
    world.dispose();
  }
});

test('disconnection, respawn and a new race remove old opponent contacts', () => {
  const state = { x: 500, y: 450, rotation: 0, vx: 0, vy: 0, angularVelocity: 0 };
  const other = {
    playerId: 'other',
    position: { x: 500, y: 400 },
    rotation: 0,
    velocity: { x: 0, y: 0 },
    angularVelocity: 0,
  };
  const input = { ...DEFAULT_INPUT_STATE, accelerate: true, sequence: 1, timestamp: 0 };
  initializePrediction(state, track);
  try {
    setPredictionOpponents([other]);
    predictLocalMovement(state, input);
    assert.ok(getReconciliationDebug().carContacts > 0);
    setPredictionOpponents([]);
    assert.equal(getReconciliationDebug().carContacts, 0);
    assert.ok(predictLocalMovement(state, input).y < 449.9, 'departed player must stop blocking');
    setPredictionOpponents([other]);
    reconcileWithServer({ ...state, x: 1200 }, 1);
    assert.equal(getReconciliationDebug().carContacts, 0, 'respawn clears warm contacts');
    clearPrediction();
    initializePrediction(state, track);
    assert.equal(getReconciliationDebug().carCollisionSteps, 0);
    assert.ok(predictLocalMovement(state, input).y < 449, 'new race has no stale blockers');
  } finally {
    clearPrediction();
  }
});

test('prediction without a track also disposes opponent bodies when a race ends', () => {
  const state = { x: 500, y: 450, rotation: 0, vx: 0, vy: 0, angularVelocity: 0 };
  initializePrediction(state);
  setPredictionOpponents([
    {
      playerId: 'other',
      position: { x: 500, y: 400 },
      rotation: 0,
      velocity: { x: 0, y: 0 },
      angularVelocity: 0,
    },
  ]);
  const input = { ...DEFAULT_INPUT_STATE, accelerate: true, sequence: 1, timestamp: 0 };
  try {
    assert.ok(predictLocalMovement(state, input).y > 449.9);
    clearPrediction();
    initializePrediction(state);
    assert.ok(predictLocalMovement(state, input).y < 449);
    assert.equal(getReconciliationDebug().carContacts, 0);
  } finally {
    clearPrediction();
  }
});
