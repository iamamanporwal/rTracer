import { beforeAll, describe, expect, it } from 'vitest';
import type { VehicleManifest } from '@trace/core';
import { initRapier, createPhysicsWorld } from '../../world';
import { createGround } from '../../ground';
import { createStuntPark, STUNT_LOOP, STUNT_RAMPS } from '../../stunts';
import { PHYSICS_PROFILES } from '../../profiles';
import { LOOP_ASSIST_MIN_SURF_TILT_RAD } from './config';
import { NEUTRAL_INPUT, type ControlInput } from '../../input';
import { createMovement } from '../index';

/**
 * Stunt park behaviour, proven on a real Rapier sim across the vehicle mass range
 * (light bike → heavy Hummer), not by eye:
 *   • the 360° loop is rideable by EVERY vehicle and enforces a minimum entry
 *     speed (fast = inverted over the top; slow = stalls and slides back);
 *   • the kick ramps launch every vehicle cleanly into the air;
 *   • jump ramps stay below the loop-assist bank threshold, so a launch can never
 *     get "stuck" to the surface.
 */

const base = {
  version: '0.1.0',
  visualMesh: 'v.glb',
  proxyMesh: 'p.glb',
  skinning: '',
  engine: {
    powerCurveHpAtRpm: [[0, 40], [6000, 180], [9000, 220]] as [number, number][],
    redline: 9000,
  },
  gearbox: { ratios: [2.6, 1.9, 1.5, 1.3, 1.15, 1.04], final: 3.2, type: 'manual' as const },
};

const BIKE: VehicleManifest = {
  ...base,
  id: 'vehicle_test_bike',
  displayName: 'Test Bike',
  class: 'bike',
  rig: {
    wheels: [
      { position: [0.3, 0.31, 0.68], radius: 0.31, isDriven: false, isSteered: true },
      { position: [-0.3, 0.31, 0.68], radius: 0.31, isDriven: false, isSteered: true },
      { position: [0.3, 0.31, -0.68], radius: 0.31, isDriven: true, isSteered: false },
      { position: [-0.3, 0.31, -0.68], radius: 0.31, isDriven: true, isSteered: false },
    ],
    seat: [0, 1.05, -0.1],
  },
  mass: 300,
  inertiaTensor: [70, 90, 45],
  tuning: { antirollKp: 90, antirollKd: 18, comHeightScale: 1.3, gripScale: 1.15 },
};

const LIGHT_CAR: VehicleManifest = {
  ...base,
  id: 'vehicle_test_light',
  displayName: 'Test Light Car',
  class: 'car',
  rig: {
    wheels: [
      { position: [0.75, 0.33, 1.25], radius: 0.33, isDriven: false, isSteered: true },
      { position: [-0.75, 0.33, 1.25], radius: 0.33, isDriven: false, isSteered: true },
      { position: [0.75, 0.33, -1.25], radius: 0.33, isDriven: true, isSteered: false },
      { position: [-0.75, 0.33, -1.25], radius: 0.33, isDriven: true, isSteered: false },
    ],
    seat: [0, 0.6, -0.2],
  },
  mass: 1200,
  inertiaTensor: [450, 550, 200],
};

const HEAVY_CAR: VehicleManifest = {
  ...base,
  id: 'vehicle_test_heavy',
  displayName: 'Test Heavy Car',
  class: 'car',
  rig: {
    wheels: [
      { position: [0.939, 0.45, 1.658], radius: 0.45, isDriven: true, isSteered: true },
      { position: [-0.939, 0.45, 1.658], radius: 0.45, isDriven: true, isSteered: true },
      { position: [0.931, 0.45, -1.658], radius: 0.45, isDriven: true, isSteered: false },
      { position: [-0.931, 0.45, -1.658], radius: 0.45, isDriven: true, isSteered: false },
    ],
    seat: [0, 0.8, -0.2],
  },
  mass: 4100,
  inertiaTensor: [6500, 8000, 3000],
};

const input = (over: Partial<ControlInput>): ControlInput => ({ ...NEUTRAL_INPUT, ...over });

function spawn(manifest: VehicleManifest, x: number, z: number) {
  const physics = createPhysicsWorld();
  createGround(physics.world, { tag: 'tarmac' });
  createStuntPark(physics.world);
  const handle = createMovement(physics.world, {
    kind: 'car',
    manifest,
    profile: PHYSICS_PROFILES.tarmac_circuit,
    spawn: { position: [x, 0.6, z], rotation: [0, 0, 0, 1] },
  });
  for (let i = 0; i < 24; i++) {
    handle.update(NEUTRAL_INPUT, 1 / 60);
    physics.step();
  }
  return { physics, handle };
}

/** Drive `entrySpeed` (m/s, forward = -Z) into the loop on full throttle. */
function attemptLoop(manifest: VehicleManifest, entrySpeed: number) {
  const { physics, handle } = spawn(manifest, STUNT_LOOP.x, STUNT_LOOP.approachZ);
  handle.body.setLinvel({ x: 0, y: 0, z: -entrySpeed }, true);
  let maxY = 0;
  let minUpY = 1;
  for (let i = 0; i < 260; i++) {
    handle.update(input({ throttle: 1 }), 1 / 60);
    physics.step();
    const t = handle.body.translation();
    if (t.y > maxY) maxY = t.y;
    const q = handle.body.rotation();
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    if (upY < minUpY) minUpY = upY;
  }
  return { maxY, minUpY, cleared: minUpY < -0.5 && maxY > STUNT_LOOP.topY - 2 };
}

/** Drive at a kick ramp and report the peak chassis height (airtime proxy). */
function rampPeakY(manifest: VehicleManifest, rampId: string, entrySpeed: number): number {
  const ramp = STUNT_RAMPS.find((r) => r.id === rampId);
  if (!ramp) throw new Error(`no ramp ${rampId}`);
  const { physics, handle } = spawn(manifest, ramp.x, ramp.footZ + 18);
  handle.body.setLinvel({ x: 0, y: 0, z: -entrySpeed }, true);
  let maxY = 0;
  for (let i = 0; i < 200; i++) {
    handle.update(input({ throttle: 1 }), 1 / 60);
    physics.step();
    const t = handle.body.translation();
    if (t.y > maxY) maxY = t.y;
  }
  return maxY;
}

const VEHICLES = [
  ['bike', BIKE],
  ['light car', LIGHT_CAR],
  ['heavy car', HEAVY_CAR],
] as const;

describe('stunt park — 360° loop, every vehicle', () => {
  beforeAll(async () => {
    await initRapier();
  });

  it('clears the loop at speed — chassis goes fully inverted over the top', () => {
    // 30 and 32 m/s both sit inside the cleared window for the whole roster
    // (light bike → 4.1 t Hummer); assert both so the window can't silently
    // narrow to a single speed.
    for (const [name, m] of VEHICLES) {
      for (const v of [30, 32]) {
        const r = attemptLoop(m, v);
        expect(r.cleared, `${name} should clear at ${v} m/s`).toBe(true);
        expect(r.minUpY, `${name} inverted at the top @${v}`).toBeLessThan(-0.5);
      }
    }
  });

  it('does NOT clear when rolled in too slowly — stalls and slides back', () => {
    for (const [name, m] of VEHICLES) {
      const r = attemptLoop(m, 20);
      expect(r.cleared, `${name} should NOT clear at 20 m/s`).toBe(false);
      expect(r.minUpY, `${name} never inverts @20`).toBeGreaterThan(0);
    }
  });
});

describe('stunt park — ramps launch every vehicle', () => {
  beforeAll(async () => {
    await initRapier();
  });

  it('the launch ramp and big-jump takeoff throw every vehicle well into the air', () => {
    for (const [name, m] of VEHICLES) {
      expect(rampPeakY(m, 'ramp_launch', 22), `${name} off launch ramp`).toBeGreaterThan(1.6);
      expect(rampPeakY(m, 'jump_takeoff', 22), `${name} off big jump`).toBeGreaterThan(1.6);
    }
  });

  it('the kicker pops every vehicle off the ground', () => {
    for (const [name, m] of VEHICLES) {
      expect(rampPeakY(m, 'ramp_kicker', 20), `${name} off kicker`).toBeGreaterThan(1.0);
    }
  });

  it('jump ramps stay below the loop-assist bank threshold (no false "stick")', () => {
    // If a ramp were as steep as the loop assist's engagement bank, a launch would
    // get stuck to the surface instead of flying. Guard the separation.
    const steepestRampRad = Math.max(...STUNT_RAMPS.map((r) => r.lipDeg)) * (Math.PI / 180);
    expect(steepestRampRad).toBeLessThan(LOOP_ASSIST_MIN_SURF_TILT_RAD);
  });
});
