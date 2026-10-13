import { Vector2 } from '../types/physics';
import { lerpAngle } from './math';

/** Authoritative motion of one car at a server timestamp (ms). */
export interface MotionSample {
  time: number;
  x: number;
  y: number;
  rotation: number;
  vx: number;
  vy: number;
  angularVelocity: number;
}

export interface MotionState {
  position: Vector2;
  rotation: number;
  velocity: Vector2;
  angularVelocity: number;
}

/** Remote cars are drawn this far in the past, so two snapshots (20 Hz) bracket the render time. */
export const INTERPOLATION_DELAY_MS = 100;
// Velocities are per 60 Hz physics step.
const STEP_MS = 1000 / 60;
const BUFFER_MS = 1000;
// Positions further apart than this between snapshots are teleports (respawns), never blended.
const TELEPORT_DISTANCE = 200;

/**
 * Maps the local clock to the server clock. The offset includes the one-way delivery delay; the
 * fastest snapshot seen is the best estimate, and the estimate slowly follows clock drift.
 */
export class ServerClock {
  private offset: number | null = null;

  observe(serverTime: number, clientTime = Date.now()): void {
    const sample = clientTime - serverTime;
    if (this.offset === null || sample < this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.01;
  }

  get synchronized(): boolean {
    return this.offset !== null;
  }

  /** Server time of the newest snapshot that could have arrived by `clientTime`. */
  serverTime(clientTime = Date.now()): number {
    return clientTime - (this.offset ?? 0);
  }

  reset(): void {
    this.offset = null;
  }
}

function extrapolate(sample: MotionSample, milliseconds: number): MotionState {
  const steps = milliseconds / STEP_MS;
  return {
    position: { x: sample.x + sample.vx * steps, y: sample.y + sample.vy * steps },
    rotation: sample.rotation + sample.angularVelocity * steps,
    velocity: { x: sample.vx, y: sample.vy },
    angularVelocity: sample.angularVelocity,
  };
}

/** Timestamped snapshot history per car, sampled at an arbitrary server time. */
export class SnapshotInterpolator {
  private buffers = new Map<string, MotionSample[]>();

  push(id: string, sample: MotionSample): void {
    let buffer = this.buffers.get(id);
    if (!buffer) {
      buffer = [];
      this.buffers.set(id, buffer);
    }
    const last = buffer[buffer.length - 1];
    if (last && sample.time <= last.time) return;
    buffer.push({ ...sample });
    while (buffer.length > 2 && buffer[1]!.time < sample.time - BUFFER_MS) buffer.shift();
  }

  /** Forgets cars that are no longer in the race. */
  retain(ids: ReadonlySet<string>): void {
    for (const id of this.buffers.keys()) {
      if (!ids.has(id)) this.buffers.delete(id);
    }
  }

  /**
   * Motion at `time`: interpolated between the surrounding snapshots, or extrapolated from the
   * newest one by at most `maxExtrapolationMs`.
   */
  sample(id: string, time: number, maxExtrapolationMs = 150): MotionState | null {
    const buffer = this.buffers.get(id);
    if (!buffer || buffer.length === 0) return null;
    const first = buffer[0]!;
    if (time <= first.time) return extrapolate(first, 0);
    for (let i = buffer.length - 1; i > 0; i--) {
      const a = buffer[i - 1]!;
      const b = buffer[i]!;
      if (time < a.time || time > b.time) continue;
      if (Math.hypot(b.x - a.x, b.y - a.y) > TELEPORT_DISTANCE) {
        return extrapolate(time - a.time < b.time - time ? a : b, 0);
      }
      const t = (time - a.time) / (b.time - a.time);
      return {
        position: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        rotation: lerpAngle(a.rotation, b.rotation, t),
        velocity: { x: a.vx + (b.vx - a.vx) * t, y: a.vy + (b.vy - a.vy) * t },
        angularVelocity: a.angularVelocity + (b.angularVelocity - a.angularVelocity) * t,
      };
    }
    const last = buffer[buffer.length - 1]!;
    return extrapolate(last, Math.min(Math.max(0, time - last.time), maxExtrapolationMs));
  }

  clear(): void {
    this.buffers.clear();
  }
}
