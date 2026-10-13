import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INTERPOLATION_DELAY_MS,
  ServerClock,
  SnapshotInterpolator,
  WallPredictionWorld,
  createCircuitTrack,
} from '../shared/index';

const FRAME_MS = 1000 / 60;
const SPEED = 13; // px per frame, the asphalt top speed

function drive(jitterMs: number) {
  const motion = new SnapshotInterpolator();
  const clock = new ServerClock();
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const arrivals: { at: number; time: number }[] = [];
  for (let time = 0; time <= 5000; time += 50) {
    arrivals.push({
      at: Math.max(time + 40 + random() * jitterMs, arrivals.at(-1)?.at ?? 0),
      time,
    });
  }
  const errors: number[] = [];
  for (let now = 0; now <= 5000; now += FRAME_MS) {
    while (arrivals.length && arrivals[0]!.at <= now) {
      const { time, at } = arrivals.shift()!;
      clock.observe(time, at);
      motion.push('car', {
        time,
        x: (time / FRAME_MS) * SPEED,
        y: 0,
        rotation: Math.PI / 2,
        vx: SPEED,
        vy: 0,
        angularVelocity: 0,
      });
    }
    if (now < 1000) continue;
    const renderTime = clock.serverTime(now) - INTERPOLATION_DELAY_MS;
    const shown = motion.sample('car', renderTime)!;
    errors.push(Math.abs(shown.position.x - (renderTime / FRAME_MS) * SPEED));
  }
  return errors;
}

test('remote cars move smoothly along their real path, delayed only by the interpolation buffer', () => {
  for (const jitter of [0, 30]) {
    const errors = drive(jitter);
    assert.ok(
      Math.max(...errors) < 1,
      `jitter ${jitter}: ${Math.max(...errors).toFixed(2)}px off path`
    );
  }
});

test('server clock tracks the fastest delivery and follows slow drift', () => {
  const clock = new ServerClock();
  clock.observe(1000, 1060);
  clock.observe(1050, 1090);
  assert.equal(clock.serverTime(2000), 1960);
  for (let i = 0; i < 2000; i++) clock.observe(5000 + i, 5000 + i + 60);
  assert.ok(Math.abs(clock.serverTime(10000) - 9940) < 1);
});

test('teleports are not blended and extrapolation is bounded', () => {
  const motion = new SnapshotInterpolator();
  const sample = (time: number, x: number) => ({
    time,
    x,
    y: 0,
    rotation: 0,
    vx: 10,
    vy: 0,
    angularVelocity: 0,
  });
  motion.push('car', sample(0, 0));
  motion.push('car', sample(50, 5000));
  assert.equal(motion.sample('car', 20)!.position.x, 0);
  assert.equal(motion.sample('car', 30)!.position.x, 5000);
  motion.push('car', sample(40, 123));
  assert.equal(motion.sample('car', 50)!.position.x, 5000, 'out-of-order snapshots are ignored');
  const ahead = motion.sample('car', 50 + 10 * FRAME_MS, 1000)!;
  assert.ok(Math.abs(ahead.position.x - 5100) < 1e-9);
  assert.ok(Math.abs(motion.sample('car', 5000, 150)!.position.x - (5000 + 9 * 10)) < 1e-9);
  motion.retain(new Set());
  assert.equal(motion.sample('car', 50), null);
});

test('prediction only simulates walls near the car on large circuits, yet still collides', () => {
  const track = createCircuitTrack('monza-grand-prix');
  const walls = track.elements.filter(element => element.type === 'wall');
  const world = new WallPredictionWorld(track);
  try {
    const wall = walls[0]!;
    const center = { x: wall.x + wall.width / 2, y: wall.y + wall.height / 2 };
    const state = { ...center, rotation: wall.rotation, vx: 0, vy: 0, angularVelocity: 0 };
    world.resolve(state, state);
    assert.ok(world.activeWallCount > 0);
    assert.ok(
      world.activeWallCount < walls.length / 4,
      `${world.activeWallCount} of ${walls.length}`
    );
    assert.ok(world.contacts > 0, 'a car placed on a barrier is in contact with it');
  } finally {
    world.dispose();
  }
});
