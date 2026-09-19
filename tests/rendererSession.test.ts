import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startRendererSession } from '../client/src/game/rendererSession';

function createRenderer(frames: Set<() => void>) {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const initialized = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const state = { simulatedFrames: 0, activations: 0, destructions: 0 };
  const errors: unknown[] = [];
  const onFrame = () => state.simulatedFrames++;
  const dispose = startRendererSession({
    initialize: () => initialized,
    activate: () => {
      state.activations++;
      frames.add(onFrame);
    },
    destroy: () => {
      state.destructions++;
      frames.delete(onFrame);
    },
    onError: error => errors.push(error),
  });
  return { resolve, reject, initialized, dispose, state, errors };
}

for (const olderFinishesFirst of [true, false]) {
  test(`only the mounted renderer simulates frames after async remount (older first: ${olderFinishesFirst})`, async () => {
    const frames = new Set<() => void>();
    const cancelled = createRenderer(frames);
    cancelled.dispose();
    const current = createRenderer(frames);
    const order = olderFinishesFirst ? [cancelled, current] : [current, cancelled];
    for (const renderer of order) {
      renderer.resolve();
      await renderer.initialized;
    }

    for (let i = 0; i < 60; i++) frames.forEach(frame => frame());
    assert.equal(cancelled.state.simulatedFrames, 0);
    assert.equal(cancelled.state.activations, 0);
    assert.equal(cancelled.state.destructions, 1);
    assert.equal(current.state.simulatedFrames, 60);
    assert.equal(frames.size, 1);
    current.dispose();
    assert.equal(frames.size, 0);
  });
}

test('successive races advance once per frame and stop immediately on leaving', async () => {
  const frames = new Set<() => void>();
  const races: ReturnType<typeof createRenderer>[] = [];
  for (let race = 0; race < 5; race++) {
    const renderer = createRenderer(frames);
    races.push(renderer);
    renderer.resolve();
    await renderer.initialized;
    for (let i = 0; i < 60; i++) frames.forEach(frame => frame());
    renderer.dispose();
    renderer.dispose();
    frames.forEach(frame => frame());
    assert.equal(frames.size, 0);
  }
  for (const renderer of races) {
    assert.equal(renderer.state.simulatedFrames, 60);
    assert.equal(renderer.state.activations, 1);
    assert.equal(renderer.state.destructions, 1);
    assert.deepEqual(renderer.errors, []);
  }
});

test('initialization failure is reported without activating the renderer', async () => {
  const frames = new Set<() => void>();
  const renderer = createRenderer(frames);
  const error = new Error('Renderer initialization failed');
  renderer.reject(error);
  await assert.rejects(renderer.initialized, error);
  renderer.dispose();
  assert.equal(renderer.state.activations, 0);
  assert.equal(frames.size, 0);
  assert.deepEqual(renderer.errors, [error]);
});

test('activation failure releases the initialized renderer and reports the error', async () => {
  let running = false;
  let destructions = 0;
  const errors: unknown[] = [];
  const error = new Error('Scene setup failed');
  const initialized = Promise.resolve();
  const dispose = startRendererSession({
    initialize: () => initialized,
    activate: () => {
      running = true;
      throw error;
    },
    destroy: () => {
      running = false;
      destructions++;
    },
    onError: failure => errors.push(failure),
  });
  await initialized;
  dispose();
  assert.equal(running, false);
  assert.equal(destructions, 1);
  assert.deepEqual(errors, [error]);
});
