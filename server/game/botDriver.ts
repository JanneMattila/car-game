import {
  BotDifficulty,
  CarState,
  GridSlot,
  PHYSICS_CONSTANTS,
  PlayerInput,
  Vector2,
  normalizeAngle,
  unwrapForTrack,
} from '@shared';
import { RacingLine, headingOf } from './racingLine.js';

interface DriverProfile {
  /** Fraction of the racing line's safe corner speed the driver dares to carry. */
  cornerFactor: number;
  topSpeed: number;
  useNitro: boolean;
  /** Maximum sideways offset from the racing line, giving each bot its own line. */
  lineOffset: number;
}

// Cars reach about 13 px/frame on asphalt (18 with nitro), so speed caps sit below that.
const PROFILES: Record<BotDifficulty, DriverProfile> = {
  easy: { cornerFactor: 0.75, topSpeed: 10.5, useNitro: false, lineOffset: 30 },
  medium: { cornerFactor: 0.88, topSpeed: 12, useNitro: false, lineOffset: 22 },
  hard: { cornerFactor: 1, topSpeed: Infinity, useNitro: true, lineOffset: 14 },
};

const SEARCH_BEHIND = 8;
const SEARCH_AHEAD = 40;
const LOST_DISTANCE = 260;
const STUCK_SPEED = 0.8;
const STUCK_TIME = 900;
const REVERSE_TIME = 900;
const NO_PROGRESS_RESPAWN = 7000;
const MISSED_GATE_DISTANCE = 160;
const GATE_COMMIT_DISTANCE = 30;
const CAR_LENGTH = PHYSICS_CONSTANTS.CAR_HEIGHT;
const PASS_OFFSET = 60;

export interface BotCommand {
  input: PlayerInput;
  /** Set when the bot needs to be placed back on its racing line. */
  respawn?: GridSlot & { reason: 'missed-gate' | 'no-progress' };
}

/** Deterministic per-bot variation so several bots of one difficulty do not drive identically. */
function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 16777619);
  return () => {
    state = Math.imul(state ^ (state >>> 15), 2246822507);
    state = Math.imul(state ^ (state >>> 13), 3266489909);
    state ^= state >>> 16;
    return (state >>> 0) / 4294967296;
  };
}

export class BotDriver {
  private readonly profile: DriverProfile;
  private readonly lateral: number;
  private index = -1;
  private time = 0;
  private sequence = 0;
  private stuckSince = -1;
  private reverseUntil = -1;
  private reverseSteer = 0;
  private progress = 0;
  private progressMark = 0;
  private progressMarkTime = 0;
  /** Gate most recently missed, to escalate the recovery if it is missed again. */
  private missedGate = -1;
  /** Car being overtaken and the side chosen to pass it on (-1 left, 1 right). */
  private passing: { playerId: string; side: number } | null = null;

  constructor(
    readonly playerId: string,
    private line: RacingLine,
    difficulty: BotDifficulty
  ) {
    const random = seededRandom(playerId);
    const base = PROFILES[difficulty];
    this.profile = { ...base, cornerFactor: base.cornerFactor * (0.97 + random() * 0.05) };
    this.lateral = (random() * 2 - 1) * base.lineOffset;
  }

  private relative(point: Vector2, reference: Vector2): Vector2 {
    return this.line.wrapAround
      ? unwrapForTrack(point, reference, this.line.trackWidth, this.line.trackHeight)
      : point;
  }

  private allowed(expected: number, car: CarState): boolean {
    return (
      expected === car.checkpoint || (car.checkpoint === 0 && expected === this.line.gateCount)
    );
  }

  private locate(car: CarState): void {
    const { points } = this.line;
    const n = points.length;
    let best = -1;
    let bestDistance = Infinity;
    const consider = (i: number) => {
      const point = this.relative(points[i]!, car.position);
      const distance = (point.x - car.position.x) ** 2 + (point.y - car.position.y) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    };
    if (this.index >= 0) {
      for (let offset = -SEARCH_BEHIND; offset <= SEARCH_AHEAD; offset++) {
        consider((this.index + offset + n) % n);
      }
    }
    if (best < 0 || bestDistance > LOST_DISTANCE ** 2) {
      best = -1;
      bestDistance = Infinity;
      for (let i = 0; i < n; i++) {
        if (this.allowed(this.line.expected[i]!, car)) consider(i);
      }
    }
    if (best < 0) return;
    if (this.index >= 0) {
      let advance = best - this.index;
      if (advance > n / 2) advance -= n;
      if (advance < -n / 2) advance += n;
      this.progress += advance * this.line.spacing;
    }
    this.index = best;
  }

  /** Point on the racing line a given distance ahead, never skipping past the next gate. */
  private ahead(
    distance: number,
    reference: Vector2,
    stopAtGate = false
  ): { point: Vector2; index: number } {
    const n = this.line.points.length;
    let steps = Math.max(1, Math.round(distance / this.line.spacing));
    if (stopAtGate) {
      const gate = this.line.nextGate[this.index]!;
      const gateSteps = (gate - this.index + n) % n;
      const gatePoint = this.relative(this.line.points[gate]!, reference);
      const gateDistance = Math.hypot(gatePoint.x - reference.x, gatePoint.y - reference.y);
      if (gateSteps < steps && gateDistance > GATE_COMMIT_DISTANCE) steps = Math.max(1, gateSteps);
    }
    const index = (this.index + steps) % n;
    return { point: this.relative(this.line.points[index]!, reference), index };
  }

  private respawnSlot(index: number, reference: Vector2): GridSlot {
    const n = this.line.points.length;
    const point = { ...this.relative(this.line.points[index]!, reference) };
    const next = this.relative(this.line.points[(index + 2) % n]!, point);
    return {
      position: point,
      rotation: headingOf({ x: next.x - point.x, y: next.y - point.y }),
    };
  }

  private command(
    controls: Partial<Pick<PlayerInput, 'accelerate' | 'brake' | 'nitro'>> & { steer?: number }
  ): PlayerInput {
    const steer = Math.max(-1, Math.min(1, controls.steer ?? 0));
    return {
      playerId: this.playerId,
      sequence: ++this.sequence,
      timestamp: Date.now(),
      accelerate: !!controls.accelerate,
      brake: !!controls.brake,
      steerLeft: steer < -0.05,
      steerRight: steer > 0.05,
      steerValue: steer,
      nitro: !!controls.nitro,
      handbrake: false,
      respawn: false,
    };
  }

  private resetRecovery(): void {
    this.stuckSince = -1;
    this.reverseUntil = -1;
    this.progressMark = this.progress;
    this.progressMarkTime = this.time;
  }

  update(car: CarState, others: CarState[], deltaMs: number): BotCommand {
    this.time += deltaMs;
    const line = this.line;
    const n = line.points.length;
    this.locate(car);
    if (this.index < 0) return { input: this.command({ accelerate: true }) };

    // A gate passed outside its width never counts, so go back and take it properly.
    const expected = line.expected[this.index]!;
    const gatesAhead = (expected - car.checkpoint + line.gateCount + 1) % (line.gateCount + 1);
    const missed =
      !this.allowed(expected, car) &&
      gatesAhead >= 1 &&
      gatesAhead <= Math.max(1, Math.floor((line.gateCount + 1) / 2)) &&
      (gatesAhead > 1 || line.sinceGate[this.index]! > MISSED_GATE_DISTANCE);
    if (missed && !car.finished) {
      const gate = Math.min(car.checkpoint, line.gateCount);
      const entry = line.gateEntry[gate]!;
      this.index = entry;
      this.resetRecovery();
      const repeated = this.missedGate === gate;
      this.missedGate = gate;
      let slot = this.respawnSlot(entry, car.position);
      if (repeated) {
        // Awkward gate geometry: start just before the gate, aimed straight through it.
        const { center, forward } = line.gates[gate]!;
        const before = this.relative(center, car.position);
        slot = {
          position: { x: before.x - forward.x * 25, y: before.y - forward.y * 25 },
          rotation: headingOf(forward),
        };
        this.missedGate = -1;
      }
      return { input: this.command({}), respawn: { ...slot, reason: 'missed-gate' } };
    }
    if (car.checkpoint !== this.missedGate) this.missedGate = -1;

    if (this.progress - this.progressMark > 150) {
      this.progressMark = this.progress;
      this.progressMarkTime = this.time;
    } else if (this.time - this.progressMarkTime > NO_PROGRESS_RESPAWN && !car.finished) {
      this.resetRecovery();
      return {
        input: this.command({}),
        respawn: { ...this.respawnSlot(this.index, car.position), reason: 'no-progress' },
      };
    }

    const position = car.position;
    const heading = car.rotation;
    const forward = { x: Math.sin(heading), y: -Math.cos(heading) };
    const right = { x: -forward.y, y: forward.x };
    const speed = car.speed;
    const forwardSpeed = car.velocity.x * forward.x + car.velocity.y * forward.y;

    const look = this.ahead(30 + speed * 6, position, true);
    const lookNext = this.relative(line.points[(look.index + 2) % n]!, look.point);
    const tangent = { x: lookNext.x - look.point.x, y: lookNext.y - look.point.y };
    const tangentLength = Math.hypot(tangent.x, tangent.y) || 1;
    const normal = { x: -tangent.y / tangentLength, y: tangent.x / tangentLength };
    // Drive the exact line through gates; a personal line elsewhere spreads the field out.
    const toGate = ((line.nextGate[this.index]! - this.index + n) % n) * line.spacing;
    let offset = this.lateral * Math.min(1, Math.max(0, toGate - 40) / 160);

    let targetSpeed = Math.min(
      this.profile.topSpeed,
      line.speed[this.ahead(speed * 3, position).index]! * this.profile.cornerFactor
    );

    // Pass slower cars on the side with more room, committing to that side until the car is
    // behind; follow when there is no room.
    const range = CAR_LENGTH * 1.5 + speed * 8;
    const sideClear = (side: number) => {
      const candidate = {
        x: look.point.x + normal.x * side * PASS_OFFSET,
        y: look.point.y + normal.y * side * PASS_OFFSET,
      };
      return (
        line.wallDistance(candidate) > 40 &&
        (!line.isAsphalt(look.point) || line.isAsphalt(candidate))
      );
    };
    let blocker: { id: string; across: number; speed: number; along: number } | null = null;
    let passingStillAlongside = false;
    for (const other of others) {
      if (other.playerId === car.playerId) continue;
      const otherPosition = this.relative(other.position, position);
      const dx = otherPosition.x - position.x;
      const dy = otherPosition.y - position.y;
      const along = dx * forward.x + dy * forward.y;
      const across = dx * right.x + dy * right.y;
      if (other.playerId === this.passing?.playerId) {
        passingStillAlongside =
          along > -CAR_LENGTH * 1.2 && along < range + CAR_LENGTH && Math.abs(across) < 110;
      }
      if (along <= 0 || along > range || Math.abs(across) > 45) continue;
      const otherSpeed = other.velocity.x * forward.x + other.velocity.y * forward.y;
      if (otherSpeed > forwardSpeed - 0.3) continue;
      if (!blocker || along < blocker.along) {
        blocker = { id: other.playerId, across, speed: otherSpeed, along };
      }
    }
    if (this.passing && !passingStillAlongside) this.passing = null;
    if (!this.passing && blocker) {
      const side = [blocker.across > 0 ? -1 : 1, blocker.across > 0 ? 1 : -1].find(sideClear);
      if (side !== undefined) this.passing = { playerId: blocker.id, side };
    }
    if (this.passing && sideClear(this.passing.side)) {
      offset = this.passing.side * PASS_OFFSET;
    } else {
      this.passing = null;
      if (blocker) targetSpeed = Math.min(targetSpeed, Math.max(2, blocker.speed - 0.5));
    }

    let target = {
      x: look.point.x + normal.x * offset,
      y: look.point.y + normal.y * offset,
    };
    if (offset !== 0 && line.wallDistance(target) < 40) target = look.point;
    const error = normalizeAngle(
      headingOf({ x: target.x - position.x, y: target.y - position.y }) - heading
    );

    if (car.finished) targetSpeed = Math.min(targetSpeed, 8);
    if (Math.abs(error) > 0.7) targetSpeed = Math.min(targetSpeed, 6);

    // Reverse away from walls or other cars, then continue.
    if (this.time < this.reverseUntil) {
      return { input: this.command({ brake: true, steer: this.reverseSteer }) };
    }
    const facingAway = Math.abs(error) > 2 && speed < 3;
    if (speed < STUCK_SPEED || facingAway) {
      if (this.stuckSince < 0) this.stuckSince = this.time;
      if (this.time - this.stuckSince > (facingAway ? 200 : STUCK_TIME)) {
        this.stuckSince = -1;
        this.reverseUntil = this.time + REVERSE_TIME;
        // Steering is mirrored in reverse, so this swings the nose towards the target.
        this.reverseSteer = error > 0 ? -1 : 1;
        return { input: this.command({ brake: true, steer: this.reverseSteer }) };
      }
    } else {
      this.stuckSince = -1;
    }

    const accelerate = forwardSpeed < targetSpeed - 0.2;
    const brake = forwardSpeed > targetSpeed + 1.2;
    const straightAhead =
      this.profile.useNitro &&
      accelerate &&
      Math.abs(error) < 0.08 &&
      car.nitroAmount > 25 &&
      line.speed[this.ahead(speed * 25, position).index]! >= 19 &&
      targetSpeed >= 19;
    return {
      input: this.command({
        accelerate,
        brake,
        nitro: straightAhead,
        steer: error * 3.5,
      }),
    };
  }
}
