import { describe, expect, it } from 'vitest';
import type { VehicleManifest } from '@trace/core';
import { PHYSICS_PROFILES } from '../../profiles';
import { deriveCarChassis, deriveRestHubLocalY } from './chassis';
import { resolveCarFeel } from './config';

/**
 * Pure-geometry tests: no Rapier, no world. They pin the chassis derivation
 * invariants the controller relies on (collider encloses the footprint, COM is
 * low, struts sit a rest-length above the resting hub).
 */

function makeManifest(over: Partial<VehicleManifest> = {}): VehicleManifest {
  return {
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
    engine: { powerCurveHpAtRpm: [[1000, 30], [7000, 220]], redline: 7500 },
    gearbox: { ratios: [3.6, 2.1, 1.4, 1.0, 0.8], final: 3.9, type: 'manual' },
    ...over,
  };
}

const profile = PHYSICS_PROFILES.tarmac_circuit;

describe('deriveCarChassis', () => {
  it('collider half-extents enclose the wheel footprint', () => {
    const m = makeManifest();
    const c = deriveCarChassis(m, profile, resolveCarFeel(m));
    expect(c.halfExtents.x).toBeGreaterThanOrEqual(0.75);
    expect(c.halfExtents.z).toBeGreaterThanOrEqual(1.35);
    expect(c.halfExtents.y).toBeGreaterThan(0.4);
  });

  it('places the center of mass below the geometric center', () => {
    const m = makeManifest();
    const c = deriveCarChassis(m, profile, resolveCarFeel(m));
    expect(c.comOffset.y).toBeLessThan(0);
  });

  it('comHeightScale > 1 lowers the center of mass further', () => {
    const base = makeManifest();
    const planted = makeManifest({ tuning: { comHeightScale: 1.5 } });
    const cb = deriveCarChassis(base, profile, resolveCarFeel(base));
    const cp = deriveCarChassis(planted, profile, resolveCarFeel(planted));
    expect(cp.comOffset.y).toBeLessThan(cb.comOffset.y);
  });

  it('spawns the body at box-bottom clearance above the ground', () => {
    const m = makeManifest();
    const c = deriveCarChassis(m, profile, resolveCarFeel(m));
    expect(c.spawnOriginY).toBeCloseTo(c.halfExtents.y + 0.3, 6);
  });

  it('seats each strut a rest-length above the resting hub', () => {
    const m = makeManifest();
    const c = deriveCarChassis(m, profile, resolveCarFeel(m));
    for (let i = 0; i < c.wheels.length; i++) {
      const w = c.wheels[i];
      const rigWheel = m.rig.wheels[i];
      if (!w || !rigWheel) throw new Error('missing wheel');
      const expectedHubY = rigWheel.radius - c.spawnOriginY;
      expect(w.connection.y).toBeCloseTo(expectedHubY + c.suspension.restLength, 6);
      // X/Z come straight from the rig.
      expect(w.connection.x).toBeCloseTo(rigWheel.position[0], 6);
      expect(w.connection.z).toBeCloseTo(rigWheel.position[2], 6);
    }
  });

  it('caps tire friction-slip to keep hard braking from flipping the car', () => {
    const grippy = makeManifest({ tuning: { gripScale: 5 } });
    const c = deriveCarChassis(grippy, profile, resolveCarFeel(grippy));
    expect(c.frictionSlip).toBeLessThanOrEqual(6.5);
  });

  it('scales spring stiffness with mass', () => {
    const light = makeManifest({ mass: 1000 });
    const heavy = makeManifest({ mass: 3000 });
    const cl = deriveCarChassis(light, profile, resolveCarFeel(light));
    const ch = deriveCarChassis(heavy, profile, resolveCarFeel(heavy));
    expect(ch.suspension.stiffness).toBeGreaterThan(cl.suspension.stiffness);
  });
});

describe('deriveRestHubLocalY', () => {
  // SUSPENSION_DIR points straight down (0,-1,0), so the body-local hub Y of one
  // wheel is `connection.y − length`, and the seat is the average over wheels.
  it('averages connection.y − settled length across the wheels', () => {
    const wheels = [
      { connection: { x: 0, y: 0.04, z: 1.25 } },
      { connection: { x: 0, y: 0.04, z: -1.25 } },
    ];
    expect(deriveRestHubLocalY(wheels, [0.25, 0.35])).toBeCloseTo(0.04 - 0.3, 9);
  });

  // The regression guard: the seat must depend ONLY on connection.y and the
  // suspension lengths — never on the wheels' x/z. The old world-space formula
  // leaked a `cornerZ · sin(slope)` term, so a car settled on an incline seated
  // its body mesh too high or too low. Holding y and lengths fixed while moving
  // the wheels far apart in x/z must not move the seat one bit.
  it('ignores wheel x/z position, so the seat is slope-invariant by construction', () => {
    const lengths = [0.28, 0.28, 0.28, 0.28];
    const centred = deriveRestHubLocalY(
      [
        { connection: { x: 0, y: 0.04, z: 0 } },
        { connection: { x: 0, y: 0.04, z: 0 } },
        { connection: { x: 0, y: 0.04, z: 0 } },
        { connection: { x: 0, y: 0.04, z: 0 } },
      ],
      lengths,
    );
    const spread = deriveRestHubLocalY(
      [
        { connection: { x: 0.8, y: 0.04, z: 1.25 } },
        { connection: { x: -0.8, y: 0.04, z: 1.25 } },
        { connection: { x: 0.8, y: 0.04, z: -1.25 } },
        { connection: { x: -0.8, y: 0.04, z: -1.25 } },
      ],
      lengths,
    );
    expect(spread).toBeCloseTo(centred, 9);
  });

  it('returns 0 for an empty wheel list rather than NaN', () => {
    expect(deriveRestHubLocalY([], [])).toBe(0);
  });
});
