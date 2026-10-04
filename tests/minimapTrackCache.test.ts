import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  circuitRectangle,
  createCircuitTrack,
  createBezierRoad,
  DEFAULT_TRACK,
  type Track,
} from '../shared/index';
import { MinimapTrackCache } from '../client/src/utils/minimapTrackCache';

function canvasFactory() {
  const canvases: HTMLCanvasElement[] = [];
  const calls: string[] = [];
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: '',
    lineJoin: '',
    font: '',
    textAlign: '',
    save() {},
    restore() {},
    scale() {},
    translate() {},
    rotate() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    fill() {
      calls.push('fill');
    },
    fillRect() {
      calls.push('rect');
    },
    fillText() {
      calls.push('label');
    },
    stroke() {
      calls.push('stroke');
    },
    arc() {},
    ellipse() {},
  } as CanvasRenderingContext2D;
  const create = () => {
    const canvas = { width: 0, height: 0, getContext: () => context } as HTMLCanvasElement;
    canvases.push(canvas);
    return canvas;
  };
  return { create, canvases, calls };
}

test('the static minimap is built once, not redrawn as cars move or repeated tiles scroll', () => {
  const factory = canvasFactory();
  const cache = new MinimapTrackCache(factory.create);
  const track = createCircuitTrack('bristol-short-oval');
  const layers = cache.get(track, 0.03);
  assert.equal(
    factory.canvases.length,
    2,
    'separate scenery and road layers preserve seam ordering'
  );
  assert.ok(factory.calls.length > 100, 'fixture must cover an expensive real circuit');
  const drawingCalls = factory.calls.length;
  for (let frame = 0; frame < 300; frame++) assert.equal(cache.get(track, 0.03), layers);
  assert.equal(
    factory.calls.length,
    drawingCalls,
    'no static vector draws during subsequent frames'
  );
  assert.equal(factory.canvases.length, 2);
});

test('changing the track or map scale rebuilds the cache without keeping stale geometry', () => {
  const factory = canvasFactory();
  const cache = new MinimapTrackCache(factory.create);
  const track = createCircuitTrack('bristol-short-oval');
  const original = cache.get(track, 0.03);
  const rescaled = cache.get(track, 0.04);
  assert.notEqual(rescaled, original);
  assert.equal(factory.canvases.length, 4);
  const changed = { ...track, elements: track.elements.filter(el => el.type !== 'finish') };
  assert.notEqual(cache.get(changed, 0.04), rescaled);
  assert.equal(factory.canvases.length, 6);
});

test('cached bounds include rotated roads, curve caps, finish offsets and out-of-bounds scenery', () => {
  const factory = canvasFactory();
  const track: Track = {
    ...DEFAULT_TRACK,
    width: 1000,
    height: 800,
    elements: [
      circuitRectangle('road', 'road', { x: 0, y: 0 }, 200, 1000, Math.PI / 4),
      createBezierRoad(
        'curve',
        {
          start: { x: 900, y: 700 },
          control1: { x: 1100, y: 700 },
          control2: { x: 1200, y: 900 },
          end: { x: 1200, y: 1100 },
        },
        200
      ),
      circuitRectangle('finish', 'finish', { x: 0, y: 0 }, 300, 40, Math.PI / 4),
    ],
    scenery: [
      {
        id: 'outside',
        type: 'building',
        position: { x: 1800, y: -400 },
        rotation: Math.PI / 4,
        scale: 2,
        width: 300,
        height: 300,
        label: 'Outside',
      },
    ],
  };
  const [scenery, roads] = new MinimapTrackCache(factory.create).get(track, 0.1);
  assert.ok(roads.x < -400 && roads.y < -400);
  assert.ok(roads.x + roads.width / 0.1 > 1800);
  assert.ok(roads.y + roads.height / 0.1 >= 1200);
  assert.equal(scenery.x, roads.x);
  assert.equal(scenery.y, roads.y);
  assert.ok(factory.calls.includes('label'));
  assert.ok(factory.calls.includes('stroke'));
});

test('repeating tracks retain edge-crossing surfaces and bound memory for distant scenery', () => {
  const factory = canvasFactory();
  const track: Track = {
    ...DEFAULT_TRACK,
    width: 800,
    height: 600,
    wrapAround: true,
    elements: [circuitRectangle('edge', 'road', { x: 0, y: 300 }, 200, 620, 0)],
    scenery: [],
  };
  const cache = new MinimapTrackCache(factory.create);
  const [, roads] = cache.get(track, 0.1);
  assert.equal(roads.x, -100);
  assert.equal(roads.y, -10);
  assert.ok(roads.y + roads.height / 0.1 >= 610);
  const distant = {
    ...track,
    scenery: [
      {
        id: 'far',
        type: 'building',
        position: { x: 1e9, y: 1e9 },
        rotation: 0,
        scale: 1,
        width: 300,
        height: 300,
      },
    ],
  };
  for (const layer of cache.get(distant, 0.1)) {
    assert.ok(layer.canvas.width <= 2048 && layer.canvas.height <= 2048);
    assert.ok(layer.width > 0 && layer.height > 0);
  }
});

test('cache construction errors and invalid inputs are explicit', () => {
  const factory = canvasFactory();
  const cache = new MinimapTrackCache(factory.create);
  for (const scale of [0, -1, NaN, Infinity]) {
    assert.throws(() => cache.get(DEFAULT_TRACK, scale), /positive/);
  }
  assert.throws(() => cache.get({ ...DEFAULT_TRACK, width: NaN }, 0.1), /finite positive bounds/);
  const unavailable = new MinimapTrackCache(
    () =>
      ({
        width: 0,
        height: 0,
        getContext: () => null,
      }) as HTMLCanvasElement
  );
  assert.throws(() => unavailable.get(DEFAULT_TRACK, 0.1), /Unable to create/);
});
