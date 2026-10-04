import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createBezierRoad,
  presetBezier,
  getRoadBezier,
  bezierPoint,
  bezierTangent,
  sampleRoadCurve,
  hitTestRoadCurve,
  nearestRoadEndpoint,
  alignBezierEndpoint,
  roadStrokeWidth,
  roadKerbDashes,
  validateTrack,
  DEFAULT_TRACK,
  CURVE_PRESETS,
} from '../shared/index';

test('every bend preset keeps exact endpoints and a fixed road width', () => {
  const start = { x: 300, y: 400 };
  const end = { x: 950, y: 900 };
  for (const preset of CURVE_PRESETS) {
    const road = createBezierRoad(preset.id, presetBezier(start, end, preset.id), 180);
    const curve = getRoadBezier(road)!;
    assert.ok(Math.hypot(curve.start.x - start.x, curve.start.y - start.y) < 1e-8);
    assert.ok(Math.hypot(curve.end.x - end.x, curve.end.y - end.y) < 1e-8);
    assert.equal(roadStrokeWidth(road), 180);
    assert.ok(sampleRoadCurve(road).length >= 25);
    for (const point of sampleRoadCurve(road)) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    }
  }
});

test('left and right presets mirror correctly and custom roads remain straight', () => {
  const start = { x: 0, y: 0 };
  const end = { x: 600, y: 0 };
  const left = bezierPoint(presetBezier(start, end, 'left90'), 0.5);
  const right = bezierPoint(presetBezier(start, end, 'right90'), 0.5);
  assert.ok(Math.abs(left.y + right.y) < 1e-8);
  assert.ok(left.y > 0 && right.y < 0);
  assert.equal(bezierPoint(presetBezier(start, end, 'custom'), 0.5).y, 0);
});

test('moving, resizing and rotating curves preserves normalized handles and road width', () => {
  const road = createBezierRoad(
    'curve',
    presetBezier({ x: 100, y: 200 }, { x: 700, y: 800 }, 'right90'),
    160
  );
  const translated = getRoadBezier({ ...road, x: road.x + 500, y: road.y - 300 })!;
  assert.deepEqual(translated.start, { x: 600, y: -100 });
  const rotated = getRoadBezier({ ...road, rotation: Math.PI })!;
  assert.ok(Math.abs(rotated.start.x - (2 * road.x + road.width - 100)) < 1e-8);
  assert.ok(Math.abs(rotated.start.y - (2 * road.y + road.height - 200)) < 1e-8);
  assert.equal(roadStrokeWidth({ ...road, width: road.width * 2 }), 160);
});

test('curve hit testing follows the asphalt instead of selecting empty bounding-box space', () => {
  const road = createBezierRoad(
    'curve',
    presetBezier({ x: 100, y: 100 }, { x: 800, y: 800 }, 'right90'),
    100
  );
  assert.equal(hitTestRoadCurve(bezierPoint(getRoadBezier(road)!, 0.5), road), true);
  assert.equal(hitTestRoadCurve({ x: road.x + 5, y: road.y + road.height - 5 }, road), false);
});

test('endpoint snapping joins roads exactly and matches their tangent direction', () => {
  const existing = createBezierRoad(
    'old',
    presetBezier({ x: 100, y: 100 }, { x: 600, y: 100 }, 'custom'),
    160
  );
  const endpoint = nearestRoadEndpoint({ x: 603, y: 104 }, [existing], 20)!;
  const next = alignBezierEndpoint(
    presetBezier({ x: 610, y: 110 }, { x: 1000, y: 500 }, 'right90'),
    endpoint,
    true
  );
  assert.deepEqual(next.start, { x: 600, y: 100 });
  const tangent = bezierTangent(next, 0);
  assert.ok(tangent.x > 0 && Math.abs(tangent.y) < 1e-8);
  assert.equal(nearestRoadEndpoint(endpoint.point, [existing], 20, 'old'), null);
  assert.equal(nearestRoadEndpoint({ x: 900, y: 900 }, [existing], 20), null);
});

test('legacy quarter circles retain the editor geometry and can be snapped to', () => {
  const road = {
    id: 'legacy',
    type: 'road_curve' as const,
    x: 100,
    y: 200,
    position: { x: 100, y: 200 },
    width: 400,
    height: 400,
    rotation: 0,
  };
  const points = sampleRoadCurve(road);
  assert.deepEqual(points[0], { x: 300, y: 200 });
  assert.ok(Math.abs(points[32]!.x - 100) < 1e-8);
  assert.equal(points[32]!.y, 400);
  assert.equal(roadStrokeWidth(road), 240);
});

test('kerb dashes remain bounded on long and degenerate segments', () => {
  const dashes = roadKerbDashes([
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 200, y: 0 },
  ]);
  assert.equal(dashes.length, 4);
  assert.deepEqual(dashes[0], [
    { x: 0, y: 0 },
    { x: 28, y: 0 },
  ]);
  assert.deepEqual(dashes[1], [
    { x: 56, y: 0 },
    { x: 84, y: 0 },
  ]);
});

test('track validation rejects malformed curve control points and widths', () => {
  const road = createBezierRoad(
    'bad',
    presetBezier({ x: 100, y: 100 }, { x: 500, y: 500 }, 'left45'),
    160
  );
  for (const width of [0, NaN, Infinity]) {
    const result = validateTrack({
      ...DEFAULT_TRACK,
      elements: [{ ...road, properties: { ...road.properties, roadWidth: width } }],
    });
    assert.ok(result.errors.some(error => error.code === 'INVALID_ROAD_CURVE'));
  }
  const badPoint = {
    ...road,
    properties: {
      ...road.properties,
      bezier: { ...road.properties!.bezier!, start: { x: -1, y: 0 } },
    },
  };
  assert.ok(
    validateTrack({ ...DEFAULT_TRACK, elements: [badPoint] }).errors.some(
      error => error.code === 'INVALID_ROAD_CURVE'
    )
  );
});
