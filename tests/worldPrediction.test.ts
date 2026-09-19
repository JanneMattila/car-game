import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearPrediction, initializePrediction, reconcileWithServer } from '../client/src/game/clientPrediction';

test('reconciliation preserves authoritative world coordinates far beyond the first tile', () => {
  for (const position of [-2000000, -15000, 15000, 2000000]) {
    clearPrediction();
    const state = { x: position, y: position, rotation: 0, vx: 0, vy: 0, angularVelocity: 0 };
    initializePrediction(state);
    assert.deepEqual(reconcileWithServer(state, 1), state);
  }
  clearPrediction();
});

test('an explicit respawn uses the authoritative location, not a nearby equivalent tile', () => {
  clearPrediction();
  const state = { x: 40000, y: -30000, rotation: 0, vx: 0, vy: 0, angularVelocity: 0 };
  initializePrediction(state);
  const respawn = { ...state, x: 240, y: 330 };
  assert.deepEqual(reconcileWithServer(respawn, 2), respawn);
  clearPrediction();
});
