import { beforeAll, describe, expect, it } from 'vitest';
import type { VehicleManifest } from '@trace/core';
import { initRapier, createPhysicsWorld } from '../../world';
import { createGround } from '../../ground';
import { createVehicle } from '../../vehicle';
import { PHYSICS_PROFILES } from '../../profiles';
import { NEUTRAL_INPUT, type ControlInput } from '../../input';

/**
 * Tire ground-contact contract tests — burnout (W+S) and handbrake (Space)
 * must both report slip > 0 on the appropriate wheels, AND a burnout must
 * hold the chassis nearly still while driven wheels free-spin. These are
 * the physics signals the renderer's tire-fx module pipes into smoke +
 * skid marks.
 */

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

const SPAWN = {
  position: [0, 0.5, 0] as [number, number, number],
  rotation: [0, 0, 0, 1] as [number, number, number, number],
};

function input(over: Partial<ControlInput>): ControlInput {
  return { ...NEUTRAL_INPUT, ...over };
}

function buildVehicle() {
  const physics = createPhysicsWorld();
  createGround(physics.world, { tag: 'tarmac' });
  const vehicle = createVehicle(physics.world, {
    manifest: MANIFEST,
    profile: PHYSICS_PROFILES.tarmac_circuit,
    spawn: SPAWN,
  });
  // Settle on the suspension first so the wheels are seated on the ground
  // before the test input arrives.
  for (let i = 0; i < 10; i++) {
    vehicle.update(NEUTRAL_INPUT, 1 / 60);
    physics.step();
  }
  return { physics, vehicle };
}

describe('vehicle tire-contact slip signal', () => {
  beforeAll(async () => {
    await initRapier();
  });

  it('burnout (W+S from rest) pins the chassis while driven wheels report slip ≈ 1', () => {
    const { physics, vehicle } = buildVehicle();
    // Hold throttle+brake for ~1 s.
    for (let i = 0; i < 60; i++) {
      vehicle.update(input({ throttle: 1, brake: 1 }), 1 / 60);
      physics.step();
    }
    const snap = vehicle.readSnapshot();

    // Chassis barely moves — fronts hold while rears free-spin. The bound is
    // generous because the steered wheels still bite hard and we want some
    // tolerance for ABS pulse edge cases.
    expect(Math.abs(snap.position.z)).toBeLessThan(0.8);

    // Driven wheels (z < 0 in this rig) report full slip; steered wheels
    // (front, z > 0) report none.
    const driven = snap.wheels.filter((_, i) => MANIFEST.rig.wheels[i]!.isDriven);
    const steered = snap.wheels.filter((_, i) => MANIFEST.rig.wheels[i]!.isSteered);
    expect(driven.every((w) => w.slip >= 0.99)).toBe(true);
    expect(steered.every((w) => w.slip < 0.01)).toBe(true);

    vehicle.dispose();
    physics.dispose();
  });

  it('handbrake (Space) while rolling reports slip on the rear wheels only', () => {
    const { physics, vehicle } = buildVehicle();
    // Roll forward to ≥ 3 m/s so the handbrake-slip-ramp saturates.
    for (let i = 0; i < 240; i++) {
      vehicle.update(input({ throttle: 1 }), 1 / 60);
      physics.step();
      if (Math.abs(vehicle.readSnapshot().speed) > 5) break;
    }
    // Yank handbrake (W still held to keep momentum) and step a few frames.
    let maxRearSlip = 0;
    let maxFrontSlip = 0;
    for (let i = 0; i < 20; i++) {
      vehicle.update(input({ throttle: 1, handbrake: 1 }), 1 / 60);
      physics.step();
      const snap = vehicle.readSnapshot();
      for (let k = 0; k < snap.wheels.length; k++) {
        const w = snap.wheels[k]!;
        if (MANIFEST.rig.wheels[k]!.isSteered) maxFrontSlip = Math.max(maxFrontSlip, w.slip);
        else maxRearSlip = Math.max(maxRearSlip, w.slip);
      }
    }
    expect(maxRearSlip).toBeGreaterThan(0.5);
    expect(maxFrontSlip).toBe(0);

    vehicle.dispose();
    physics.dispose();
  });

  it('contact point sits one wheel-radius below the wheel center on flat ground', () => {
    const { physics, vehicle } = buildVehicle();
    vehicle.update(NEUTRAL_INPUT, 1 / 60);
    physics.step();
    const snap = vehicle.readSnapshot();
    for (let i = 0; i < snap.wheels.length; i++) {
      const w = snap.wheels[i]!;
      const radius = MANIFEST.rig.wheels[i]!.radius;
      // Contact Y ≈ wheel Y − radius (down-pointing suspension). Allow a
      // millimetre of suspension flutter.
      expect(w.contact.y).toBeCloseTo(w.position.y - radius, 2);
      expect(w.inContact).toBe(true);
    }
    vehicle.dispose();
    physics.dispose();
  });
});
