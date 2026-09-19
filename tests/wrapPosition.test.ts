import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unwrapForTrack } from '../shared/index';

test('respawn selects the nearest repeated checkpoint after crossing multiple tiles', () => {
  const actual = unwrapForTrack(
    { x: 774.83, y: 164.31 },
    { x: -726.7729131647734, y: 191.3608400646777 },
    800,
    600
  );
  assert.ok(Math.abs(actual.x - (-825.17)) < 0.001);
  assert.equal(actual.y, 164.31);
});

test('nearest terrain-point lookup handles positive and negative tile offsets in both axes', () => {
  for (const direction of [-1, 1]) {
    for (const lapsAway of [-10, -2, 0, 2, 10]) {
      let previous = { x: lapsAway * 800 + 775, y: lapsAway * 600 + 575 };
      for (let frame = 1; frame <= 600; frame++) {
        const angle = direction * frame * Math.PI / 120;
        const expected = {
          x: lapsAway * 800 + 775 + 150 * Math.sin(angle),
          y: lapsAway * 600 + 425 + 150 * Math.cos(angle),
        };
        const wrapped = {
          x: ((expected.x % 800) + 800) % 800,
          y: ((expected.y % 600) + 600) % 600,
        };
        const actual = unwrapForTrack(wrapped, previous, 800, 600);
        assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 0.001);
        assert.ok(Math.hypot(actual.x - previous.x, actual.y - previous.y) < 4);
        previous = actual;
      }
    }
  }
});

test('unwrapping preserves ordinary positions and leaves input vectors unchanged', () => {
  const position = { x: 250, y: 300 };
  const reference = { x: 240, y: 290 };
  assert.deepEqual(unwrapForTrack(position, reference, 800, 600), position);
  assert.deepEqual(position, { x: 250, y: 300 });
  assert.deepEqual(reference, { x: 240, y: 290 });
});
