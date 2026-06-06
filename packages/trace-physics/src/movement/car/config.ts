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
 * Default peak braking deceleration (m/s²) — the *budget* both pedals scale.
 * The foot brake (S) uses it at full strength across all four wheels; the
 * handbrake (Space) multiplies it by {@link DEFAULT_HANDBRAKE_FORCE_MUL} on the
 * locked rear so Space is the stronger reference and S lands at ≈1/mul of it
 * (the "S = ~65 % of Space" request). 9 m/s² ≈ 0.92 g — a firm, planted stop;
 * the brake input ramp (`input.ts`) plus the anti-pitch rate damping in the
 * stabilizer keep this from pitching the chassis into a stoppie. Sport cars
 * override via `manifest.tuning.brakeDecelG`.
 */
export const DEFAULT_PEAK_DECEL_MS2 = 9;
/**
 * Handbrake (Space) force as a multiple of the foot-brake budget. >1 makes the
 * handbrake the firmer brake, so the foot brake (S) is ≈1/mul = 67 % of it —
 * the "same as Space but 60–70 % power" feel. Also lends Space a harder rear
 * lock for drift initiation. Overridable via `manifest.tuning.handbrakeForceMul`.
 */
export const DEFAULT_HANDBRAKE_FORCE_MUL = 1.5;
/** Default reverse acceleration — weaker than forward, still perceptible. */
export const DEFAULT_REVERSE_ACCEL_MS2 = 4.5;
/**
 * Top reverse speed (m/s) ≈ 50 km/h — fast enough to back out of a corner at
 * pace, matching the player-requested reverse cap. The drivetrain holds full
 * reverse force up to {@link REVERSE_PLATEAU_FRAC} of this value, then tapers to
 * zero at the cap so the approach is smooth instead of a cliff. Scaled per car
 * by `manifest.tuning.maxReverseSpeedMul`.
 */
export const MAX_REVERSE_SPEED_MS = 13.89;
/**
 * Fraction of {@link MAX_REVERSE_SPEED_MS} where the reverse force *starts*
 * tapering. Below this fraction, force is at 100 % — gives a punchy, responsive
 * reverse from rest instead of the previous linear-from-zero soft cap that
 * felt sluggish near standstill.
 */
export const REVERSE_PLATEAU_FRAC = 0.8;
/** Default brake bias — 60 % front / 40 % rear (per the brake-fix spec). */
export const DEFAULT_FRONT_BRAKE_BIAS = 0.6;
/** Default steering lock (deg). Trimmed 32 → 30 so corner entry is less twitchy. */
export const DEFAULT_MAX_STEER_DEG = 30;
/**
 * Speed (m/s) at which steering lock has halved. Raised 18 → 22 so the lock
 * fades a touch more gently with speed — the car still tightens up at pace
 * (less twitch, less roll moment) without feeling numb in fast sweepers.
 */
export const DEFAULT_STEER_SPEED_SCALE = 22;

// ── Coasting drag ────────────────────────────────────────────────────────────
/**
 * Chassis linear damping — velocity-proportional drag (Rapier units). Kept low
 * so a car coasting at speed carries its momentum instead of braking itself down
 * the instant the player lifts off (the high-speed term is `damping × speed`, so
 * this is what dominates coast-down at 200+ km/h). The *firm* low-speed stop is
 * the speed-gated engine braking + auto-hold below, not this. Per-car via
 * `manifest.tuning.linearDamping`.
 */
export const DEFAULT_LINEAR_DAMPING = 0.02;

// ── Off-throttle behaviour: engine braking + auto-hold (creep arrest) ─────────
/**
 * Engine-braking deceleration (m/s²) applied at the wheels when the player is
 * off both pedals — but ONLY below {@link COAST_BRAKE_FADE_END_MS}, ramping to
 * full at/under {@link COAST_BRAKE_FADE_START_MS}. So lifting off at speed lets
 * the car coast freely (realistic momentum), while under ~50 km/h it bleeds the
 * last of the speed off in a couple of seconds before the auto-hold parks it.
 * Per-car via `manifest.tuning.engineBrakeG`.
 */
export const DEFAULT_ENGINE_BRAKE_DECEL_MS2 = 3;
/**
 * At/below this speed (m/s ≈ 50 km/h) engine braking is at full strength — this
 * is the "stops in a couple of seconds, but only when slow" band the player
 * asked for.
 */
export const COAST_BRAKE_FADE_START_MS = 13.89;
/**
 * Above this speed (m/s ≈ 75 km/h) engine braking is OFF entirely — high-speed
 * coasting must keep rolling, not stop itself in a few seconds. Between the two
 * thresholds it fades linearly.
 */
export const COAST_BRAKE_FADE_END_MS = 20.83;
/**
 * Auto-hold deceleration (m/s²) — a firm brake clamped onto every wheel once the
 * car has coasted to a crawl with no pedal input, so it comes to a *complete*
 * stop and stays put on a slope instead of creeping. 5 m/s² ≈ 0.5 g holds well
 * past any drivable grade. Per-car via `manifest.tuning.holdG`.
 */
export const DEFAULT_HOLD_DECEL_MS2 = 5;
/**
 * Engage the auto-hold below this speed (m/s). Kept under {@link
 * ABS_MIN_VEHICLE_SPEED_MS} so ABS is already disabled at the hold point and the
 * brake locks solid instead of pulsing.
 */
export const HOLD_ENGAGE_MS = 0.9;
/**
 * Release the auto-hold once the car is moving faster than this (m/s) — e.g. it
 * slid off on a steep grade, or the player tapped the throttle. The engage/
 * release gap is hysteresis so the hold doesn't chatter at the threshold.
 */
export const HOLD_RELEASE_MS = 1.4;

// ── Stability assist (anti-roll + anti-pitch-rate) ───────────────────────────
/**
 * Anti-roll proportional gain (1/s² — a restoring angular acceleration per rad
 * of body roll, scaled by the car's roll inertia at use so it's mass-agnostic).
 * Catches a developing roll-over before it tips; the deadzone below leaves
 * gentle cornering lean intact. Per-car via `manifest.tuning.antirollKp`.
 */
export const DEFAULT_ANTIROLL_KP = 50;
/**
 * Anti-roll/anti-pitch derivative gain (1/s). Damps the chassis tilt *rate*
 * (roll AND pitch, never yaw), so quick tip-ups and brake nose-dives are bled
 * off while a car settled on a slope is left alone (a static incline has zero
 * tilt rate). ≈ critical with {@link DEFAULT_ANTIROLL_KP}. Per-car via
 * `manifest.tuning.antirollKd`.
 */
export const DEFAULT_ANTIROLL_KD = 14;
/** Roll inside this angle (rad) is left untouched — natural cornering lean. */
export const ANTIROLL_DEADZONE_RAD = 3.5 * DEG;
/** Clamp the roll fed to the restoring term (rad) so a flipped car can't blow up. */
export const MAX_ANTIROLL_ANGLE_RAD = Math.PI / 4;
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
  /** Handbrake force as a multiple of the foot-brake budget (Space vs S). */
  handbrakeForceMul: number;
  reverseAccelMs2: number;
  /** Reverse top-speed multiplier (1 = {@link MAX_REVERSE_SPEED_MS} ≈ 50 km/h). */
  maxReverseSpeedMul: number;
  frontBrakeBias: number;
  maxSteerRad: number;
  steerSpeedScale: number;
  /** Chassis linear damping (velocity-proportional coasting drag). */
  linearDamping: number;
  /** Off-throttle engine-braking decel (m/s²), applied speed-gated. */
  engineBrakeDecelMs2: number;
  /** Auto-hold decel (m/s²) that arrests creep at a standstill. */
  holdDecelMs2: number;
  /** Anti-roll restoring gain (1/s², scaled by roll inertia at use). */
  antirollKp: number;
  /** Anti-roll/anti-pitch tilt-rate damping gain (1/s, scaled by roll inertia). */
  antirollKd: number;
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
    handbrakeForceMul: t?.handbrakeForceMul ?? DEFAULT_HANDBRAKE_FORCE_MUL,
    reverseAccelMs2: t?.reverseAccelG != null ? t.reverseAccelG * G : DEFAULT_REVERSE_ACCEL_MS2,
    maxReverseSpeedMul: t?.maxReverseSpeedMul ?? 1,
    frontBrakeBias: t?.frontBrakeBias ?? DEFAULT_FRONT_BRAKE_BIAS,
    maxSteerRad: (t?.maxSteerDeg ?? DEFAULT_MAX_STEER_DEG) * DEG,
    steerSpeedScale: t?.steerSpeedScale ?? DEFAULT_STEER_SPEED_SCALE,
    linearDamping: t?.linearDamping ?? DEFAULT_LINEAR_DAMPING,
    engineBrakeDecelMs2: t?.engineBrakeG != null ? t.engineBrakeG * G : DEFAULT_ENGINE_BRAKE_DECEL_MS2,
    holdDecelMs2: t?.holdG != null ? t.holdG * G : DEFAULT_HOLD_DECEL_MS2,
    antirollKp: t?.antirollKp ?? DEFAULT_ANTIROLL_KP,
    antirollKd: t?.antirollKd ?? DEFAULT_ANTIROLL_KD,
    comHeightScale: t?.comHeightScale ?? 1,
    suspensionStiffnessScale: t?.suspensionStiffnessScale ?? 1,
    suspensionTravelScale: t?.suspensionTravelScale ?? 1,
    gripScale: t?.gripScale ?? 1,
    rideHeight: t?.rideHeight ?? DEFAULT_GROUND_CLEARANCE,
  };
}
