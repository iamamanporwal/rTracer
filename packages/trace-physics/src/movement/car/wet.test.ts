import { beforeAll, describe, expect, it } from 'vitest';
import type { VehicleManifest } from '@trace/core';
import { initRapier, createPhysicsWorld } from '../../world';
import { createGround } from '../../ground';
import { PHYSICS_PROFILES } from '../../profiles';
import { NEUTRAL_INPUT, type ControlInput } from '../../input';
import { createMovement } from '../index';

/**
 * Wet-grip overlay test — the seam the weather system uses to make rain
 * slippery without mutating the zone's authoritative physics profile.
 *
 * The behavioral probe is **cornering**, not braking — Rapier's straight-line
 * brake impulse is dominated by the (constant) brake torque path, while
 * `sideFrictionStiffness` (which our multiplier scales) is the lateral-grip
 * knob that decides how hard the tire bites a turn. A wet car must not be able
 * to corner as sharply as the same car on a dry road.
 */

const MANIFEST: VehicleManifest = {
  id: 'vehicle_test',
  displayName: 'Test',
  version: '0.1.0',
  visualMesh: 'v.glb',
  proxyMesh: 'p.glb',
  skinning: 's.bin',
  rig: {
    wheels: [
      { position: [-0.75, 0.3, 1.35], radius: 0.48, isDriven: false, isSteered: true },
      { position: [0.75, 0.3, 1.35], radius: 0.48, isDriven: false, isSteered: true },
      { position: [-0.75, 0.3, -1.35], radius: 0.48, isDriven: true, isSteered: false },
      { position: [0.75, 0.3, -1.35], radius: 0.48, isDriven: true, isSteered: false },
    ],
    seat: [0.4, 0.9, 0.1],
  },
  mass: 1200,
  inertiaTensor: [1400, 1500, 600],
  engine: { powerCurveHpAtRpm: [[1000, 30], [3000, 110], [5000, 180], [7000, 220]], redline: 7500 },
  gearbox: { ratios: [3.6, 2.1, 1.4, 1.0, 0.8], final: 3.9, type: 'manual' },
};

const SPAWN = {
  position: [0, 0.5, 0] as [number, number, number],
  rotation: [0, 0, 0, 1] as [number, number, number, number],
};

function input(over: Partial<ControlInput>): ControlInput {
  return { ...NEUTRAL_INPUT, ...over };
}

/**
 * Accelerate from rest, then hold a hard right turn. Returns distance from the
 * spawn origin — a robust slip metric. A grippy car bites the turn and traces a
 * tight circle (returns near origin); a slippery car can't bite and slides
 * along a wide arc (ends much further away).
 */
function turnDistance(gripMul: number): number {
  const physics = createPhysicsWorld();
  createGround(physics.world, { tag: 'tarmac' });
  const car = createMovement(physics.world, {
    kind: 'car',
    manifest: MANIFEST,
    profile: PHYSICS_PROFILES.tarmac_circuit,
    spawn: SPAWN,
  });
  car.setGripMultiplier(gripMul);
  // Build up speed in a straight line first.
  for (let i = 0; i < 180; i++) {
    car.update(input({ throttle: 1 }), 1 / 60);
    physics.step();
  }
  // Hold a hard turn at constant throttle.
  for (let i = 0; i < 180; i++) {
    car.update(input({ throttle: 0.7, steering: 1 }), 1 / 60);
    physics.step();
  }
  const p = car.readSnapshot().position;
  car.dispose();
  physics.dispose();
  return Math.hypot(p.x, p.z);
}

describe('wet grip overlay', () => {
  beforeAll(async () => {
    await initRapier();
  });

  it('a wet road robs the car of cornering grip (wider arc, slides further)', () => {
    const dry = turnDistance(1.0);
    const wet = turnDistance(0.45);
    // Wet can't bite the turn → much wider arc → ends much further from spawn.
    expect(wet).toBeGreaterThan(dry + 3);
  });

  it('clamps the multiplier so the car is always driveable (no NaN, no super-grip)', () => {
    const veryWet = turnDistance(0.0); // clamped to 0.1 internally
    const cheat = turnDistance(10); // clamped to 1 internally
    expect(Number.isFinite(veryWet)).toBe(true);
    expect(Number.isFinite(cheat)).toBe(true);
    // The clamped-wet floor must still corner worse than the clamped-dry ceiling.
    expect(veryWet).toBeGreaterThan(cheat);
  });
});
