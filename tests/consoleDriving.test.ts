import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getDrivingInput, parseDrivePattern } from '../console-client/driving';

test('console auto-drive defaults to straight acceleration and rejects unknown patterns', () => {
  assert.equal(parseDrivePattern(), 'straight');
  assert.equal(getDrivingInput(parseDrivePattern(), 1000).steerValue, 0);
  assert.throws(() => parseDrivePattern('random'), /Invalid DRIVE_PATTERN/);
});

test('circle patterns hold acceleration and mutually exclusive steering', () => {
  for (const [pattern, direction] of [['circle-left', -1], ['circle-right', 1]] as const) {
    for (const elapsed of [0, 8000, 32000]) {
      const input = getDrivingInput(pattern, elapsed);
      assert.equal(input.accelerate, true);
      assert.equal(input.brake, false);
      assert.equal(input.respawn, false);
      assert.equal(input.steerValue, direction);
      assert.equal(input.steerLeft, direction === -1);
      assert.equal(input.steerRight, direction === 1);
    }
  }
});

test('figure-eight driving reverses steering every eight seconds without stopping', () => {
  for (const [elapsed, direction] of [[0, 1], [7999, 1], [8000, -1], [15999, -1], [16000, 1]] as const) {
    const input = getDrivingInput('figure-eight', elapsed);
    assert.equal(input.accelerate, true);
    assert.equal(input.steerValue, direction);
    assert.equal(input.steerLeft, direction === -1);
    assert.equal(input.steerRight, direction === 1);
  }
});
