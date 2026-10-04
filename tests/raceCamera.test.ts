import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cameraZoomForSpeed,
  createRaceCamera,
  updateRaceCamera,
} from '../client/src/game/raceCamera';

test('camera opens the view progressively at speed and retains the close view at rest', () => {
  assert.equal(cameraZoomForSpeed(0), 1);
  assert.equal(cameraZoomForSpeed(3), 1);
  assert.ok(cameraZoomForSpeed(9) < 1);
  assert.ok(Math.abs(cameraZoomForSpeed(15) - 0.55) < 0.000001);
  assert.equal(cameraZoomForSpeed(26), cameraZoomForSpeed(15));
  let previous = 1;
  for (let speed = 0; speed <= 30; speed += 0.1) {
    const zoom = cameraZoomForSpeed(speed);
    assert.ok(zoom <= previous && zoom >= 0.55 && zoom <= 1);
    previous = zoom;
  }
  assert.ok(1 / cameraZoomForSpeed(15) > 1.8, 'fast view must show 80% more world in each axis');
});

test('zoom stays smooth and frame-rate independent without moving the car off center', () => {
  const position = { x: 400, y: 450 };
  const velocity = { x: 0, y: -15 };
  const results = [30, 60, 144].map(fps => {
    let camera = updateRaceCamera(createRaceCamera(), position, velocity, 0);
    for (let frame = 0; frame < fps; frame++) {
      const previousZoom = camera.zoom;
      camera = updateRaceCamera(camera, position, velocity, 1 / fps);
      assert.ok(camera.zoom <= previousZoom && camera.zoom > 0.55);
      assert.equal(camera.x, position.x);
      assert.equal(camera.y, position.y);
    }
    return camera;
  });
  for (const camera of results) {
    assert.ok(Math.abs(camera.zoom - results[0]!.zoom) < 0.000001);
    assert.ok(Math.abs(camera.y - results[0]!.y) < 0.000001);
  }
  const fast = results[0]!;
  const braking = updateRaceCamera(fast, position, { x: 0, y: 0 }, 1 / 60);
  assert.ok(
    braking.zoom > fast.zoom && braking.zoom < 0.6,
    'braking or hitting a wall must not cause an abrupt zoom-in'
  );
});

test('camera reset starts centered at a new spawn even when coordinates are zero', () => {
  const initial = updateRaceCamera(createRaceCamera(), { x: 0, y: 0 }, { x: 0, y: 0 }, 0);
  assert.equal(initial.initialized, true);
  assert.equal(initial.zoom, 1);
  const moved = updateRaceCamera(initial, { x: 100, y: 0 }, { x: 0, y: 0 }, 1 / 60);
  assert.equal(moved.x, 100, 'camera movement must not lag behind the car');
  const reset = updateRaceCamera(createRaceCamera(), { x: 2000, y: 1000 }, { x: 0, y: 0 }, 0);
  assert.equal(reset.x, 2000);
  assert.equal(reset.y, 1000);
  assert.equal(reset.zoom, 1);
});

test('moving cars remain exactly centered through acceleration, nitro, braking and reverse', () => {
  for (const fps of [30, 60, 144]) {
    let camera = createRaceCamera();
    let position = { x: 0, y: 0 };
    for (const velocity of [
      { x: 0, y: 0 },
      { x: 9, y: -3 },
      { x: 20, y: 0 },
      { x: 0, y: -26 },
      { x: -18, y: 18 },
      { x: 0, y: 0 },
      { x: -8, y: 2 },
    ]) {
      for (let frame = 0; frame < fps; frame++) {
        position = {
          x: position.x + (velocity.x * 60) / fps,
          y: position.y + (velocity.y * 60) / fps,
        };
        camera = updateRaceCamera(camera, position, velocity, 1 / fps);
        assert.equal(camera.x, position.x);
        assert.equal(camera.y, position.y);
        for (const viewport of [
          { width: 713, height: 667 },
          { width: 1920, height: 1080 },
        ]) {
          const screenX = viewport.width / 2 + (position.x - camera.x) * camera.zoom;
          const screenY = viewport.height / 2 + (position.y - camera.y) * camera.zoom;
          assert.equal(screenX, viewport.width / 2);
          assert.equal(screenY, viewport.height / 2);
        }
      }
    }
  }
});

test('corrections and distant world coordinates center immediately, even with no elapsed time', () => {
  const previous = updateRaceCamera(createRaceCamera(), { x: 100, y: 100 }, { x: 0, y: 0 }, 0);
  for (const position of [
    { x: 0, y: 0 },
    { x: 1000000, y: -2000000 },
  ]) {
    const corrected = updateRaceCamera(previous, position, { x: 26, y: 0 }, 0);
    assert.equal(corrected.x, position.x);
    assert.equal(corrected.y, position.y);
    assert.equal(corrected.zoom, previous.zoom, 'position corrections must not jump the zoom');
  }
});
