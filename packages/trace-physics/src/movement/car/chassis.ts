import type { VehicleManifest } from '@trace/core';
import type { PhysicsProfile } from '../../profiles';
import {
  DEFAULT_COM_DROP_FRACTION,
  FRONT_SUSPENSION_STIFFNESS_MUL,
  MAX_COM_Y,
  MAX_FRICTION_SLIP,
  REFERENCE_MASS,
  type CarFeel,
} from './config';

/**
 * Pure chassis geometry derivation — no Rapier, no side effects, fully
 * unit-testable. Turns a manifest + terrain profile + resolved feel into the
 * numbers the controller hands to Rapier.
 *
 * The key fix over the old monolith: the **strut hard-point sits a rest-length
 * above the wheel hub** (a real strut), and the body-center spawn height is
 * derived so an uncompressed wheel just touches the ground. The car then settles
 * onto its springs naturally instead of being shoved upward by a connection
 * point buried below the hub. Ride height is whatever the springs balance to;
 * the controller measures the *settled* hub offset for the visual seam.
 */

export type WheelGeometry = {
  /** Strut hard-point (ray start) in chassis space. */
  connection: { x: number; y: number; z: number };
  radius: number;
  isDriven: boolean;
  isSteered: boolean;
  /**
   * Per-wheel suspension stiffness — front struts ride stiffer than rear to
   * resist forward dive under braking (stoppie suppression).
   */
  stiffness: number;
};

export type SuspensionParams = {
  restLength: number;
  maxTravel: number;
  stiffness: number;
  compression: number;
  relaxation: number;
};

export type CarChassis = {
  /** Cuboid collider half-extents. */
  halfExtents: { x: number; y: number; z: number };
  /** Center-of-mass offset in chassis space (kept low for roll resistance). */
  comOffset: { x: number; y: number; z: number };
  /** Body-center world Y to spawn at, before the car settles on its springs. */
  spawnOriginY: number;
  suspension: SuspensionParams;
  /** Per-wheel lateral grip parameter (friction slip). */
  frictionSlip: number;
  /** Per-wheel side-friction stiffness at full grip (rear is cut on handbrake). */
  sideFrictionStiffness: number;
  wheels: WheelGeometry[];
};

/**
 * Derive everything geometric/physical the Rapier wheels need. `manifest.mass`
 * scales spring stiffness so heavy cars don't bottom out; per-car `feel`
 * multipliers ride on top.
 */
export function deriveCarChassis(
  manifest: VehicleManifest,
  profile: PhysicsProfile,
  feel: CarFeel,
): CarChassis {
  // Footprint from the wheel rig.
  let maxX = 0;
  let maxZ = 0;
  let maxRadius = 0;
  for (const w of manifest.rig.wheels) {
    maxX = Math.max(maxX, Math.abs(w.position[0]));
    maxZ = Math.max(maxZ, Math.abs(w.position[2]));
    maxRadius = Math.max(maxRadius, w.radius);
  }

  // Box height tracks tire size so big-wheeled trucks get a taller tub, but stays
  // in a sane band. (Old code hardcoded 0.5; this lands near it for ~0.48 tires.)
  const halfHeight = clamp(maxRadius * 1.05, 0.45, 0.7);
  const halfExtents = {
    x: maxX + 0.15,
    y: halfHeight,
    z: maxZ + 0.25,
  };

  // Suspension: stiffness scales with mass and the per-car multiplier; travel and
  // grip scale per car. Friction slip is capped to keep hard braking from flipping.
  const massScale = manifest.mass / REFERENCE_MASS;
  const travelScale = feel.suspensionTravelScale;
  const suspension: SuspensionParams = {
    restLength: profile.suspensionRestLength * travelScale,
    maxTravel: profile.suspensionMaxTravel * travelScale,
    stiffness: profile.suspensionStiffness * massScale * feel.suspensionStiffnessScale,
    compression: profile.suspensionCompression,
    relaxation: profile.suspensionRelaxation,
  };
  const frictionSlip = Math.min(profile.tireFrictionSlip * feel.gripScale, MAX_FRICTION_SLIP);
  const sideFrictionStiffness = profile.sideFrictionStiffness * feel.gripScale;

  // Body center spawns at box-bottom clearance above ground (per-car ride height).
  const spawnOriginY = halfHeight + feel.rideHeight;

  // COM low and central (planted, roll-resistant). comHeightScale>1 lowers it.
  // Also clamped to be at least MAX_COM_Y below center so even short cars (with
  // a tiny halfHeight) get the deep, anti-stoppie center of mass.
  const naturalComY = -halfHeight * DEFAULT_COM_DROP_FRACTION * feel.comHeightScale;
  const comOffset = {
    x: 0,
    y: Math.min(naturalComY, MAX_COM_Y),
    z: 0,
  };

  // Each strut hard-point sits `restLength` above where the (uncompressed) hub
  // rests. With the body at spawnOriginY and the hub world-Y at the wheel radius,
  // the hard-point ends up the same world height for every wheel — so the wheels
  // touch down together and the car settles square.
  const wheels: WheelGeometry[] = manifest.rig.wheels.map((w) => {
    const hubLocalY = w.radius - spawnOriginY;
    // Front wheels (steered) ride stiffer struts so the chassis can't dive far
    // enough to lift the rear during braking — basic geometric ABS support.
    const stiffness = suspension.stiffness * (w.isSteered ? FRONT_SUSPENSION_STIFFNESS_MUL : 1);
    return {
      connection: {
        x: w.position[0],
        y: hubLocalY + suspension.restLength,
        z: w.position[2],
      },
      radius: w.radius,
      isDriven: w.isDriven,
      isSteered: w.isSteered,
      stiffness,
    };
  });

  return {
    halfExtents,
    comOffset,
    spawnOriginY,
    suspension,
    frictionSlip,
    sideFrictionStiffness,
    wheels,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
