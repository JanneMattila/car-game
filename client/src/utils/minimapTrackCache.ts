import {
  Track,
  Vector2,
  finishMarkings,
  localToWorld,
  roadStrokeWidth,
  sampleRoadCurve,
  sceneryShapes,
} from '@shared';
import { drawFinishMarkings, drawRoadCurve, drawScenery } from './trackDrawing';

export interface MinimapLayer {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  width: number;
  height: number;
}

function trackBounds(track: Track) {
  let minX = 0;
  let minY = 0;
  let maxX = track.width;
  let maxY = track.height;
  const include = (point: Vector2, radius = 0) => {
    minX = Math.min(minX, point.x - radius);
    minY = Math.min(minY, point.y - radius);
    maxX = Math.max(maxX, point.x + radius);
    maxY = Math.max(maxY, point.y + radius);
  };
  const corners = (left: number, top: number, right: number, bottom: number) => [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  for (const element of track.elements) {
    if (element.type === 'road_curve') {
      for (const point of sampleRoadCurve(element)) include(point, roadStrokeWidth(element) / 2);
    } else if (element.type === 'finish') {
      for (const marking of finishMarkings(track, element)) marking.points.forEach(p => include(p));
    } else if (['road', 'wall', 'barrier'].includes(element.type)) {
      corners(0, 0, 1, 1).forEach(p => include(localToWorld(element, p)));
    }
  }
  for (const item of track.scenery ?? []) {
    const transform = (p: Vector2) => ({
      x:
        item.position.x +
        item.scale * (p.x * Math.cos(item.rotation) - p.y * Math.sin(item.rotation)),
      y:
        item.position.y +
        item.scale * (p.x * Math.sin(item.rotation) + p.y * Math.cos(item.rotation)),
    });
    for (const shape of sceneryShapes(item)) {
      let bounds: Vector2[];
      if (shape.kind === 'rect') {
        bounds = corners(shape.x, shape.y, shape.x + shape.width, shape.y + shape.height);
      } else if (shape.kind === 'line') {
        const radius = shape.width / 2;
        bounds = corners(
          Math.min(shape.x, shape.endX) - radius,
          Math.min(shape.y, shape.endY) - radius,
          Math.max(shape.x, shape.endX) + radius,
          Math.max(shape.y, shape.endY) + radius
        );
      } else {
        const rx = shape.kind === 'circle' ? shape.radius : shape.radiusX;
        const ry = shape.kind === 'circle' ? shape.radius : shape.radiusY;
        bounds = corners(shape.x - rx, shape.y - ry, shape.x + rx, shape.y + ry);
      }
      bounds.forEach(p => include(transform(p)));
    }
    if (item.label) {
      corners(-item.label.length * 28, -28, item.label.length * 28, 65).forEach(p =>
        include(transform(p))
      );
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Rasterize static geometry once; keep scenery behind roads across repeated tile seams. */
export class MinimapTrackCache {
  private track: Track | null = null;
  private scale = 0;
  private layers: [MinimapLayer, MinimapLayer] | null = null;

  constructor(private createCanvas = () => document.createElement('canvas')) {}

  get(track: Track, scale: number): [MinimapLayer, MinimapLayer] {
    if (!Number.isFinite(scale) || scale <= 0)
      throw new RangeError('Minimap scale must be positive.');
    if (this.track === track && this.scale === scale && this.layers) return this.layers;
    const bounds = trackBounds(track);
    const worldWidth = bounds.maxX - bounds.minX;
    const worldHeight = bounds.maxY - bounds.minY;
    if (
      !Number.isFinite(worldWidth) ||
      !Number.isFinite(worldHeight) ||
      worldWidth <= 0 ||
      worldHeight <= 0
    ) {
      throw new RangeError('Minimap geometry needs finite positive bounds.');
    }
    // Supersample normal maps, but bound memory for unusually large imported scenery.
    const rasterScale = Math.min(scale * 2, 2048 / worldWidth, 2048 / worldHeight);
    const createLayer = (scenery: boolean): MinimapLayer => {
      const canvas = this.createCanvas();
      canvas.width = Math.min(2048, Math.max(1, Math.ceil(worldWidth * rasterScale)));
      canvas.height = Math.min(2048, Math.max(1, Math.ceil(worldHeight * rasterScale)));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Unable to create the minimap track cache.');
      ctx.scale(rasterScale, rasterScale);
      ctx.translate(-bounds.minX, -bounds.minY);
      if (scenery) {
        for (const item of track.scenery ?? []) drawScenery(ctx, item);
      } else {
        for (const element of track.elements) {
          if (element.type === 'road_curve') drawRoadCurve(ctx, element, false, 'surface');
          else if (element.type === 'finish') drawFinishMarkings(ctx, track, element);
          else if (['road', 'wall', 'barrier'].includes(element.type)) {
            ctx.save();
            ctx.translate(element.x + element.width / 2, element.y + element.height / 2);
            ctx.rotate(element.rotation);
            ctx.fillStyle = element.type === 'road' ? '#666699' : '#ff4444';
            ctx.fillRect(-element.width / 2, -element.height / 2, element.width, element.height);
            ctx.restore();
          }
        }
      }
      return {
        canvas,
        x: bounds.minX,
        y: bounds.minY,
        width: (canvas.width / rasterScale) * scale,
        height: (canvas.height / rasterScale) * scale,
      };
    };
    this.layers = [createLayer(true), createLayer(false)];
    this.track = track;
    this.scale = scale;
    return this.layers;
  }
}
