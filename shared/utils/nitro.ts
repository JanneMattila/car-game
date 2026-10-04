import { PHYSICS_CONSTANTS } from '../constants/physics';

export function stepNitro(amount: number, requested: boolean, deltaTime: number) {
  if (
    !Number.isFinite(amount) ||
    amount < 0 ||
    amount > PHYSICS_CONSTANTS.NITRO_MAX ||
    !Number.isFinite(deltaTime) ||
    deltaTime < 0
  ) {
    throw new RangeError('Nitro requires a valid fuel amount and nonnegative timestep.');
  }
  if (deltaTime === 0) return { amount, boostScale: 0 };
  if (!requested) {
    return {
      amount: Math.min(
        PHYSICS_CONSTANTS.NITRO_MAX,
        amount + PHYSICS_CONSTANTS.NITRO_RECHARGE_RATE * deltaTime
      ),
      boostScale: 0,
    };
  }
  const consumption = PHYSICS_CONSTANTS.NITRO_DRAIN_RATE * deltaTime;
  return {
    amount: Math.max(0, amount - consumption),
    boostScale: Math.min(1, amount / consumption),
  };
}
