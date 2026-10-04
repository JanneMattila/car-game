import { SceneryItem } from '../types/track';

export type SceneryShape =
  | { kind: 'rect'; x: number; y: number; width: number; height: number; color: string }
  | { kind: 'circle'; x: number; y: number; radius: number; color: string }
  | { kind: 'ellipse'; x: number; y: number; radiusX: number; radiusY: number; color: string }
  | {
      kind: 'line';
      x: number;
      y: number;
      endX: number;
      endY: number;
      width: number;
      color: string;
    };

/** Canvas and Pixi draw the same original vector scenery, without image assets. */
export function sceneryShapes(item: SceneryItem): SceneryShape[] {
  if (item.type === 'tree') {
    return [
      { kind: 'circle', x: 4, y: 6, radius: 28, color: '#203f2b' },
      { kind: 'circle', x: 0, y: 0, radius: 24, color: '#357343' },
      { kind: 'circle', x: -6, y: -6, radius: 13, color: '#489655' },
    ];
  }
  const building = item.type === 'building' || item.type === 'grandstand';
  const colors: Record<string, string> = {
    building: '#bac7ce',
    grandstand: '#7695ac',
    area: '#879480',
    water: '#287d99',
    sand: '#d8c596',
    park: '#628d57',
    runway: '#343d46',
  };
  const defaultColor = colors[item.type];
  if (!defaultColor) return [];
  const color = item.color ?? defaultColor;
  const width = item.width ?? 200;
  const height = item.height ?? (building ? 60 : 200);
  const shapes: SceneryShape[] = [
    {
      kind: 'rect',
      x: -width / 2,
      y: -height / 2,
      width,
      height,
      color: building ? '#263746' : color,
    },
  ];
  if (building) {
    shapes.push({
      kind: 'rect',
      x: -width / 2 + 4,
      y: -height / 2 + 4,
      width: width - 8,
      height: height - 12,
      color,
    });
    for (let y = -height / 2 + 12; y < height / 2 - 6; y += Math.max(9, height / 10)) {
      shapes.push({
        kind: 'line',
        x: -width / 2 + 6,
        y,
        endX: width / 2 - 6,
        endY: y,
        width: 3,
        color: '#3d566a',
      });
    }
  } else if (item.type === 'park') {
    shapes.push({
      kind: 'ellipse',
      x: 0,
      y: 0,
      radiusX: width * 0.42,
      radiusY: height * 0.42,
      color: '#73985e',
    });
  } else if (item.type === 'runway') {
    for (let y = -height / 2 + 100; y < height / 2 - 100; y += 140) {
      shapes.push({
        kind: 'line',
        x: 0,
        y,
        endX: 0,
        endY: y + 70,
        width: 8,
        color: '#ebeee6',
      });
    }
  }
  return shapes;
}
