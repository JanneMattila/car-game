import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  CIRCUIT_TEMPLATES,
  createCircuitTrack,
  createInitialCarState,
  DEFAULT_INPUT_STATE,
  bezierPoint,
  bezierTangent,
  getRoadBezier,
  sampleRoadCurve,
  localToWorld,
  distanceToSegment,
  validateTrack,
  circuitRoadWidthRange,
  getCircuitPreview,
  type Vector2,
} from '../shared/index';
import { PhysicsEngine } from '../server/game/physicsEngine';

const distance = (a: Vector2, b: Vector2) => Math.hypot(a.x - b.x, a.y - b.y);

test('pack completes the announced 2026 F1 venues and retains NASCAR and the original city', () => {
  const expected = [
    'melbourne',
    'shanghai',
    'suzuka',
    'bahrain',
    'jeddah',
    'miami',
    'montreal',
    'monaco',
    'barcelona',
    'red-bull-ring',
    'silverstone',
    'spa-francorchamps',
    'hungaroring',
    'zandvoort',
    'monza',
    'madrid',
    'baku',
    'singapore',
    'austin',
    'mexico-city',
    'interlagos',
    'las-vegas',
    'lusail',
    'yas-marina',
  ].map(venue => `${venue}-grand-prix`);
  const f1 = CIRCUIT_TEMPLATES.filter(t => t.category === 'Formula 1');
  assert.deepEqual([...f1.map(t => t.id), 'silverstone-grand-prix'].sort(), expected.sort());
  assert.equal(new Set(f1.map(t => JSON.stringify(getCircuitPreview(t.id)))).size, 23);
  assert.equal(CIRCUIT_TEMPLATES.filter(t => t.category === 'NASCAR').length, 3);
  assert.equal(CIRCUIT_TEMPLATES.filter(t => t.category === 'Urban').length, 1);
  assert.equal(new Set(CIRCUIT_TEMPLATES.map(t => t.id)).size, 27);
  assert.throws(() => createCircuitTrack('missing'), /Unknown circuit/);
  assert.throws(() => getCircuitPreview('missing'), /Unknown circuit/);
  assert.throws(() => createCircuitTrack('monza-grand-prix', NaN), /Road width/);
  assert.throws(() => createCircuitTrack('daytona-tri-oval', 100), /Road width/);
});

test('new circuits are closed, tangent-continuous and leave clear racing corridors', async t => {
  const variants = CIRCUIT_TEMPLATES.flatMap(template => {
    const { minimum, maximum } = circuitRoadWidthRange(template.category);
    return [...new Set([minimum, template.roadWidth, maximum])].map(width => ({ template, width }));
  });
  for (const { template, width } of variants) {
    await t.test(`${template.name} (${width} units)`, () => {
      const track = createCircuitTrack(template.id, width);
      assert.equal(validateTrack(track).isValid, true);
      const roads = track.elements.filter(e => e.type === 'road_curve');
      const course = roads.flatMap(road => sampleRoadCurve(road).slice(0, -1));
      const signedArea = course.reduce((sum, point, i) => {
        const next = course[(i + 1) % course.length]!;
        return sum + point.x * next.y - next.x * point.y;
      }, 0);
      const clockwise = !new Set([
        'interlagos-grand-prix',
        'daytona-tri-oval',
        'talladega-superspeedway',
        'bristol-short-oval',
        'pacific-city-circuit',
        'baku-grand-prix',
        'miami-grand-prix',
        'austin-grand-prix',
        'las-vegas-grand-prix',
        'jeddah-grand-prix',
        'singapore-grand-prix',
        'yas-marina-grand-prix',
      ]).has(template.id);
      assert.equal(
        signedArea > 0,
        clockwise,
        'circuits must run in their intended racing direction'
      );
      for (let i = 0; i < roads.length; i++) {
        const curve = getRoadBezier(roads[i]!)!;
        const preview = getCircuitPreview(template.id)[i]!;
        for (const key of ['start', 'control1', 'control2', 'end'] as const) {
          assert.ok(
            distance(preview[key], curve[key]) < 1e-7,
            'preview must match playable geometry'
          );
        }
        const next = getRoadBezier(roads[(i + 1) % roads.length]!)!;
        assert.ok(distance(curve.end, next.start) < 0.000001);
        const end = bezierTangent(curve, 1);
        const start = bezierTangent(next, 0);
        const dot =
          (end.x * start.x + end.y * start.y) /
          (Math.hypot(end.x, end.y) * Math.hypot(start.x, start.y));
        assert.ok(dot > 0.999999, 'road joins must have matching headings');
        assert.equal(roads[i]!.properties?.kerbs, template.category === 'Formula 1');
      }
      const walls = track.elements
        .filter(e => e.type === 'wall')
        .map(
          wall =>
            [localToWorld(wall, { x: 0, y: 0.5 }), localToWorld(wall, { x: 1, y: 0.5 })] as const
        );
      for (let i = 0; i < course.length; i += 4) {
        const point = course[i]!;
        const clearance = Math.min(...walls.map(([a, b]) => distanceToSegment(point, a, b)));
        assert.ok(
          clearance > width / 2 + 25,
          `Barrier intrudes near ${point.x.toFixed(0)},${point.y.toFixed(0)}: clearance ${clearance.toFixed(1)}`
        );
      }
      const spawns = track.elements.filter(e => e.type === 'spawn');
      assert.equal(spawns.length, 8);
      for (const spawn of spawns) {
        for (const corner of [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
          { x: 1, y: 1 },
        ]) {
          const point = localToWorld(spawn, corner);
          const clearance = Math.min(
            ...course.map((a, i) => distanceToSegment(point, a, course[(i + 1) % course.length]!))
          );
          assert.ok(clearance < width / 2, 'the entire starting grid must be on asphalt');
        }
      }
      const checkpoints = track.elements.filter(e => e.type === 'checkpoint');
      assert.deepEqual(
        checkpoints.map(e => e.checkpointIndex),
        Array.from({ length: roads.length - 1 }, (_, i) => i)
      );
      for (const [i, checkpoint] of checkpoints.entries()) {
        const point = bezierPoint(getRoadBezier(roads[i]!)!, 0.65);
        assert.ok(
          distance(point, {
            x: checkpoint.x + checkpoint.width / 2,
            y: checkpoint.y + checkpoint.height / 2,
          }) < 0.000001
        );
      }
      const finish = track.elements.find(e => e.type === 'finish')!;
      const start = getRoadBezier(roads[0]!)!.start;
      assert.ok(
        distance(start, { x: finish.x + finish.width / 2, y: finish.y + finish.height / 2 }) <
          0.000001
      );
      assert.ok(Buffer.byteLength(JSON.stringify(track)) < 2 * 1024 * 1024);
    });
  }
});

test('each new circuit supports a complete physics-driven lap through all checkpoints', async t => {
  const variants = CIRCUIT_TEMPLATES.flatMap(template => {
    const { minimum, maximum } = circuitRoadWidthRange(template.category);
    const existing = new Set([
      'monza-grand-prix',
      'spa-francorchamps-grand-prix',
      'interlagos-grand-prix',
    ]).has(template.id);
    const widths =
      template.category === 'Formula 1' && !existing
        ? [...new Set([minimum, template.roadWidth, maximum])]
        : [template.roadWidth];
    return widths.map(width => ({ template, width }));
  });
  for (const { template, width } of variants) {
    await t.test(`${template.name} (${width} units)`, () => {
      const track = createCircuitTrack(template.id, width);
      const roads = track.elements.filter(e => e.type === 'road_curve');
      const course = roads.flatMap(road => sampleRoadCurve(road).slice(0, -1));
      const spawn = track.elements.find(e => e.type === 'spawn')!;
      const position = { x: spawn.x + spawn.width / 2, y: spawn.y + spawn.height / 2 };
      const car = createInitialCarState('car', 'driver', position, spawn.rotation);
      const physics = new PhysicsEngine(track);
      physics.initialize([car]);
      let cursor = course.reduce(
        (best, point, i) =>
          distance(point, position) < distance(course[best]!, position) ? i : best,
        0
      );
      let checkpoints = 0;
      let lap = false;
      try {
        for (let frame = 0; frame < 18000 && !lap; frame++) {
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
          const error = Math.atan2(
            Math.sin(desired - car.rotation),
            Math.cos(desired - car.rotation)
          );
          const speed = Math.hypot(car.velocity.x, car.velocity.y);
          const cruiseSpeed = template.category === 'NASCAR' ? 12 : 7;
          physics.applyInput('driver', {
            ...DEFAULT_INPUT_STATE,
            playerId: 'driver',
            sequence: frame,
            timestamp: (frame * 1000) / 60,
            accelerate: speed < cruiseSpeed,
            brake: speed > cruiseSpeed + 1,
            steerValue: Math.max(-1, Math.min(1, error * 1.8)),
          });
          const events = physics.update(1 / 60);
          physics.syncCarState(car);
          checkpoints += events.filter(e => e.type === 'checkpoint').length;
          lap = events.some(e => e.type === 'lap');
          assert.ok(
            nearestDistance < track.elements[0]!.properties!.roadWidth! / 2 - 25,
            `Car left asphalt at frame ${frame}: ${nearestDistance.toFixed(1)} units`
          );
        }
        assert.equal(checkpoints, roads.length - 1, 'every checkpoint must be crossed in order');
        assert.ok(lap, 'a continuous driven lap must cross the finish');
      } finally {
        physics.reset();
      }
    });
  }
});

test('curated circuit files match their reproducible templates', async t => {
  for (const template of CIRCUIT_TEMPLATES) {
    await t.test(template.name, async () => {
      const saved = JSON.parse(
        await readFile(new URL(`../data/tracks/${template.id}.json`, import.meta.url), 'utf8')
      );
      assert.deepEqual(saved, createCircuitTrack(template.id));
    });
  }
});

test('template width changes rebuild markers, walls and grids without mutating the original', () => {
  for (const template of CIRCUIT_TEMPLATES) {
    const original = createCircuitTrack(template.id);
    const width = circuitRoadWidthRange(template.category).maximum;
    const wider = createCircuitTrack(template.id, width);
    assert.ok(
      wider.elements
        .filter(e => e.type === 'road_curve')
        .every(e => e.properties?.roadWidth === width)
    );
    assert.equal(wider.elements.find(e => e.type === 'finish')!.width, width);
    assert.equal(wider.elements.find(e => e.type === 'checkpoint')!.width, width + 40);
    assert.notDeepEqual(
      wider.elements.find(e => e.type === 'wall'),
      original.elements.find(e => e.type === 'wall')
    );
    assert.deepEqual(original, createCircuitTrack(template.id));
  }
});
