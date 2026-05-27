import type { SurfaceTag } from '@trace/core';
import { DEFAULT_SURFACE_FRICTION } from '@trace/core';

/**
 * Physics profile parameter sets per blueprint §6.3.
 *
 * A profile is a parameter bundle, not a separate engine. Switching mid-session
 * is unsupported (per §6.3); the zone load sequence applies the profile once,
 * before the vehicle spawns.
 */
export type PhysicsProfileId = 'tarmac_circuit' | 'dirt' | 'snow' | 'drift';

export type PhysicsProfile = {
  id: PhysicsProfileId;
  /** Friction coefficient overrides by surface tag. Anything missing falls back to {@link DEFAULT_SURFACE_FRICTION}. */
  surfaceFriction: Partial<Record<SurfaceTag, number>>;
  /** Tire lateral friction-slip parameter passed to Rapier's vehicle controller. */
  tireFrictionSlip: number;
  /** Side friction stiffness — how aggressively lateral grip resists sliding. */
  sideFrictionStiffness: number;
  /** Suspension spring stiffness (Rapier units). */
  suspensionStiffness: number;
  /** Damping while suspension compresses. */
  suspensionCompression: number;
  /** Damping while suspension extends back. */
  suspensionRelaxation: number;
  /** Rest length of suspension spring (meters). */
  suspensionRestLength: number;
  /** Maximum suspension travel either side of rest (meters). */
  suspensionMaxTravel: number;
  /** Engine drag at zero throttle, applied as % of max engine force. */
  rollResistance: number;
};

export const PHYSICS_PROFILES: Record<PhysicsProfileId, PhysicsProfile> = {
  tarmac_circuit: {
    id: 'tarmac_circuit',
    surfaceFriction: { tarmac: 1.0, kerb: 0.85, grass: 0.45 },
    tireFrictionSlip: 5.0,
    sideFrictionStiffness: 1.0,
    suspensionStiffness: 40,
    suspensionCompression: 0.85,
    suspensionRelaxation: 0.88,
    suspensionRestLength: 0.4,
    suspensionMaxTravel: 0.5,
    rollResistance: 0.015,
  },
  dirt: {
    id: 'dirt',
    surfaceFriction: { tarmac: 0.95, dirt: 0.75, gravel: 0.65, grass: 0.55 },
    tireFrictionSlip: 3.5,
    sideFrictionStiffness: 0.8,
    suspensionStiffness: 28,
    suspensionCompression: 0.6,
    suspensionRelaxation: 0.65,
    suspensionRestLength: 0.45,
    suspensionMaxTravel: 0.7,
    rollResistance: 0.03,
  },
  snow: {
    id: 'snow',
    surfaceFriction: { tarmac: 0.6, snow: 0.3, grass: 0.4 },
    tireFrictionSlip: 2.2,
    sideFrictionStiffness: 0.55,
    suspensionStiffness: 32,
    suspensionCompression: 0.7,
    suspensionRelaxation: 0.75,
    suspensionRestLength: 0.42,
    suspensionMaxTravel: 0.55,
    rollResistance: 0.025,
  },
  drift: {
    id: 'drift',
    surfaceFriction: { tarmac: 0.85, kerb: 0.7 },
    tireFrictionSlip: 3.0,
    sideFrictionStiffness: 0.4,
    suspensionStiffness: 36,
    suspensionCompression: 0.8,
    suspensionRelaxation: 0.82,
    suspensionRestLength: 0.4,
    suspensionMaxTravel: 0.5,
    rollResistance: 0.02,
  },
};

/** Resolve effective friction for a surface tag under a profile, with fallback. */
export function frictionFor(profile: PhysicsProfile, tag: SurfaceTag): number {
  return profile.surfaceFriction[tag] ?? DEFAULT_SURFACE_FRICTION[tag];
}
