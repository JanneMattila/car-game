import { PHYSICS_CONSTANTS } from '../constants/physics';
import { Vector2 } from '../types/physics';
import { Track } from '../types/track';

export interface GridSlot {
  position: Vector2;
  rotation: number;
}

const MIN_ROW_SPACING = PHYSICS_CONSTANTS.CAR_HEIGHT + 30;
const MIN_SLOT_DISTANCE = Math.hypot(PHYSICS_CONSTANTS.CAR_WIDTH, PHYSICS_CONSTANTS.CAR_HEIGHT) + 4;

const forwardOf = (rotation: number): Vector2 => ({
  x: Math.sin(rotation),
  y: -Math.cos(rotation),
});

/**
 * Start grid ordered from pole position backwards. Authored spawns are sorted by how far ahead
 * they are along the finish line's forward direction; extra cars continue the grid pattern in
 * further rows so no two cars ever start overlapping.
 */
export function computeStartGrid(track: Track, count: number): GridSlot[] {
  const spawns = track.elements.filter(element => element.type === 'spawn');
  if (count <= 0 || spawns.length === 0) return [];

  const finish = track.elements.find(element => element.type === 'finish');
  const reference = forwardOf(finish ? finish.rotation : spawns[0]!.rotation || 0);
  const slots: GridSlot[] = spawns
    .map(spawn => ({
      position: { x: spawn.x + spawn.width / 2, y: spawn.y + spawn.height / 2 },
      rotation: spawn.rotation || 0,
    }))
    .map((slot, index) => ({ slot, index }))
    .sort((a, b) => {
      const ahead = (s: GridSlot) => s.position.x * reference.x + s.position.y * reference.y;
      const difference = ahead(b.slot) - ahead(a.slot);
      // Slots in the same row keep their authored order.
      return Math.abs(difference) > 1 ? difference : a.index - b.index;
    })
    .map(({ slot }) => slot);

  // Two-wide grids repeat every second slot; single spawns stack directly behind each other.
  const columns = Math.min(2, slots.length);
  let rowSpacing = MIN_ROW_SPACING;
  if (slots.length > columns) {
    const first = slots[0]!;
    const next = slots[columns]!;
    rowSpacing = Math.max(
      MIN_ROW_SPACING,
      Math.hypot(next.position.x - first.position.x, next.position.y - first.position.y)
    );
  }

  while (slots.length < count) {
    const base = slots[slots.length - columns]!;
    const back = forwardOf(base.rotation);
    let distance = rowSpacing;
    let candidate: GridSlot;
    do {
      candidate = {
        position: {
          x: base.position.x - back.x * distance,
          y: base.position.y - back.y * distance,
        },
        rotation: base.rotation,
      };
      distance += MIN_ROW_SPACING / 2;
    } while (
      slots.some(
        slot =>
          Math.hypot(
            slot.position.x - candidate.position.x,
            slot.position.y - candidate.position.y
          ) < MIN_SLOT_DISTANCE
      )
    );
    slots.push(candidate);
  }
  return slots.slice(0, count);
}
