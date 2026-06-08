import { beforeAll, describe, expect, it } from 'vitest';
import type { VehicleManifest } from '@trace/core';
import { initRapier, createPhysicsWorld } from '../../world';
import { createGround } from '../../ground';
import { PHYSICS_PROFILES } from '../../profiles';
import { NEUTRAL_INPUT, type ControlInput } from '../../input';
import { createMovement } from '../index';
import { FORWARD_SIGN } from './config';

/**
 * Integration stability tests — the "does it actually behave" gate the refactor
 * is judged on. Builds a real Rapier world + ground + car via the movement
 * registry and drives it through hard inputs, asserting it never flips,
 * explodes, or sinks, settles square on its springs, and can stop.
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

/** Build world + ground + car, settle, then run `steps` of `ctrl`. Returns the car + world. */
function run(phases: { ctrl: ControlInput; steps: number }[]) {
  const physics = createPhysicsWorld();
  createGround(physics.world, { tag: 'tarmac' });
  const car = createMovement(physics.world, {
    kind: 'car',
    manifest: MANIFEST,
    profile: PHYSICS_PROFILES.tarmac_circuit,
    spawn: SPAWN,
  });
  for (let i = 0; i < 30; i++) {
    car.update(NEUTRAL_INPUT, 1 / 60);
    physics.step();
  }
  for (const phase of phases) {
    for (let i = 0; i < phase.steps; i++) {
      car.update(phase.ctrl, 1 / 60);
      physics.step();
    }
  }
  const snap = car.readSnapshot();
  const r = car.body.rotation();
  // World-space local-up Y component: 1 = perfectly upright, <0 = flipped.
  const upY = 1 - 2 * (r.x * r.x + r.z * r.z);
  car.dispose();
  physics.dispose();
  return { snap, upY };
}

describe('car stability', () => {
  beforeAll(async () => {
    await initRapier();
  });

  it('settles square on its springs with all wheels in contact', () => {
    const { snap } = run([]);
    for (const w of snap.wheels) expect(w.inContact).toBe(true);
    // Body sits in a believable ride-height band (not sunk through, not floating).
    expect(snap.position.y).toBeGreaterThan(0.2);
    expect(snap.position.y).toBeLessThan(1.0);
  });

  it('stays upright and bounded through hard throttle + steer (no flip/explosion)', () => {
    const { snap, upY } = run([{ ctrl: input({ throttle: 1, steering: 0.7 }), steps: 600 }]);
    expect(Number.isFinite(snap.position.x)).toBe(true);
    expect(Number.isFinite(snap.position.y)).toBe(true);
    expect(upY).toBeGreaterThan(0.5); // never rolled past ~60°
    expect(snap.position.y).toBeLessThan(4); // didn't launch into orbit
    expect(snap.position.y).toBeGreaterThan(-1); // didn't fall through the floor
  });

  it('can accelerate then brake (forward speed killed; S engages reverse)', () => {
    const { snap } = run([
      { ctrl: input({ throttle: 1 }), steps: 150 },
      { ctrl: input({ brake: 1 }), steps: 240 },
    ]);
    // Spec: S brakes forward motion to zero, then (once below the reverse
    // threshold) starts the car moving backward. The test pins the spec by
    // asserting forward speed has been killed — reverse momentum is bounded by
    // the soft cap (MAX_REVERSE_SPEED_MS) but we don't constrain the exact
    // value because Rapier's chassis dynamics aren't precise F=ma.
    const forwardSpeed = snap.speed * FORWARD_SIGN;
    expect(forwardSpeed).toBeLessThan(0.5);
    expect(Number.isFinite(forwardSpeed)).toBe(true);
  });

  it('survives a handbrake drift without flipping', () => {
    const { upY, snap } = run([
      { ctrl: input({ throttle: 1 }), steps: 120 },
      { ctrl: input({ throttle: 0.6, steering: 1, handbrake: 1 }), steps: 120 },
    ]);
    expect(upY).toBeGreaterThan(0.4);
    expect(Number.isFinite(snap.position.x)).toBe(true);
  });

  it('coasts to a stop on flat ground when the player lifts off (no idle creep)', () => {
    // Accelerate to within the engine-braking band (<25 km/h), then release every
    // input. Engine braking bleeds the speed and, with no slope force, the car
    // settles to rest on the flat.
    const { snap } = run([
      { ctrl: input({ throttle: 1 }), steps: 50 },
      { ctrl: NEUTRAL_INPUT, steps: 600 },
    ]);
    expect(Math.abs(snap.speed)).toBeLessThan(0.1);
  });

  it('rolls on a slope while coasting, and a brake tap parks it', () => {
    // Real-car behaviour: off the pedals on a hill the car rolls (engine braking
    // tapers to zero near standstill so it can't statically hold a grade); a quick
    // brake tap latches the park-hold and it stays put. Simulated with tilted
    // gravity (flat ground + a forward gravity component = a downhill).
    const g = 9.81;
    const theta = (12 * Math.PI) / 180; // ~12° downhill along the car's forward (−Z)
    const physics = createPhysicsWorld({
      gravity: { x: 0, y: -g * Math.cos(theta), z: -g * Math.sin(theta) },
    });
    createGround(physics.world, { tag: 'tarmac' });
    const car = createMovement(physics.world, {
      kind: 'car',
      manifest: MANIFEST,
      profile: PHYSICS_PROFILES.tarmac_circuit,
      spawn: SPAWN,
    });
    for (let i = 0; i < 30; i++) {
      car.update(NEUTRAL_INPUT, 1 / 60);
      physics.step();
    }
    const zStart = car.readSnapshot().position.z;
    // Coast on the slope: gravity should roll it downhill (+Z), not lock it up.
    for (let i = 0; i < 240; i++) {
      car.update(NEUTRAL_INPUT, 1 / 60);
      physics.step();
    }
    const zRolled = car.readSnapshot().position.z;
    // Tap the brake briefly (shorter than the reverse-arm delay) then release.
    for (let i = 0; i < 20; i++) {
      car.update(input({ brake: 1 }), 1 / 60);
      physics.step();
    }
    for (let i = 0; i < 180; i++) {
      car.update(NEUTRAL_INPUT, 1 / 60);
      physics.step();
    }
    const zHeld = car.readSnapshot().position.z;
    const heldSpeed = Math.abs(car.readSnapshot().speed);
    car.dispose();
    physics.dispose();

    expect(Math.abs(zRolled - zStart)).toBeGreaterThan(1.0); // coasted down the grade
    expect(Math.abs(zHeld - zRolled)).toBeLessThan(0.3); // a single brake tap parked it
    expect(heldSpeed).toBeLessThan(0.2);
  });

  it('coasts nearly freely at high speed (lifting off does not brake hard)', () => {
    // The reported bug: lifting off at speed stopped the car in ~2-3 s. Above
    // ~25 km/h engine braking is OFF, so a second of coasting should shed only a
    // little speed (gentle drag), not a braking-grade chunk.
    const physics = createPhysicsWorld();
    createGround(physics.world, { tag: 'tarmac' });
    const car = createMovement(physics.world, {
      kind: 'car',
      manifest: MANIFEST,
      profile: PHYSICS_PROFILES.tarmac_circuit,
      spawn: SPAWN,
    });
    for (let i = 0; i < 30; i++) {
      car.update(NEUTRAL_INPUT, 1 / 60);
      physics.step();
    }
    // Get well above the 50 km/h (13.89 m/s) free-coast threshold.
    for (let i = 0; i < 600; i++) {
      car.update(input({ throttle: 1 }), 1 / 60);
      physics.step();
    }
    const fast = Math.abs(car.readSnapshot().speed);
    // Coast for one second.
    for (let i = 0; i < 60; i++) {
      car.update(NEUTRAL_INPUT, 1 / 60);
      physics.step();
    }
    const afterCoast = Math.abs(car.readSnapshot().speed);
    car.dispose();
    physics.dispose();

    expect(fast).toBeGreaterThan(20.83); // genuinely in the high-speed regime
    // A braking-grade stop would shed ~3-4 m/s in a second; free coasting sheds far less.
    expect(fast - afterCoast).toBeLessThan(2.5);
  });

  it('reverses up to ≈50 km/h (13.89 m/s)', () => {
    // Brake from a roll → footbrake kills forward speed → reverse ramps to its
    // cap. snap.speed reports the tracked reverse speed (positive) while reversing.
    const { snap } = run([
      { ctrl: input({ throttle: 1 }), steps: 120 },
      { ctrl: input({ brake: 1 }), steps: 420 },
    ]);
    expect(snap.speed).toBeGreaterThan(12);
    expect(snap.speed).toBeLessThanOrEqual(14.3);
  });

  it('stays strongly planted through full-lock cornering (anti-roll, no tip)', () => {
    // A harder input than the generic upright test — full throttle AND full lock.
    // The stability assist should keep it near-flat, not just under the 60° flip
    // line: a much tighter bound than the baseline upright check.
    const { upY, snap } = run([{ ctrl: input({ throttle: 1, steering: 1 }), steps: 600 }]);
    expect(upY).toBeGreaterThan(0.9);
    expect(Number.isFinite(snap.position.x)).toBe(true);
  });

  // Regression: wheels must track the body at speed. The earlier controller read
  // Rapier's cached pre-step hard point, so at speed the wheels trailed the body
  // by ~speed × dt (the "body slides off its wheels" bug). Each wheel's body-local
  // (x,z) must stay pinned to its rig position regardless of speed.
  it('keeps wheels locked under the body at speed (no one-step lag)', () => {
    const physics = createPhysicsWorld();
    createGround(physics.world, { tag: 'tarmac' });
    const car = createMovement(physics.world, {
      kind: 'car',
      manifest: MANIFEST,
      profile: PHYSICS_PROFILES.tarmac_circuit,
      spawn: SPAWN,
    });
    for (let i = 0; i < 240; i++) {
      car.update(input({ throttle: 1 }), 1 / 60);
      physics.step();
    }
    const snap = car.readSnapshot();
    const t = car.body.translation();
    const r = car.body.rotation();
    expect(Math.abs(snap.speed)).toBeGreaterThan(5); // genuinely moving

    for (let i = 0; i < snap.wheels.length; i++) {
      const wheel = snap.wheels[i];
      const rig = MANIFEST.rig.wheels[i];
      if (!wheel || !rig) throw new Error('missing wheel');
      const local = toBodyLocal(r, wheel.position.x - t.x, wheel.position.y - t.y, wheel.position.z - t.z);
      // Body-local (x,z) of the wheel center == the rig connection (x,z), to a few cm.
      // Pre-fix this drifted ~0.18 m along forward at this speed.
      expect(Math.abs(local.x - rig.position[0])).toBeLessThan(0.06);
      expect(Math.abs(local.z - rig.position[2])).toBeLessThan(0.06);
    }
    car.dispose();
    physics.dispose();
  });
});

/** Rotate a world-space delta into body-local space via the conjugate quaternion. */
function toBodyLocal(
  q: { x: number; y: number; z: number; w: number },
  dx: number,
  dy: number,
  dz: number,
): { x: number; y: number; z: number } {
  const x = -q.x;
  const y = -q.y;
  const z = -q.z;
  const w = q.w;
  const tx = 2 * (y * dz - z * dy);
  const ty = 2 * (z * dx - x * dz);
  const tz = 2 * (x * dy - y * dx);
  return {
    x: dx + w * tx + (y * tz - z * ty),
    y: dy + w * ty + (z * tx - x * tz),
    z: dz + w * tz + (x * ty - y * tx),
  };
}
