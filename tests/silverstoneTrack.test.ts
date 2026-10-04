import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  Track,
  Vector2,
  validateTrack,
  getRoadBezier,
  bezierTangent,
  sampleRoadCurve,
  hitTestRoadCurve,
  distanceToSegment,
  localToWorld,
  createInitialCarState,
  DEFAULT_INPUT_STATE,
} from '../shared/index';
import { createSilverstoneTrack } from '../scripts/generateSilverstoneTrack';
import { PhysicsEngine } from '../server/game/physicsEngine';

const track = createSilverstoneTrack();
const roads = track.elements.filter(el => el.type === 'road_curve');
const course = roads.flatMap(road => sampleRoadCurve(road).slice(0, -1));

test('persisted Silverstone circuit is reproducible, large, closed and valid for eight racers', async () => {
  const saved = JSON.parse(
    await readFile(new URL('../data/tracks/silverstone-grand-prix.json', import.meta.url), 'utf8')
  ) as Track;
  assert.ok(saved.updatedAt >= saved.createdAt);
  assert.deepEqual({ ...saved, updatedAt: track.updatedAt }, track);
  assert.deepEqual(validateTrack(saved), { isValid: true, errors: [], warnings: [] });
  assert.ok(track.width >= 7000 && track.height >= 6000);
  assert.equal(track.wrapAround, false);
  assert.equal(track.elements.filter(el => el.type === 'spawn').length, 8);
  let length = 0;
  for (let i = 0; i < roads.length; i++) {
    const curve = getRoadBezier(roads[i]!)!;
    const next = getRoadBezier(roads[(i + 1) % roads.length]!)!;
    assert.ok(Math.hypot(curve.end.x - next.start.x, curve.end.y - next.start.y) < 1e-8);
    const a = bezierTangent(curve, 1);
    const b = bezierTangent(next, 0);
    const cosine = (a.x * b.x + a.y * b.y) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y));
    assert.ok(cosine > 0.99999, `Road ${i} must connect without a tangent kink`);
  }
  for (let i = 0; i < course.length; i++) {
    const p = course[i]!;
    const next = course[(i + 1) % course.length]!;
    assert.ok(p.x > 200 && p.x < track.width - 200 && p.y > 200 && p.y < track.height - 200);
    length += Math.hypot(next.x - p.x, next.y - p.y);
  }
  assert.ok(length > 20000, `Circuit length ${length.toFixed(0)} must exceed 20,000 world units`);
});

test('grid slots, finish and all checkpoint centers sit on drivable asphalt', () => {
  for (const element of track.elements.filter(el =>
    ['spawn', 'finish', 'checkpoint'].includes(el.type)
  )) {
    const center = { x: element.x + element.width / 2, y: element.y + element.height / 2 };
    assert.ok(
      roads.some(road => hitTestRoadCurve(center, road)),
      `${element.id} must be on the track`
    );
  }
  const spawns = track.elements.filter(el => el.type === 'spawn');
  assert.ok(spawns.every(spawn => spawn.rotation === 0 && spawn.y > 5000));
});

test('rotated safety barriers leave clearance along the entire racing line', () => {
  const walls = track.elements.filter(el => el.type === 'wall');
  const segments = walls.map(
    wall => [localToWorld(wall, { x: 0, y: 0.5 }), localToWorld(wall, { x: 1, y: 0.5 })] as const
  );
  for (let i = 0; i < course.length; i += 2) {
    const point = course[i]!;
    const clearance = Math.min(
      ...segments.map(([start, end]) => distanceToSegment(point, start, end))
    );
    assert.ok(
      clearance > 145,
      `Racing line at ${point.x.toFixed(0)},${point.y.toFixed(0)} has only ${clearance.toFixed(0)} barrier clearance`
    );
  }
});

test('server collision geometry follows rotated walls rather than unrotated bounding boxes', () => {
  const wallTrack: Track = {
    ...track,
    elements: [
      {
        id: 'rotated-wall',
        type: 'wall',
        x: 350,
        y: 493,
        position: { x: 350, y: 493 },
        width: 300,
        height: 14,
        rotation: Math.PI / 2,
      },
    ],
  };
  const physics = new PhysicsEngine(wallTrack);
  const car = createInitialCarState('wall-car', 'driver', { x: 300, y: 500 }, Math.PI / 2);
  physics.initialize([car]);
  physics.applyInput('driver', {
    ...DEFAULT_INPUT_STATE,
    playerId: 'driver',
    sequence: 1,
    timestamp: 0,
    accelerate: true,
  });
  for (let frame = 0; frame < 180; frame++) physics.update(1 / 60);
  physics.syncCarState(car);
  physics.reset();
  assert.ok(
    car.position.x > 460 && car.position.x < 485,
    `Rotated barrier stopped car at ${car.position.x}`
  );
});
test('server physics can drive a continuous Silverstone lap and trigger every checkpoint in order', () => {
  const physics = new PhysicsEngine(track);
  const car = createInitialCarState('silverstone-car', 'test-driver', { x: 4000, y: 5100 }, 0);
  physics.initialize([car]);
  let cursor = course.length - 10;
  let checkpoints = 0;
  let lap = false;
  const normalizeAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
  const distance = (a: Vector2, b: Vector2) => Math.hypot(a.x - b.x, a.y - b.y);
  for (let frame = 0; frame < 24000 && !lap; frame++) {
    let nearest = cursor;
    let nearestDistance = Infinity;
    for (let look = 0; look < 35; look++) {
      const index = (cursor + look) % course.length;
      const d = distance(car.position, course[index]!);
      if (d < nearestDistance) {
        nearestDistance = d;
        nearest = index;
      }
    }
    cursor = nearest;
    const target = course[(cursor + 8) % course.length]!;
    const desired = Math.atan2(target.x - car.position.x, -(target.y - car.position.y));
    const error = normalizeAngle(desired - car.rotation);
    const speed = Math.hypot(car.velocity.x, car.velocity.y);
    physics.applyInput('test-driver', {
      ...DEFAULT_INPUT_STATE,
      playerId: 'test-driver',
      sequence: frame,
      timestamp: (frame * 1000) / 60,
      accelerate: speed < 7,
      brake: speed > 8,
      steerValue: Math.max(-1, Math.min(1, error * 1.8)),
    });
    const events = physics.update(1 / 60);
    physics.syncCarState(car);
    checkpoints += events.filter(event => event.type === 'checkpoint').length;
    lap = events.some(event => event.type === 'lap');
    assert.ok(
      nearestDistance < 160,
      `Car left racing corridor at frame ${frame}: ${nearestDistance.toFixed(0)} units`
    );
  }
  physics.reset();
  assert.equal(checkpoints, track.elements.filter(el => el.type === 'checkpoint').length);
  assert.ok(lap, 'A continuous driven lap must trigger the finish line');
});
