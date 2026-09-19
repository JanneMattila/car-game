import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getVisibleCarCopies } from '../client/src/game/wrappedCarCopies';

const track = { width: 800, height: 600 };
const viewport = { width: 850, height: 735 };

test('remote car copies do not jump when crossing half the track from the camera', () => {
  const before = getVisibleCarCopies({ x: 0, y: 297 }, { x: 0, y: 0 }, viewport, track);
  const after = getVisibleCarCopies({ x: 0, y: 303 }, { x: 0, y: 0 }, viewport, track);
  for (const key of ['0:-1', '0:0']) {
    const a = before.find(copy => copy.key === key)!;
    const b = after.find(copy => copy.key === key)!;
    assert.ok(a && b, 'both visible track copies must retain their sprites');
    assert.equal(b.y - a.y, 6);
    assert.equal(b.x, a.x);
  }
});

test('turning cars and moving cameras retain continuous copies through multiple wraps', () => {
  let previous = getVisibleCarCopies({ x: -8000, y: -6000 }, { x: 8000, y: 6000 }, viewport, track);
  for (let frame = 1; frame <= 1200; frame++) {
    const camera = { x: 8000 + frame * 3, y: 6000 - frame * 2 };
    const angle = frame * Math.PI / 120;
    const position = { x: -8000 + 150 * Math.sin(angle), y: -6150 + 150 * Math.cos(angle) };
    const copies = getVisibleCarCopies(position, camera, viewport, track);
    assert.equal(new Set(copies.map(copy => copy.key)).size, copies.length);
    assert.ok(copies.length > 0 && copies.length <= 9, 'sprite count stays bounded');
    for (const copy of copies) {
      const old = previous.find(old => old.key === copy.key);
      if (old) {
        assert.ok(Math.hypot(copy.x - old.x, copy.y - old.y) < 4);
      } else {
        assert.ok(
          Math.abs(copy.x - camera.x) > viewport.width / 2 ||
          Math.abs(copy.y - camera.y) > viewport.height / 2,
          'new copies appear offscreen, not in the visible viewport'
        );
      }
    }
    previous = copies;
  }
});
