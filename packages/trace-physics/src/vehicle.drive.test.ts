import { beforeAll, describe, expect, it } from 'vitest';
import type { VehicleManifest } from '@trace/core';
import { initRapier } from './world';
import { createPhysicsWorld } from './world';
import { createGround } from './ground';
import { createVehicle } from './vehicle';
import { PHYSICS_PROFILES } from './profiles';
import { NEUTRAL_INPUT, type ControlInput } from './input';

/**
 * Drive-direction contract test.
 *
 * The chase camera sits behind the car at local −Z (see `camera-rig.ts`
 * default offset). "Forward" — what the throttle / W key must produce — is
 * therefore motion toward +Z, away from the camera. This pins down
 * `FORWARD_SIGN` so the W/S inversion can never silently regress.
 */

// Mirror of assets/vehicles/vehicle_alpha — front (steered) wheels at +Z.
const MANIFEST: VehicleManifest = {
  id: 'vehicle_alpha',
  displayName: 'Alpha Demo',
  version: '0.1.0',
  visualMesh: 'visual.glb',
  proxyMesh: 'proxy.glb',
  skinning: 'skinning.bin',
  rig: {
    wheels: [
      { position: [-0.75, 0.3, 1.35], radius: 0.31, isDriven: false, isSteered: true },
      { position: [0.75, 0.3, 1.35], radius: 0.31, isDriven: false, isSteered: true },
      { position: [-0.75, 0.3, -1.35], radius: 0.31, isDriven: true, isSteered: false },
      { position: [0.75, 0.3, -1.35], radius: 0.31, isDriven: true, isSteered: false },
    ],
    seat: [0.4, 0.9, 0.1],
  },
  mass: 1200,
  inertiaTensor: [1400, 1500, 600],
  engine: {
    powerCurveHpAtRpm: [
      [1000, 30],
      [3000, 110],
      [5000, 180],
      [7000, 220],
    ],
    redline: 7500,
  },
  gearbox: { ratios: [3.6, 2.1, 1.4, 1.0, 0.8], final: 3.9, type: 'manual' },
};

const SPAWN = { position: [0, 0.5, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] };

function input(over: Partial<ControlInput>): ControlInput {
  return { ...NEUTRAL_INPUT, ...over };
}

/** Build a world + ground + vehicle and drive it for `steps` fixed ticks. */
function drive(ctrl: ControlInput, steps: number) {
  const physics = createPhysicsWorld();
  createGround(physics.world, { tag: 'tarmac' });
  const vehicle = createVehicle(physics.world, {
    manifest: MANIFEST,
    profile: PHYSICS_PROFILES.tarmac_circuit,
    spawn: SPAWN,
  });
  // Settle on the suspension for a few ticks first.
  for (let i = 0; i < 10; i++) {
    vehicle.update(NEUTRAL_INPUT, 1 / 60);
    physics.step();
  }
  for (let i = 0; i < steps; i++) {
    vehicle.update(ctrl, 1 / 60);
    physics.step();
  }
  const snap = vehicle.readSnapshot();
  vehicle.dispose();
  physics.dispose();
  return snap;
}

describe('vehicle drive direction', () => {
  beforeAll(async () => {
    await initRapier();
  });

  it('throttle (W) drives the car forward, away from the chase camera (+Z)', () => {
    const snap = drive(input({ throttle: 1 }), 120);
    // Camera sits at −Z; forward must be +Z and clearly moving.
    expect(snap.position.z).toBeGreaterThan(2);
  });

  it('reverse (S from standstill) drives the car backward, toward the camera (−Z)', () => {
    const snap = drive(input({ brake: 1 }), 120);
    expect(snap.position.z).toBeLessThan(-0.5);
  });

  // Facing +Z with +Y up, the player's right is forward × up = +Z × +Y = −X, so
  // a left turn (A, steering −1) must curve the car toward +X and a right turn
  // (D, steering +1) toward −X. Pins down STEER_SIGN against an A/D swap.
  it('steering left (A) while driving forward curves the car to the left (+X)', () => {
    const snap = drive(input({ throttle: 1, steering: -1 }), 120);
    expect(snap.position.x).toBeGreaterThan(0.5);
  });

  it('steering right (D) while driving forward curves the car to the right (−X)', () => {
    const snap = drive(input({ throttle: 1, steering: 1 }), 120);
    expect(snap.position.x).toBeLessThan(-0.5);
  });
});
