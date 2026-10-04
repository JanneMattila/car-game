import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCircuitTrack,
  distanceToSegment,
  sampleRoadCurve,
  sceneryShapes,
  validateTrack,
  type SceneryItem,
} from '../shared/index';

test('Pacific City has a large original city backdrop and editable, bounded race route', () => {
  const track = createCircuitTrack('pacific-city-circuit');
  assert.equal(track.width, 13000);
  assert.equal(track.height, 10500);
  assert.equal(track.wrapAround, false);
  assert.equal(track.elements.filter(el => el.type === 'road_curve').length, 24);
  assert.equal(track.elements.filter(el => el.type === 'checkpoint').length, 23);
  assert.equal(track.elements.filter(el => el.type === 'spawn').length, 8);
  assert.ok(track.scenery.length > 200);
  assert.equal(new Set(track.scenery.map(item => item.id)).size, track.scenery.length);
  for (const name of [
    'DOWNTOWN',
    'SUNSET HILLS',
    'BOARDWALK BEACH',
    'MARINA CANALS',
    'COAST AIRPORT',
    'PORT AZURE',
  ])
    assert.ok(track.scenery.some(item => item.label === name));
  assert.ok(track.scenery.some(item => item.type === 'runway'));
  assert.equal(validateTrack(track).isValid, true);
  assert.ok(Buffer.byteLength(JSON.stringify(track)) < 2 * 1024 * 1024);
});

test('the widest city race route stays dry and clear of building footprints', () => {
  const track = createCircuitTrack('pacific-city-circuit', 360);
  const course = track.elements
    .filter(el => el.type === 'road_curve')
    .flatMap(road => sampleRoadCurve(road).slice(0, -1));
  for (const item of track.scenery) {
    assert.ok(Number.isFinite(item.position.x) && Number.isFinite(item.position.y));
    if (item.type !== 'water' && item.type !== 'building') continue;
    const width = item.width;
    const height = item.height;
    assert.ok(width !== undefined && height !== undefined);
    const cosine = Math.cos(item.rotation);
    const sine = Math.sin(item.rotation);
    for (let i = 0; i < course.length; i += 4) {
      const point = course[i]!;
      const dx = point.x - item.position.x;
      const dy = point.y - item.position.y;
      const localX = dx * cosine + dy * sine;
      const localY = -dx * sine + dy * cosine;
      const clearance = Math.hypot(
        Math.max(0, Math.abs(localX) - width / 2),
        Math.max(0, Math.abs(localY) - height / 2)
      );
      assert.ok(
        clearance > 190,
        `${item.id} intrudes on the widest street at ${point.x},${point.y}`
      );
    }
    if (item.type === 'building') {
      const centerClearance = Math.min(
        ...course.map((a, i) =>
          distanceToSegment(item.position, a, course[(i + 1) % course.length]!)
        )
      );
      assert.ok(centerClearance > 200);
    }
  }
});

test('shared scenery preserves legacy vectors and supports original city surfaces', () => {
  const item: SceneryItem = {
    id: 'test',
    type: 'building',
    position: { x: 0, y: 0 },
    rotation: 0,
    scale: 1,
  };
  const legacy = sceneryShapes(item);
  assert.deepEqual(legacy.slice(0, 2), [
    { kind: 'rect', x: -100, y: -30, width: 200, height: 60, color: '#263746' },
    { kind: 'rect', x: -96, y: -26, width: 192, height: 48, color: '#bac7ce' },
  ]);
  assert.equal(sceneryShapes({ ...item, type: 'tree' }).length, 3);
  assert.deepEqual(sceneryShapes({ ...item, type: 'label' }), []);
  const water = sceneryShapes({
    ...item,
    type: 'water',
    width: 800,
    height: 400,
    color: '#123456',
  });
  assert.deepEqual(water, [
    { kind: 'rect', x: -400, y: -200, width: 800, height: 400, color: '#123456' },
  ]);
  assert.ok(
    sceneryShapes({ ...item, type: 'runway', height: 2000 }).some(shape => shape.kind === 'line')
  );
  const invalid = createCircuitTrack('pacific-city-circuit');
  invalid.scenery[0]!.color = 'not-a-color';
  assert.ok(validateTrack(invalid).errors.some(error => error.code === 'INVALID_SCENERY'));
});
