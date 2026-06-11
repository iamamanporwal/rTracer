import { beforeAll, describe, expect, it } from 'vitest';
import type { VehicleManifest } from '@trace/core';
import { initRapier, createPhysicsWorld } from '../../world';
import { createGround } from '../../ground';
import { PHYSICS_PROFILES } from '../../profiles';
import { NEUTRAL_INPUT, type ControlInput } from '../../input';
import { createMovement } from '../index';

/**
 * Bike stunt + recovery behaviour (GTA-style). The bike's physics is the narrow
 * four-wheel raycast rig (kind 'car', manifest.class 'bike'); these gate the new
 * rider-lean stunts and prove the chassis pitches the right way.
 *
 * Pitch is read from the chassis FORWARD axis in world space (rotate (0,0,1) by
 * the body quaternion): forward.y > 0 = nose UP (wheelie), < 0 = nose DOWN
 * (stoppie). Sign-unambiguous, unlike a chase-cam screenshot.
 */

const BIKE: VehicleManifest = {
  id: 'vehicle_test_bike',
  displayName: 'Test Bike',
  version: '0.1.0',
  class: 'bike',
  visualMesh: 'v.glb',
  proxyMesh: 'p.glb',
  skinning: '',
  rig: {
    wheels: [
      { position: [0.3, 0.31, 0.68], radius: 0.31, isDriven: false, isSteered: true },
      { position: [-0.3, 0.31, 0.68], radius: 0.31, isDriven: false, isSteered: true },
      { position: [0.3, 0.31, -0.68], radius: 0.31, isDriven: true, isSteered: false },
      { position: [-0.3, 0.31, -0.68], radius: 0.31, isDriven: true, isSteered: false },
    ],
    seat: [0, 1.05, -0.1],
  },
  mass: 190,
  inertiaTensor: [55, 70, 38],
  engine: { powerCurveHpAtRpm: [[0, 20], [6000, 52], [8000, 58]], redline: 9000 },
  gearbox: { ratios: [2.7, 1.9, 1.45, 1.2, 1.0], final: 2.7, type: 'manual' },
  tuning: { antirollKp: 90, antirollKd: 18, comHeightScale: 1.3 },
};

const SPAWN = {
  position: [0, 0.5, 0] as [number, number, number],
  rotation: [0, 0, 0, 1] as [number, number, number, number],
};
const input = (over: Partial<ControlInput>): ControlInput => ({ ...NEUTRAL_INPUT, ...over });

/** Build + settle the bike, run the phases, return the live handle + world. */
function drive(phases: { ctrl: ControlInput; steps: number }[]) {
  const physics = createPhysicsWorld();
  createGround(physics.world, { tag: 'tarmac' });
  const bike = createMovement(physics.world, {
    kind: 'car',
    manifest: BIKE,
    profile: PHYSICS_PROFILES.tarmac_circuit,
    spawn: SPAWN,
  });
  for (let i = 0; i < 30; i++) {
    bike.update(NEUTRAL_INPUT, 1 / 60);
    physics.step();
  }
  for (const phase of phases) {
    for (let i = 0; i < phase.steps; i++) {
      bike.update(phase.ctrl, 1 / 60);
      physics.step();
    }
  }
  return { bike, physics };
}

/** Chassis forward-axis Y in world (>0 nose up = wheelie, <0 nose down = stoppie). */
function noseY(bike: ReturnType<typeof drive>['bike']): number {
  const q = bike.body.rotation();
  // forward = (0,0,1) rotated by q → y component = 2*(q.y*q.z - q.w*q.x)
  return 2 * (q.y * q.z - q.w * q.x);
}

describe('bike stunts (wheelie / stoppie) + recovery', () => {
  beforeAll(async () => {
    await initRapier();
  });

  it('↓ + throttle pops a WHEELIE (nose lifts)', () => {
    const { bike } = drive([
      { ctrl: input({ throttle: 1 }), steps: 120 }, // get rolling
      { ctrl: input({ throttle: 1, pitchLean: 1 }), steps: 90 }, // lean back → wheelie
    ]);
    expect(noseY(bike)).toBeGreaterThan(0.2); // nose clearly up
  });

  it('releasing the wheelie brings the front back DOWN', () => {
    const { bike } = drive([
      { ctrl: input({ throttle: 1 }), steps: 120 },
      { ctrl: input({ throttle: 1, pitchLean: 1 }), steps: 90 }, // wheelie up
      { ctrl: input({ throttle: 0.3 }), steps: 120 }, // released → anti-pitch restores
    ]);
    expect(Math.abs(noseY(bike))).toBeLessThan(0.18); // ~back to level
  });

  it('↑ + brake does a STOPPIE (nose dives)', () => {
    const { bike } = drive([
      { ctrl: input({ throttle: 1 }), steps: 200 }, // build real speed
      { ctrl: input({ brake: 1, pitchLean: -1 }), steps: 70 }, // lean fwd + brake → stoppie
    ]);
    expect(noseY(bike)).toBeLessThan(-0.18); // nose clearly down
  });

  it('hard throttle WITHOUT lean does NOT wheelie (anti-pitch holds it flat)', () => {
    const { bike } = drive([{ ctrl: input({ throttle: 1 }), steps: 200 }]);
    expect(Math.abs(noseY(bike))).toBeLessThan(0.16);
  });

  it('recovers to UPRIGHT after being knocked over (anti-roll)', () => {
    const { bike, physics } = drive([{ ctrl: input({ throttle: 0.4 }), steps: 60 }]);
    // Knock it onto its side: slam a big roll angular velocity about forward (Z).
    bike.body.setAngvel({ x: 0, y: 0, z: 9 }, true);
    for (let i = 0; i < 240; i++) {
      bike.update(NEUTRAL_INPUT, 1 / 60);
      physics.step();
    }
    // localUp.y ≈ 1 when upright; the anti-roll must bring it back near level.
    const q = bike.body.rotation();
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z); // world-up Y of the chassis
    expect(upY).toBeGreaterThan(0.95);
  });
});
