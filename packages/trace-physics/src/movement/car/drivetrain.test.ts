import { describe, expect, it } from 'vitest';
import type { VehicleManifest } from '@trace/core';
import { NEUTRAL_INPUT, type ControlInput } from '../../input';
import { computeDriveCommand, deriveDrivetrainParams } from './drivetrain';
import { FORWARD_SIGN, resolveCarFeel } from './config';

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

  it('steering lock shrinks as speed rises', () => {
    const slow = computeDriveCommand(input({ steering: 1 }), 0, params);
    const fast = computeDriveCommand(input({ steering: 1 }), 30 * FORWARD_SIGN, params);
    expect(Math.abs(fast.steerAngle)).toBeLessThan(Math.abs(slow.steerAngle));
    expect(Math.abs(slow.steerAngle)).toBeGreaterThan(0);
  });
});
