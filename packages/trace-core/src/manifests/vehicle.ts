import { z } from 'zod';
import { Vec3Schema } from '../math/vec';

/**
 * Vehicle manifest — physical + visual parameters needed to instantiate a car.
 *
 * Authoritative shape per blueprint §7.1. Driving feel emerges from the engine
 * power curve × gearbox × Rapier vehicle controller; the rig fields define
 * suspension geometry the controller uses.
 */
export const VehicleManifestSchema = z.object({
  id: z.string().regex(/^vehicle_[a-z0-9_]+$/, 'id must match /^vehicle_[a-z0-9_]+$/'),
  displayName: z.string().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver MAJOR.MINOR.PATCH'),

  /**
   * Vehicle kind. `bike` flips the renderer to the two-wheeled visual path
   * (static body + cosmetic lean + a posed rider, see `createBikeVisual`) and
   * the UI to a motorcycle label/icon. Absent → `car` (every existing manifest).
   * NOTE: a bike's *physics* rig is still a stable narrow four-wheel raycast
   * vehicle — the two visible wheels are cosmetic. This keeps the tuned
   * never-flip car dynamics; only the look changes.
   */
  class: z.enum(['car', 'bike']).optional(),

  visualMesh: z.string(),
  proxyMesh: z.string(),
  skinning: z.string(),

  /** Optional hero/preview image path (relative to the bundle dir), used by the
   * Garage car-select screen. Absent → the Garage falls back to its Lucide
   * silhouette glyph. */
  preview: z.string().optional(),

  rig: z.object({
    wheels: z
      .array(
        z.object({
          position: Vec3Schema,
          radius: z.number().positive(),
          isDriven: z.boolean(),
          isSteered: z.boolean(),
        }),
      )
      .min(2, 'at least two wheels required'),
    seat: Vec3Schema,
  }),

  mass: z.number().positive(),
  inertiaTensor: Vec3Schema,

  engine: z.object({
    powerCurveHpAtRpm: z
      .array(z.tuple([z.number().nonnegative(), z.number().nonnegative()]))
      .min(2, 'engine power curve needs at least two points'),
    redline: z.number().positive(),
  }),

  gearbox: z.object({
    ratios: z.array(z.number().positive()).min(1),
    final: z.number().positive(),
    type: z.enum(['manual', 'automatic', 'dct']),
  }),

  /**
   * Optional visual binding. When `format` is `glb`, the renderer loads a rigged
   * glTF/GLB instead of building the procedural body. Absent (or `procedural`),
   * the demo body in `@trace/renderer` is used (back-compat with vehicle_alpha).
   *
   * The four wheels each list the glTF node name(s) whose subtree is that wheel
   * (tire + rim + brake). Multiple names are allowed because some exports split
   * a single wheel across sibling nodes. The loader reparents each cluster onto
   * a pivot at its bounding-box center, so a node's own (possibly wrong) origin
   * doesn't matter — it spins about the true axle regardless.
   */
  visual: z
    .object({
      format: z.enum(['procedural', 'glb']),
      /** GLB/glTF path relative to the bundle dir, e.g. `model/scene.gltf`. */
      glb: z.string().optional(),
      /** Uniform scale applied to the loaded scene (model units → meters). */
      scale: z.number().positive().optional(),
      /** Yaw about Y (radians) to face the car's nose toward +Z (forward). */
      yaw: z.number().optional(),
      /** Post-fit nudge (game body-local meters) for fine alignment. */
      offset: Vec3Schema.optional(),
      /** glTF node names per wheel; subtree is reparented onto a spin pivot. */
      wheels: z
        .object({
          fl: z.array(z.string()).min(1),
          fr: z.array(z.string()).min(1),
          rl: z.array(z.string()).min(1),
          rr: z.array(z.string()).min(1),
        })
        .optional(),
      /**
       * Bike steering binding (class `bike` only). The GLB carries a `steer` node
       * whose origin is baked on the steering-head pivot, parenting `wheel_front`
       * + `grips`. The renderer turns that node about `axis` (a unit vector in the
       * model's body frame — the raked steering axis: roughly straight up, tilted
       * back by the rake angle) by the front wheel's steer angle, clamped to
       * ±`maxDeg`. Absent → the front wheel turns about pure vertical at its hub.
       */
      steer: z
        .object({
          /** Steering-axis unit vector in model/glTF body coords (x, up, fwd). */
          axis: Vec3Schema,
          /** Visual steering clamp at the front wheel, in degrees. */
          maxDeg: z.number().positive(),
        })
        .optional(),
    })
    .optional(),

  /**
   * Optional rider — a rigged humanoid (Mixamo `mixamorig:` skeleton) seated on
   * a bike. Loaded as FBX at runtime by `createBikeVisual`, posed into a riding
   * position via bone rotations, and parented to the bike's visual group so it
   * leans with the body. On a hard crash it plays `fallClip` (a Mixamo
   * falling/knockout clip) if provided. Ignored unless `class === 'bike'`.
   */
  rider: z
    .object({
      /** FBX path relative to the bundle dir, e.g. `rider/x_bot.fbx`. */
      fbx: z.string(),
      /** Optional Mixamo falling/knockout clip (FBX) played on a hard crash. */
      fallClip: z.string().optional(),
      /** Uniform scale (model units → meters). Mixamo exports are cm → ~0.01. */
      scale: z.number().positive().optional(),
      /** Seat-local placement nudge (meters) for fine alignment on the seat. */
      offset: Vec3Schema.optional(),
      /** Crash-impact magnitude (N·s) above which the fall animation triggers. */
      crashImpulse: z.number().positive().optional(),
    })
    .optional(),

  /**
   * Optional per-car dynamics tuning. These override the global feel constants
   * in `@trace/physics` so each car brakes, launches, steers, and rolls
   * differently. Anything omitted falls back to the package default, so a
   * manifest without `tuning` (vehicle_alpha) is unchanged.
   */
  tuning: z
    .object({
      /** Traction-limited launch acceleration cap, in g. */
      driveAccelG: z.number().positive().optional(),
      /** Peak braking deceleration (foot brake / S), in g. */
      brakeDecelG: z.number().positive().optional(),
      /**
       * Handbrake (Space) force as a multiple of the foot-brake budget. >1 makes
       * the handbrake the stronger brake, so the foot brake is ≈1/mul of it.
       */
      handbrakeForceMul: z.number().positive().optional(),
      /** Reverse acceleration, in g. */
      reverseAccelG: z.number().positive().optional(),
      /** Reverse top-speed multiplier (1 = ≈50 km/h). */
      maxReverseSpeedMul: z.number().positive().optional(),
      /** Steering lock at the front wheels, in degrees. */
      maxSteerDeg: z.number().positive().optional(),
      /** Speed (m/s) at which steering lock has halved — lower = twitchier. */
      steerSpeedScale: z.number().positive().optional(),
      /** Chassis linear damping (coasting drag); lower = freer high-speed coast. */
      linearDamping: z.number().nonnegative().optional(),
      /**
       * Chassis angular damping (yaw/roll/pitch rate drag). Higher = more planted,
       * resists oversteer (the rear can't snap around); lower = looser, slides more
       * freely. The main lever for how much the car wants to rotate.
       */
      angularDamping: z.number().nonnegative().optional(),
      /** Off-throttle engine-braking (coast-down) deceleration, in g. */
      engineBrakeG: z.number().nonnegative().optional(),
      /** Brake-park hold deceleration (firm parking hold on a slope), in g. */
      holdG: z.number().nonnegative().optional(),
      /** Anti-roll restoring gain (1/s², scaled by roll inertia at runtime). */
      antirollKp: z.number().nonnegative().optional(),
      /** Anti-roll/anti-pitch tilt-rate damping gain (1/s, scaled by roll inertia). */
      antirollKd: z.number().nonnegative().optional(),
      /**
       * Gated anti-stoppie/anti-wheelie pitch-restoring gain (1/s², scaled by
       * pitch inertia). Engages only when one axle lifts off — keeps the rear
       * seated under hard braking so the car skids flat instead of tipping.
       */
      antipitchKp: z.number().nonnegative().optional(),
      /** Front brake torque share, 0..1. */
      frontBrakeBias: z.number().min(0).max(1).optional(),
      /** Multiplier on the (mass-scaled) suspension spring stiffness. */
      suspensionStiffnessScale: z.number().positive().optional(),
      /** Multiplier on suspension rest length + max travel (ride height/squish). */
      suspensionTravelScale: z.number().positive().optional(),
      /** Multiplier on lateral tire grip (side friction + friction slip). */
      gripScale: z.number().positive().optional(),
      /** Center-of-mass height factor; >1 lowers it (more planted), <1 raises it. */
      comHeightScale: z.number().positive().optional(),
      /**
       * Static ground clearance (chassis-bottom to ground, meters) the car
       * settles to at rest. Raises the whole body relative to its wheels — use
       * a larger value for tall off-roaders (e.g. the Hummer). Default ~0.3.
       */
      rideHeight: z.number().positive().optional(),
    })
    .optional(),

  /**
   * Optional engine-sound profile for the WebAudio synth. `electric` skips the
   * gear model and emits a rising inverter whine (the Hummer EV); the others
   * derive RPM from wheel speed × gearbox and shape combustion harmonics.
   */
  audio: z
    .object({
      kind: z.enum(['v8', 'flat', 'inline', 'electric']),
      /** Tone frequency at idle (Hz). */
      idleHz: z.number().positive(),
      /** Tone frequency at redline (Hz). */
      revHz: z.number().positive(),
      /** Master gain 0..1. */
      gain: z.number().min(0).max(1).optional(),
    })
    .optional(),

  credits: z.string().optional(),
});

export type VehicleManifest = z.infer<typeof VehicleManifestSchema>;
export type GearboxType = VehicleManifest['gearbox']['type'];
export type VehicleVisualConfig = NonNullable<VehicleManifest['visual']>;
export type VehicleRiderConfig = NonNullable<VehicleManifest['rider']>;
export type VehicleTuning = NonNullable<VehicleManifest['tuning']>;
export type VehicleAudioProfile = NonNullable<VehicleManifest['audio']>;

/**
 * URL path where a vehicle bundle's manifest lives.
 *
 * @example
 *   vehicleManifestPath('vehicle_alpha', '0.1.0')
 *   // '/assets/vehicles/vehicle_alpha/v0.1.0/manifest.json'
 */
export function vehicleManifestPath(id: string, version: string): string {
  return `/assets/vehicles/${id}/v${version}/manifest.json`;
}

/** Directory holding a vehicle bundle. */
export function vehicleBundleDir(id: string, version: string): string {
  return `/assets/vehicles/${id}/v${version}`;
}
