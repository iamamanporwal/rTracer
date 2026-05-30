import type RAPIER from '@dimforge/rapier3d-compat';
import type { Quat, Vec3, VehicleManifest } from '@trace/core';
import type { PhysicsProfile } from '../profiles';
import type { ControlInput } from '../input';

/**
 * Movement framework contracts — the seam every locomotion type plugs into.
 *
 * Phase 1 implements `'car'` (Rapier raycast vehicle). Bikes, planes, and
 * animals are first-class *kinds* here so they can be added as separate
 * controllers later without touching the session, renderer, or this contract —
 * the runtime only ever sees a {@link MovementController}. Keeping the surface
 * narrow (snapshot in, input each tick, debug frame out) is what makes the
 * framework extensible without overengineering any single kind.
 */
export type MovementKind = 'car' | 'bike' | 'plane' | 'animal';

/** Spawn pose in world space. */
export type MovementSpawn = {
  position: Vec3;
  rotation: Quat;
};

/** Back-compat alias — cars spawned via the old name. */
export type VehicleSpawn = MovementSpawn;

export type WheelSnapshot = {
  /** World-space position of the wheel center. */
  position: { x: number; y: number; z: number };
  /** Steering angle in radians; positive = right. */
  steering: number;
  /** Cumulative spin angle in radians. */
  rotation: number;
  /** Whether the wheel is in ground contact this frame. */
  inContact: boolean;
  /**
   * World-space ground contact point for this wheel. Equal to the projected
   * ray end when airborne; the renderer uses it as the seed for skid marks
   * and tire-smoke effects, but only when {@link inContact} is true AND
   * {@link slip} > 0.
   */
  contact: { x: number; y: number; z: number };
  /**
   * Tire slip magnitude this tick, 0..1. Drives every ground-contact effect:
   * - **0** baseline rolling tire
   * - **handbrake drift** rear wheels: `min(handbrake * speed/V_REF, 1)`
   * - **burnout** driven wheels: forced to 1 while throttle+brake are both held
   *   at low speed
   * - **ABS pulse** front wheels: 0.6 the tick a wheel is latched locked
   * Combined into a single number because the visual layer doesn't care WHY
   * the tire is sliding, only how hard.
   */
  slip: number;
};

/**
 * World-space pose snapshot read once per render frame and fed to the visual.
 * Generic across kinds: a bike fills two `wheels`, a quadruped could map feet to
 * the same array. The renderer only reads `position`/`rotation`/`wheels`.
 */
export type MovementSnapshot = {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  /** Forward speed (m/s) as reported by the controller. */
  speed: number;
  wheels: WheelSnapshot[];
};

/** Back-compat alias for the car snapshot. */
export type VehicleSnapshot = MovementSnapshot;

/**
 * Per-contact-point debug data for the visualizer overlay. Plain numbers only —
 * no Rapier types cross into the renderer, keeping physics ⇄ render decoupled.
 */
export type MovementDebugContact = {
  /** World-space ray-cast start (strut top / hard point). */
  hardPoint: { x: number; y: number; z: number };
  /** World-space wheel/foot center. */
  center: { x: number; y: number; z: number };
  /** World-space ground contact (equals projected ray end when airborne). */
  contact: { x: number; y: number; z: number };
  inContact: boolean;
  /** Suspension spring force this tick (Rapier units; 0 when airborne). */
  suspensionForce: number;
};

export type MovementDebugFrame = {
  /** World-space center of mass. */
  comWorld: { x: number; y: number; z: number };
  /** World-space linear velocity (m/s). */
  velocity: { x: number; y: number; z: number };
  contacts: MovementDebugContact[];
};

/**
 * The one interface the runtime depends on. Implementations own their Rapier
 * bodies/controllers; callers drive them with {@link update} inside the fixed
 * step and read poses with {@link readSnapshot} at render time.
 */
export interface MovementController {
  readonly kind: MovementKind;
  /** The chassis/root rigid body. Read for visual sync; do not free directly. */
  readonly body: RAPIER.RigidBody;
  /** World-space pose snapshot — alloc-free, reused buffer. */
  readSnapshot(): MovementSnapshot;
  /** Debug-overlay frame — alloc-free, reused buffer. */
  readDebugFrame(): MovementDebugFrame;
  /**
   * Apply input + advance the controller by `dt`. Call once per fixed physics
   * step, BEFORE `world.step()` so suspension/contact forces feed integration.
   */
  update(input: ControlInput, dt: number): void;
  /**
   * Live grip multiplier overlay (clamped to [0.1, 1]) — multiplies the
   * zone profile's tire friction-slip + side-friction-stiffness each tick.
   * The seam the weather system uses to make wet roads slippery without
   * mutating the zone's authoritative physics profile (Blueprint §6.3).
   * 1 = dry baseline (default); 0.6 ≈ wet; 0.3 ≈ icy.
   */
  setGripMultiplier(multiplier: number): void;
  /** Teleport back to the spawn pose with zero velocity. */
  reset(spawn?: MovementSpawn): void;
  /** Free controller-owned memory. */
  dispose(): void;
}

/**
 * Car controller handle — a {@link MovementController} plus two fields the
 * vehicle visual needs. Kept as a distinct exported name for back-compat.
 */
export interface VehicleHandle extends MovementController {
  readonly kind: 'car';
  /** Wheel count, fixed at construction. */
  readonly wheelCount: number;
  /**
   * Settled body-local Y of the wheel hub at rest. A GLB visual uses this to
   * seat the body mesh at the correct height relative to the wheels.
   */
  readonly restHubLocalY: number;
}

export type CreateMovementOptions = {
  /** Which controller to build. Defaults to `'car'`. */
  kind?: MovementKind;
  manifest: VehicleManifest;
  profile: PhysicsProfile;
  spawn: MovementSpawn;
};

/** Car-only options (back-compat with `createVehicle`). */
export type CreateVehicleOptions = {
  manifest: VehicleManifest;
  profile: PhysicsProfile;
  spawn: MovementSpawn;
};
