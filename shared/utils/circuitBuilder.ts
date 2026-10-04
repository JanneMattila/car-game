import { RoadBezier, SceneryItem, Track, TrackElement } from '../types/track';
import { Vector2 } from '../types/physics';
import {
  bezierPoint,
  bezierTangent,
  createBezierRoad,
  getRoadBezier,
  sampleRoadCurve,
} from './roadGeometry';
import { validateTrack } from './validation';

export interface CircuitNode extends Vector2 {
  heading: number;
  handle: number;
}

export interface CircuitDesign {
  id: string;
  name: string;
  category: 'Formula 1' | 'NASCAR' | 'Urban';
  description: string;
  width: number;
  height: number;
  roadWidth: number;
  difficulty: Track['difficulty'];
  nodes: CircuitNode[];
  scenery: SceneryItem[];
}

export function circuitRectangle(
  id: string,
  type: TrackElement['type'],
  center: Vector2,
  width: number,
  height: number,
  rotation: number
): TrackElement {
  const x = center.x - width / 2;
  const y = center.y - height / 2;
  return {
    id, type, x, y, position: { x, y }, width, height, rotation, layer: 0,
    ...(type === 'finish' ? {
      properties: { finishVisibleWidth: width, finishVisibleOffset: 0 },
    } : {}),
  };
}

export function circuitBoundary(
  prefix: string,
  points: Vector2[],
  side: number,
  roadWidth: number
): TrackElement[] {
  const offset = roadWidth / 2 + 90;
  const edge = points.map((p, i) => {
    const before = points[(i + points.length - 1) % points.length]!;
    const after = points[(i + 1) % points.length]!;
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) throw new Error('Circuit boundary has a zero-length tangent.');
    return { x: p.x - (dy / length) * offset * side, y: p.y + (dx / length) * offset * side };
  });
  return edge.map((p, i) => {
    const next = edge[(i + 1) % edge.length]!;
    const dx = next.x - p.x;
    const dy = next.y - p.y;
    return circuitRectangle(
      `${prefix}-wall-${side}-${i}`,
      'wall',
      { x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 },
      Math.hypot(dx, dy) + 3,
      14,
      Math.atan2(dy, dx)
    );
  });
}

function circuitSegment(nodes: CircuitNode[], index: number): RoadBezier {
  const start = nodes[index]!;
  const end = nodes[(index + 1) % nodes.length]!;
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  const h1 = Math.min(start.handle, length * 0.48);
  const h2 = Math.min(end.handle, length * 0.48);
  const a1 = (start.heading * Math.PI) / 180;
  const a2 = (end.heading * Math.PI) / 180;
  return {
    start: { x: start.x, y: start.y },
    control1: { x: start.x + Math.cos(a1) * h1, y: start.y + Math.sin(a1) * h1 },
    control2: { x: end.x - Math.cos(a2) * h2, y: end.y - Math.sin(a2) * h2 },
    end: { x: end.x, y: end.y },
  };
}

export function circuitRoadWidthRange(category: CircuitDesign['category']) {
  if (category === 'Urban') return { minimum: 220, maximum: 360 };
  return category === 'Formula 1' ? { minimum: 180, maximum: 280 } : { minimum: 260, maximum: 440 };
}

export function circuitBezierCurves(design: CircuitDesign): RoadBezier[] {
  return design.nodes.map((_, i) => circuitSegment(design.nodes, i));
}

export function buildCircuit(design: CircuitDesign, roadWidth = design.roadWidth): Track {
  const { minimum, maximum } = circuitRoadWidthRange(design.category);
  if (!Number.isFinite(roadWidth) || roadWidth < minimum || roadWidth > maximum) {
    throw new RangeError(`Road width must be between ${minimum} and ${maximum}.`);
  }
  const roads = circuitBezierCurves(design).map((curve, i) =>
    createBezierRoad(`${design.id}-road-${i}`, curve, roadWidth, 0, design.category === 'Formula 1')
  );
  const points = roads.flatMap(road =>
    sampleRoadCurve(road).filter((_, i, samples) => i % 4 === 0 && i < samples.length - 1)
  );
  const checkpoints = roads.slice(0, -1).map((road, i) => {
    const curve = getRoadBezier(road)!;
    const tangent = bezierTangent(curve, 0.65);
    return {
      ...circuitRectangle(
        `${design.id}-checkpoint-${i}`,
        'checkpoint',
        bezierPoint(curve, 0.65),
        roadWidth + 40,
        80,
        Math.atan2(tangent.y, tangent.x) + Math.PI / 2
      ),
      checkpointIndex: i,
    };
  });
  const start = design.nodes[0]!;
  const heading = (start.heading * Math.PI) / 180;
  const forward = { x: Math.cos(heading), y: Math.sin(heading) };
  const grid = Array.from({ length: 8 }, (_, i) => {
    const back = 140 + Math.floor(i / 2) * 100 + (i % 2) * 35;
    const lateral = (i % 2 === 0 ? -1 : 1) * roadWidth * 0.22;
    return circuitRectangle(
      `${design.id}-grid-${i}`,
      'spawn',
      {
        x: start.x - forward.x * back - forward.y * lateral,
        y: start.y - forward.y * back + forward.x * lateral,
      },
      30,
      50,
      heading + Math.PI / 2
    );
  });
  const timestamp = Date.parse('2026-10-03T11:30:00Z');
  const track: Track = {
    id: design.id,
    version: 1,
    name: design.name,
    author: 'Car Game',
    createdAt: timestamp,
    updatedAt: timestamp,
    difficulty: design.difficulty,
    defaultLapCount: design.category === 'NASCAR' ? 10 : 3,
    width: design.width,
    height: design.height,
    backgroundColor: '#426b45',
    wrapAround: false,
    elements: [
      ...roads,
      ...circuitBoundary(design.id, points, -1, roadWidth),
      ...circuitBoundary(design.id, points, 1, roadWidth),
      ...checkpoints,
      circuitRectangle(
        `${design.id}-finish`,
        'finish',
        start,
        roadWidth,
        40,
        heading + Math.PI / 2
      ),
      ...grid,
    ],
    scenery: design.scenery.map(item => ({ ...item, position: { ...item.position } })),
  };
  const validation = validateTrack(track);
  if (!validation.isValid) throw new Error(validation.errors.map(e => e.message).join('\n'));
  return track;
}
