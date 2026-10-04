import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import {
  circuitRectangle,
  createBezierRoad,
  createInitialCarState,
  DEFAULT_INPUT_STATE,
  effectiveRaceGate,
  finishMarkings,
  fitRaceGate,
  preserveFinishMarkings,
  raceGateCrossing,
  RoadSurfaceIndex,
  sampleRoadCurve,
  validateTrack,
  type Track,
  type TrackElement,
} from '../shared/index';
import { migrateFinishMarkings } from '../scripts/migrateFinishMarkings';
import { PhysicsEngine } from '../server/game/physicsEngine';
import { drawFinishMarkings } from '../client/src/utils/trackDrawing';

function fixture(...elements: TrackElement[]): Track {
  return {
    id: 'marking-test',
    version: 1,
    name: 'Marking test',
    author: 'Test',
    createdAt: 0,
    updatedAt: 0,
    difficulty: 'easy',
    defaultLapCount: 99,
    width: 1000,
    height: 1200,
    wrapAround: false,
    scenery: [],
    elements,
  };
}

function assertOnlyAsphalt(track: Track, marker: TrackElement) {
  const markings = finishMarkings(track, marker);
  assert.ok(markings.length > 0);
  const surfaces = new RoadSurfaceIndex(track);
  for (const marking of markings) {
    const center = {
      x: marking.points.reduce((sum, p) => sum + p.x, 0) / marking.points.length,
      y: marking.points.reduce((sum, p) => sum + p.y, 0) / marking.points.length,
    };
    for (const point of marking.points) {
      // Test just inside each boundary to avoid floating-point equality at asphalt edges.
      assert.ok(
        surfaces.isAsphalt(
          {
            x: point.x * 0.999999 + center.x * 0.000001,
            y: point.y * 0.999999 + center.y * 0.000001,
          },
          marker.layer ?? 0
        ),
        `Paint outside asphalt: ${JSON.stringify(point)}`
      );
    }
  }
}

test('checkerboards stop exactly at straight asphalt edges, not the wider hidden gate', () => {
  const marker = circuitRectangle('finish', 'finish', { x: 500, y: 300 }, 400, 37, 0);
  const track = fixture(marker, circuitRectangle('road', 'road', { x: 500, y: 500 }, 200, 1200, 0));
  assertOnlyAsphalt(track, marker);
  const points = finishMarkings(track, marker).flatMap(m => m.points);
  assert.equal(Math.min(...points.map(p => p.x)), 400);
  assert.equal(Math.max(...points.map(p => p.x)), 600);
  assert.equal(Math.min(...points.map(p => p.y)), 281.5);
  assert.equal(
    Math.max(...points.map(p => p.y)),
    318.5,
    'partial checker cells must not overshoot'
  );
  assert.ok(finishMarkings(track, marker).some(m => m.white));
  assert.ok(finishMarkings(track, marker).some(m => !m.white));
  assert.equal(raceGateCrossing(track, marker, { x: 666, y: 350 }, { x: 666, y: 250 }), 0.5);
  assert.equal(
    finishMarkings(track, marker),
    finishMarkings(track, marker),
    'immutable geometry is cached'
  );
});

test('angled markings clip rotated rectangles, Bézier bends and legacy curves, excluding kerbs', () => {
  const rectangle = circuitRectangle('road', 'road', { x: 500, y: 500 }, 200, 800, 0.73);
  const bezier = createBezierRoad(
    'bezier',
    {
      start: { x: 100, y: 200 },
      control1: { x: 700, y: 200 },
      control2: { x: 300, y: 900 },
      end: { x: 800, y: 900 },
    },
    180
  );
  const legacy = circuitRectangle('legacy', 'road_curve', { x: 500, y: 500 }, 600, 600, 0.4);
  for (const road of [rectangle, bezier, legacy]) {
    road.properties = { ...road.properties, kerbs: true };
    const center =
      road.type === 'road'
        ? { x: 500, y: 500 }
        : sampleRoadCurve(road)[Math.floor(sampleRoadCurve(road).length / 2)]!;
    const marker = circuitRectangle('finish', 'finish', center, 600, 70, 0.31);
    assertOnlyAsphalt(fixture(marker, road), marker);
  }
});

test('layered road surfaces and seam-crossing repeated terrain clip consistently', () => {
  for (const type of ['road', 'bridge', 'ramp', 'ramp_up', 'ramp_down'] as const) {
    const road = { ...circuitRectangle(type, type, { x: 500, y: 300 }, 200, 400, 0), layer: 1 };
    const marker = circuitRectangle('finish', 'finish', { x: 500, y: 300 }, 400, 40, 0);
    assert.deepEqual(finishMarkings(fixture(marker, road), marker), []);
    const elevated = { ...marker, layer: 1 };
    assertOnlyAsphalt(fixture(elevated, road), elevated);
  }
  for (const x of [-60, 940]) {
    const marker = circuitRectangle('finish', 'finish', { x, y: 300 }, 400, 40, 0);
    const repeated = {
      ...fixture(marker, circuitRectangle('road', 'road', { x: -40, y: 300 }, 200, 400, 0)),
      wrapAround: true,
    };
    assertOnlyAsphalt(repeated, marker);
  }
});

test('visible width/offset and fully hidden markings never change detection', () => {
  const marker = circuitRectangle('finish', 'finish', { x: 500, y: 300 }, 400, 40, 0);
  const road = circuitRectangle('road', 'road', { x: 500, y: 500 }, 600, 1200, 0);
  for (const [width, offset] of [
    [0, 0],
    [100, -50],
    [100, 180],
    [10000, 0],
  ]) {
    const modified = {
      ...marker,
      properties: { finishVisibleWidth: width, finishVisibleOffset: offset },
    };
    const track = fixture(modified, road);
    assert.equal(
      raceGateCrossing(
        track,
        effectiveRaceGate(track, modified),
        { x: 666, y: 350 },
        { x: 666, y: 250 }
      ),
      0.5
    );
    const points = finishMarkings(track, modified).flatMap(m => m.points);
    if (width === 0) assert.equal(points.length, 0);
    else {
      assertOnlyAsphalt(track, modified);
      assert.ok(
        points.every(p => p.x >= 300 && p.x <= 700),
        'paint must also stay within the detection gate'
      );
      if (offset === -50) {
        assert.equal(Math.min(...points.map(p => p.x)), 400);
        assert.equal(Math.max(...points.map(p => p.x)), 500);
      }
    }
  }
  const legacy = { ...marker, properties: undefined };
  assertOnlyAsphalt(fixture(legacy, road), legacy);
});

test('fitting asymmetric rotated barriers preserves checkerboard world position and width', () => {
  for (const angle of [0, 0.73, Math.PI / 2]) {
    const point = (x: number, y: number) => ({
      x: 500 + x * Math.cos(angle) - y * Math.sin(angle),
      y: 500 + x * Math.sin(angle) + y * Math.cos(angle),
    });
    const original = circuitRectangle('finish', 'finish', point(0, 0), 240, 40, angle);
    const track = fixture(
      original,
      circuitRectangle('road', 'road', point(0, 0), 240, 1000, angle),
      circuitRectangle('left', 'wall', point(-200, 0), 14, 1000, angle),
      circuitRectangle('right', 'wall', point(230, 0), 14, 1000, angle)
    );
    const fitted = preserveFinishMarkings(original, fitRaceGate(track, original));
    const before = finishMarkings(track, original).flatMap(m => m.points);
    const after = finishMarkings(
      { ...track, elements: track.elements.map(el => (el.id === original.id ? fitted : el)) },
      fitted
    ).flatMap(m => m.points);
    assert.equal(before.length, after.length);
    before.forEach((p, i) => {
      assert.ok(Math.hypot(p.x - after[i]!.x, p.y - after[i]!.y) < 1e-7);
    });
    assert.equal(fitted.properties?.finishVisibleWidth, 240);
  }
});

test('invalid marking metadata is explicitly rejected; zero-width hidden finishes are valid', () => {
  const marker = circuitRectangle('finish', 'finish', { x: 500, y: 300 }, 400, 40, 0);
  for (const properties of [
    { finishVisibleWidth: -1 },
    { finishVisibleWidth: NaN },
    { finishVisibleWidth: Infinity },
    { finishVisibleOffset: Infinity },
    { finishVisibleOffset: NaN },
  ]) {
    const invalid = { ...marker, properties };
    assert.ok(
      validateTrack(fixture(invalid)).errors.some(e => e.code === 'INVALID_FINISH_MARKINGS')
    );
    assert.throws(() => finishMarkings(fixture(invalid), invalid), /Invalid finish markings/);
  }
  const hidden = { ...marker, properties: { finishVisibleWidth: 0 } };
  assert.ok(!validateTrack(fixture(hidden)).errors.some(e => e.code === 'INVALID_FINISH_MARKINGS'));
});

test('a physical lap through invisible grass counts once, including a completely hidden finish', () => {
  for (const visibleWidth of [240, 0]) {
    const marker = circuitRectangle('finish', 'finish', { x: 500, y: 300 }, 240, 40, 0);
    marker.properties = { finishVisibleWidth: visibleWidth, finishVisibleOffset: 0 };
    const checkpoint = circuitRectangle('checkpoint', 'checkpoint', { x: 500, y: 600 }, 280, 80, 0);
    checkpoint.checkpointIndex = 0;
    const track = fixture(
      marker,
      checkpoint,
      circuitRectangle('road', 'road', { x: 500, y: 600 }, 200, 1200, 0),
      circuitRectangle('left', 'wall', { x: 290, y: 600 }, 14, 1200, 0),
      circuitRectangle('right', 'wall', { x: 710, y: 600 }, 14, 1200, 0)
    );
    assert.equal(new RoadSurfaceIndex(track).isAsphalt({ x: 666, y: 300 }), false);
    assert.ok(finishMarkings(track, marker).every(m => m.points.every(p => p.x <= 600)));
    const physics = new PhysicsEngine(track);
    const car = createInitialCarState('car', 'driver', { x: 666, y: 710 }, 0);
    physics.initialize([car]);
    physics.applyInput('driver', {
      ...DEFAULT_INPUT_STATE,
      accelerate: true,
      timestamp: 0,
      sequence: 1,
    });
    try {
      const events = [];
      for (let frame = 0; frame < 160; frame++) events.push(...physics.update(1 / 60));
      physics.syncCarState(car);
      assert.equal(car.lap, 1);
      assert.equal(events.filter(event => event.type === 'lap').length, 1);
    } finally {
      physics.reset();
    }
  }
});

test('all saved finishes have separate spans, asphalt-only markings and hidden grass detection', async () => {
  const directory = new URL('../data/tracks/', import.meta.url);
  const files = (await readdir(directory)).filter(file => file.endsWith('.json'));
  assert.equal(files.length, 30);
  for (const file of files) {
    const track: Track = JSON.parse(await readFile(new URL(file, directory), 'utf8'));
    assert.deepEqual(migrateFinishMarkings(track), track, 'migration must be idempotent');
    for (const marker of track.elements.filter(el => el.type === 'finish')) {
      assert.ok(marker.properties?.finishVisibleWidth !== undefined, file);
      assert.equal(marker.properties?.finishVisibleOffset, 0, file);
      assertOnlyAsphalt(track, marker);
      const gate = effectiveRaceGate(track, marker);
      assert.ok(gate.width > marker.properties!.finishVisibleWidth!, file);
      const x = gate.x + gate.width / 2;
      const y = gate.y + gate.height / 2;
      const surfaces = new RoadSurfaceIndex(track);
      const grass = Array.from({ length: Math.floor(gate.width / 2) }, (_, i) => {
        const offset = -gate.width / 2 + 1 + i * 2;
        return { x: x + Math.cos(gate.rotation) * offset, y: y + Math.sin(gate.rotation) * offset };
      }).find(point => !surfaces.isAsphalt(point, marker.layer ?? 0));
      assert.ok(grass, `${file}: missing hidden grass span`);
      const forward = { x: Math.sin(gate.rotation) * 50, y: -Math.cos(gate.rotation) * 50 };
      assert.ok(
        raceGateCrossing(
          track,
          gate,
          { x: grass.x - forward.x, y: grass.y - forward.y },
          { x: grass.x + forward.x, y: grass.y + forward.y }
        ) !== null,
        file
      );
    }
  }
});

test('legacy migration preserves layout, marking center, user properties and detection direction', () => {
  const marker = {
    ...circuitRectangle('finish', 'finish', { x: 500, y: 300 }, 200, 40, 0.73),
    properties: { autoGateWidth: false },
  };
  const track = fixture(
    marker,
    circuitRectangle('road', 'road', { x: 500, y: 300 }, 200, 1000, 0.73)
  );
  const migrated = migrateFinishMarkings(track);
  const finish = migrated.elements[0]!;
  assert.equal(finish.width, 366);
  assert.equal(finish.x + finish.width / 2, 500);
  assert.equal(finish.y + finish.height / 2, 300);
  assert.equal(finish.rotation, marker.rotation);
  assert.equal(finish.properties?.autoGateWidth, false);
  assert.equal(finish.properties?.finishVisibleWidth, 200);
  assert.deepEqual(migrated.elements.slice(1), track.elements.slice(1));
  assert.deepEqual({ ...migrated, elements: [] }, { ...track, elements: [] });
});

test('editor and minimap canvas painter uses the shared clipped polygons', () => {
  const marker = circuitRectangle('finish', 'finish', { x: 500, y: 300 }, 400, 40, 0);
  const track = fixture(marker, circuitRectangle('road', 'road', { x: 500, y: 500 }, 200, 1200, 0));
  const paths: number[][] = [];
  const context = {
    fillStyle: '',
    save() {},
    restore() {},
    closePath() {},
    fill() {},
    beginPath() {
      paths.push([]);
    },
    moveTo(x: number, y: number) {
      paths[paths.length - 1]!.push(x, y);
    },
    lineTo(x: number, y: number) {
      paths[paths.length - 1]!.push(x, y);
    },
  };
  drawFinishMarkings(context as CanvasRenderingContext2D, track, marker);
  assert.deepEqual(
    paths,
    finishMarkings(track, marker).map(m => m.points.flatMap(p => [p.x, p.y]))
  );
});
