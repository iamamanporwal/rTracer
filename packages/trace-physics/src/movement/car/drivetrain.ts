import type { VehicleManifest } from '@trace/core';
import type { ControlInput } from '../../input';
import {
  FORWARD_SIGN,
  HANDBRAKE_REAR_GRIP_MUL,
  HP_TO_WATTS,
  MAX_REVERSE_SPEED_MS,
  REF_SPEED_MS,
  REVERSE_PLATEAU_FRAC,
  REVERSE_THRESHOLD_MS,
  STEER_SIGN,
  type CarFeel,
} from './config';

/**
 * Arcade drivetrain — pure force/steer math, no Rapier. Believable, not
 * simulated: a power/speed engine model with a traction-limited launch cap,
 * split braking, speed-sensitive steering, and a GTA handbrake that breaks rear
 * grip for drifts. Deterministic and unit-testable.
 */

export type DrivetrainParams = {
  /** Peak engine power in watts (from the HP curve). */
  peakPowerW: number;
  /** Traction-limited forward force ceiling (N) = mass × drive accel. */
  maxEngineForce: number;
  /** Reverse force (N) = mass × reverse accel. */
  maxReverseForce: number;
  /** Peak total foot-brake force (N) = mass × peak decel. */
  maxBrakeTotal: number;
  /** Handbrake force as a multiple of {@link maxBrakeTotal} (Space vs S). */
  handbrakeForceMul: number;
  /** Number of driven wheels (≥1). */
  drivenCount: number;
  /** Number of braked front wheels (steered), for per-wheel split (≥1). */
  frontCount: number;
  /** Number of braked rear wheels, for per-wheel split (≥1). */
  rearCount: number;
  frontBrakeBias: number;
  maxSteerRad: number;
  steerSpeedScale: number;
};

export type DriveCommand = {
  /** Signed engine force per driven wheel, in Rapier's forward-axis convention. */
  enginePerWheel: number;
  /**
   * Foot-brake force per front wheel — eligible for per-wheel ABS modulation in
   * the controller. Excludes the handbrake (held separately, see below) so the
   * handbrake can stay solid (rear locked = drift) while ABS pulses the front.
   */
  frontBrake: number;
  /** Foot-brake force per rear wheel — eligible for ABS modulation. */
  rearBrake: number;
  /** Handbrake force per rear wheel — NEVER ABS-modulated (Space = locks rear). */
  rearHandbrake: number;
  /** Signed steering angle (rad), in Rapier's convention. */
  steerAngle: number;
  /** Rear lateral-grip multiplier this tick (1 = full; <1 = handbrake drift). */
  rearGripMul: number;
};

/** Build the static drivetrain params for a car from its manifest + feel. */
export function deriveDrivetrainParams(manifest: VehicleManifest, feel: CarFeel): DrivetrainParams {
  const drivenCount = manifest.rig.wheels.filter((w) => w.isDriven).length || 1;
  const frontCount = manifest.rig.wheels.filter((w) => w.isSteered).length || 1;
  const rearCount = manifest.rig.wheels.filter((w) => !w.isSteered).length || 1;
  return {
    peakPowerW: peakPower(manifest),
    maxEngineForce: manifest.mass * feel.driveAccelMs2,
    maxReverseForce: manifest.mass * feel.reverseAccelMs2,
    maxBrakeTotal: manifest.mass * feel.peakDecelMs2,
    handbrakeForceMul: feel.handbrakeForceMul,
    drivenCount,
    frontCount,
    rearCount,
    frontBrakeBias: feel.frontBrakeBias,
    maxSteerRad: feel.maxSteerRad,
    steerSpeedScale: feel.steerSpeedScale,
  };
}

/**
 * Map control input + current speed to per-wheel forces and steering.
 *
 * @param input   clamped control input
 * @param rawSpeed Rapier's `currentVehicleSpeed()` (native sign)
 */
export function computeDriveCommand(
  input: ControlInput,
  rawSpeed: number,
  p: DrivetrainParams,
): DriveCommand {
  // Signed forward speed: positive = moving the way throttle pushes.
  const signedSpeed = rawSpeed * FORWARD_SIGN;
  const absSpeed = Math.abs(signedSpeed);

  let engineForceTotal = 0;
  // Handbrake always contributes a rear-heavy braking force — stronger than the
  // foot brake (handbrakeForceMul) so Space is the firmer brake and S lands at
  // ≈1/mul of it, and so the rear locks hard enough to break away for a drift.
  let footBrakeTotal = 0;
  const handbrakeTotal = input.handbrake * p.maxBrakeTotal * p.handbrakeForceMul;

  if (input.throttle > 0) {
    // Power/speed model: force tapers as speed rises, capped for a clean launch.
    const powerForce = (p.peakPowerW * input.throttle) / Math.max(absSpeed, REF_SPEED_MS);
    engineForceTotal = FORWARD_SIGN * Math.min(powerForce, p.maxEngineForce * input.throttle);
  } else if (input.brake > 0) {
    if (signedSpeed > REVERSE_THRESHOLD_MS) {
      // Rolling forward → footbrake.
      footBrakeTotal = input.brake * p.maxBrakeTotal;
    } else {
      // Stopped or already reversing. Two-stage cap: full force up to the
      // plateau (≈80 % of top reverse speed) so the car gets a punchy launch
      // backwards, then a sharp linear ramp to zero force at MAX_REVERSE_SPEED_MS.
      // Above the cap, force is zero — friction bleeds any momentum overshoot.
      const reverseSpeed = -signedSpeed; // positive once moving backward
      const r = reverseSpeed / MAX_REVERSE_SPEED_MS;
      const factor =
        r <= REVERSE_PLATEAU_FRAC
          ? 1
          : clamp((1 - r) / (1 - REVERSE_PLATEAU_FRAC), 0, 1);
      engineForceTotal = -FORWARD_SIGN * p.maxReverseForce * input.brake * factor;
    }
  }

  const enginePerWheel = engineForceTotal / p.drivenCount;

  // Footbrake splits front/rear by bias; the handbrake is reported separately
  // so the controller can keep it out of the ABS loop (it must lock the rear).
  const frontBrake = (footBrakeTotal * p.frontBrakeBias) / p.frontCount;
  const rearBrake = (footBrakeTotal * (1 - p.frontBrakeBias)) / p.rearCount;
  const rearHandbrake = handbrakeTotal / p.rearCount;

  // Steering lock shrinks with speed so the car isn't twitchy at pace.
  const steerAngle =
    STEER_SIGN * input.steering * p.maxSteerRad * (1 / (1 + absSpeed / p.steerSpeedScale));

  // Handbrake cuts rear lateral grip → the back steps out (drift).
  const rearGripMul =
    input.handbrake > 0 ? 1 - input.handbrake * (1 - HANDBRAKE_REAR_GRIP_MUL) : 1;

  return { enginePerWheel, frontBrake, rearBrake, rearHandbrake, steerAngle, rearGripMul };
}

/** Peak engine power in watts from the HP-at-RPM curve. */
export function peakPower(manifest: VehicleManifest): number {
  let peakHp = 0;
  for (const [, hp] of manifest.engine.powerCurveHpAtRpm) {
    if (hp > peakHp) peakHp = hp;
  }
  return peakHp * HP_TO_WATTS;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
