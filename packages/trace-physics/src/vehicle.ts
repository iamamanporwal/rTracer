import RAPIER from '@dimforge/rapier3d-compat';
import type { Quat, Vec3, VehicleManifest } from '@trace/core';
import type { PhysicsProfile } from './profiles';
import { clampInput, NEUTRAL_INPUT, type ControlInput } from './input';

/**
 * Physical vehicle per blueprint §7.2 — one chassis rigid body plus a Rapier
 * `DynamicRayCastVehicleController` for the wheels. No baked animation: every
 * wheel pose is integrated from raycast contact + spring/damper forces.
 *
 * Phase 1 W2: the model is intentionally coarse. Engine force is `power /
 * speed` with a low-speed clamp; brake is split 60/40 front/rear; steering is
 * speed-sensitive. W3 (P1-11..P1-13) introduces the real torque curve, gearbox
 * states, and the return-to-center steering torque.
 */

const HP_TO_WATTS = 745.7;
const REF_SPEED_MS = 8;
/** Acceleration cap (m/s²) so raw power can't launch/flip the car. ~0.55g. */
const MAX_ACCEL_MS2 = 5.5;
/** Peak braking deceleration (m/s²). */
const PEAK_DECEL_MS2 = 8;
/** Reverse gear is weaker than forward, but still clearly perceptible. */
const REVERSE_ACCEL_MS2 = 4.5;
const FRONT_BRAKE_BIAS = 0.6;
const MAX_STEER_ANGLE = (Math.PI / 180) * 32;
const STEER_SPEED_SCALE = 18;
/** Below this forward speed (m/s), the brake input is treated as reverse. */
const REVERSE_THRESHOLD_MS = 0.8;
/**
 * Sign of the chassis-local forward axis (+Z) that throttle pushes toward.
 *
 * Rapier's raycast vehicle accelerates *opposite* to a naive reading of its
 * forward-axis index: a positive `setWheelEngineForce` moves the chassis toward
 * −Z. The chase camera sits behind the nose at local −Z, and the steered (front)
 * wheels are at +Z, so "forward" must be +Z. We therefore drive with −1 so
 * throttle pushes the car toward +Z (away from the camera). `FORWARD_SIGN` is
 * threaded through engine force, reverse force, and signed speed, so this one
 * knob keeps all three consistent. Locked by `vehicle.drive.test.ts`.
 */
const FORWARD_SIGN = -1;
/**
 * Sign mapping steering input (`+1` = the player's right, the D key) to Rapier's
 * wheel steering angle. Inverted for the same reason as {@link FORWARD_SIGN}:
 * because the car drives toward +Z (opposite Rapier's native forward), the
 * controller's steering is mirrored too, so without this A/D — and the visible
 * front wheels — would turn the wrong way. Locked by `vehicle.drive.test.ts`.
 */
const STEER_SIGN = -1;

export type VehicleSpawn = {
  position: Vec3;
  rotation: Quat;
};

export type VehicleHandle = {
  /** The chassis rigid body. Read this for visual sync each frame. */
  readonly body: RAPIER.RigidBody;
  /** Wheel count, fixed at construction. */
  readonly wheelCount: number;
  /** World-space pose snapshot — alloc-free, reused buffer. */
  readSnapshot(): VehicleSnapshot;
  /**
   * Apply input + advance the vehicle controller by `dt`. Call once per fixed
   * physics step, BEFORE `world.step()` so suspension forces feed into the
   * integration.
   */
  update(input: ControlInput, dt: number): void;
  /** Teleport back to the spawn pose with zero velocity. */
  reset(spawn?: VehicleSpawn): void;
  /** Free Rapier-owned memory. */
  dispose(): void;
};

export type WheelSnapshot = {
  /** World-space position of the wheel center. */
  position: { x: number; y: number; z: number };
  /** Steering angle in radians; positive = right. */
  steering: number;
  /** Cumulative spin angle in radians. */
  rotation: number;
  /** Whether the wheel is in ground contact this frame. */
  inContact: boolean;
};

export type VehicleSnapshot = {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  speed: number;
  wheels: WheelSnapshot[];
};

export type CreateVehicleOptions = {
  manifest: VehicleManifest;
  profile: PhysicsProfile;
  spawn: VehicleSpawn;
};

/**
 * Build a physical vehicle from a {@link VehicleManifest} and {@link PhysicsProfile}.
 *
 * The chassis is a single cuboid sized to enclose the wheel footprint with
 * sensible body height. W3 swaps in a tighter collider derived from the visual
 * mesh; for W2 the box is enough to show suspension dive and roll.
 */
export function createVehicle(
  world: RAPIER.World,
  options: CreateVehicleOptions,
): VehicleHandle {
  const { manifest, profile, spawn } = options;

  const halfExtents = chassisHalfExtents(manifest);

  // Ride height: chassis bottom sits this far above the ground at rest. Wheels
  // poke out below it. Spawn the body so the wheels start slightly compressed,
  // guaranteeing the suspension raycast reaches the ground on frame one.
  const RIDE_HEIGHT = 0.3;
  const idealBodyY = halfExtents.y + RIDE_HEIGHT;
  const bodyY = Math.max(spawn.position[1], idealBodyY);

  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(spawn.position[0], bodyY, spawn.position[2])
    .setRotation({
      x: spawn.rotation[0],
      y: spawn.rotation[1],
      z: spawn.rotation[2],
      w: spawn.rotation[3],
    })
    .setLinearDamping(0.05)
    .setAngularDamping(0.6);
  // Mass with an artificially low center of mass — keeps the car planted and
  // resists roll-over. We supply mass here and make the collider massless so
  // the two don't stack.
  bodyDesc.setAdditionalMassProperties(
    manifest.mass,
    { x: 0, y: -halfExtents.y * 0.7, z: 0 },
    {
      x: manifest.inertiaTensor[0],
      y: manifest.inertiaTensor[1],
      z: manifest.inertiaTensor[2],
    },
    { x: 0, y: 0, z: 0, w: 1 },
  );
  bodyDesc.setCanSleep(false);
  const body = world.createRigidBody(bodyDesc);

  const colliderDesc = RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
    .setDensity(0)
    .setFriction(0.4)
    .setRestitution(0.0);
  world.createCollider(colliderDesc, body);

  const controller = world.createVehicleController(body);
  controller.indexUpAxis = 1;
  controller.setIndexForwardAxis = 2;

  // Strut top sits in the lower third of the chassis so the downward raycast
  // (length = restLength + radius) comfortably overshoots the ground.
  const connectionLocalY = -halfExtents.y * 0.5;

  for (let i = 0; i < manifest.rig.wheels.length; i++) {
    const w = manifest.rig.wheels[i];
    if (!w) continue;
    const connection = {
      x: w.position[0],
      y: connectionLocalY,
      z: w.position[2],
    };
    controller.addWheel(
      connection,
      { x: 0, y: -1, z: 0 },
      { x: 1, y: 0, z: 0 },
      profile.suspensionRestLength,
      w.radius,
    );
    controller.setWheelSuspensionStiffness(i, profile.suspensionStiffness);
    controller.setWheelSuspensionCompression(i, profile.suspensionCompression);
    controller.setWheelSuspensionRelaxation(i, profile.suspensionRelaxation);
    controller.setWheelMaxSuspensionTravel(i, profile.suspensionMaxTravel);
    controller.setWheelFrictionSlip(i, profile.tireFrictionSlip);
    controller.setWheelSideFrictionStiffness(i, profile.sideFrictionStiffness);
  }

  const peakPowerW = peakPower(manifest);
  const maxEngineForce = manifest.mass * MAX_ACCEL_MS2;
  const maxReverseForce = manifest.mass * REVERSE_ACCEL_MS2;
  const maxBrakeTotal = manifest.mass * PEAK_DECEL_MS2;
  const drivenCount = manifest.rig.wheels.filter((w) => w.isDriven).length || 1;
  const wheelCount = manifest.rig.wheels.length;

  // Reused buffers — hot path allocates zero (§18.4).
  const snapshot: VehicleSnapshot = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    speed: 0,
    wheels: Array.from({ length: wheelCount }, () => ({
      position: { x: 0, y: 0, z: 0 },
      steering: 0,
      rotation: 0,
      inContact: false,
    })),
  };

  let initialSpawn: VehicleSpawn = {
    position: [...spawn.position] as Vec3,
    rotation: [...spawn.rotation] as Quat,
  };

  function update(input: ControlInput, dt: number): void {
    const ci = clampInput(input);
    // Signed forward speed: positive = moving the way throttle pushes.
    const signedSpeed = controller.currentVehicleSpeed() * FORWARD_SIGN;
    const absSpeed = Math.abs(signedSpeed);

    // Engine force (along +forwardAxis, scaled by FORWARD_SIGN) and brake force
    // are mutually exclusive per input. Brake doubles as reverse at standstill.
    let engineForceTotal = 0;
    let brakeForceTotal = ci.handbrake * maxBrakeTotal;

    if (ci.throttle > 0) {
      const powerForce = (peakPowerW * ci.throttle) / Math.max(absSpeed, REF_SPEED_MS);
      engineForceTotal = FORWARD_SIGN * Math.min(powerForce, maxEngineForce * ci.throttle);
    } else if (ci.brake > 0) {
      if (signedSpeed > REVERSE_THRESHOLD_MS) {
        // Rolling forward → brake.
        brakeForceTotal = Math.max(brakeForceTotal, ci.brake * maxBrakeTotal);
      } else {
        // Stopped or already reversing → apply reverse engine force.
        engineForceTotal = -FORWARD_SIGN * maxReverseForce * ci.brake;
      }
    }

    const engineForcePerWheel = engineForceTotal / drivenCount;
    const frontBrake = (brakeForceTotal * FRONT_BRAKE_BIAS) / 2;
    const rearBrake = (brakeForceTotal * (1 - FRONT_BRAKE_BIAS)) / 2;

    const steerAngle =
      STEER_SIGN * ci.steering * MAX_STEER_ANGLE * (1 / (1 + absSpeed / STEER_SPEED_SCALE));

    for (let i = 0; i < wheelCount; i++) {
      const w = manifest.rig.wheels[i];
      if (!w) continue;
      controller.setWheelEngineForce(i, w.isDriven ? engineForcePerWheel : 0);
      controller.setWheelBrake(i, w.isSteered ? frontBrake : rearBrake);
      controller.setWheelSteering(i, w.isSteered ? steerAngle : 0);
    }

    controller.updateVehicle(dt);
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
    snapshot.speed = controller.currentVehicleSpeed();
    for (let i = 0; i < wheelCount; i++) {
      const wheel = snapshot.wheels[i];
      if (!wheel) continue;
      const contactPoint = controller.wheelContactPoint(i);
      if (contactPoint) {
        wheel.position.x = contactPoint.x;
        wheel.position.y = contactPoint.y + (controller.wheelRadius(i) ?? 0);
        wheel.position.z = contactPoint.z;
        wheel.inContact = true;
      } else {
        wheel.inContact = false;
        // Fall back to chassis-relative connection point projected to world.
        const cp = controller.wheelChassisConnectionPointCs(i);
        if (cp) {
          // Approximate world position by adding chassis translation. Not
          // rotation-correct, but only used while the wheel is airborne and the
          // renderer is forgiving.
          wheel.position.x = t.x + cp.x;
          wheel.position.y = t.y + cp.y - (controller.wheelSuspensionRestLength(i) ?? 0);
          wheel.position.z = t.z + cp.z;
        }
      }
      wheel.steering = controller.wheelSteering(i) ?? 0;
      wheel.rotation = controller.wheelRotation(i) ?? 0;
    }
    return snapshot;
  }

  function reset(next?: VehicleSpawn): void {
    if (next) initialSpawn = { position: [...next.position] as Vec3, rotation: [...next.rotation] as Quat };
    const { position, rotation } = initialSpawn;
    const resetY = Math.max(position[1], idealBodyY);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.setTranslation({ x: position[0], y: resetY, z: position[2] }, true);
    body.setRotation(
      { x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] },
      true,
    );
  }

  function dispose(): void {
    world.removeVehicleController(controller);
    world.removeRigidBody(body);
  }

  // Settle the snapshot once so consumers can read it before the first step.
  update(NEUTRAL_INPUT, 0);
  readSnapshot();

  return {
    body,
    wheelCount,
    readSnapshot,
    update,
    reset,
    dispose,
  };
}

function chassisHalfExtents(manifest: VehicleManifest): { x: number; y: number; z: number } {
  let maxX = 0;
  let maxZ = 0;
  for (const w of manifest.rig.wheels) {
    if (Math.abs(w.position[0]) > maxX) maxX = Math.abs(w.position[0]);
    if (Math.abs(w.position[2]) > maxZ) maxZ = Math.abs(w.position[2]);
  }
  return {
    x: maxX + 0.15,
    y: 0.5,
    z: maxZ + 0.25,
  };
}

function peakPower(manifest: VehicleManifest): number {
  let peakHp = 0;
  for (const [, hp] of manifest.engine.powerCurveHpAtRpm) {
    if (hp > peakHp) peakHp = hp;
  }
  return peakHp * HP_TO_WATTS;
}
