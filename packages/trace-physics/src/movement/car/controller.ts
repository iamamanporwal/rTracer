import RAPIER from '@dimforge/rapier3d-compat';
import type { Quat, Vec3 } from '@trace/core';
import { clampInput, NEUTRAL_INPUT, type ControlInput } from '../../input';
import type {
  CreateVehicleOptions,
  MovementDebugFrame,
  MovementSpawn,
  VehicleHandle,
  VehicleSnapshot,
} from '../types';
import {
  ABS_LOCK_RAD_S,
  ABS_LOCK_SLIP_MIN_SPEED_MS,
  ABS_LOCK_SLIP_VALUE,
  ABS_MIN_VEHICLE_SPEED_MS,
  ABS_RELEASE_RAD_S,
  ANTIROLL_DEADZONE_RAD,
  AXLE_DIR,
  BURNOUT_DRIVEN_SIDE_GRIP_MUL,
  BURNOUT_DRIVEN_SLIP_MUL,
  BURNOUT_FRONT_BRAKE_FRAC,
  BURNOUT_INPUT_THRESHOLD,
  BURNOUT_MAX_SPEED_MS,
  COAST_BRAKE_FADE_END_MS,
  COAST_BRAKE_FADE_START_MS,
  COAST_BRAKE_TAPER_MS,
  FORWARD_AXIS,
  FORWARD_SIGN,
  HANDBRAKE_SLIP_REF_SPEED_MS,
  MAX_ANTIROLL_ANGLE_RAD,
  MAX_REVERSE_SPEED_MS,
  PARK_BRAKE_SPEED_MS,
  resolveCarFeel,
  REVERSE_ENGAGE_DELAY_S,
  SLOPE_DETECT_MS2,
  SUSPENSION_DIR,
  UP_AXIS,
} from './config';
import { deriveCarChassis, deriveRestHubLocalY } from './chassis';
import { computeDriveCommand, deriveDrivetrainParams } from './drivetrain';

/**
 * Car controller — one chassis rigid body plus Rapier's official
 * `DynamicRayCastVehicleController` (blueprint §7.2). No baked animation: every
 * wheel pose is integrated from raycast contact + spring/damper forces.
 *
 * This file is *only* the Rapier wiring. Geometry/COM derivation lives in
 * `chassis.ts`, the force/steer model in `drivetrain.ts`, and the constants in
 * `config.ts` — so the physics feel can be tuned and tested without touching the
 * controller, and other movement kinds can follow the same split.
 */

const SETTLE_DT = 1 / 60;
/** Maximum steps before the settle loop gives up waiting for stability. */
const SETTLE_MAX_STEPS = 500;
/** Minimum steps before stability is checked (let the car start moving first). */
const SETTLE_MIN_STEPS = 30;
/** Consecutive stable steps required to declare the car settled. */
const SETTLE_STABLE_COUNT = 10;
/** Body velocity (m/s) below which the car is considered stable. */
const SETTLE_VEL_THRESHOLD = 0.05;

/**
 * Minimum summed contact force (Rapier units) on the chassis collider before a
 * contact-force event fires. Tuned to ignore suspension settle / light curb
 * scrapes while still catching any genuine crash into a steel crate or wall.
 */
const CHASSIS_CONTACT_FORCE_THRESHOLD = 800;

export function createCarController(
  world: RAPIER.World,
  options: CreateVehicleOptions,
): VehicleHandle {
  const { manifest, profile, spawn } = options;

  const feel = resolveCarFeel(manifest);
  const chassis = deriveCarChassis(manifest, profile, feel);
  const drivetrain = deriveDrivetrainParams(manifest, feel);
  const wheelCount = chassis.wheels.length;

  // Roll inertia (about the chassis-local forward axis = Z) — used to scale the
  // stability-assist torque so a heavy SUV and a light coupe get the same
  // *response*, not the same raw N·m. Floored so a degenerate manifest can't
  // zero the assist out.
  const rollInertia = Math.max(manifest.inertiaTensor[FORWARD_AXIS] ?? 0, 1);

  // World gravity, cached (constant per session). Used to detect when the car is
  // parked on a grade — `gravity · chassisForward` is the pull along the car's
  // travel axis — so it can free-roll there instead of being brake-held.
  const gravityX = world.gravity.x;
  const gravityY = world.gravity.y;
  const gravityZ = world.gravity.z;

  // Wheelbase (distance between front + rear axles in chassis-local Z) is
  // needed for the reverse bicycle-model yaw — see the reverse propulsion
  // section below. Falls back to 1 m if the rig somehow has all wheels at z=0
  // so we never divide by zero.
  let maxWheelZ = -Infinity;
  let minWheelZ = Infinity;
  for (const w of manifest.rig.wheels) {
    if (w.position[2] > maxWheelZ) maxWheelZ = w.position[2];
    if (w.position[2] < minWheelZ) minWheelZ = w.position[2];
  }
  const wheelbase = Math.max(maxWheelZ - minWheelZ, 1);

  // Spawn at the derived ride height (never below it, so the wheels can reach
  // the ground on frame one); the car then settles onto its springs.
  const bodyY = Math.max(spawn.position[1], chassis.spawnOriginY);

  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(spawn.position[0], bodyY, spawn.position[2])
    .setRotation({
      x: spawn.rotation[0],
      y: spawn.rotation[1],
      z: spawn.rotation[2],
      w: spawn.rotation[3],
    })
    .setLinearDamping(feel.linearDamping)
    .setAngularDamping(0.6);
  // Supply mass with a low, central COM for roll resistance; the collider is
  // massless so the two don't stack.
  bodyDesc.setAdditionalMassProperties(
    manifest.mass,
    chassis.comOffset,
    {
      x: manifest.inertiaTensor[0],
      y: manifest.inertiaTensor[1],
      z: manifest.inertiaTensor[2],
    },
    { x: 0, y: 0, z: 0, w: 1 },
  );
  bodyDesc.setCanSleep(false);
  const body = world.createRigidBody(bodyDesc);

  const colliderDesc = RAPIER.ColliderDesc.cuboid(
    chassis.halfExtents.x,
    chassis.halfExtents.y,
    chassis.halfExtents.z,
  )
    .setDensity(0)
    .setFriction(0.4)
    .setRestitution(0.0)
    // Report contact forces involving the chassis so the renderer can crumple
    // the body mesh on a crash (BeamNG-style deformation). The threshold filters
    // out incidental scrapes (curbs, bottoming on a speed bump) — only a real
    // hit clears it. The deformation layer maps the reported force → dent depth.
    .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
    .setContactForceEventThreshold(CHASSIS_CONTACT_FORCE_THRESHOLD);
  world.createCollider(colliderDesc, body);

  const controller = world.createVehicleController(body);
  controller.indexUpAxis = UP_AXIS;
  controller.setIndexForwardAxis = FORWARD_AXIS;

  for (let i = 0; i < wheelCount; i++) {
    const w = chassis.wheels[i];
    if (!w) continue;
    controller.addWheel(
      w.connection,
      { ...SUSPENSION_DIR },
      { ...AXLE_DIR },
      chassis.suspension.restLength,
      w.radius,
    );
    // Per-wheel stiffness so front struts can ride stiffer than rear.
    controller.setWheelSuspensionStiffness(i, w.stiffness);
    controller.setWheelSuspensionCompression(i, chassis.suspension.compression);
    controller.setWheelSuspensionRelaxation(i, chassis.suspension.relaxation);
    controller.setWheelMaxSuspensionTravel(i, chassis.suspension.maxTravel);
    controller.setWheelFrictionSlip(i, chassis.frictionSlip);
    controller.setWheelSideFrictionStiffness(i, chassis.sideFrictionStiffness);
  }

  // ABS state — per-wheel previous angle (rad) for angular-velocity finite
  // differences, and a per-wheel "locked" latch so the brake stays released
  // until the wheel spins back up past ABS_RELEASE_RAD_S.
  const prevWheelAngle = new Array<number>(wheelCount).fill(0);
  const wheelLocked = new Array<boolean>(wheelCount).fill(false);

  // ── Reused buffers — hot path allocates zero (§18.4). ──────────────────────
  const snapshot: VehicleSnapshot = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    speed: 0,
    wheels: Array.from({ length: wheelCount }, () => ({
      position: { x: 0, y: 0, z: 0 },
      steering: 0,
      rotation: 0,
      inContact: false,
      contact: { x: 0, y: 0, z: 0 },
      slip: 0,
    })),
  };
  // Per-wheel slip the controller fills in `update()` and the snapshot copies
  // out in `readSnapshot()`. Kept on the controller side so the snapshot path
  // stays read-only — input ⇒ tick ⇒ slip ⇒ snapshot ⇒ renderer FX.
  const wheelSlip = new Array<number>(wheelCount).fill(0);
  const debugFrame: MovementDebugFrame = {
    comWorld: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    contacts: Array.from({ length: wheelCount }, () => ({
      hardPoint: { x: 0, y: 0, z: 0 },
      center: { x: 0, y: 0, z: 0 },
      contact: { x: 0, y: 0, z: 0 },
      inContact: false,
      suspensionForce: 0,
    })),
  };
  // Scratch buffers for rotation-correct wheel reconstruction (alloc-free).
  const worldDir = { x: 0, y: 0, z: 0 };
  const worldHard = { x: 0, y: 0, z: 0 };
  // Scratch for the reverse chassis-velocity bypass (see end of update()).
  // `worldBack` holds the chassis-local backward direction (chassis-local -Z,
  // because Rapier's forward convention is inverted from ours; see
  // FORWARD_SIGN) rotated into world space.
  const worldBack = { x: 0, y: 0, z: 0 };
  const linvelOut = { x: 0, y: 0, z: 0 };
  const angvelOut = { x: 0, y: 0, z: 0 };
  // Scratch for the stability assist (anti-roll + tilt-rate damping).
  // `qConj` holds the chassis rotation's conjugate (to map world-up into body
  // space for the roll angle); `localUp`/`worldFwd`/`worldUp` are rotated unit
  // axes; `stabilizerOut` is the world-space torque handed to addTorque.
  const qConj = { x: 0, y: 0, z: 0, w: 1 };
  const localUp = { x: 0, y: 0, z: 0 };
  const worldFwd = { x: 0, y: 0, z: 0 };
  const worldUp = { x: 0, y: 0, z: 0 };
  const stabilizerOut = { x: 0, y: 0, z: 0 };
  // Chassis forward in world, recomputed in the coast block for slope detection.
  const coastFwd = { x: 0, y: 0, z: 0 };

  let initialSpawn: MovementSpawn = {
    position: [...spawn.position] as Vec3,
    rotation: [...spawn.rotation] as Quat,
  };

  // Runtime grip overlay (weather → wet roads). 1 = dry baseline. Re-applies
  // longitudinal friction-slip lazily, only when it changes (avoids 4 unneeded
  // Rapier setter calls per tick when conditions are stable).
  let gripMul = 1;
  // Combines gripMul AND the reverse-mode flag — re-apply frictionSlip when
  // either changes. In reverse, slip is forced to 0 so Rapier's wheel-friction
  // model stops fighting the chassis-velocity bypass below.
  let lastAppliedSlipKey = NaN;
  // Driver-controlled reverse speed (m/s, positive = moving backward in our
  // convention). Ramps from 0 → MAX_REVERSE_SPEED_MS while S is held below the
  // forward-speed threshold; resets to 0 the moment we leave reverse mode.
  // Owned by the controller because Rapier's `currentVehicleSpeed()` and the
  // body's own `linvel()` both become unreliable once we bypass the wheel-
  // friction loop (Rapier's internal substep solver alternates between the
  // commanded velocity and a wheel-derived value — the chassis still moves at
  // the slammed speed, but the readings flicker).
  let reverseSpeed = 0;
  // Brake-park latch: a quick tap of the foot brake at a near-standstill clamps a
  // firm parking hold on so the car stays put even on a slope until the player
  // drives away (throttle / handbrake / reverse release it). Off-throttle coasting
  // does NOT auto-engage this — the speed-tapered engine braking lets a slope roll
  // the car gently, the way a real car in neutral does, until the brake is tapped.
  let parkHeld = false;
  // Seconds the foot brake has been held at a standstill. Reverse only engages
  // once this passes REVERSE_ENGAGE_DELAY_S, so a brake *tap* parks the car while
  // a sustained *hold* backs it up — and a tap can't lurch into reverse.
  let reverseArmTimer = 0;

  function update(input: ControlInput, dt: number): void {
    const ci = clampInput(input);
    const rawSpeed = controller.currentVehicleSpeed();
    const cmd = computeDriveCommand(ci, rawSpeed, drivetrain);

    // Reverse mode: the chassis is driven via setLinvel (below). Zero the
    // wheel-level engine force AND the longitudinal friction-slip so Rapier
    // stops opposing the bypass.
    //
    // We **latch** reverse mode once entered: the drivetrain signal
    // (`enginePerWheel > 0`) comes from `signedSpeed = rawSpeed × FORWARD_SIGN`
    // crossing REVERSE_THRESHOLD_MS, but while we're slamming `linvel` Rapier's
    // `currentVehicleSpeed` flickers (its internal substep solver alternates
    // between our commanded velocity and a wheel-derived value). That flicker
    // would otherwise pop the drivetrain into footbrake mode for a tick every
    // few frames, resetting our tracked `reverseSpeed` and stalling the car at
    // ≈ 0.4 m/s. Latching = "if we're already reversing and the player is
    // still holding S, stay in reverse" — same intent as the user's foot on
    // the pedal.
    //
    // Reverse ARMING: the drivetrain wants reverse the instant the brake is held
    // at (near) standstill, but we hold it off for REVERSE_ENGAGE_DELAY_S so a
    // brake *tap* parks the car (see parkHeld) and only a sustained *hold* backs
    // up. Once `reverseSpeed` is rolling, the second clause keeps us latched.
    const wantsReverse = cmd.enginePerWheel > 0;
    if (wantsReverse && ci.brake > 0) reverseArmTimer += dt;
    else reverseArmTimer = 0;
    const isReverseMode =
      (wantsReverse && reverseArmTimer >= REVERSE_ENGAGE_DELAY_S) ||
      (ci.brake > 0 && reverseSpeed > 0);
    // Zero the wheel engine force whenever reverse is wanted (armed or not) so the
    // car doesn't creep backward through the un-armed window — the brake/park-hold
    // holds it there until reverse properly engages via the linvel bypass below.
    const wheelEngine = wantsReverse ? 0 : cmd.enginePerWheel;

    // Burnout: both pedals mashed at a crawl. The driven wheels free-spin
    // (slip cut, brake released, full engine force) while the steered wheels
    // bite hard so the chassis is held. This produces the launch-control
    // smoke-show before the player releases the brake to take off, and also
    // covers the "donut" case (hold both pedals, steer to rotate).
    //
    // Gated to a low speed so a player who panic-brakes while throttling at
    // pace doesn't suddenly lose all drive — at high speed the brake reverts
    // to its normal "compete with throttle" role.
    const signedSpeed = rawSpeed * FORWARD_SIGN;
    const isBurnoutMode =
      !isReverseMode &&
      ci.throttle > BURNOUT_INPUT_THRESHOLD &&
      ci.brake > BURNOUT_INPUT_THRESHOLD &&
      signedSpeed < BURNOUT_MAX_SPEED_MS &&
      signedSpeed > -ABS_MIN_VEHICLE_SPEED_MS;

    // Re-apply per-wheel longitudinal grip only when something relevant changed
    // — hot-path-friendly. Lateral grip is set every tick anyway (handbrake).
    // In reverse, slip is forced to a near-zero value (kept just above 0 so
    // Rapier doesn't divide-by-zero internally). In burnout, only the DRIVEN
    // wheels get their longitudinal grip cut — fronts must keep biting so the
    // chassis can't get pulled forward by the spinning rear.
    const slipKey = isReverseMode ? -1 : isBurnoutMode ? -2 - gripMul : gripMul;
    if (slipKey !== lastAppliedSlipKey) {
      for (let i = 0; i < wheelCount; i++) {
        const w = chassis.wheels[i];
        if (!w) continue;
        let slip: number;
        if (isReverseMode) slip = 0;
        else if (isBurnoutMode && w.isDriven)
          slip = chassis.frictionSlip * gripMul * BURNOUT_DRIVEN_SLIP_MUL;
        else slip = chassis.frictionSlip * gripMul;
        controller.setWheelFrictionSlip(i, slip);
      }
      lastAppliedSlipKey = slipKey;
    }

    const baseSide = chassis.sideFrictionStiffness * gripMul;
    const carMoving = Math.abs(rawSpeed) > ABS_MIN_VEHICLE_SPEED_MS;
    const invDt = 1 / Math.max(dt, 1e-6);

    // Slip signal precomputes that don't depend on the wheel index.
    const absSpeedForSlip = Math.abs(rawSpeed);
    const handbrakeSlipBase =
      ci.handbrake > 0
        ? Math.min(ci.handbrake * (absSpeedForSlip / HANDBRAKE_SLIP_REF_SPEED_MS), 1)
        : 0;
    // Burnout side-grip cut for driven wheels — pulled out of the loop so
    // it's a single multiply per wheel below.
    const burnoutSideMul = isBurnoutMode ? BURNOUT_DRIVEN_SIDE_GRIP_MUL : 1;
    // Front brake during burnout: enough force per front wheel to fully oppose
    // the driven engine force feeding through (split by frontCount).
    const burnoutFrontBrake =
      (drivetrain.maxBrakeTotal * BURNOUT_FRONT_BRAKE_FRAC) / drivetrain.frontCount;

    // ── Brake-park hold + speed-banded engine braking (added to every wheel) ───
    // Two off-pedal behaviours, picked here and added to the per-wheel brake
    // below. Kept out of computeDriveCommand so the drivetrain's standstill→
    // reverse contract is untouched. Reverse owns its own motion (linvel bypass),
    // so neither fights it.
    //
    //   • PARK HOLD — a quick foot-brake tap at a near-standstill latches a firm
    //     parking hold that survives the release, so the car stays put on a slope
    //     until the player drives away. (A sustained hold arms reverse instead.)
    //   • ENGINE BRAKING — when fully off the pedals, a speed-banded coast-down:
    //     OFF above ≈50 km/h (momentum carries), fading in 25–50, full 5–25, and
    //     TAPERING to zero under ≈5 km/h so the brake can't statically hold a
    //     grade. Result: the car settles on flat ground but rolls gently downhill
    //     until the brake is tapped — like a real car left in neutral.
    // Slope detection: the gravity component along the car's forward axis. A
    // tilted road pitches the chassis (so forward gains a vertical component) and
    // a tilted-gravity test does the same — either way this is the pull that
    // would roll the car along its wheels.
    rotateByQuat(body.rotation(), 0, 0, 1, coastFwd);
    const slopePull = Math.abs(
      gravityX * coastFwd.x + gravityY * coastFwd.y + gravityZ * coastFwd.z,
    );
    const onSlope = slopePull > SLOPE_DETECT_MS2;

    const nearStop = absSpeedForSlip < PARK_BRAKE_SPEED_MS;
    if (ci.brake > 0 && nearStop && !isReverseMode) parkHeld = true;
    if (ci.throttle > 0 || ci.handbrake > 0 || isReverseMode) parkHeld = false;

    const coasting =
      !isReverseMode && ci.throttle === 0 && ci.brake === 0 && ci.handbrake === 0;
    let coastBrakePerWheel = 0;
    if (parkHeld) {
      coastBrakePerWheel = (feel.holdDecelMs2 * body.mass()) / wheelCount;
    } else if (coasting && absSpeedForSlip < COAST_BRAKE_FADE_END_MS) {
      let decel = feel.engineBrakeDecelMs2;
      if (absSpeedForSlip > COAST_BRAKE_FADE_START_MS) {
        // Fade out between the full-strength speed and the off speed.
        decel *=
          (COAST_BRAKE_FADE_END_MS - absSpeedForSlip) /
          (COAST_BRAKE_FADE_END_MS - COAST_BRAKE_FADE_START_MS);
      } else if (onSlope && absSpeedForSlip < COAST_BRAKE_TAPER_MS) {
        // On a grade under ≈5 km/h, release the brake so gravity rolls the car
        // gently. (A tapered-but-nonzero brake would still statically hold it —
        // Rapier locks a braked wheel — so it has to be fully off here.) On the
        // flat this branch is skipped, so full braking brings it to a dead stop.
        decel = 0;
      }
      coastBrakePerWheel = (decel * body.mass()) / wheelCount;
    }

    for (let i = 0; i < wheelCount; i++) {
      const w = chassis.wheels[i];
      if (!w) continue;

      // Engine force: burnout keeps full force on driven wheels (skipping the
      // power/speed taper which would crush the launch torque from rest).
      let engineForceI: number;
      if (isBurnoutMode && w.isDriven) {
        engineForceI = FORWARD_SIGN * drivetrain.maxEngineForce * ci.throttle / drivetrain.drivenCount;
      } else {
        engineForceI = w.isDriven ? wheelEngine : 0;
      }
      controller.setWheelEngineForce(i, engineForceI);

      // ABS pulse: derive the wheel's angular speed from the rotation delta and
      // drop the foot-brake force to zero on any wheel whose spin has nearly
      // stalled while the chassis is still moving. Latched until the wheel
      // spins back up past ABS_RELEASE_RAD_S so we get a clean release/grab.
      const angle = controller.wheelRotation(i) ?? 0;
      const angVel = Math.abs((angle - prevWheelAngle[i]!) * invDt);
      prevWheelAngle[i] = angle;

      // Footbrake source: in burnout mode the driven wheels release entirely
      // and the steered wheels go to a full clamp regardless of the player's
      // partial brake input — we want the chassis pinned solid.
      let footBrake: number;
      if (isBurnoutMode) {
        footBrake = w.isDriven ? 0 : burnoutFrontBrake;
      } else {
        footBrake = w.isSteered ? cmd.frontBrake : cmd.rearBrake;
      }
      const isContact = controller.wheelIsInContact(i);

      if (carMoving && isContact) {
        if (wheelLocked[i]) {
          if (angVel > ABS_RELEASE_RAD_S) wheelLocked[i] = false;
        } else if (footBrake > 0 && angVel < ABS_LOCK_RAD_S) {
          wheelLocked[i] = true;
        }
      } else {
        // At a crawl or airborne, ABS is off — let the brake hold the car still.
        wheelLocked[i] = false;
      }

      const modulatedFoot = wheelLocked[i] ? 0 : footBrake;
      // Handbrake bypasses ABS (Space must lock the rear for a drift). It's
      // also suppressed while burnout is engaged for non-driven wheels — those
      // are the fronts (steered) and the handbrake should never be on them.
      // The coast/hold brake (zero unless the player is off all pedals) rides on
      // top of every wheel — it never overlaps foot/hand braking, so it can't
      // double up; at the hold speed ABS is already off so it locks solid.
      const brake =
        (w.isSteered ? modulatedFoot : modulatedFoot + cmd.rearHandbrake) + coastBrakePerWheel;
      controller.setWheelBrake(i, brake);

      controller.setWheelSteering(i, w.isSteered ? cmd.steerAngle : 0);
      // Handbrake breaks rear grip for drifts; fronts keep biting. Burnout
      // additionally cuts driven-axle lateral grip so the rear can spin
      // sideways for donuts. Wet multiplier pre-applied to baseSide.
      let grip = w.isSteered ? baseSide : baseSide * cmd.rearGripMul;
      if (isBurnoutMode && w.isDriven) grip *= burnoutSideMul;
      controller.setWheelSideFrictionStiffness(i, grip);

      // Aggregate the slip signal that drives the renderer FX. Sources are
      // additive in priority order — burnout pins driven wheels to 1, then
      // handbrake colours the rear, then ABS-lock colours whichever wheel
      // is latched. `carMoving` gates the brake-lock skid so a stationary
      // hold doesn't paint a mark.
      let slip = 0;
      if (isBurnoutMode && w.isDriven) {
        slip = 1;
      } else if (!w.isSteered && handbrakeSlipBase > 0) {
        slip = handbrakeSlipBase;
      } else if (
        wheelLocked[i] &&
        absSpeedForSlip > ABS_LOCK_SLIP_MIN_SPEED_MS &&
        isContact
      ) {
        slip = ABS_LOCK_SLIP_VALUE;
      }
      wheelSlip[i] = isContact ? slip : 0;
    }

    controller.updateVehicle(dt);

    // ── Stability assist (anti-roll + tilt-rate damping) ──────────────────────
    // Keeps the car planted and stops it tipping over in hard cornering, and
    // bleeds off the brake nose-dive that a firm stop would otherwise produce —
    // without ever fighting yaw (steering) or a static slope.
    //
    // Roll angle: rotate WORLD-up (0,1,0) into chassis space via the rotation's
    // conjugate. For a level car that's (0,1,0); a sideways lean tips its X, so
    // roll = atan2(localUp.x, localUp.y) — correct under combined yaw+pitch
    // (unlike a raw quaternion-component proxy). A restoring torque about the
    // chassis forward axis, past a small deadzone (natural cornering lean stays),
    // proportional to the roll, scaled by roll inertia so the *response* is
    // mass-agnostic. Clamped so a flipped car can't generate an explosive torque.
    {
      const q = body.rotation();
      qConj.x = -q.x;
      qConj.y = -q.y;
      qConj.z = -q.z;
      qConj.w = q.w;
      rotateByQuat(qConj, 0, 1, 0, localUp);
      let roll = Math.atan2(localUp.x, localUp.y);
      if (roll > MAX_ANTIROLL_ANGLE_RAD) roll = MAX_ANTIROLL_ANGLE_RAD;
      else if (roll < -MAX_ANTIROLL_ANGLE_RAD) roll = -MAX_ANTIROLL_ANGLE_RAD;
      // Subtract the deadzone (continuous at the edge — no torque step).
      const activeRoll =
        roll > ANTIROLL_DEADZONE_RAD
          ? roll - ANTIROLL_DEADZONE_RAD
          : roll < -ANTIROLL_DEADZONE_RAD
            ? roll + ANTIROLL_DEADZONE_RAD
            : 0;

      // Chassis forward (roll torque axis) and up (yaw axis) in world space.
      rotateByQuat(q, 0, 0, 1, worldFwd);
      rotateByQuat(q, 0, 1, 0, worldUp);

      // Tilt rate = angular velocity with its yaw component (about the car's own
      // up) removed, so we damp roll AND pitch but never the player's steering.
      const av = body.angvel();
      const spin = av.x * worldUp.x + av.y * worldUp.y + av.z * worldUp.z;
      const tiltX = av.x - spin * worldUp.x;
      const tiltY = av.y - spin * worldUp.y;
      const tiltZ = av.z - spin * worldUp.z;

      // Restoring torque (about forward) minus rate damping (about the tilt).
      // Both scaled by roll inertia so kp/kd read as accelerations, not N·m.
      // Applied as a per-step torque IMPULSE (torque × dt): Rapier's addTorque
      // persists and accumulates across steps until reset, which would build an
      // unbounded torque when called every tick — applyTorqueImpulse is one-shot.
      const restore = -rollInertia * feel.antirollKp * activeRoll;
      const kd = rollInertia * feel.antirollKd;
      stabilizerOut.x = (worldFwd.x * restore - kd * tiltX) * dt;
      stabilizerOut.y = (worldFwd.y * restore - kd * tiltY) * dt;
      stabilizerOut.z = (worldFwd.z * restore - kd * tiltZ) * dt;
      body.applyTorqueImpulse(stabilizerOut, true);
    }

    // ── Reverse propulsion bypass ────────────────────────────────────────────
    // Rapier's raycast vehicle propels the chassis through wheel friction. That
    // works for throttle (wheels spin in their natural rolling direction) but
    // barely accelerates the chassis in reverse — the wheels would have to spin
    // backwards against a chassis at rest, and the slip model caps the
    // longitudinal force severely enough that the car creeps at < 1 km/h (the
    // bug the player reported). Neither a one-shot impulse nor a per-tick
    // velocity nudge survives the next `updateVehicle`: the wheel-friction loop
    // re-detects "slip" and clamps the chassis back down each step.
    //
    // Workaround: in reverse mode, slam the chassis linear velocity directly to
    // a driver-controlled `reverseSpeed` (ramped from 0 toward
    // MAX_REVERSE_SPEED_MS) along the chassis-local backward axis. The wheel
    // engine force is zeroed and frictionSlip dropped to 0 so the wheel-
    // friction loop has nothing to fight. The chassis position accumulates at
    // the slammed speed regardless of internal solver behaviour.
    if (isReverseMode) {
      // Ramp reverseSpeed toward the cap at the per-car reverse acceleration.
      // The cap scales with brake input so partial pedal yields a partial cap.
      const accelMs2 = drivetrain.maxReverseForce / body.mass();
      const targetMax = MAX_REVERSE_SPEED_MS * feel.maxReverseSpeedMul * ci.brake;
      reverseSpeed = Math.min(reverseSpeed + accelMs2 * dt, targetMax);

      // Slam chassis linvel along chassis-local backward (-Z chassis-local,
      // rotated into world). Y is left alone for gravity + suspension.
      const q = body.rotation();
      rotateByQuat(q, 0, 0, -1, worldBack);
      const v = body.linvel();
      linvelOut.x = worldBack.x * reverseSpeed;
      linvelOut.y = v.y;
      linvelOut.z = worldBack.z * reverseSpeed;
      body.setLinvel(linvelOut, true);

      // Apply yaw directly. Because we're bypassing the wheel-friction loop,
      // the lateral force from steered wheels that would normally rotate the
      // chassis never gets applied — without this the car can only reverse in
      // a straight line regardless of A/D. We use a bicycle-model magnitude
      // (|v|·tan(δ)/L) but pin the *direction* to the user's steering input
      // so A always curves to the player's +X side and D always to -X — same
      // visual side as the W+A / W+D forward tests. Arcade convention:
      // pressing the same key in forward or reverse moves the car to the same
      // side of the screen, which is what players expect from racing games.
      const absSpeed = reverseSpeed;
      const speedScale = drivetrain.steerSpeedScale;
      const steerMag =
        Math.abs(ci.steering) * drivetrain.maxSteerRad * (1 / (1 + absSpeed / speedScale));
      const yawRate = ci.steering * reverseSpeed * Math.tan(steerMag) / wheelbase;
      const a = body.angvel();
      // Preserve roll (X) and pitch (Z) — those come from suspension. Replace
      // yaw (Y) with our computed rate so steering actually does something.
      angvelOut.x = a.x;
      angvelOut.y = yawRate;
      angvelOut.z = a.z;
      body.setAngvel(angvelOut, true);
    } else {
      // Out of reverse — drop our tracked reverse velocity so the next time we
      // re-enter reverse mode we ramp from rest, not from the last cap value.
      reverseSpeed = 0;
    }
  }

  function setGripMultiplier(m: number): void {
    // Clamp so the car can't lose all grip (undriveable) or amplify (cheating).
    gripMul = m < 0.1 ? 0.1 : m > 1 ? 1 : m;
  }

  function readSnapshot(): VehicleSnapshot {
    const t = body.translation();
    const r = body.rotation();
    snapshot.position.x = t.x;
    snapshot.position.y = t.y;
    snapshot.position.z = t.z;
    snapshot.rotation.x = r.x;
    snapshot.rotation.y = r.y;
    snapshot.rotation.z = r.z;
    snapshot.rotation.w = r.w;
    // Speed: while reverse is engaged, Rapier's `currentVehicleSpeed` reads
    // ~0 because we bypass the wheel-friction loop — report our tracked
    // `reverseSpeed` instead (positive = moving backward, matching the snapshot
    // convention) so the HUD shows the real km/h.
    snapshot.speed = reverseSpeed > 0 ? reverseSpeed : controller.currentVehicleSpeed();

    // Reconstruct each wheel from the CURRENT (post-step) body transform — NOT
    // from Rapier's cached `wheelHardPoint`, which is computed inside
    // updateVehicle() BEFORE world.step() and is therefore one step
    // (speed × dt) behind the body. At 40 km/h that stale hard point trails the
    // body ~18 cm, which reads as "the body slides forward off its wheels."
    // Using the live transform locks body and wheels together at any speed.
    rotateByQuat(r, SUSPENSION_DIR.x, SUSPENSION_DIR.y, SUSPENSION_DIR.z, worldDir);
    for (let i = 0; i < wheelCount; i++) {
      const wheel = snapshot.wheels[i];
      const w = chassis.wheels[i];
      if (!wheel || !w) continue;
      // Live world hard point = body translation + R × chassis-local connection.
      rotateByQuat(r, w.connection.x, w.connection.y, w.connection.z, worldHard);
      const len = controller.wheelSuspensionLength(i) ?? chassis.suspension.restLength;
      // Wheel center = hard point + suspension dir × length (rotation-correct on
      // slopes, mid-roll, and airborne).
      wheel.position.x = t.x + worldHard.x + worldDir.x * len;
      wheel.position.y = t.y + worldHard.y + worldDir.y * len;
      wheel.position.z = t.z + worldHard.z + worldDir.z * len;
      wheel.inContact = controller.wheelIsInContact(i);
      wheel.steering = controller.wheelSteering(i) ?? 0;
      wheel.rotation = controller.wheelRotation(i) ?? 0;
      // Ground contact point = wheel center + suspension dir × wheel radius.
      // The renderer drops skid marks here (slightly above the ground in its
      // own draw call) so the trail anchors to the actual tire footprint
      // regardless of body pitch/roll.
      wheel.contact.x = wheel.position.x + worldDir.x * w.radius;
      wheel.contact.y = wheel.position.y + worldDir.y * w.radius;
      wheel.contact.z = wheel.position.z + worldDir.z * w.radius;
      wheel.slip = wheelSlip[i] ?? 0;
    }
    return snapshot;
  }

  function readDebugFrame(): MovementDebugFrame {
    const t = body.translation();
    const r = body.rotation();
    // COM world = translation + R × comOffset.
    rotateByQuat(r, chassis.comOffset.x, chassis.comOffset.y, chassis.comOffset.z, worldHard);
    debugFrame.comWorld.x = t.x + worldHard.x;
    debugFrame.comWorld.y = t.y + worldHard.y;
    debugFrame.comWorld.z = t.z + worldHard.z;

    const v = body.linvel();
    debugFrame.velocity.x = v.x;
    debugFrame.velocity.y = v.y;
    debugFrame.velocity.z = v.z;

    // Same live-transform reconstruction as readSnapshot (no one-step lag).
    rotateByQuat(r, SUSPENSION_DIR.x, SUSPENSION_DIR.y, SUSPENSION_DIR.z, worldDir);
    for (let i = 0; i < wheelCount; i++) {
      const c = debugFrame.contacts[i];
      const w = chassis.wheels[i];
      if (!c || !w) continue;
      rotateByQuat(r, w.connection.x, w.connection.y, w.connection.z, worldHard);
      const hx = t.x + worldHard.x;
      const hy = t.y + worldHard.y;
      const hz = t.z + worldHard.z;
      const len = controller.wheelSuspensionLength(i) ?? chassis.suspension.restLength;
      c.hardPoint.x = hx;
      c.hardPoint.y = hy;
      c.hardPoint.z = hz;
      c.center.x = hx + worldDir.x * len;
      c.center.y = hy + worldDir.y * len;
      c.center.z = hz + worldDir.z * len;
      c.contact.x = c.center.x + worldDir.x * w.radius;
      c.contact.y = c.center.y + worldDir.y * w.radius;
      c.contact.z = c.center.z + worldDir.z * w.radius;
      c.inContact = controller.wheelIsInContact(i);
      c.suspensionForce = controller.wheelSuspensionForce(i) ?? 0;
    }
    return debugFrame;
  }

  function reset(next?: MovementSpawn): void {
    if (next) {
      initialSpawn = {
        position: [...next.position] as Vec3,
        rotation: [...next.rotation] as Quat,
      };
    }
    const { position, rotation } = initialSpawn;
    const resetY = Math.max(position[1], chassis.spawnOriginY);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.setTranslation({ x: position[0], y: resetY, z: position[2] }, true);
    body.setRotation(
      { x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] },
      true,
    );
    reverseSpeed = 0;
    parkHeld = false;
    reverseArmTimer = 0;
  }

  function dispose(): void {
    world.removeVehicleController(controller);
    world.removeRigidBody(body);
  }

  // Settle the car onto its springs at construction. Two payoffs: it spawns
  // grounded (no first-frame drop), and we can measure the TRUE resting body
  // height so the visual's hub seat (restHubLocalY) matches where the wheels
  // actually rest — including spring sag, which a static formula can't predict.
  //
  // Adaptive: keep stepping until the body velocity is near-zero (car at rest)
  // or until SETTLE_MAX_STEPS. This handles the common case (~60 steps when the
  // car spawns just above the road) AND the pathological case where a spawn-
  // raycast hits a barrier 10-20 m above the road — previously the fixed 60
  // steps ended mid-fall, giving a wrong restHubLocalY that made the body mesh
  // appear sunken or floating on specific maps.
  {
    let stableCount = 0;
    for (let i = 0; i < SETTLE_MAX_STEPS; i++) {
      update(NEUTRAL_INPUT, SETTLE_DT);
      world.step();
      if (i >= SETTLE_MIN_STEPS) {
        const v = body.linvel();
        if (
          Math.abs(v.y) < SETTLE_VEL_THRESHOLD &&
          Math.abs(v.x) < SETTLE_VEL_THRESHOLD &&
          Math.abs(v.z) < SETTLE_VEL_THRESHOLD
        ) {
          if (++stableCount >= SETTLE_STABLE_COUNT) break;
        } else {
          stableCount = 0;
        }
      }
    }
  }
  // Body-local Y the hub rests at, used by the visual to seat the body mesh on
  // its wheels. Measured from the SETTLED suspension lengths (so it captures
  // real spring sag) but in CHASSIS space, so it is invariant to ground
  // elevation AND spawn slope. Deriving it from world coordinates instead
  // (`wheelWorldY − bodyWorldY`) folded the spawn tilt into the seat and made
  // the body float or sink relative to the tires on inclines — see
  // deriveRestHubLocalY for the full reasoning.
  const settledLengths = chassis.wheels.map(
    (_, i) => controller.wheelSuspensionLength(i) ?? chassis.suspension.restLength,
  );
  const restHubLocalY = deriveRestHubLocalY(chassis.wheels, settledLengths);

  return {
    kind: 'car',
    body,
    wheelCount,
    restHubLocalY,
    readSnapshot,
    readDebugFrame,
    update,
    setGripMultiplier,
    reset,
    dispose,
  };
}

/** Rotate vector (vx,vy,vz) by quaternion `q` into `out`. Alloc-free (q·v·q⁻¹). */
function rotateByQuat(
  q: { x: number; y: number; z: number; w: number },
  vx: number,
  vy: number,
  vz: number,
  out: { x: number; y: number; z: number },
): void {
  const { x, y, z, w } = q;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out.x = vx + w * tx + (y * tz - z * ty);
  out.y = vy + w * ty + (z * tx - x * tz);
  out.z = vz + w * tz + (x * ty - y * tx);
}
