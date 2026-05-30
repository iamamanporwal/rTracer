import type { VehicleManifest } from '@trace/core';

/**
 * Car controller constants — axis conventions, sign locks, and default feel.
 *
 * Centralized here so the magic isn't scattered through the controller. The two
 * sign locks below are the historically fiddly part; they are pinned by the
 * drive-direction test (`vehicle.drive.test.ts`), so changing them safely means
 * re-deriving the whole forward/steer/reverse chain.
 */

// ── Rapier axis convention ───────────────────────────────────────────────────
/** Chassis-local up axis index (0=x, 1=y, 2=z). */
export const UP_AXIS = 1;
/** Chassis-local forward axis index. */
export const FORWARD_AXIS = 2;
/** Suspension ray direction in chassis space (straight down). */
export const SUSPENSION_DIR = { x: 0, y: -1, z: 0 } as const;
/** Wheel axle axis in chassis space (across the car). */
export const AXLE_DIR = { x: 1, y: 0, z: 0 } as const;

/**
 * Sign of the chassis-local forward axis (+Z) that throttle pushes toward.
 *
 * Rapier's raycast vehicle accelerates *opposite* to a naive reading of its
 * forward-axis index: a positive `setWheelEngineForce` moves the chassis toward
 * −Z. The chase camera sits behind the nose at local −Z and the steered (front)
 * wheels are at +Z, so "forward" must be +Z. We therefore drive with −1 so
 * throttle pushes the car toward +Z (away from the camera). Threaded through
 * engine force, reverse force, and signed speed so this one knob stays
 * consistent. Locked by the drive-direction test.
 */
export const FORWARD_SIGN = -1;
/**
 * Sign mapping steering input (`+1` = the player's right, the D key) to Rapier's
 * wheel steering angle. Inverted for the same reason as {@link FORWARD_SIGN}:
 * because the car drives toward +Z (opposite Rapier's native forward), steering
 * is mirrored too, else A/D — and the visible front wheels — turn the wrong way.
 */
export const STEER_SIGN = -1;

// ── Physical constants ───────────────────────────────────────────────────────
export const G = 9.81;
export const HP_TO_WATTS = 745.7;
/** Reference speed (m/s) below which the power/speed force model is clamped. */
export const REF_SPEED_MS = 8;
/** Reference mass the base profile suspension was tuned at (vehicle_alpha). */
export const REFERENCE_MASS = 1200;
export const DEG = Math.PI / 180;
/**
 * Below this forward speed (m/s) the brake input is treated as reverse. Kept
 * small so the foot-brake → reverse handoff happens just before standstill —
 * pressing S while rolling at walking pace still finishes braking, then engages
 * reverse smoothly when the car is essentially stopped.
 */
export const REVERSE_THRESHOLD_MS = 0.3;

// ── Default feel (overridable per car via manifest.tuning) ───────────────────
/** Default acceleration cap (m/s²) so raw power can't launch/flip the car. */
export const DEFAULT_DRIVE_ACCEL_MS2 = 5.5;
/**
 * Default peak braking deceleration (m/s²). Tuned down from 8 → 6 so the
 * default S-brake doesn't pitch the chassis into a stoppie even before ABS
 * modulation kicks in. Sport cars override via `manifest.tuning.brakeDecelG`.
 */
export const DEFAULT_PEAK_DECEL_MS2 = 6;
/** Default reverse acceleration — weaker than forward, still perceptible. */
export const DEFAULT_REVERSE_ACCEL_MS2 = 4.5;
/**
 * Top reverse speed (m/s). Tuned to ≈13 km/h (10–15 km/h band) so reverse
 * matches real-car feel — fast enough to manoeuvre, slow enough to be safe.
 * The drivetrain holds full reverse force up to {@link REVERSE_PLATEAU_FRAC}
 * of this value, then tapers to zero at the cap so the approach is smooth
 * instead of a cliff.
 */
export const MAX_REVERSE_SPEED_MS = 3.6;
/**
 * Fraction of {@link MAX_REVERSE_SPEED_MS} where the reverse force *starts*
 * tapering. Below this fraction, force is at 100 % — gives a punchy, responsive
 * reverse from rest instead of the previous linear-from-zero soft cap that
 * felt sluggish near standstill.
 */
export const REVERSE_PLATEAU_FRAC = 0.8;
/** Default brake bias — 60 % front / 40 % rear (per the brake-fix spec). */
export const DEFAULT_FRONT_BRAKE_BIAS = 0.6;
export const DEFAULT_MAX_STEER_DEG = 32;
export const DEFAULT_STEER_SPEED_SCALE = 18;
/** Fraction of chassis half-height the COM sits below center at comHeightScale=1. */
export const DEFAULT_COM_DROP_FRACTION = 0.8;
/**
 * Hard upper bound on the COM Y (chassis-local) — i.e. the COM is always at
 * least this far below the geometric center. Keeps tall cars planted and stops
 * the chassis from pitching forward enough to lift the rear under braking.
 */
export const MAX_COM_Y = -0.4;
/**
 * Front struts ride this much stiffer than the rear. Stoppie suppression: the
 * front compresses less under braking weight transfer, so the rear stays seated
 * instead of unweighting and lifting off.
 */
export const FRONT_SUSPENSION_STIFFNESS_MUL = 1.3;
/** Chassis box bottom clearance above ground at the spawn pose (meters). */
export const DEFAULT_GROUND_CLEARANCE = 0.3;

// ── ABS (basic anti-lock; controller-side) ───────────────────────────────────
/**
 * Vehicle speed below which ABS is disabled — at a crawl the brake should just
 * lock the wheels and hold the car still.
 */
export const ABS_MIN_VEHICLE_SPEED_MS = 1.2;
/**
 * Wheel angular speed (|rad/s|) below which ABS treats the wheel as locked and
 * drops its brake force to zero for the tick.
 */
export const ABS_LOCK_RAD_S = 0.6;
/**
 * Once locked, ABS holds the brake released until the wheel spins this fast
 * again — gives a clear release/grab pulse instead of dithering on the edge.
 */
export const ABS_RELEASE_RAD_S = 4;
/**
 * Lateral grip multiplier applied to the rear wheels while the handbrake is
 * held — the GTA "yank the handbrake and the back steps out" drift. <1 breaks
 * rear traction; the front keeps biting so the car rotates.
 */
export const HANDBRAKE_REAR_GRIP_MUL = 0.35;
/** Hard cap on effective tire friction-slip (Rapier flips cars above ~7). */
export const MAX_FRICTION_SLIP = 6.5;

// ── Burnout (W+S held while at a crawl) ──────────────────────────────────────
/**
 * Both throttle and brake must exceed this threshold for the controller to
 * recognise the "two-pedal launch" gesture. 0.5 keeps drag-strip burnouts
 * intentional — a hesitant tap on either pedal won't trigger it.
 */
export const BURNOUT_INPUT_THRESHOLD = 0.5;
/**
 * Chassis speed (m/s) below which the burnout gesture engages. Above this the
 * brake pedal returns to normal "slow the car" duty so the player can mash
 * brake-while-throttle at speed without the rear wheels suddenly free-wheeling.
 * 2.5 m/s ≈ 9 km/h — slow rolling launch is fine; cruising is not.
 */
export const BURNOUT_MAX_SPEED_MS = 2.5;
/**
 * Multiplier applied to driven-wheel longitudinal friction-slip during a
 * burnout. Cut hard so the rear tires spin freely instead of transferring full
 * engine force to the chassis — the player sees wheelspin, smoke, and a slow
 * rolling launch instead of an instant pop off the line.
 */
export const BURNOUT_DRIVEN_SLIP_MUL = 0.15;
/**
 * Multiplier applied to driven-wheel side-friction-stiffness during a burnout.
 * Mirrors the handbrake — without it, even with longitudinal slip cut, the
 * rear stays glued laterally and you can't induce a rolling spin/donut by
 * steering during the burnout.
 */
export const BURNOUT_DRIVEN_SIDE_GRIP_MUL = 0.35;
/**
 * Foot-brake fraction applied to non-driven (front, steered) wheels during a
 * burnout — they have to bite hard to hold the chassis while the rear spins.
 * 1.0 = full braking force on the fronts.
 */
export const BURNOUT_FRONT_BRAKE_FRAC = 1;

// ── Tire slip signal (drives skid marks + smoke in the renderer) ─────────────
/**
 * Reference speed (m/s) above which the handbrake produces full slip on the
 * rear axle. Below this speed slip scales linearly with speed so a Space-press
 * at standstill doesn't paint a mark.
 */
export const HANDBRAKE_SLIP_REF_SPEED_MS = 3;
/** Slip threshold below which the wheel is considered "rolling" — no FX. */
export const SLIP_FX_THRESHOLD = 0.18;
/** Slip value the controller reports the tick an ABS-latched wheel is locked. */
export const ABS_LOCK_SLIP_VALUE = 0.6;
/** Minimum chassis speed (m/s) for an ABS lock to be considered a visible skid. */
export const ABS_LOCK_SLIP_MIN_SPEED_MS = 2;

/** Resolved, per-car feel — defaults merged with `manifest.tuning`. */
export type CarFeel = {
  driveAccelMs2: number;
  peakDecelMs2: number;
  reverseAccelMs2: number;
  frontBrakeBias: number;
  maxSteerRad: number;
  steerSpeedScale: number;
  comHeightScale: number;
  suspensionStiffnessScale: number;
  suspensionTravelScale: number;
  gripScale: number;
  /** Static ground clearance (chassis-bottom to ground, m) the body rests at. */
  rideHeight: number;
};

/** Merge a manifest's optional `tuning` block with the package defaults. */
export function resolveCarFeel(manifest: VehicleManifest): CarFeel {
  const t = manifest.tuning;
  return {
    driveAccelMs2: t?.driveAccelG != null ? t.driveAccelG * G : DEFAULT_DRIVE_ACCEL_MS2,
    peakDecelMs2: t?.brakeDecelG != null ? t.brakeDecelG * G : DEFAULT_PEAK_DECEL_MS2,
    reverseAccelMs2: t?.reverseAccelG != null ? t.reverseAccelG * G : DEFAULT_REVERSE_ACCEL_MS2,
    frontBrakeBias: t?.frontBrakeBias ?? DEFAULT_FRONT_BRAKE_BIAS,
    maxSteerRad: (t?.maxSteerDeg ?? DEFAULT_MAX_STEER_DEG) * DEG,
    steerSpeedScale: t?.steerSpeedScale ?? DEFAULT_STEER_SPEED_SCALE,
    comHeightScale: t?.comHeightScale ?? 1,
    suspensionStiffnessScale: t?.suspensionStiffnessScale ?? 1,
    suspensionTravelScale: t?.suspensionTravelScale ?? 1,
    gripScale: t?.gripScale ?? 1,
    rideHeight: t?.rideHeight ?? DEFAULT_GROUND_CLEARANCE,
  };
}
