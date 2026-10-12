import {
  PHYSICS_CONSTANTS,
  RoadSurfaceIndex,
  Track,
  TrackElement,
  Vector2,
  effectiveRaceGate,
  normalizeAngle,
  unwrapForTrack,
} from '@shared';

/** Closed driving line through every race gate in order, shared by all AI drivers on a track. */
export interface RacingLine {
  points: Vector2[];
  /** Checkpoint progress (car.checkpoint) a car has while driving at each point. */
  expected: number[];
  /** Distance driven since the last gate centre, used to detect missed gates. */
  sinceGate: number[];
  /** Index shortly before each gate centre; the finish is the last gate. */
  gateEntry: number[];
  /** Index of the next gate centre point at or after each point. */
  nextGate: number[];
  /** Gate centres and crossing directions in race order; the finish is last. */
  gates: { center: Vector2; forward: Vector2 }[];
  /** Highest safe speed (px/frame) at each point, including braking for upcoming corners. */
  speed: number[];
  spacing: number;
  gateCount: number;
  wrapAround: boolean;
  trackWidth: number;
  trackHeight: number;
  /** Approximate distance from a point to the nearest wall or barrier. */
  wallDistance(point: Vector2): number;
  isAsphalt(point: Vector2): boolean;
}

const SPACING = 16;
const GATE_APPROACH = 60;
const GATE_SIDE_POINTS = 6;
// Minimum crossing angle of roughly 17 degrees through each gate.
const GATE_SIDE_SLOPE = 0.3;
const GATE_ENTRY_POINTS = 10;
const PASSABLE_CLEARANCE = PHYSICS_CONSTANTS.CAR_WIDTH / 2 + 7;
const LINE_CLEARANCE = 42;
const PREFERRED_CLEARANCE = 90;
const OFFROAD_COST = 4;
const UNREACHABLE = 1e9;
// Heading change per frame at full steering lock between 3 and 15 px/frame. PhysicsEngine sets
// MAX_STEERING_ANGLE * 0.18, but Matter's integration and air friction leave about two thirds of
// that (measured by holding full lock at constant speed).
const TURN_RATE = PHYSICS_CONSTANTS.MAX_STEERING_ANGLE * 0.18 * 0.66;
const FULL_TURN_SPEED = 15;

const forwardOf = (rotation: number): Vector2 => ({
  x: Math.sin(rotation),
  y: -Math.cos(rotation),
});

class NavGrid {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly clearance: Float32Array;
  readonly cost: Float32Array;
  readonly asphalt: Uint8Array;
  /** Gate lines A* may not cross, so routes never pass a gate backwards or out of order. */
  readonly gateLines: Uint8Array;
  private readonly wrap: boolean;

  constructor(private track: Track) {
    this.wrap = !!track.wrapAround;
    this.cellSize = Math.max(16, Math.ceil(Math.sqrt((track.width * track.height) / 250000)));
    this.cols = Math.ceil(track.width / this.cellSize);
    this.rows = Math.ceil(track.height / this.cellSize);
    const size = this.cols * this.rows;
    this.gateLines = new Uint8Array(size);
    this.clearance = new Float32Array(size);
    this.cost = new Float32Array(size);
    this.asphalt = new Uint8Array(size);
  }

  /** Grid layers need many geometry tests, so they are computed in slices. */
  async build(gates: TrackElement[], surface: RoadSurfaceIndex): Promise<void> {
    const reach = this.cellSize * 0.75;
    const blocked = new Uint8Array(this.cols * this.rows);
    const walls = this.track.elements.filter(
      wall => (wall.type === 'wall' || wall.type === 'barrier') && (wall.layer ?? 0) === 0
    );
    for (let i = 0; i < walls.length; i++) {
      if (i % 400 === 0) await yieldToEventLoop();
      this.rasterize(blocked, walls[i]!, reach);
    }
    for (const gate of gates) {
      this.rasterize(this.gateLines, { ...gate, height: 0, y: gate.y + gate.height / 2 }, reach);
    }
    await this.computeDistanceField(blocked);
    for (let cell = 0; cell < this.cost.length; cell++) {
      if (cell % 20000 === 0) await yieldToEventLoop();
      const onRoad = surface.isAsphalt(this.center(cell));
      this.asphalt[cell] = onRoad ? 1 : 0;
      const distance = this.clearance[cell]! - this.cellSize / 2;
      if (distance < PASSABLE_CLEARANCE) {
        this.cost[cell] = Infinity;
        continue;
      }
      const wallPenalty = Math.max(0, PREFERRED_CLEARANCE - distance) / PREFERRED_CLEARANCE;
      this.cost[cell] = (onRoad ? 1 : OFFROAD_COST) + wallPenalty * 3;
    }
  }

  isAsphalt(point: Vector2): boolean {
    const cell = this.cellAt(point);
    return cell !== null && this.asphalt[cell] === 1;
  }

  center(cell: number): Vector2 {
    return {
      x: ((cell % this.cols) + 0.5) * this.cellSize,
      y: (Math.floor(cell / this.cols) + 0.5) * this.cellSize,
    };
  }

  cellAt(point: Vector2): number | null {
    let col = Math.floor(point.x / this.cellSize);
    let row = Math.floor(point.y / this.cellSize);
    if (this.wrap) {
      col = ((col % this.cols) + this.cols) % this.cols;
      row = ((row % this.rows) + this.rows) % this.rows;
    } else if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) {
      return null;
    }
    return row * this.cols + col;
  }

  private neighbor(col: number, row: number): number {
    if (this.wrap) {
      col = ((col % this.cols) + this.cols) % this.cols;
      row = ((row % this.rows) + this.rows) % this.rows;
    } else if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) {
      return -1;
    }
    return row * this.cols + col;
  }

  private rasterize(mask: Uint8Array, element: TrackElement, reach: number): void {
    const cx = element.x + element.width / 2;
    const cy = element.y + element.height / 2;
    const cosine = Math.cos(element.rotation || 0);
    const sine = Math.sin(element.rotation || 0);
    const halfW = element.width / 2;
    const halfH = element.height / 2;
    const extentX = Math.abs(halfW * cosine) + Math.abs(halfH * sine) + reach;
    const extentY = Math.abs(halfW * sine) + Math.abs(halfH * cosine) + reach;
    const minCol = Math.floor((cx - extentX) / this.cellSize);
    const maxCol = Math.floor((cx + extentX) / this.cellSize);
    const minRow = Math.floor((cy - extentY) / this.cellSize);
    const maxRow = Math.floor((cy + extentY) / this.cellSize);
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const cell = this.neighbor(col, row);
        if (cell < 0) continue;
        const dx = (col + 0.5) * this.cellSize - cx;
        const dy = (row + 0.5) * this.cellSize - cy;
        const localX = Math.abs(dx * cosine + dy * sine) - halfW;
        const localY = Math.abs(-dx * sine + dy * cosine) - halfH;
        if (Math.hypot(Math.max(0, localX), Math.max(0, localY)) <= reach) mask[cell] = 1;
      }
    }
  }

  /** Chamfer distance (px) from each cell centre to the nearest blocked cell centre. */
  private async computeDistanceField(blocked: Uint8Array): Promise<void> {
    const field = this.clearance;
    for (let cell = 0; cell < field.length; cell++) field[cell] = blocked[cell] ? 0 : UNREACHABLE;
    const straight = this.cellSize;
    const diagonal = this.cellSize * Math.SQRT2;
    const forwardMask: [number, number, number][] = [
      [-1, -1, diagonal],
      [0, -1, straight],
      [1, -1, diagonal],
      [-1, 0, straight],
    ];
    const backwardMask: [number, number, number][] = [
      [1, 1, diagonal],
      [0, 1, straight],
      [-1, 1, diagonal],
      [1, 0, straight],
    ];
    const relax = (col: number, row: number, mask: [number, number, number][]) => {
      const cell = row * this.cols + col;
      for (const [dx, dy, step] of mask) {
        const other = this.neighbor(col + dx, row + dy);
        if (other >= 0 && field[other]! + step < field[cell]!) field[cell] = field[other]! + step;
      }
    };
    // Repeating terrain needs a second sweep so distances propagate across tile seams.
    for (let sweep = 0; sweep < (this.wrap ? 2 : 1); sweep++) {
      for (let row = 0; row < this.rows; row++) {
        if (row % 100 === 0) await yieldToEventLoop();
        for (let col = 0; col < this.cols; col++) relax(col, row, forwardMask);
      }
      for (let row = this.rows - 1; row >= 0; row--) {
        if (row % 100 === 0) await yieldToEventLoop();
        for (let col = this.cols - 1; col >= 0; col--) relax(col, row, backwardMask);
      }
    }
  }

  wallDistance(point: Vector2): number {
    const gx = point.x / this.cellSize - 0.5;
    const gy = point.y / this.cellSize - 0.5;
    const col = Math.floor(gx);
    const row = Math.floor(gy);
    const sample = (c: number, r: number) => {
      const cell = this.neighbor(
        this.wrap ? c : Math.min(this.cols - 1, Math.max(0, c)),
        this.wrap ? r : Math.min(this.rows - 1, Math.max(0, r))
      );
      return this.clearance[cell]!;
    };
    const tx = gx - col;
    const ty = gy - row;
    const top = sample(col, row) * (1 - tx) + sample(col + 1, row) * tx;
    const bottom = sample(col, row + 1) * (1 - tx) + sample(col + 1, row + 1) * tx;
    return top * (1 - ty) + bottom * ty - this.cellSize / 2;
  }

  /** Nearest passable cell, so gate approach points beside a barrier still route. */
  snap(point: Vector2): number | null {
    const start = this.cellAt(point);
    if (start === null) return null;
    if (Number.isFinite(this.cost[start]!)) return start;
    const col = start % this.cols;
    const row = Math.floor(start / this.cols);
    for (let radius = 1; radius <= 8; radius++) {
      let best: number | null = null;
      let bestDistance = Infinity;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const cell = this.neighbor(col + dx, row + dy);
          if (cell < 0 || !Number.isFinite(this.cost[cell]!)) continue;
          const distance = dx * dx + dy * dy;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = cell;
          }
        }
      }
      if (best !== null) return best;
    }
    return start;
  }

  /** A* over 8-connected cells; diagonal moves may not squeeze between blocked cells. */
  findPath(from: number, to: number): number[] | null {
    if (from === to) return [from];
    const size = this.cols * this.rows;
    const gScore = new Float64Array(size).fill(Infinity);
    const cameFrom = new Int32Array(size).fill(-1);
    const closed = new Uint8Array(size);
    const heap = new MinHeap();
    const toCol = to % this.cols;
    const toRow = Math.floor(to / this.cols);
    const heuristic = (cell: number) => {
      let dx = Math.abs((cell % this.cols) - toCol);
      let dy = Math.abs(Math.floor(cell / this.cols) - toRow);
      if (this.wrap) {
        dx = Math.min(dx, this.cols - dx);
        dy = Math.min(dy, this.rows - dy);
      }
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    gScore[from] = 0;
    heap.push(from, heuristic(from));
    const open = (cell: number) =>
      cell >= 0 && Number.isFinite(this.cost[cell]!) && (!this.gateLines[cell] || cell === to);
    while (heap.size > 0) {
      const current = heap.pop();
      if (current === to) {
        const path = [to];
        let cell = to;
        while (cameFrom[cell]! >= 0) {
          cell = cameFrom[cell]!;
          path.push(cell);
        }
        return path.reverse();
      }
      if (closed[current]) continue;
      closed[current] = 1;
      const col = current % this.cols;
      const row = Math.floor(current / this.cols);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const next = this.neighbor(col + dx, row + dy);
          if (closed[next] || !open(next)) continue;
          if (dx !== 0 && dy !== 0) {
            if (!open(this.neighbor(col + dx, row)) || !open(this.neighbor(col, row + dy)))
              continue;
          }
          const currentCost = Number.isFinite(this.cost[current]!)
            ? this.cost[current]!
            : this.cost[next]!;
          const step =
            ((dx !== 0 && dy !== 0 ? Math.SQRT2 : 1) * (currentCost + this.cost[next]!)) / 2;
          const score = gScore[current]! + step;
          if (score < gScore[next]!) {
            gScore[next] = score;
            cameFrom[next] = current;
            heap.push(next, score + heuristic(next));
          }
        }
      }
    }
    return null;
  }
}

class MinHeap {
  private items: number[] = [];
  private priorities: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, priority: number): void {
    const items = this.items;
    const priorities = this.priorities;
    let index = items.length;
    items.push(item);
    priorities.push(priority);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (priorities[parent]! <= priority) break;
      items[index] = items[parent]!;
      priorities[index] = priorities[parent]!;
      index = parent;
    }
    items[index] = item;
    priorities[index] = priority;
  }

  pop(): number {
    const items = this.items;
    const priorities = this.priorities;
    const top = items[0]!;
    const lastItem = items.pop()!;
    const lastPriority = priorities.pop()!;
    if (items.length > 0) {
      let index = 0;
      const length = items.length;
      for (let left = 1; left < length; left = index * 2 + 1) {
        const right = left + 1;
        const child = right < length && priorities[right]! < priorities[left]! ? right : left;
        if (priorities[child]! >= lastPriority) break;
        items[index] = items[child]!;
        priorities[index] = priorities[child]!;
        index = child;
      }
      items[index] = lastItem;
      priorities[index] = lastPriority;
    }
    return top;
  }
}

interface Vertex {
  point: Vector2;
  /** Progress for the edge leaving this vertex. */
  expected: number;
  /** Gate whose centre line this vertex lies on, or -1. */
  gate: number;
}

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

/** Highest speed whose full-lock turning circle fits inside the given radius. */
export function cornerSpeed(radius: number): number {
  const lowSpeedRadius = 3 / TURN_RATE;
  if (radius <= lowSpeedRadius) return 3;
  if (radius <= FULL_TURN_SPEED / TURN_RATE) return radius * TURN_RATE;
  return Math.sqrt(radius * TURN_RATE * FULL_TURN_SPEED);
}

function circumradius(a: Vector2, b: Vector2, c: Vector2): number {
  const ab = Math.hypot(b.x - a.x, b.y - a.y);
  const bc = Math.hypot(c.x - b.x, c.y - b.y);
  const ca = Math.hypot(a.x - c.x, a.y - c.y);
  const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  return area2 < 1e-6 ? Infinity : (ab * bc * ca) / (2 * area2);
}

/** Uniformly spaced points along a closed polyline; gate vertices are always kept. */
function resample(
  vertices: Vertex[],
  spacing: number,
  relative: (reference: Vector2, point: Vector2) => Vector2
): Vertex[] {
  const result: Vertex[] = [];
  let carry = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i]!;
    const following = vertices[(i + 1) % vertices.length]!;
    const b = relative(a.point, following.point);
    if (a.gate >= 0) {
      result.push({ ...a, point: { ...a.point } });
      carry = 0;
    }
    const length = Math.hypot(b.x - a.point.x, b.y - a.point.y);
    // Avoid a near-duplicate point immediately before a kept gate vertex.
    const end = following.gate >= 0 ? length - spacing / 2 : length - 1e-6;
    let distance = a.gate >= 0 ? spacing : spacing - carry;
    while (distance < end) {
      const t = distance / length;
      result.push({
        point: { x: a.point.x + (b.x - a.point.x) * t, y: a.point.y + (b.y - a.point.y) * t },
        expected: a.expected,
        gate: -1,
      });
      distance += spacing;
    }
    carry = length - (distance - spacing);
  }
  return result;
}

async function buildRacingLine(track: Track): Promise<RacingLine | null> {
  const checkpoints = track.elements
    .filter(element => element.type === 'checkpoint')
    .sort((a, b) => (a.checkpointIndex ?? 0) - (b.checkpointIndex ?? 0));
  const finish = track.elements.find(element => element.type === 'finish');
  if (!finish) return null;
  const gates: TrackElement[] = [...checkpoints, finish].map(gate =>
    effectiveRaceGate(track, gate)
  );
  const gateCount = checkpoints.length;
  const grid = new NavGrid(track);
  await grid.build(gates, new RoadSurfaceIndex(track));
  const wrapPoint = (reference: Vector2, point: Vector2) =>
    track.wrapAround ? unwrapForTrack(point, reference, track.width, track.height) : point;

  const gateGeometry = gates.map(gate => {
    const center = { x: gate.x + gate.width / 2, y: gate.y + gate.height / 2 };
    const forward = forwardOf(gate.rotation);
    return {
      center,
      across: { x: Math.cos(gate.rotation), y: Math.sin(gate.rotation) },
      // Keep the crossing point far enough from the gate ends for a whole car.
      halfWidth: Math.max(0, gate.width / 2 - LINE_CLEARANCE),
      approach: {
        x: center.x - forward.x * GATE_APPROACH,
        y: center.y - forward.y * GATE_APPROACH,
      },
      exit: { x: center.x + forward.x * GATE_APPROACH, y: center.y + forward.y * GATE_APPROACH },
    };
  });

  // The lap starts just past the finish line, where every car has zero checkpoints.
  let vertices: Vertex[] = [];
  let cursor = gateGeometry[gates.length - 1]!.exit;
  for (let gate = 0; gate < gates.length; gate++) {
    await yieldToEventLoop();
    const geometry = gateGeometry[gate]!;
    const fromCell = grid.snap(cursor);
    const toCell = grid.snap(geometry.approach);
    const path = fromCell !== null && toCell !== null ? grid.findPath(fromCell, toCell) : null;
    if (!path) {
      console.warn(`🤖 Racing line: no route to gate ${gate} on ${track.name}`);
      return null;
    }
    let point = cursor;
    vertices.push({ point, expected: gate, gate: -1 });
    for (let i = 1; i < path.length - 1; i++) {
      point = wrapPoint(point, grid.center(path[i]!));
      vertices.push({ point, expected: gate, gate: -1 });
    }
    const approach = wrapPoint(point, geometry.approach);
    const offset = { x: approach.x - geometry.approach.x, y: approach.y - geometry.approach.y };
    vertices.push({ point: approach, expected: gate, gate: -1 });
    vertices.push({
      point: { x: geometry.center.x + offset.x, y: geometry.center.y + offset.y },
      expected: gate === gateCount ? 0 : gate + 1,
      gate,
    });
    cursor = { x: geometry.exit.x + offset.x, y: geometry.exit.y + offset.y };
  }

  vertices = resample(vertices, SPACING, wrapPoint);
  const wallDistance = (point: Vector2) => grid.wallDistance(point);
  const isAsphalt = (point: Vector2) => grid.isAsphalt(point);

  // Clearance-constrained relaxation pulls the line tight through corners. Gate vertices slide
  // along their gate line, so every lap still crosses each gate in order and inside its width.
  for (let iteration = 0; iteration < 200; iteration++) {
    if (iteration % 4 === 0) await yieldToEventLoop();
    const n = vertices.length;
    for (let i = 0; i < n; i++) {
      const vertex = vertices[i]!;
      const current = vertex.point;
      const previous = wrapPoint(current, vertices[(i - 1 + n) % n]!.point);
      const next = wrapPoint(current, vertices[(i + 1) % n]!.point);
      let candidate = {
        x: current.x + ((previous.x + next.x) / 2 - current.x) * 0.5,
        y: current.y + ((previous.y + next.y) / 2 - current.y) * 0.5,
      };
      if (vertex.gate >= 0) {
        const geometry = gateGeometry[vertex.gate]!;
        const center = wrapPoint(current, geometry.center);
        const lateral = Math.max(
          -geometry.halfWidth,
          Math.min(
            geometry.halfWidth,
            (candidate.x - center.x) * geometry.across.x +
              (candidate.y - center.y) * geometry.across.y
          )
        );
        candidate = {
          x: center.x + geometry.across.x * lateral,
          y: center.y + geometry.across.y * lateral,
        };
      }
      const clearance = wallDistance(candidate);
      if (clearance < LINE_CLEARANCE && clearance < wallDistance(current)) continue;
      if (isAsphalt(current) && !isAsphalt(candidate)) continue;
      vertex.point = candidate;
    }
    // Points next to a gate stay clearly on their side of it, so the line crosses each gate at
    // an angle instead of running along a gate that is parallel to the road.
    for (let i = 0; i < n; i++) {
      const gate = vertices[i]!.gate;
      if (gate < 0) continue;
      const geometry = gateGeometry[gate]!;
      const forward = forwardOf(gates[gate]!.rotation);
      const center = vertices[i]!.point;
      for (let step = -GATE_SIDE_POINTS; step <= GATE_SIDE_POINTS; step++) {
        if (step === 0) continue;
        const vertex = vertices[(i + step + n) % n]!;
        const point = wrapPoint(center, vertex.point);
        const along = (point.x - center.x) * forward.x + (point.y - center.y) * forward.y;
        const required = step * SPACING * GATE_SIDE_SLOPE;
        const across =
          (point.x - center.x) * geometry.across.x + (point.y - center.y) * geometry.across.y;
        if (Math.abs(across) > geometry.halfWidth + LINE_CLEARANCE) continue;
        if (step < 0 ? along > required : along < required) {
          const shift = required - along;
          vertex.point = {
            x: vertex.point.x + forward.x * shift,
            y: vertex.point.y + forward.y * shift,
          };
        }
      }
    }
  }

  // Seamless unwrapped coordinates around the loop for distance calculations.
  for (let i = 1; i < vertices.length; i++) {
    vertices[i]!.point = wrapPoint(vertices[i - 1]!.point, vertices[i]!.point);
  }
  vertices = resample(vertices, SPACING, wrapPoint);

  const n = vertices.length;
  const points = vertices.map(vertex => vertex.point);
  const expected = vertices.map(vertex => vertex.expected);
  const sinceGate: number[] = new Array(n).fill(0);
  const gateEntry: number[] = new Array(gates.length).fill(0);
  const firstGate = vertices.findIndex(vertex => vertex.gate >= 0);
  for (let step = 1; step <= n; step++) {
    const i = (firstGate + step) % n;
    sinceGate[i] = vertices[i]!.gate >= 0 ? 0 : sinceGate[(i - 1 + n) % n]! + SPACING;
  }
  vertices.forEach((vertex, i) => {
    if (vertex.gate >= 0) gateEntry[vertex.gate] = (i - GATE_ENTRY_POINTS + n) % n;
  });
  const nextGate: number[] = new Array(n).fill(firstGate);
  for (let step = n - 1; step >= 0; step--) {
    const i = (firstGate + step) % n;
    nextGate[i] = vertices[i]!.gate >= 0 ? i : nextGate[(i + 1) % n]!;
  }

  const span = 4;
  const speed = points.map((current, i) => {
    const previous = wrapPoint(current, points[(i - span + n) % n]!);
    const next = wrapPoint(current, points[(i + span) % n]!);
    return Math.min(
      PHYSICS_CONSTANTS.MAX_SPEED * PHYSICS_CONSTANTS.NITRO_BOOST_MULTIPLIER,
      cornerSpeed(circumradius(previous, current, next))
    );
  });
  // Speed a car can shed per pixel while braking, matching PhysicsEngine drag and brakes.
  const shed = (velocity: number) =>
    0.6 *
    (PHYSICS_CONSTANTS.DRAG_COEFFICIENT * velocity + PHYSICS_CONSTANTS.ROLLING_RESISTANCE + 0.05);
  for (let lap = 0; lap < 2; lap++) {
    for (let i = n - 1; i >= 0; i--) {
      const next = speed[(i + 1) % n]!;
      speed[i] = Math.min(speed[i]!, next + SPACING * shed(next));
    }
  }

  return {
    points,
    expected,
    sinceGate,
    gateEntry,
    nextGate,
    gates: gateGeometry.map((geometry, i) => ({
      center: geometry.center,
      forward: forwardOf(gates[i]!.rotation),
    })),
    speed,
    spacing: SPACING,
    gateCount,
    wrapAround: !!track.wrapAround,
    trackWidth: track.width,
    trackHeight: track.height,
    wallDistance,
    isAsphalt,
  };
}

export function headingOf(direction: Vector2): number {
  return normalizeAngle(Math.atan2(direction.x, -direction.y));
}

const cache = new Map<string, Promise<RacingLine | null>>();

/** Racing lines are built cooperatively in slices so other rooms keep simulating meanwhile. */
export function prepareRacingLine(track: Track): Promise<RacingLine | null> {
  const key = `${track.id}:${track.updatedAt}:${track.elements.length}`;
  let line = cache.get(key);
  if (!line) {
    const started = Date.now();
    line = buildRacingLine(track)
      .catch(error => {
        console.error(`🤖 Racing line failed for ${track.name}:`, error);
        return null;
      })
      .then(result => {
        console.log(
          `🤖 Racing line for ${track.name}: ${result?.points.length ?? 0} points in ` +
            `${Date.now() - started}ms`
        );
        return result;
      });
    if (cache.size >= 16) cache.delete(cache.keys().next().value!);
    cache.set(key, line);
  }
  return line;
}
