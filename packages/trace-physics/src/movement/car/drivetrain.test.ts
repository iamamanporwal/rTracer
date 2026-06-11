import { describe, expect, it } from 'vitest';
import type { VehicleManifest } from '@trace/core';
import { NEUTRAL_INPUT, type ControlInput } from '../../input';
import { computeDriveCommand, deriveDrivetrainParams } from './drivetrain';
import {
  DEFAULT_HANDBRAKE_FORCE_MUL,
  FORWARD_SIGN,
  G,
  resolveCarFeel,
} from './config';

/**
 * Pure force-model tests. No Rapier — just the arcade drivetrain math: throttle
 * direction, footbrake vs. reverse, handbrake drift, and speed-sensitive steer.
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
  engine: { powerCurveHpAtRpm: [[1000, 30], [7000, 220]], redline: 7500 },
  gearbox: { ratios: [3.6, 2.1, 1.4, 1.0, 0.8], final: 3.9, type: 'manual' },
};

const params = deriveDrivetrainParams(MANIFEST, resolveCarFeel(MANIFEST));

function input(over: Partial<ControlInput>): ControlInput {
  return { ...NEUTRAL_INPUT, ...over };
}

describe('computeDriveCommand', () => {
  it('throttle drives forward (engine force has the forward sign) with no braking', () => {
    const cmd = computeDriveCommand(input({ throttle: 1 }), 0, params);
    // Forward force is applied in Rapier's convention = FORWARD_SIGN × |force|.
    expect(Math.sign(cmd.enginePerWheel)).toBe(FORWARD_SIGN);
    expect(cmd.frontBrake).toBe(0);
    expect(cmd.rearBrake).toBe(0);
    expect(cmd.rearGripMul).toBe(1);
  });

  it('caps launch force at the traction limit (mass × drive accel) per driven wheel', () => {
    const cmd = computeDriveCommand(input({ throttle: 1 }), 0, params);
    const cap = params.maxEngineForce / params.drivenCount;
    expect(Math.abs(cmd.enginePerWheel)).toBeLessThanOrEqual(cap + 1e-6);
  });

  it('brake while rolling forward applies footbrake, not reverse', () => {
    // signedSpeed = rawSpeed × FORWARD_SIGN; pick rawSpeed so signedSpeed > 0.
    const cmd = computeDriveCommand(input({ brake: 1 }), 5 * FORWARD_SIGN, params);
    expect(cmd.frontBrake).toBeGreaterThan(0);
    expect(cmd.rearBrake).toBeGreaterThan(0);
    expect(cmd.enginePerWheel).toBe(0);
  });

  it('brake from standstill drives in reverse (opposite the forward sign)', () => {
    const cmd = computeDriveCommand(input({ brake: 1 }), 0, params);
    expect(Math.sign(cmd.enginePerWheel)).toBe(-FORWARD_SIGN);
    expect(cmd.frontBrake).toBe(0);
  });

  it('handbrake loads the rear axle separately from the foot brake', () => {
    // Separate channel so the controller can leave the handbrake out of ABS
    // (Space must lock the rear for drifts).
    const cmd = computeDriveCommand(input({ handbrake: 1 }), 0, params);
    expect(cmd.rearGripMul).toBeLessThan(1);
    expect(cmd.rearHandbrake).toBeGreaterThan(0);
    expect(cmd.rearBrake).toBe(0);
  });

  it('foot brake (S) is ≈1/handbrakeForceMul of the handbrake (Space) — the "65% of Space" feel', () => {
    // Handbrake total acts on the rear only; foot brake total is split front+rear.
    const hb = computeDriveCommand(input({ handbrake: 1 }), 0, params);
    const fb = computeDriveCommand(input({ brake: 1 }), 5 * FORWARD_SIGN, params);
    const handTotal = hb.rearHandbrake * params.rearCount;
    const footTotal = fb.frontBrake * params.frontCount + fb.rearBrake * params.rearCount;
    expect(handTotal).toBeGreaterThan(footTotal); // Space is the firmer brake
    expect(footTotal / handTotal).toBeCloseTo(1 / params.handbrakeForceMul, 5);
  });

  it('steering lock shrinks as speed rises', () => {
    const slow = computeDriveCommand(input({ steering: 1 }), 0, params);
    const fast = computeDriveCommand(input({ steering: 1 }), 30 * FORWARD_SIGN, params);
    expect(Math.abs(fast.steerAngle)).toBeLessThan(Math.abs(slow.steerAngle));
    expect(Math.abs(slow.steerAngle)).toBeGreaterThan(0);
  });
});

describe('resolveCarFeel tuning overrides (per-car tweakability)', () => {
  it('falls back to package defaults when tuning is absent', () => {
    const feel = resolveCarFeel(MANIFEST);
    expect(feel.handbrakeForceMul).toBe(DEFAULT_HANDBRAKE_FORCE_MUL);
    expect(feel.maxReverseSpeedMul).toBe(1);
  });

  it('threads every new dynamics knob through from manifest.tuning', () => {
    const tuned: VehicleManifest = {
      ...MANIFEST,
      tuning: {
        handbrakeForceMul: 2.2,
        maxReverseSpeedMul: 0.5,
        linearDamping: 0.04,
        angularDamping: 1.8,
        engineBrakeG: 0.2,
        holdG: 0.6,
        antirollKp: 80,
        antirollKd: 20,
      },
    };
    const feel = resolveCarFeel(tuned);
    expect(feel.handbrakeForceMul).toBe(2.2);
    expect(feel.maxReverseSpeedMul).toBe(0.5);
    expect(feel.linearDamping).toBe(0.04);
    expect(feel.angularDamping).toBe(1.8);
    expect(feel.engineBrakeDecelMs2).toBeCloseTo(0.2 * G, 5);
    expect(feel.holdDecelMs2).toBeCloseTo(0.6 * G, 5);
    expect(feel.antirollKp).toBe(80);
    expect(feel.antirollKd).toBe(20);
  });
});
