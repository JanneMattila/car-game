export interface FrameStats {
  fps: number | null;
  frameTimeMs: number | null;
  slowestFrameMs: number | null;
}

export class FrameStatsMonitor {
  private previousTime: number | null = null;
  private windowStart = 0;
  private frames = 0;
  private slowestFrame = 0;
  private stats: FrameStats = { fps: null, frameTimeMs: null, slowestFrameMs: null };

  reset(): void {
    this.previousTime = null;
    this.windowStart = 0;
    this.frames = 0;
    this.slowestFrame = 0;
    this.stats = { fps: null, frameTimeMs: null, slowestFrameMs: null };
  }

  recordFrame(time: number): void {
    if (!Number.isFinite(time) || (this.previousTime !== null && time < this.previousTime)) {
      throw new RangeError('Frame timestamps must be finite and monotonic.');
    }
    if (this.previousTime === null) {
      this.previousTime = time;
      this.windowStart = time;
      return;
    }
    this.slowestFrame = Math.max(this.slowestFrame, time - this.previousTime);
    this.previousTime = time;
    this.frames++;
    const elapsed = time - this.windowStart;
    if (elapsed >= 1000) {
      this.stats = {
        fps: (this.frames * 1000) / elapsed,
        frameTimeMs: elapsed / this.frames,
        slowestFrameMs: this.slowestFrame,
      };
      this.windowStart = time;
      this.frames = 0;
      this.slowestFrame = 0;
    }
  }

  getStats(): Readonly<FrameStats> {
    return this.stats;
  }
}

export const rendererFrameStats = new FrameStatsMonitor();
