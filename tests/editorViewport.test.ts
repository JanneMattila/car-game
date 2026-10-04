import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitEditorViewport } from '../client/src/utils/editorViewport';

test('Fit track includes the entire city on desktop, mobile and an open inspector', () => {
  for (const viewport of [
    { width: 800, height: 600 },
    { width: 295, height: 500 },
    { width: 333, height: 551 },
    { width: 35, height: 40 },
  ]) {
    const fitted = fitEditorViewport(13000, 10500, viewport);
    assert.ok(fitted.pan.x >= 0 && fitted.pan.y >= 0);
    assert.ok(fitted.pan.x + 13000 * fitted.zoom <= viewport.width);
    assert.ok(fitted.pan.y + 10500 * fitted.zoom <= viewport.height);
    assert.ok(fitted.minimumZoom < fitted.zoom, 'wheel/slider must allow zooming out past fit');
  }
});

test('fitting adapts to larger worlds while preserving the small-world zoom cap', () => {
  const viewport = { width: 600, height: 500 };
  const large = fitEditorViewport(50000, 10000, viewport);
  assert.equal(large.zoom, 552 / 50000);
  assert.ok(large.minimumZoom < 0.03);
  assert.equal(fitEditorViewport(100, 100, viewport).zoom, 2);
  assert.throws(() => fitEditorViewport(NaN, 100, viewport), RangeError);
  assert.throws(() => fitEditorViewport(100, 100, { width: 0, height: 10 }), RangeError);
});
