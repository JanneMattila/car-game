import { CircuitDesign, buildCircuit } from '../utils/circuitBuilder';
import { distanceToSegment, sampleRoadCurve } from '../utils/roadGeometry';
import { SceneryItem } from '../types/track';
import { Vector2 } from '../types/physics';

const design: CircuitDesign = {
  id: 'pacific-city-circuit',
  name: 'Pacific City Street Circuit',
  category: 'Urban',
  description:
    'An original coastal metropolis: downtown boulevards, hillside esses, beach, canals and working harbor.',
  width: 13000,
  height: 10500,
  roadWidth: 280,
  difficulty: 'hard',
  nodes: [
    [6200, 8800, 0, 700],
    [8700, 8800, 0, 800],
    [10500, 8600, -20, 600],
    [11600, 7400, -90, 750],
    [11400, 6000, 180, 600],
    [9300, 6000, 180, 750],
    [8100, 5500, -90, 480],
    [8100, 4100, -90, 600],
    [9900, 3500, 0, 600],
    [11100, 2800, -90, 550],
    [10000, 1600, 180, 650],
    [8000, 1600, 180, 700],
    [6500, 2300, 135, 700],
    [5900, 3500, 90, 500],
    [5100, 4400, 180, 500],
    [3700, 3600, -90, 500],
    [3500, 2300, -130, 500],
    [2300, 2100, 180, 450],
    [1700, 3100, 90, 550],
    [2000, 4600, 70, 550],
    [2400, 5900, 90, 500],
    [2200, 7200, 90, 500],
    [3100, 8100, 0, 600],
    [4200, 8800, 0, 800],
  ].map(([x, y, heading, handle]) => ({ x: x!, y: y!, heading: heading!, handle: handle! })),
  scenery: [],
};

function cityScenery(): SceneryItem[] {
  const course = buildCircuit(design)
    .elements.filter(el => el.type === 'road_curve')
    .flatMap(road => sampleRoadCurve(road).filter((_, i) => i % 4 === 0));
  const clear = (point: Vector2, radius: number) =>
    course.every(
      (a, i) => distanceToSegment(point, a, course[(i + 1) % course.length]!) > 305 + radius
    );
  const items: SceneryItem[] = [];
  const area = (
    type: string,
    x: number,
    y: number,
    width: number,
    height: number,
    color?: string
  ) => {
    items.push({
      id: `pacific-scenery-${items.length}`,
      type,
      position: { x, y },
      width,
      height,
      ...(color === undefined ? {} : { color }),
      rotation: 0,
      scale: 1,
    });
  };
  const label = (text: string, x: number, y: number, scale = 2) => {
    items.push({
      id: `pacific-label-${items.length}`,
      type: 'label',
      label: text,
      position: { x, y },
      rotation: 0,
      scale,
    });
  };
  area('water', 600, 5250, 1200, 10500, '#256f8b');
  area('water', 6500, 10100, 13000, 800, '#256f8b');
  area('sand', 1450, 4700, 500, 7600);
  area('park', 6500, 1150, 8500, 1300);
  area('park', 4700, 3350, 1450, 1250);
  area('water', 11100, 9800, 3600, 1000);
  for (let x = 3850; x <= 11000; x += 650) area('area', x, 5350, 110, 5100, '#899296');
  for (let y = 3100; y <= 7700; y += 650) area('area', 7600, y, 7700, 110, '#899296');
  area('area', 5050, 6650, 1950, 2100, '#707b7c');
  area('runway', 5000, 6700, 480, 1850);
  area('building', 5650, 6700, 360, 1200, '#bdc8ce');
  area('water', 3800, 7300, 1400, 90, '#459aac');
  area('water', 3450, 6900, 90, 800, '#459aac');
  area('water', 4150, 6900, 90, 800, '#459aac');
  area('water', 3800, 7750, 700, 200, '#459aac');
  for (let x = 3400; x <= 4200; x += 200) area('area', x, 7420, 60, 150, '#b49b74');
  for (let x = 9600; x <= 12300; x += 450) area('area', x, 9460, 100, 700, '#a0a89f');

  const roofs = ['#a5b6bf', '#b9ad96', '#879fac', '#a6b8a0'];
  for (let x = 4150; x <= 10800; x += 650) {
    for (let y = 3300; y <= 7600; y += 650) {
      for (const dx of [-150, 150]) {
        for (const dy of [-150, 150]) {
          const point = { x: x + dx, y: y + dy };
          if (point.x < 6150 && point.y > 5400) continue;
          if (clear(point, 160)) {
            area('building', point.x, point.y, 240, 200, roofs[items.length % roofs.length]);
          }
        }
      }
    }
  }
  for (let x = 9400; x <= 10800; x += 350) {
    for (let y = 6650; y <= 8050; y += 300) {
      if (clear({ x, y }, 140)) {
        area('building', x, y, 260, 95, ['#a66d54', '#c0a85e', '#628b94'][items.length % 3]);
      }
    }
  }
  for (let x = 2500; x <= 10500; x += 450) {
    for (let y = 950; y <= 2350; y += 450) {
      if (clear({ x, y }, 75)) {
        items.push({
          id: `pacific-tree-${items.length}`,
          type: 'tree',
          position: { x, y },
          rotation: 0,
          scale: 1.8,
        });
      }
    }
  }
  for (let y = 3200; y <= 7400; y += 350) {
    const point = { x: 1390, y };
    if (clear(point, 35)) {
      items.push({
        id: `pacific-beach-tree-${items.length}`,
        type: 'tree',
        position: point,
        rotation: 0,
        scale: 1,
      });
    }
  }
  label('PACIFIC CITY', 7100, 7450, 3.5);
  label('DOWNTOWN', 6950, 5200, 2.2);
  label('CIVIC AVENUE', 8700, 4500, 1.2);
  label('SUNSET HILLS', 8150, 1050);
  label('BOARDWALK BEACH', 1450, 4300, 1.3);
  label('MARINA CANALS', 3600, 6250, 1.3);
  label('COAST AIRPORT', 5100, 8000, 1.5);
  label('PORT AZURE', 10300, 7200, 1.8);
  label('START / FINISH', 6400, 9390, 1.3);
  label('HARBOR EXPRESSWAY', 7950, 9240, 1.3);
  return items;
}

export const PACIFIC_CITY_DESIGN: CircuitDesign = { ...design, scenery: cityScenery() };
