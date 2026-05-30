import type RAPIER from '@dimforge/rapier3d-compat';
import { createCarController } from './car/controller';
import type { CreateMovementOptions, MovementController } from './types';

/**
 * Movement framework entry point. The runtime asks for a {@link MovementKind}
 * and gets back a {@link MovementController} — it never knows whether the thing
 * is a Rapier raycast car, a leaning bike, an aircraft, or an animal gait.
 *
 * Phase 1 implements `'car'`. The other kinds are deliberately *registered but
 * unimplemented*: the contract, profiles, and wiring are ready, so adding one is
 * a new controller under `movement/<kind>/` plus a case below — no churn to the
 * session, renderer, or callers.
 */
export function createMovement(
  world: RAPIER.World,
  options: CreateMovementOptions,
): MovementController {
  const kind = options.kind ?? 'car';
  switch (kind) {
    case 'car':
      return createCarController(world, options);
    case 'bike':
    case 'plane':
    case 'animal':
      throw new Error(
        `movement kind '${kind}' is not implemented yet. The framework is ready: ` +
          `add a controller under packages/trace-physics/src/movement/${kind}/ that ` +
          `implements MovementController, then register it in movement/index.ts.`,
      );
    default: {
      const exhaustive: never = kind;
      throw new Error(`unknown movement kind: ${String(exhaustive)}`);
    }
  }
}

export * from './types';
export { createCarController } from './car/controller';
export { deriveCarChassis } from './car/chassis';
export type { CarChassis, WheelGeometry, SuspensionParams } from './car/chassis';
export { computeDriveCommand, deriveDrivetrainParams, peakPower } from './car/drivetrain';
export type { DriveCommand, DrivetrainParams } from './car/drivetrain';
export { resolveCarFeel, FORWARD_SIGN, STEER_SIGN } from './car/config';
export type { CarFeel } from './car/config';
