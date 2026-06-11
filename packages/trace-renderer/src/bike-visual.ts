import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import type { VehicleManifest } from '@trace/core';
import type { VehicleVisual, VehicleVisualSnapshot } from './vehicle-visual';
import { createRiderRig, DEFAULT_RIDE_POSE, type RiderRig } from './rider-rig';

/**
 * Bike visual — the two-wheeled production path (`manifest.class === 'bike'`).
 *
 * A motorbike can't be a raycast vehicle with two centreline wheels (it has no
 * roll base and tips instantly). So the *physics* is a stable narrow four-wheel
 * rig (the manifest's invisible rig) that never flips, and everything that makes
 * it read as a bike lives here, visually:
 *
 *   1. **Body + rigged front end** — the GLB is pre-processed offline by
 *      `tools/blender/bike_surgery.py`, which bakes in what used to be fragile
 *      runtime mesh surgery: the cosmetic floor plane and the deployed side-stand
 *      are deleted, the fused wheels are split into `wheel_front` / `wheel_rear`
 *      with their origins ON THE TRUE HUB (so they spin without wobble), and a
 *      `steer` pivot is placed on the raked steering axis parenting the front
 *      wheel + `grips`. The renderer just drives those named nodes — no geometry
 *      surgery at load.
 *   2. **Steering** — the `steer` node turns about the model's rake axis
 *      (`visual.steer.axis`) by the front wheel's steer angle, clamped to
 *      `visual.steer.maxDeg`, so the front wheel + handlebar grips turn on the
 *      real steering axis. (The fork tubes are fused into the fairing in this
 *      source mesh and can't be separated without artist remodeling, so they
 *      stay fixed — they're occluded by the fairing + rider from the chase cam.)
 *   3. **Cosmetic lean** — the body rolls into corners by an angle derived from
 *      `speed × front-steer`, on top of the physics chassis pose. The physics
 *      body stays upright (anti-roll); only the look leans.
 *   4. **Rider** — a Mixamo humanoid (FBX) IK-posed into a sport tuck and
 *      parented under the body so it leans with the bike. On a hard crash it
 *      plays a falling clip if one was supplied.
 *
 * Honours the same {@link VehicleVisual} contract as the cars, plus the optional
 * `update(dt)` (advances the rider mixer) and `crash()` (starts the fall).
 */

export type CreateBikeVisualOptions = {
  /** Absolute URL to the bike `.glb`/`.gltf`. */
  url: string;
  manifest: VehicleManifest;
  /** Body-local Y the wheel hub rests at (from physics) — seats the body height. */
  restHubLocalY: number;
  environment?: THREE.Texture | null;
  /** Absolute URL to the rider FBX (Mixamo). Null/absent → no rider. */
  riderUrl?: string | null;
  /** Absolute URL to a Mixamo falling/knockout clip (FBX). Null → crash() no-ops. */
  fallClipUrl?: string | null;
};

// ── Cosmetic lean tuning ─────────────────────────────────────────────────────
/** Lean angle ≈ LEAN_GAIN · speed · steerAngle, clamped to ±MAX_LEAN_RAD. */
const LEAN_GAIN = 0.16;
const MAX_LEAN_RAD = 0.62; // ~35°
/** Sign that makes the bike lean INTO the corner (flip if it leans out). */
const LEAN_SIGN = -1;
/** Per-frame smoothing toward the target lean (higher = snappier). */
const LEAN_SMOOTH = 0.18;

const FORWARD = new THREE.Vector3(0, 0, 1); // chassis-local forward (FORWARD_AXIS=2)
const RIGHT = new THREE.Vector3(1, 0, 0); // wheel axle (spin axis)
/** Default raked steering axis (≈24° rake) if the manifest omits `visual.steer`. */
const DEFAULT_RAKE_AXIS = new THREE.Vector3(0, 0.914, -0.407);
const DEFAULT_STEER_MAX_DEG = 26;

/**
 * A bike visual is a {@link VehicleVisual} plus its {@link RiderRig} — exposed so
 * the dev pose editor can re-pose the seated rider live. `riderRig` is null when
 * the manifest carries no rider or the rider failed to load.
 */
export type BikeVisual = VehicleVisual & { riderRig: RiderRig | null };

export async function createBikeVisual(
  options: CreateBikeVisualOptions,
): Promise<BikeVisual> {
  const { url, manifest, restHubLocalY, environment, riderUrl, fallClipUrl } = options;

  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene;

  const container = new THREE.Group();
  container.name = `bike:${manifest.id}`;
  const fit = new THREE.Group();
  fit.name = 'glb-fit';
  fit.add(root);
  container.add(fit);

  const cfg = manifest.visual;
  const scale = cfg?.scale ?? 1;
  fit.scale.setScalar(scale);
  fit.rotation.set(0, cfg?.yaw ?? 0, 0);
  container.updateMatrixWorld(true);

  // Ground alignment: drop the body so its lowest point (wheel contact) sits at
  // the physics ground level. The floor plane and side-stand are already stripped
  // from the GLB by the offline surgery, so the lowest point is the tyre contact.
  const MAX_MESH_SPAN = 10;
  const bodyBox = new THREE.Box3();
  const spanVec = new THREE.Vector3();
  container.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mb = new THREE.Box3().setFromObject(obj);
    mb.getSize(spanVec);
    if (Math.max(spanVec.x, spanVec.y, spanVec.z) > MAX_MESH_SPAN) return;
    bodyBox.union(mb);
  });
  const avgRadius =
    manifest.rig.wheels.reduce((s, w) => s + w.radius, 0) / manifest.rig.wheels.length;
  const physicsGroundLocalY = restHubLocalY - avgRadius;
  const modelGroundY = bodyBox.isEmpty() ? 0 : bodyBox.min.y;
  const offset = cfg?.offset ?? [0, 0, 0];
  fit.position.set(offset[0], physicsGroundLocalY - modelGroundY + offset[1], offset[2]);
  container.updateMatrixWorld(true);

  // Materials: shadows, env reflections, glass downgrade (mobile perf).
  container.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
    const mat = obj.material as THREE.Material | THREE.Material[];
    if (Array.isArray(mat)) mat.forEach(prepMaterial);
    else prepMaterial(mat);
  });
  function prepMaterial(m: THREE.Material): void {
    const phys = m as THREE.MeshPhysicalMaterial;
    if (phys.isMeshPhysicalMaterial && phys.transmission > 0) {
      phys.transmission = 0;
      phys.transparent = false;
      phys.opacity = 1;
      phys.roughness = Math.min(phys.roughness, 0.2);
      phys.metalness = Math.max(phys.metalness, 0.1);
    }
    if (environment) {
      const std = m as THREE.MeshStandardMaterial;
      if (std.isMeshStandardMaterial) {
        std.envMap = environment;
        std.envMapIntensity = 1.0;
      }
    }
    m.needsUpdate = true;
  }

  // ── Named rig nodes (baked by the offline surgery). Any missing node simply
  //    won't animate — the bike still renders and drives. ──────────────────────
  const steerNode = container.getObjectByName('steer') ?? null;
  const wheelFront = container.getObjectByName('wheel_front') ?? null;
  const wheelRear = container.getObjectByName('wheel_rear') ?? null;

  const rakeAxis = cfg?.steer
    ? new THREE.Vector3(cfg.steer.axis[0], cfg.steer.axis[1], cfg.steer.axis[2]).normalize()
    : DEFAULT_RAKE_AXIS.clone();
  const steerMaxRad = THREE.MathUtils.degToRad(cfg?.steer?.maxDeg ?? DEFAULT_STEER_MAX_DEG);

  // ── Rider (best-effort; a failure must never break the drivable bike). ──────
  let mixer: THREE.AnimationMixer | null = null;
  let fallAction: THREE.AnimationAction | null = null;
  let crashed = false;
  let riderRig: RiderRig | null = null;
  if (riderUrl) {
    try {
      riderRig = await loadRider(container, manifest, riderUrl);
      if (fallClipUrl) {
        const rider = container.getObjectByName('bike-rider');
        if (rider) {
          const clipFbx = await new FBXLoader().loadAsync(fallClipUrl);
          const clip = clipFbx.animations[0];
          if (clip) {
            mixer = new THREE.AnimationMixer(rider);
            fallAction = mixer.clipAction(clip);
            fallAction.loop = THREE.LoopOnce;
            fallAction.clampWhenFinished = true;
          }
        }
      }
    } catch (err) {
      console.warn(`[${manifest.id}] rider load failed — continuing without rider`, err);
    }
  }

  // ── Per-frame scratch (alloc-free). ────────────────────────────────────────
  const chassisQuat = new THREE.Quaternion();
  const leanQuat = new THREE.Quaternion();
  const steerQuat = new THREE.Quaternion();
  const spinQuat = new THREE.Quaternion();
  let lean = 0; // current smoothed lean angle (rad)

  function applySnapshot(snapshot: VehicleVisualSnapshot): void {
    container.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
    chassisQuat.set(
      snapshot.rotation.x,
      snapshot.rotation.y,
      snapshot.rotation.z,
      snapshot.rotation.w,
    );

    // Cosmetic lean — derived from speed × front-wheel steer. It ALWAYS tracks
    // its target (and so smoothly returns to upright when the bike slows or
    // straightens, e.g. after a knock): the physics chassis is a never-flip rig
    // that the anti-roll rights, so a frozen lean would leave the bike reading as
    // permanently tilted. (A crash plays the rider fall clip independently; it no
    // longer freezes the body lean.)
    const steer = snapshot.wheels[0]?.steering ?? 0;
    const speed = snapshot.speed ?? 0;
    const target = clamp(LEAN_SIGN * LEAN_GAIN * speed * steer, -MAX_LEAN_RAD, MAX_LEAN_RAD);
    lean += (target - lean) * LEAN_SMOOTH;
    leanQuat.setFromAxisAngle(FORWARD, lean);
    container.quaternion.copy(chassisQuat).multiply(leanQuat);
    container.updateMatrixWorld(true);

    // Steering — turn the steer pivot (front wheel + grips) about the rake axis,
    // clamped for a believable lock. Falls back to steering the front wheel about
    // pure vertical at its hub if the GLB carries no steer node.
    const steerVis = clamp(steer, -steerMaxRad, steerMaxRad);
    if (steerNode) {
      steerNode.quaternion.setFromAxisAngle(rakeAxis, steerVis);
      if (wheelFront) wheelFront.quaternion.setFromAxisAngle(RIGHT, snapshot.wheels[0]?.rotation ?? 0);
    } else if (wheelFront) {
      // No baked steer pivot: turn the front wheel in place about the same rake
      // axis (through its own hub), so steering stays consistent with the manifest
      // — the slight rake-induced camber matches a real steered front wheel.
      steerQuat.setFromAxisAngle(rakeAxis, steerVis);
      spinQuat.setFromAxisAngle(RIGHT, snapshot.wheels[0]?.rotation ?? 0);
      wheelFront.quaternion.copy(steerQuat).multiply(spinQuat);
    }
    if (wheelRear) wheelRear.quaternion.setFromAxisAngle(RIGHT, snapshot.wheels[2]?.rotation ?? 0);
  }

  function update(dt: number): void {
    if (mixer) mixer.update(dt);
  }

  function crash(): void {
    if (crashed) return;
    crashed = true;
    if (fallAction) {
      fallAction.reset();
      fallAction.play();
    }
    // Without a fall clip we simply freeze the lean (handled in applySnapshot);
    // the bike body still tumbles via the physics chassis pose.
  }

  function dispose(): void {
    mixer?.stopAllAction();
    container.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else mat.dispose();
    });
    container.removeFromParent();
  }

  return { group: container, applySnapshot, update, crash, dispose, riderRig };
}

/** Load the rider FBX, build a {@link RiderRig}, and pose it into the sport tuck. */
async function loadRider(
  container: THREE.Group,
  manifest: VehicleManifest,
  riderUrl: string,
): Promise<RiderRig> {
  const fbx = await new FBXLoader().loadAsync(riderUrl);
  const rider = fbx as unknown as THREE.Group;
  rider.name = 'bike-rider';
  rider.scale.setScalar(manifest.rider?.scale ?? 0.01);
  // The rig discovers the (possibly multiple) skeletons, parents the rider, and
  // measures the seat + grip hardpoints; applyPose then solves the IK.
  // DEFAULT_RIDE_POSE reproduces the original hand-tuned sport posture exactly.
  const rig = createRiderRig({ rider, container, manifest });
  rig.applyPose(DEFAULT_RIDE_POSE);
  return rig;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
