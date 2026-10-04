import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameStatsMonitor } from '../client/src/game/frameStats';

test('FPS counts actual render frames at 30, 60 and 144 Hz, independently of UI polling', () => {
  for (const fps of [30, 60, 144]) {
    const monitor = new FrameStatsMonitor();
    for (let frame = 0; frame <= fps * 2; frame++) {
      monitor.recordFrame((frame * 1000) / fps);
      for (let read = 0; read < 10; read++) monitor.getStats();
    }
    const stats = monitor.getStats();
    assert.ok(Math.abs(stats.fps! - fps) < 1e-6);
    assert.ok(Math.abs(stats.frameTimeMs! - 1000 / fps) < 1e-6);
    assert.ok(Math.abs(stats.slowestFrameMs! - 1000 / fps) < 1e-6);
  }
});

test('warmup and renderer/background reset do not report fake zero or stale FPS', () => {
  const monitor = new FrameStatsMonitor();
  assert.deepEqual(monitor.getStats(), { fps: null, frameTimeMs: null, slowestFrameMs: null });
  monitor.recordFrame(0);
  monitor.recordFrame(500);
  assert.equal(monitor.getStats().fps, null);
  monitor.recordFrame(1000);
  assert.equal(monitor.getStats().fps, 2);
  monitor.reset();
  monitor.recordFrame(100000);
  assert.equal(monitor.getStats().fps, null, 'hidden time must not enter the next sample');
  for (let frame = 1; frame <= 60; frame++) monitor.recordFrame(100000 + (frame * 1000) / 60);
  assert.equal(monitor.getStats().fps, 60);
});

test('long visible stalls contribute their real duration and the slowest-frame metric', () => {
  const monitor = new FrameStatsMonitor();
  for (const time of [0, 10, 20, 1020]) monitor.recordFrame(time);
  assert.deepEqual(monitor.getStats(), {
    fps: 3000 / 1020,
    frameTimeMs: 340,
    slowestFrameMs: 1000,
  });
  for (let frame = 1; frame <= 60; frame++) monitor.recordFrame(1020 + (frame * 1000) / 60);
  assert.ok(Math.abs(monitor.getStats().slowestFrameMs! - 1000 / 60) < 1e-6);
});

test('invalid timestamps are rejected without corrupting frame statistics', () => {
  const monitor = new FrameStatsMonitor();
  monitor.recordFrame(100);
  for (const time of [NaN, Infinity, 99]) {
    assert.throws(() => monitor.recordFrame(time), /finite and monotonic/);
  }
  monitor.recordFrame(1100);
  assert.equal(monitor.getStats().fps, 1);
  assert.equal(monitor.getStats().frameTimeMs, 1000);
});
