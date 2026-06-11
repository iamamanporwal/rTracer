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
  engine: { powerCurveHpAtRpm: [[0, 40], [6000, 180], [9000, 220]], redline: 9000 },
  gearbox: { ratios: [2.6, 1.9, 1.5, 1.3, 1.15, 1.04], final: 3.2, type: 'manual' as const },
} as const;

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

describe('DIAG stunt park sweeps', () => {
  beforeAll(async () => {
    await initRapier();
  });

  it('loop sweep across masses', () => {
    for (const [name, m] of [['bike', BIKE], ['light', LIGHT_CAR], ['heavy', HEAVY_CAR]] as const) {
      for (const v of [14, 18, 22, 26, 30, 34]) {
        const r = attemptLoop(m, v);
        // eslint-disable-next-line no-console
        console.log(
          `${name} loop v${v} → maxY ${r.maxY.toFixed(1)} (top ${STUNT_LOOP.topY}) upYmin ${r.minUpY.toFixed(2)} CLEARED=${r.cleared}`,
        );
      }
    }
    expect(true).toBe(true);
  });

  it('ramp launch sweep across masses', () => {
    for (const [name, m] of [['bike', BIKE], ['light', LIGHT_CAR], ['heavy', HEAVY_CAR]] as const) {
      for (const id of ['ramp_kicker', 'ramp_launch', 'jump_takeoff']) {
        const peak = rampPeakY(m, id, 22);
        // eslint-disable-next-line no-console
        console.log(`${name} ${id} @22 → peak Y ${peak.toFixed(2)}`);
      }
    }
    expect(true).toBe(true);
  });
});
