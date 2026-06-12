import * as THREE from 'three';
import type { VehicleManifest } from '@trace/core';

/**
 * Rider rig — the re-poseable humanoid that sits on a bike.
 *
 * This is the single source of truth for *how* the Mixamo rider is posed. Both
 * the game (`createBikeVisual`) and the dev pose editor (`/pose-editor.html`)
 * build a rig from the same loaded FBX and drive it through {@link RiderRig.applyPose},
 * so a pose authored in the editor lands identically in-game.
 *
 * The pose is solved with inverse kinematics rather than hand-tuned Euler angles:
 * Mixamo bone frames vary per bone, so we never set raw rotations on the limbs —
 * instead we
 *   - tuck the spine/neck forward (explicit, the one place rotations are sane),
 *   - seat the hips on the bike, then
 *   - run a 2-bone IK so the HANDS land on the bike's actual grip meshes and the
 *     FEET land on the footpegs (estimated from the seat).
 * That guarantees the limbs match the bike's hardpoints no matter the model.
 *
 * A {@link RiderPose} carries everything that distinguishes one posture from
 * another, expressed as offsets layered on the bike's hardpoints (auto-detected
 * grips + manifest seat). So {@link DEFAULT_RIDE_POSE} reproduces the original
 * hand-tuned sport tuck exactly, and authored poses (corner, brake, wheelie,
 * stoppie) are deltas from there.
 *
 * IMPORTANT: {@link RiderRig.applyPose} solves the IK in the bike *container's*
 * local frame, treated as world — which is exact while the container sits at the
 * identity (true at asset load and in the pose editor). Per-frame re-posing of a
 * moving bike would need the targets transformed by the container's world matrix;
 * that's a deliberate follow-up, not wired here.
 *
 * Directions/offsets are (x, y, z): +x = rider's left, +y = up, +z = forward.
 */

export type Vec3 = [number, number, number];

/** A single rider posture — targets/offsets layered on the bike's hardpoints. */
export type RiderPose = {
  /** Hip-seat nudge relative to (manifest seat + manifest rider.offset), metres. */
  hips: Vec3;
  /** Hand-target delta from the auto-detected handlebar grip, per hand (metres). */
  gripL: Vec3;
  gripR: Vec3;
  /** Footpeg target relative to the seat anchor (container metres). */
  pegL: Vec3;
  pegR: Vec3;
  /** Spine-chain tuck eulers (radians, XYZ) — torso crouch + head craning. */
  spine: Vec3;
  spine1: Vec3;
  spine2: Vec3;
  neck: Vec3;
  head: Vec3;
  /** Elbow / knee pole hints — which way the joint bows (world dir). Per-side so
   *  each elbow and knee can be aimed independently in the editor. */
  armPoleL: Vec3;
  armPoleR: Vec3;
  legPoleL: Vec3;
  legPoleR: Vec3;
  /** Foot toe aim (world dir): points the sole onto the peg. */
  footAim: Vec3;
};

export type RiderPoseName = 'idle' | 'corner' | 'brake' | 'wheelie' | 'stoppie';
export type RiderPoseSet = Record<RiderPoseName, RiderPose>;

/** Ordered pose names — the states a rider blends between as the bike is driven. */
export const RIDER_POSE_NAMES: readonly RiderPoseName[] = [
  'idle',
  'corner',
  'brake',
  'wheelie',
  'stoppie',
];

/**
 * The original hand-tuned sport tuck. These were the hard-coded constants in
 * `bike-visual.ts` (POSE_EULERS / PEG_OFFSET / *_POLE / FOOT_AIM); keeping them
 * here as the default means the refactored game look is byte-identical.
 */
export const DEFAULT_RIDE_POSE: RiderPose = {
  hips: [0, 0, 0],
  gripL: [0, 0, 0],
  gripR: [0, 0, 0],
  pegL: [0.23, -0.45, 0.0],
  pegR: [-0.23, -0.45, 0.0],
  spine: [0.34, 0, 0], // tuck the torso forward over the tank (sport posture)…
  spine1: [0.26, 0, 0],
  spine2: [0.18, 0, 0],
  neck: [-0.46, 0, 0], // …but crane the head up so the eyes stay on the road
  head: [-0.12, 0, 0],
  armPoleL: [0.35, -0.7, -0.55],
  armPoleR: [-0.35, -0.7, -0.55],
  // Knees must lead FORWARD over the tank (toward +z). The pole biases the bend
  // toward −z so the knee comes forward and the shin drops to the peg; a small
  // ±x splays each knee outward against the tank. (A +z pole folds the knee
  // backward toward the rear wheel — the "broken knee" bug.)
  legPoleL: [0.15, -0.1, -1],
  legPoleR: [-0.15, -0.1, -1],
  footAim: [0, -0.18, 1],
};

/** Deep-clone a pose (all fields are fresh tuples). */
export function clonePose(p: RiderPose): RiderPose {
  return {
    hips: [...p.hips],
    gripL: [...p.gripL],
    gripR: [...p.gripR],
    pegL: [...p.pegL],
    pegR: [...p.pegR],
    spine: [...p.spine],
    spine1: [...p.spine1],
    spine2: [...p.spine2],
    neck: [...p.neck],
    head: [...p.head],
    armPoleL: [...p.armPoleL],
    armPoleR: [...p.armPoleR],
    legPoleL: [...p.legPoleL],
    legPoleR: [...p.legPoleR],
    footAim: [...p.footAim],
  };
}

/**
 * A starter pose set: every state begins as a copy of the sport tuck, ready for
 * the editor to author the per-state deltas (lean into the corner, weight back
 * for the wheelie, forward for the stoppie, …).
 */
export function defaultPoseSet(): RiderPoseSet {
  return {
    idle: clonePose(DEFAULT_RIDE_POSE),
    corner: clonePose(DEFAULT_RIDE_POSE),
    brake: clonePose(DEFAULT_RIDE_POSE),
    wheelie: clonePose(DEFAULT_RIDE_POSE),
    stoppie: clonePose(DEFAULT_RIDE_POSE),
  };
}

export type RiderRig = {
  /** The rider object (already parented to the bike container). */
  object: THREE.Object3D;
  /**
   * Bike hardpoints in container-local space, for an editor to place handles:
   * `seat` = manifest seat + rider.offset; `gripL`/`gripR` = the detected bar ends
   * (null only if the GLB carries no `grips` mesh).
   */
  hardpoints: {
    seat: THREE.Vector3;
    gripL: THREE.Vector3 | null;
    gripR: THREE.Vector3 | null;
  };
  /** Re-pose the rider into `pose`. Idempotent; safe to call every drag. */
  applyPose(pose: RiderPose): void;
  /**
   * World position of a rider bone (e.g. `'leftarm'`, `'leftupleg'`, `'leftleg'`,
   * `'leftforearm'`) after the last {@link applyPose}, or null if absent. Used by
   * the editor to anchor the elbow/knee gizmos on the real joints.
   */
  boneWorld(key: string): THREE.Vector3 | null;
  /**
   * Runtime secondary motion: add small euler offsets (radians, XYZ) to the
   * spine-chain bones on top of the last applied pose, so the rider sways/leans/
   * breathes as the bike is driven instead of riding like a statue. Only the
   * named spine/neck/head bones move — the IK'd limbs stay put. Cheap; safe to
   * call every frame. Offsets of 0 reproduce the static pose exactly.
   */
  applySpineOffsets(offsets: Partial<Record<SpineOffsetKey, Vec3>>): void;
};

/** Spine-chain bones the runtime secondary-motion layer is allowed to nudge. */
export type SpineOffsetKey = 'spine' | 'spine1' | 'spine2' | 'neck' | 'head';
const SPINE_OFFSET_KEYS: readonly SpineOffsetKey[] = ['spine', 'spine1', 'spine2', 'neck', 'head'];

export type CreateRiderRigOptions = {
  /** The loaded rider FBX scene (already named/scaled/shadowed by the caller). */
  rider: THREE.Object3D;
  /** The bike container the rider is parented onto (holds the GLB + `grips`). */
  container: THREE.Object3D;
  manifest: VehicleManifest;
};

/**
 * Build a {@link RiderRig} from a loaded rider FBX + the bike container. Discovers
 * the (possibly multiple) skinned skeletons, parents the rider, measures the
 * rest-pose hip anchor and the handlebar grips once, and returns a rig whose
 * {@link RiderRig.applyPose} can be called repeatedly.
 */
export function createRiderRig(opts: CreateRiderRigOptions): RiderRig {
  const { rider, container, manifest } = opts;

  // The X-Bot ships TWO skinned meshes (body "Surface" + ball-joint "Joints"),
  // each with its own skeleton. We pose every skeleton, reading bones from
  // `skeleton.bones` (properly nested) — `traverse` also returns childless
  // duplicate bone instances that break IK.
  const skeletons: THREE.Skeleton[] = [];
  rider.traverse((obj) => {
    const sm = obj as THREE.SkinnedMesh;
    if ((obj as THREE.Mesh).isMesh || sm.isSkinnedMesh) {
      obj.castShadow = true;
      obj.frustumCulled = false; // skinned meshes mis-cull at the seat origin
    }
    if (sm.isSkinnedMesh && sm.skeleton && !skeletons.includes(sm.skeleton)) {
      skeletons.push(sm.skeleton);
    }
  });

  const boneMaps: Map<string, THREE.Object3D>[] = [];
  let hips: THREE.Object3D | null = null;
  for (const skel of skeletons) {
    const bones = new Map<string, THREE.Object3D>();
    for (const b of skel.bones) {
      const key = normalizeBone(b.name);
      bones.set(key, b);
      if (key === 'hips' && !hips) hips = b;
    }
    boneMaps.push(bones);
  }

  // Parent the rider, then measure its rest-pose hip anchor (rider at the origin)
  // — the hips bone is the skeleton root, so the spine tuck and limb IK never move
  // it, and this offset is invariant across poses.
  rider.position.set(0, 0, 0);
  rider.quaternion.identity();
  container.add(rider);
  container.updateMatrixWorld(true);
  const hipsRestLocal = new THREE.Vector3();
  if (hips) container.worldToLocal(hips.getWorldPosition(hipsRestLocal));

  // Base seat anchor (container-local) = manifest seat + manifest rider nudge.
  const seat = manifest.rig.seat;
  const roff = manifest.rider?.offset ?? [0, 0, 0];
  const baseSeat = new THREE.Vector3(seat[0] + roff[0], seat[1] + roff[1], seat[2] + roff[2]);

  // Handlebar grips (container-local). Detected once; the container is at the
  // identity here so world == container-local.
  const gripsWorld = findGripTargets(container);
  const gripL = gripsWorld ? container.worldToLocal(gripsWorld.left.clone()) : null;
  const gripR = gripsWorld ? container.worldToLocal(gripsWorld.right.clone()) : null;

  const hardpoints = { seat: baseSeat.clone(), gripL, gripR } as const;

  // Per-call scratch (alloc-free across repeated drags).
  const _hipSeat = new THREE.Vector3();
  const _gripLT = new THREE.Vector3();
  const _gripRT = new THREE.Vector3();
  const _pegLT = new THREE.Vector3();
  const _pegRT = new THREE.Vector3();

  // The last applied pose — the rest the runtime secondary motion offsets from.
  let currentPose: RiderPose = DEFAULT_RIDE_POSE;

  function applyPose(pose: RiderPose): void {
    currentPose = pose;
    // 1. Spine/neck tuck (the limbs are handled by IK, below).
    for (const bones of boneMaps) {
      bones.get('spine')?.rotation.set(pose.spine[0], pose.spine[1], pose.spine[2]);
      bones.get('spine1')?.rotation.set(pose.spine1[0], pose.spine1[1], pose.spine1[2]);
      bones.get('spine2')?.rotation.set(pose.spine2[0], pose.spine2[1], pose.spine2[2]);
      bones.get('neck')?.rotation.set(pose.neck[0], pose.neck[1], pose.neck[2]);
      bones.get('head')?.rotation.set(pose.head[0], pose.head[1], pose.head[2]);
    }
    rider.updateMatrixWorld(true);

    // 2. Seat the rider so its Hips bone lands on the (nudged) seat anchor.
    _hipSeat.copy(baseSeat).add(new THREE.Vector3(pose.hips[0], pose.hips[1], pose.hips[2]));
    rider.position.copy(_hipSeat).sub(hipsRestLocal); // moving rider moves hips 1:1
    rider.updateMatrixWorld(true);

    // 3. Targets: hands → grips (+delta), feet → pegs (relative to the base seat,
    //    so the feet stay planted when the hips shift for a wheelie/stoppie).
    _pegLT.copy(baseSeat).add(new THREE.Vector3(pose.pegL[0], pose.pegL[1], pose.pegL[2]));
    _pegRT.copy(baseSeat).add(new THREE.Vector3(pose.pegR[0], pose.pegR[1], pose.pegR[2]));
    const gLt = gripL ? _gripLT.copy(gripL).add(new THREE.Vector3(...pose.gripL)) : undefined;
    const gRt = gripR ? _gripRT.copy(gripR).add(new THREE.Vector3(...pose.gripR)) : undefined;

    // 4. Solve each skeleton's limbs.
    for (const bones of boneMaps) {
      const ik = (
        u: string,
        l: string,
        e: string,
        t: THREE.Vector3 | undefined,
        pole: Vec3,
      ): void => {
        const bu = bones.get(u);
        const bl = bones.get(l);
        const be = bones.get(e);
        if (bu && bl && be && t) solveTwoBoneIK(bu, bl, be, t, pole);
      };
      ik('leftarm', 'leftforearm', 'lefthand', gLt, pose.armPoleL);
      ik('rightarm', 'rightforearm', 'righthand', gRt, pose.armPoleR);
      ik('leftupleg', 'leftleg', 'leftfoot', _pegLT, pose.legPoleL);
      ik('rightupleg', 'rightleg', 'rightfoot', _pegRT, pose.legPoleR);
      // Plant the feet: aim each foot's toe forward+down so the sole rests on the
      // peg rather than hanging from the rest pose.
      const lf = bones.get('leftfoot');
      const rf = bones.get('rightfoot');
      if (lf) aimBone(lf, pose.footAim);
      if (rf) aimBone(rf, pose.footAim);
    }
  }

  function boneWorld(key: string): THREE.Vector3 | null {
    const bone = boneMaps[0]?.get(normalizeBone(key));
    return bone ? bone.getWorldPosition(new THREE.Vector3()) : null;
  }

  function applySpineOffsets(offsets: Partial<Record<SpineOffsetKey, Vec3>>): void {
    for (const bones of boneMaps) {
      for (const key of SPINE_OFFSET_KEYS) {
        const off = offsets[key];
        if (!off) continue;
        const bone = bones.get(key);
        if (!bone) continue;
        const rest = currentPose[key]; // rest euler from the baked pose
        bone.rotation.set(rest[0] + off[0], rest[1] + off[1], rest[2] + off[2]);
      }
    }
  }

  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    console.log(
      `[${manifest.id}] rider rig: ${skeletons.length} skeleton(s), grips=${
        gripsWorld ? 'found' : 'MISSING'
      }, hips=${hips ? 'found' : 'MISSING'}`,
    );
  }

  return { object: rider, hardpoints, applyPose, boneWorld, applySpineOffsets };
}

// ── IK primitives (model-frame-agnostic) ─────────────────────────────────────

/** Normalize a bone name so pose lookups are robust to loader name munging. */
export function normalizeBone(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^mixamorig/, '');
}

const _boneW = new THREE.Vector3();
const _childW = new THREE.Vector3();
const _d0 = new THREE.Vector3();
const _d1 = new THREE.Vector3();
const _qDelta = new THREE.Quaternion();
const _qWorld = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();

/**
 * Rotate `bone` so the segment to its first child points along `worldDir`.
 * Frame-agnostic — works regardless of the bone's local axis convention.
 */
export function aimBone(bone: THREE.Object3D, worldDir: Vec3): void {
  // Pick the FARTHEST bone child — a bone can have a zero-length twist/helper
  // child first (Mixamo arms do), which would give a garbage direction.
  bone.updateWorldMatrix(true, false);
  _boneW.setFromMatrixPosition(bone.matrixWorld);
  let child: THREE.Object3D | null = null;
  let bestDist = 1e-4;
  for (const c of bone.children) {
    if (!(c as THREE.Bone).isBone) continue;
    c.updateWorldMatrix(true, false);
    const d = _childW.setFromMatrixPosition(c.matrixWorld).distanceTo(_boneW);
    if (d > bestDist) {
      bestDist = d;
      child = c;
    }
  }
  if (!child) return;
  _childW.setFromMatrixPosition(child.matrixWorld);
  _d0.copy(_childW).sub(_boneW).normalize();
  _d1.set(worldDir[0], worldDir[1], worldDir[2]).normalize();
  _qDelta.setFromUnitVectors(_d0, _d1); // world-space rotation d0 → d1
  bone.getWorldQuaternion(_qWorld);
  _qWorld.premultiply(_qDelta); // new desired world quaternion
  if (bone.parent) bone.parent.getWorldQuaternion(_qParent);
  else _qParent.identity();
  bone.quaternion.copy(_qParent.invert().multiply(_qWorld));
  bone.updateWorldMatrix(false, true);
}

const _ikRoot = new THREE.Vector3();
const _ikMid = new THREE.Vector3();
const _ikEnd = new THREE.Vector3();
const _ikDir = new THREE.Vector3();
const _ikAxis = new THREE.Vector3();
const _ikUp = new THREE.Vector3();
const _ikQ = new THREE.Quaternion();

/**
 * Analytic 2-bone IK: rotate `upper` + `lower` so `end`'s joint reaches
 * `target` (world). `pole` (world dir) biases which way the elbow/knee bows.
 * Built on {@link aimBone} so it's robust to Mixamo's per-bone axis frames.
 */
export function solveTwoBoneIK(
  upper: THREE.Object3D,
  lower: THREE.Object3D,
  end: THREE.Object3D,
  target: THREE.Vector3,
  pole: Vec3,
): void {
  upper.updateWorldMatrix(true, false);
  _ikRoot.setFromMatrixPosition(upper.matrixWorld);
  lower.updateWorldMatrix(true, false);
  _ikMid.setFromMatrixPosition(lower.matrixWorld);
  end.updateWorldMatrix(true, false);
  _ikEnd.setFromMatrixPosition(end.matrixWorld);
  const a = _ikRoot.distanceTo(_ikMid); // upper segment length
  const b = _ikMid.distanceTo(_ikEnd); // lower segment length
  _ikDir.copy(target).sub(_ikRoot);
  let d = _ikDir.length();
  d = Math.min(Math.max(d, 1e-3), a + b - 1e-3); // clamp to reachable range
  _ikDir.normalize();
  // Interior angle at the root between the upper bone and the root→target line.
  const cosA = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d)));
  const angA = Math.acos(cosA);
  _ikUp.set(pole[0], pole[1], pole[2]).normalize();
  _ikAxis.crossVectors(_ikDir, _ikUp);
  if (_ikAxis.lengthSq() < 1e-6) _ikAxis.set(1, 0, 0);
  _ikAxis.normalize();
  _ikQ.setFromAxisAngle(_ikAxis, -angA);
  _ikUp.copy(_ikDir).applyQuaternion(_ikQ); // upper-bone direction (reuse _ikUp)
  aimBone(upper, [_ikUp.x, _ikUp.y, _ikUp.z]);
  // The mid joint is now placed so |mid→target| == b; point the lower bone at it.
  lower.updateWorldMatrix(true, false);
  _ikMid.setFromMatrixPosition(lower.matrixWorld);
  aimBone(lower, [target.x - _ikMid.x, target.y - _ikMid.y, target.z - _ikMid.z]);
}

/**
 * The two handlebar grip positions (world space). Found from the `grips` mesh by
 * clustering its outermost ±x vertices (the bar ends the hands wrap).
 */
export function findGripTargets(
  container: THREE.Object3D,
): { left: THREE.Vector3; right: THREE.Vector3 } | null {
  let grips: THREE.Mesh | null = null;
  container.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!grips && m.isMesh && /grip/i.test(m.name)) grips = m;
  });
  if (!grips) return null;
  const mesh = grips as THREE.Mesh;
  mesh.updateWorldMatrix(true, false);
  const pos = mesh.geometry.getAttribute('position');
  const v = new THREE.Vector3();
  let xMin = Infinity;
  let xMax = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    if (v.x < xMin) xMin = v.x;
    if (v.x > xMax) xMax = v.x;
  }
  const left = new THREE.Vector3();
  const right = new THREE.Vector3();
  let nl = 0;
  let nr = 0;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    if (v.x >= xMax - 0.07) {
      left.add(v);
      nl++;
    } else if (v.x <= xMin + 0.07) {
      right.add(v);
      nr++;
    }
  }
  if (nl === 0 || nr === 0) return null;
  return { left: left.multiplyScalar(1 / nl), right: right.multiplyScalar(1 / nr) };
}
