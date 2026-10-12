import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_TRACK,
  PHYSICS_CONSTANTS,
  computeStartGrid,
  createCircuitTrack,
  type GridSlot,
  type Track,
} from '../shared/index';

const MIN_SEPARATION = Math.hypot(PHYSICS_CONSTANTS.CAR_WIDTH, PHYSICS_CONSTANTS.CAR_HEIGHT);

function assertNoOverlap(slots: GridSlot[]) {
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const distance = Math.hypot(
        slots[i]!.position.x - slots[j]!.position.x,
        slots[i]!.position.y - slots[j]!.position.y
      );
      assert.ok(
        distance >= MIN_SEPARATION,
        `slots ${i} and ${j} overlap (${distance.toFixed(1)}px)`
      );
    }
  }
}

function aheadOfFinish(track: Track, slot: GridSlot) {
  const finish = track.elements.find(element => element.type === 'finish')!;
  return slot.position.x * Math.sin(finish.rotation) - slot.position.y * Math.cos(finish.rotation);
}

test('the start grid orders authored spawns from pole position backwards', () => {
  const track = createCircuitTrack('monza-grand-prix');
  // Authored order must not matter, only distance to the finish line.
  track.elements = [...track.elements].reverse();
  const slots = computeStartGrid(track, 8);
  assert.equal(slots.length, 8);
  for (let i = 1; i < slots.length; i++) {
    assert.ok(
      aheadOfFinish(track, slots[i - 1]!) > aheadOfFinish(track, slots[i]!),
      `slot ${i - 1} is ahead of slot ${i}`
    );
  }
  assertNoOverlap(slots);
});

test('more cars than authored spawns extend the grid in further rows without overlap', () => {
  for (const track of [createCircuitTrack('bristol-short-oval'), DEFAULT_TRACK]) {
    const authored = track.elements.filter(element => element.type === 'spawn').length;
    const slots = computeStartGrid(track, authored + 6);
    assert.equal(slots.length, authored + 6);
    assertNoOverlap(slots);
    const lastAuthored = Math.min(
      ...slots.slice(0, authored).map(slot => aheadOfFinish(track, slot))
    );
    for (const extra of slots.slice(authored)) {
      assert.ok(aheadOfFinish(track, extra) < lastAuthored, 'extra slots start behind the grid');
      assert.equal(extra.rotation, slots[0]!.rotation, 'extra slots face the race direction');
    }
  }
});

test('the start grid is stable for smaller fields and empty without spawns', () => {
  const track = createCircuitTrack('daytona-tri-oval');
  assert.deepEqual(computeStartGrid(track, 3), computeStartGrid(track, 8).slice(0, 3));
  assert.deepEqual(computeStartGrid(track, 0), []);
  assert.deepEqual(
    computeStartGrid({ ...track, elements: track.elements.filter(e => e.type !== 'spawn') }, 2),
    []
  );
});
