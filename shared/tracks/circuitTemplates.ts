import {
  CircuitDesign,
  CircuitNode,
  buildCircuit,
  circuitBezierCurves,
} from '../utils/circuitBuilder';
import { SceneryItem, Track } from '../types/track';
import { PACIFIC_CITY_DESIGN } from './pacificCity';
import { F1_WESTERN_DESIGNS } from './f1WesternCircuits';
import { F1_EASTERN_DESIGNS } from './f1EasternCircuits';

function node(x: number, y: number, heading: number, handle = 350): CircuitNode {
  return { x, y, heading, handle };
}

function scenery(
  prefix: string,
  entries: [string, string, number, number, number, number][]
): SceneryItem[] {
  return entries.map(([type, label, x, y, scale, rotation], i) => ({
    id: `${prefix}-scenery-${i}`,
    type,
    label,
    position: { x, y },
    scale,
    rotation,
  }));
}

function mirrorCircuit(design: CircuitDesign): CircuitDesign {
  return {
    ...design,
    nodes: design.nodes.map(point => ({
      ...point,
      x: design.width - point.x,
      heading: ((720 - point.heading) % 360) - 180,
    })),
    scenery: design.scenery.map(item => ({
      ...item,
      position: { x: design.width - item.position.x, y: item.position.y },
      rotation:
        item.type === 'label' || item.type === 'tree' ? item.rotation : Math.PI - item.rotation,
    })),
  };
}

// Original arcade layouts inspired by each circuit's character, not traced maps.
const DESIGNS: CircuitDesign[] = [
  mirrorCircuit({
    id: 'monza-grand-prix',
    name: 'Monza Grand Prix',
    category: 'Formula 1',
    description: 'Long straights, two chicanes, Lesmo bends and a sweeping Parabolica.',
    width: 9000,
    height: 10400,
    roadWidth: 240,
    difficulty: 'hard',
    nodes: [
      node(7000, 8000, -90),
      node(7000, 5900, -90, 500),
      node(6400, 5350, -145, 260),
      node(6400, 4700, -45, 260),
      node(7000, 4100, -80, 350),
      node(6650, 2800, -130, 550),
      node(5300, 1500, -150, 500),
      node(3900, 1300, 175, 450),
      node(2600, 1850, 130),
      node(2500, 2900, 80),
      node(2900, 3900, 60),
      node(3800, 5350, 60, 450),
      node(4100, 6200, 90, 250),
      node(4650, 6900, 35, 260),
      node(4500, 7750, 120),
      node(4300, 8700, 50),
      node(5600, 9300, 0, 500),
      node(6750, 9100, -45),
      node(7000, 8700, -90),
    ],
    scenery: scenery('monza', [
      ['label', 'MONZA', 5050, 3650, 3, 0],
      ['label', 'TEMPLE OF SPEED', 5050, 3820, 1.4, 0],
      ['label', 'RETTIFILO', 7680, 5200, 1.3, 0],
      ['label', 'CURVA GRANDE', 6500, 1950, 1.3, 0],
      ['label', 'LESMO 1 / 2', 2100, 1200, 1.3, 0],
      ['label', 'ASCARI', 3500, 6650, 1.3, 0],
      ['label', 'PARABOLICA', 5450, 9800, 1.3, 0],
      ['building', 'PIT BUILDING', 7500, 7850, 4, Math.PI / 2],
      ['grandstand', 'MAIN GRANDSTAND', 6500, 7800, 4, Math.PI / 2],
      ['grandstand', 'CURVA GRANDE', 7600, 3550, 3, Math.PI / 2],
      ...Array.from({ length: 28 }, (_, i): [string, string, number, number, number, number] => [
        'tree',
        '',
        4500 + (i % 7) * 160,
        4400 + Math.floor(i / 7) * 180,
        1.4,
        0,
      ]),
    ]),
  }),
  {
    id: 'spa-francorchamps-grand-prix',
    name: 'Spa-Francorchamps Grand Prix',
    category: 'Formula 1',
    description: 'La Source, flowing Eau Rouge esses, the Kemmel Straight and fast forest bends.',
    width: 11000,
    height: 9700,
    roadWidth: 240,
    difficulty: 'hard',
    nodes: [
      node(6500, 2000, -90),
      node(6500, 1200, -90),
      node(7300, 650, 0, 400),
      node(8100, 1200, 90),
      node(8100, 2600, 90, 500),
      node(7650, 3350, 115),
      node(7850, 4300, 45),
      node(8500, 4900, 65),
      node(9500, 7000, 65, 600),
      node(9000, 8100, 155),
      node(7750, 8250, -155, 400),
      node(6700, 7450, -140),
      node(5500, 7900, 170),
      node(3900, 7700, -155, 500),
      node(2500, 6500, -135, 500),
      node(1600, 4800, -100, 550),
      node(2300, 3600, -35, 450),
      node(4000, 2600, -25, 550),
      node(5000, 2150, -10),
      node(5550, 2500, 50, 240),
      node(5850, 3100, 10, 240),
      node(6500, 3100, -65, 300),
      node(6500, 2700, -90, 190),
    ],
    scenery: scenery('spa', [
      ['label', 'SPA-FRANCORCHAMPS', 5200, 4900, 2.5, 0],
      ['label', 'FOREST GRAND PRIX', 5200, 5070, 1.4, 0],
      ['label', 'LA SOURCE', 7300, 180, 1.3, 0],
      ['label', 'EAU ROUGE / RAIDILLON', 9000, 3600, 1.3, 0],
      ['label', 'KEMMEL STRAIGHT', 10050, 6100, 1.3, 0],
      ['label', 'LES COMBES', 9550, 8650, 1.3, 0],
      ['label', 'POUHON', 5250, 8550, 1.3, 0],
      ['label', 'BLANCHIMONT', 2550, 2800, 1.3, 0],
      ['label', 'BUS STOP', 5650, 3550, 1.3, 0],
      ['building', 'PIT BUILDING', 6950, 2300, 4, Math.PI / 2],
      ['grandstand', 'LA SOURCE', 8600, 1150, 3, Math.PI / 2],
      ['grandstand', 'EAU ROUGE', 7150, 3700, 3, Math.PI / 2],
      ...Array.from({ length: 48 }, (_, i): [string, string, number, number, number, number] => [
        'tree',
        '',
        3500 + (i % 8) * 260,
        5600 + Math.floor(i / 8) * 210,
        1.4,
        0,
      ]),
    ]),
  },
  {
    id: 'interlagos-grand-prix',
    name: 'Interlagos Grand Prix',
    category: 'Formula 1',
    description:
      'Counterclockwise racing with the Senna S, a long backstretch and a technical infield.',
    width: 8200,
    height: 7900,
    roadWidth: 220,
    difficulty: 'hard',
    nodes: [
      node(6100, 2200, -135),
      node(4800, 1100, -135, 450),
      node(3900, 900, 180),
      node(3150, 1500, 125, 300),
      node(2450, 1650, 175),
      node(1100, 1650, 180, 450),
      node(600, 2500, 90),
      node(800, 4100, 80, 500),
      node(1800, 5500, 25, 450),
      node(2600, 5700, -30),
      node(3200, 4850, -90),
      node(3000, 3800, -100),
      node(4300, 3100, 0),
      node(5150, 3600, 70),
      node(4950, 4500, 150),
      node(4200, 4800, 150),
      node(3650, 5700, 90),
      node(4100, 6600, 40),
      node(5800, 6900, -10, 500),
      node(7000, 6100, -75, 450),
      node(7100, 4100, -100, 500),
      node(6600, 2700, -135),
    ],
    scenery: scenery('interlagos', [
      ['label', 'INTERLAGOS', 5400, 5350, 2.8, 0],
      ['label', 'SAO PAULO GRAND PRIX', 5400, 5500, 1.3, 0],
      ['label', 'SENNA S', 3500, 500, 1.3, 0],
      ['label', 'RETA OPOSTA', 1400, 3100, 1.3, 0],
      ['label', 'FERRADURA', 2650, 4800, 1.3, 0],
      ['label', 'BICO DE PATO', 5550, 4100, 1.3, 0],
      ['label', 'JUNCAO', 3300, 6750, 1.3, 0],
      ['building', 'PIT BUILDING', 6100, 1450, 4, Math.PI / 4],
      ['grandstand', 'SENNA GRANDSTAND', 5200, 2500, 4, Math.PI / 4],
      ['grandstand', 'JUNCAO', 5700, 7450, 4, 0],
      ...Array.from({ length: 24 }, (_, i): [string, string, number, number, number, number] => [
        'tree',
        '',
        1650 + (i % 6) * 190,
        3450 + Math.floor(i / 6) * 210,
        1.3,
        0,
      ]),
    ]),
  },
  {
    id: 'daytona-tri-oval',
    name: 'Daytona Tri-Oval',
    category: 'NASCAR',
    description:
      'A wide, sweeping tri-oval with a bowed frontstretch and a long straight backstretch.',
    width: 10500,
    height: 7100,
    roadWidth: 360,
    difficulty: 'medium',
    nodes: [
      node(5250, 5900, 0, 750),
      node(7000, 5550, -15, 750),
      node(8700, 5000, -25, 650),
      node(9750, 3600, -90, 850),
      node(8700, 1800, 180, 850),
      node(1900, 1800, 180, 850),
      node(750, 3600, 90, 850),
      node(1800, 5000, 25, 650),
      node(3500, 5550, 15, 750),
    ],
    scenery: scenery('daytona', [
      ['label', 'DAYTONA', 5250, 3450, 3.5, 0],
      ['label', 'TRI-OVAL SPEEDWAY', 5250, 3640, 1.5, 0],
      ['building', 'PIT ROAD', 5300, 5300, 6, 0],
      ['grandstand', 'FRONTSTRETCH', 5250, 6520, 8, 0],
      ['grandstand', 'TURN 1', 10000, 4800, 4, -1],
      ['grandstand', 'TURN 4', 600, 4800, 4, 1],
      ['label', 'BACKSTRETCH', 5250, 1300, 1.3, 0],
    ]),
  },
  {
    id: 'talladega-superspeedway',
    name: 'Talladega Superspeedway',
    category: 'NASCAR',
    description:
      'The largest speedway: an asymmetric tri-oval with extra-wide lanes and huge straights.',
    width: 12500,
    height: 7500,
    roadWidth: 420,
    difficulty: 'easy',
    nodes: [
      node(6200, 6100, 0, 850),
      node(8500, 6050, -10, 850),
      node(10200, 5300, -30, 850),
      node(11500, 3700, -90, 950),
      node(10300, 1550, 180, 1000),
      node(2300, 1550, 180, 1000),
      node(1050, 3400, 90, 950),
      node(2150, 5400, 35, 850),
      node(4000, 6050, 10, 850),
    ],
    scenery: scenery('talladega', [
      ['label', 'TALLADEGA', 6200, 3350, 3.5, 0],
      ['label', 'SUPER SPEEDWAY', 6200, 3560, 1.5, 0],
      ['building', 'PIT ROAD', 6200, 5420, 6, 0],
      ['grandstand', 'FRONTSTRETCH', 6200, 6790, 9, 0],
      ['grandstand', 'TURN 1', 11900, 4600, 4, -1],
      ['grandstand', 'TURN 4', 700, 4600, 4, 1],
      ['label', 'BACKSTRETCH', 6200, 970, 1.3, 0],
    ]),
  },
  {
    id: 'bristol-short-oval',
    name: 'Bristol Short Oval',
    category: 'NASCAR',
    description: 'A compact stadium oval for close racing, with tighter turns and shorter laps.',
    width: 4400,
    height: 3500,
    roadWidth: 300,
    difficulty: 'medium',
    nodes: [
      node(2200, 2650, 0, 800),
      node(3650, 1750, -90, 500),
      node(2200, 850, 180, 800),
      node(750, 1750, 90, 500),
    ],
    scenery: scenery('bristol', [
      ['label', 'BRISTOL', 2200, 1650, 2.8, 0],
      ['label', 'SHORT OVAL', 2200, 1810, 1.2, 0],
      ['building', 'PIT ROAD', 2200, 2230, 3, 0],
      ['grandstand', 'FRONTSTRETCH', 2200, 3080, 6, 0],
      ['grandstand', 'BACKSTRETCH', 2200, 420, 6, 0],
      ['grandstand', 'TURN 1 / 2', 4100, 1750, 4, Math.PI / 2],
      ['grandstand', 'TURN 3 / 4', 300, 1750, 4, Math.PI / 2],
    ]),
  },
  ...F1_WESTERN_DESIGNS,
  ...F1_EASTERN_DESIGNS,
  PACIFIC_CITY_DESIGN,
];

export const CIRCUIT_TEMPLATES = DESIGNS.map(design => ({
  id: design.id,
  name: design.name,
  category: design.category,
  description: design.description,
  width: design.width,
  height: design.height,
  roadWidth: design.roadWidth,
  difficulty: design.difficulty,
}));

function findCircuit(id: string): CircuitDesign {
  const design = DESIGNS.find(design => design.id === id);
  if (!design) throw new Error(`Unknown circuit template: ${id}`);
  return design;
}

export function getCircuitPreview(id: string) {
  return circuitBezierCurves(findCircuit(id));
}

export function createCircuitTrack(id: string, roadWidth?: number): Track {
  return buildCircuit(findCircuit(id), roadWidth);
}
