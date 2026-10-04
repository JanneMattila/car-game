import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  Track,
  TrackElement,
  RoadBezier,
  Vector2,
  createBezierRoad,
  getRoadBezier,
  sampleRoadCurve,
  bezierPoint,
  bezierTangent,
  validateTrack,
  circuitRectangle as rectangle,
  circuitBoundary,
} from '../shared/index';

interface CircuitNode {
  x: number;
  y: number;
  heading: number;
  handle: number;
  name: string;
}

// An original, arcade-scaled interpretation, not a survey or a map tracing.
const NODES: CircuitNode[] = [
  { x: 4000, y: 5000, heading: -90, handle: 240, name: 'Hamilton Straight' },
  { x: 4000, y: 4100, heading: -90, handle: 300, name: 'Abbey entry' },
  { x: 4550, y: 3500, heading: -20, handle: 330, name: 'Abbey' },
  { x: 5100, y: 3000, heading: -65, handle: 250, name: 'Farm' },
  { x: 5500, y: 2500, heading: -15, handle: 210, name: 'Village' },
  { x: 5750, y: 2050, heading: -110, handle: 250, name: 'The Loop' },
  { x: 5000, y: 1800, heading: 170, handle: 350, name: 'Loop exit' },
  { x: 4200, y: 2500, heading: 140, handle: 350, name: 'Aintree' },
  { x: 2300, y: 4100, heading: 140, handle: 420, name: 'Wellington Straight' },
  { x: 1750, y: 4650, heading: 110, handle: 220, name: 'Brooklands' },
  { x: 1050, y: 4750, heading: -130, handle: 280, name: 'Luffield' },
  { x: 850, y: 3850, heading: -80, handle: 360, name: 'Woodcote' },
  { x: 1050, y: 2200, heading: -85, handle: 420, name: 'National Straight' },
  { x: 1650, y: 1100, heading: -20, handle: 420, name: 'Copse' },
  { x: 2900, y: 750, heading: -10, handle: 300, name: 'Copse exit' },
  { x: 3700, y: 750, heading: 20, handle: 260, name: 'Maggotts' },
  { x: 4300, y: 1100, heading: 10, handle: 210, name: 'Becketts left' },
  { x: 4900, y: 850, heading: 5, handle: 240, name: 'Becketts right' },
  { x: 5500, y: 1250, heading: 25, handle: 240, name: 'Chapel' },
  { x: 6050, y: 1400, heading: 55, handle: 300, name: 'Hangar entry' },
  { x: 6850, y: 3100, heading: 65, handle: 420, name: 'Hangar Straight' },
  { x: 6800, y: 4200, heading: 125, handle: 350, name: 'Stowe' },
  { x: 5800, y: 5150, heading: 140, handle: 350, name: 'Stowe exit' },
  { x: 5250, y: 5550, heading: 145, handle: 210, name: 'Vale left' },
  { x: 4850, y: 5900, heading: 175, handle: 200, name: 'Vale right' },
  { x: 4250, y: 5850, heading: -140, handle: 220, name: 'Club' },
  { x: 4000, y: 5550, heading: -90, handle: 200, name: 'Club exit' },
];

const ROAD_WIDTH = 240;
const timestamp = Date.parse('2026-10-03T08:00:00Z');
const direction = (heading: number): Vector2 => ({
  x: Math.cos((heading * Math.PI) / 180),
  y: Math.sin((heading * Math.PI) / 180),
});

function segment(index: number): RoadBezier {
  const start = NODES[index]!;
  const end = NODES[(index + 1) % NODES.length]!;
  const d1 = direction(start.heading);
  const d2 = direction(end.heading);
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  const h1 = Math.min(start.handle, length * 0.48);
  const h2 = Math.min(end.handle, length * 0.48);
  return {
    start: { x: start.x, y: start.y },
    control1: { x: start.x + d1.x * h1, y: start.y + d1.y * h1 },
    control2: { x: end.x - d2.x * h2, y: end.y - d2.y * h2 },
    end: { x: end.x, y: end.y },
  };
}

function boundary(points: Vector2[], side: number): TrackElement[] {
  return circuitBoundary('silverstone', points, side, ROAD_WIDTH);
}

export function createSilverstoneTrack(): Track {
  const roads = NODES.map((_, i) =>
    createBezierRoad(`silverstone-road-${i}`, segment(i), ROAD_WIDTH, 0, true)
  );
  const pathPoints = roads.flatMap(road => {
    const samples = sampleRoadCurve(road);
    return samples.filter((_, i) => i % 4 === 0 && i < samples.length - 1);
  });
  const checkpoints = roads.slice(0, -1).map((road, i) => {
    const curve = getRoadBezier(road)!;
    const point = bezierPoint(curve, 0.65);
    const tangent = bezierTangent(curve, 0.65);
    return {
      ...rectangle(
        `silverstone-checkpoint-${i}`,
        'checkpoint',
        point,
        ROAD_WIDTH + 40,
        80,
        Math.atan2(tangent.y, tangent.x) + Math.PI / 2
      ),
      checkpointIndex: i,
    };
  });
  const spawns = Array.from({ length: 8 }, (_, i) =>
    rectangle(
      `silverstone-grid-${i + 1}`,
      'spawn',
      {
        x: 4000 + (i % 2 === 0 ? -60 : 60),
        y: 5140 + Math.floor(i / 2) * 100 + (i % 2) * 35,
      },
      30,
      50,
      0
    )
  );
  const track: Track = {
    id: 'silverstone-grand-prix',
    version: 1,
    name: 'Silverstone Grand Prix',
    author: 'Car Game',
    createdAt: timestamp,
    updatedAt: timestamp,
    difficulty: 'hard',
    defaultLapCount: 3,
    width: 7600,
    height: 6500,
    backgroundColor: '#426b45',
    wrapAround: false,
    elements: [
      ...roads,
      ...boundary(pathPoints, -1),
      ...boundary(pathPoints, 1),
      ...checkpoints,
      rectangle('silverstone-finish', 'finish', { x: 4000, y: 5000 }, ROAD_WIDTH, 40, 0),
      ...spawns,
    ],
    scenery: [
      {
        id: 'silverstone-title',
        type: 'label',
        position: { x: 2800, y: 2150 },
        rotation: 0,
        scale: 3,
        label: 'SILVERSTONE',
      },
      {
        id: 'silverstone-subtitle',
        type: 'label',
        position: { x: 2800, y: 2280 },
        rotation: 0,
        scale: 1.5,
        label: 'GRAND PRIX CIRCUIT',
      },
      {
        id: 'silverstone-wing',
        type: 'building',
        position: { x: 4550, y: 5050 },
        rotation: Math.PI / 2,
        scale: 4.5,
        label: 'THE WING / PIT BUILDING',
      },
      {
        id: 'silverstone-hamilton-stand',
        type: 'grandstand',
        position: { x: 3560, y: 5050 },
        rotation: Math.PI / 2,
        scale: 4,
        label: 'HAMILTON',
      },
      {
        id: 'silverstone-copse-stand',
        type: 'grandstand',
        position: { x: 1190, y: 580 },
        rotation: -0.35,
        scale: 3,
        label: 'COPSE',
      },
      {
        id: 'silverstone-becketts-stand',
        type: 'grandstand',
        position: { x: 4650, y: 410 },
        rotation: 0.15,
        scale: 3,
        label: 'BECKETTS',
      },
      {
        id: 'silverstone-stowe-stand',
        type: 'grandstand',
        position: { x: 7190, y: 4250 },
        rotation: -0.9,
        scale: 2.5,
        label: 'STOWE',
      },
      {
        id: 'silverstone-luffield-stand',
        type: 'grandstand',
        position: { x: 970, y: 5190 },
        rotation: 0.2,
        scale: 3,
        label: 'LUFFIELD',
      },
      ...[
        ['ABBEY / FARM', 4680, 3860],
        ['VILLAGE / THE LOOP', 5350, 2300],
        ['WELLINGTON STRAIGHT', 2950, 3950],
        ['BROOKLANDS', 2140, 4900],
        ['MAGGOTTS / BECKETTS', 4020, 450],
        ['HANGAR STRAIGHT', 6000, 3350],
        ['VALE / CLUB', 4840, 6260],
      ].map(([label, x, y], i) => ({
        id: `silverstone-corner-label-${i}`,
        type: 'label',
        position: { x: Number(x), y: Number(y) },
        rotation: 0,
        scale: 1.3,
        label: String(label),
      })),
      ...Array.from({ length: 48 }, (_, i) => ({
        id: `silverstone-tree-${i}`,
        type: 'tree',
        position:
          i < 24
            ? { x: 1750 + (i % 6) * 150, y: 2900 + Math.floor(i / 6) * 140 }
            : { x: 5600 + (i % 6) * 140, y: 3800 + Math.floor((i - 24) / 6) * 140 },
        rotation: 0,
        scale: 1.1 + (i % 3) * 0.15,
      })),
    ],
  };
  const validation = validateTrack(track);
  if (!validation.isValid)
    throw new Error(validation.errors.map(error => error.message).join('\n'));
  return track;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const track = createSilverstoneTrack();
  const target = fileURLToPath(
    new URL('../data/tracks/silverstone-grand-prix.json', import.meta.url)
  );
  await writeFile(target, `${JSON.stringify(track, null, 2)}\n`);
  console.log(
    `Created ${track.name}: ${track.width} x ${track.height}, ${track.elements.length} elements.`
  );
}
