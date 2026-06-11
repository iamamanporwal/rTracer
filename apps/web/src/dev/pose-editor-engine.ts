/**
 * Pose editor — three.js engine (no UI). Owns the scene, the bike + rider, the
 * draggable gizmos, and the authoritative {@link RiderPoseSet}. The React panel
 * ({@link PoseEditorApp}) drives it through plain methods and listens via
 * {@link PoseEditorEngine.onChange}; this file imports nothing from React.
 *
 * Two kinds of gizmo, both solved in the bike container's identity frame (see
 * `rider-rig.ts`), so a handle's scene position is the rig's target coordinate:
 *   - **position effectors** (hips, grips, pegs) — drag moves the IK target.
 *   - **pole handles** (elbows, knees) — drag re-aims which way the joint bends;
 *     the handle sits out from the shoulder/hip along the current pole dir, and
 *     the new pole is the direction from that joint to the handle.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import {
  createBikeVisual,
  defaultPoseSet,
  clonePose,
  DEFAULT_RIDE_POSE,
  type BikeVisual,
  type RiderPose,
  type RiderPoseName,
  type RiderPoseSet,
  type RiderRig,
  type VehicleVisualSnapshot,
} from '@trace/renderer';
import { loadVehicleManifest } from '~/manifests';

/** Draggable targets: five position effectors + four pole handles. */
export type TargetId =
  | 'hips'
  | 'gripL'
  | 'gripR'
  | 'pegL'
  | 'pegR'
  | 'elbowL'
  | 'elbowR'
  | 'kneeL'
  | 'kneeR';

/** Pose fields that are draggable vec3s (everything a gizmo can write). */
type VecField = Extract<
  keyof RiderPose,
  'hips' | 'gripL' | 'gripR' | 'pegL' | 'pegR' | 'armPoleL' | 'armPoleR' | 'legPoleL' | 'legPoleR'
>;

/** State the panel renders from. `current` is a clone — the panel never mutates the rig. */
export type EditorState = {
  pose: RiderPoseName;
  target: TargetId;
  current: RiderPose;
  hasRider: boolean;
};

export type PoseEditorEngine = {
  ready: Promise<void>;
  setPose(name: RiderPoseName): void;
  setTarget(id: TargetId): void;
  /** Set one axis of any vec3 pose field (panel sliders + number inputs). */
  setComponent(field: keyof RiderPose, axis: 0 | 1 | 2, value: number): void;
  resetCurrentPose(): void;
  copyCurrentToAll(): void;
  loadPoseSet(set: Partial<Record<RiderPoseName, Partial<RiderPose>>>): void;
  poseSetJson(): string;
  onChange(cb: (state: EditorState) => void): void;
  dispose(): void;
};

/** TargetId → the pose field it writes, plus (for poles) the joint it pivots from. */
const TARGETS: Record<TargetId, { field: VecField; kind: 'pos' | 'pole'; rootBone?: string }> = {
  hips: { field: 'hips', kind: 'pos' },
  gripL: { field: 'gripL', kind: 'pos' },
  gripR: { field: 'gripR', kind: 'pos' },
  pegL: { field: 'pegL', kind: 'pos' },
  pegR: { field: 'pegR', kind: 'pos' },
  elbowL: { field: 'armPoleL', kind: 'pole', rootBone: 'leftarm' },
  elbowR: { field: 'armPoleR', kind: 'pole', rootBone: 'rightarm' },
  kneeL: { field: 'legPoleL', kind: 'pole', rootBone: 'leftupleg' },
  kneeR: { field: 'legPoleR', kind: 'pole', rootBone: 'rightupleg' },
};
const TARGET_COLORS: Record<TargetId, number> = {
  hips: 0xffcc33,
  gripL: 0x4ab6ff,
  gripR: 0x2f6bff,
  pegL: 0x4cf08a,
  pegR: 0x23b766,
  elbowL: 0x46e8e0,
  elbowR: 0x16b6ae,
  kneeL: 0xffa23a,
  kneeR: 0xe07d18,
};
/** How far out from the shoulder/hip a pole handle floats (m). */
const POLE_LEN = 0.32;

/** Selector metadata for the React panel — grouped, labelled, mapped to fields. */
export const TARGET_LIST: readonly {
  id: TargetId;
  label: string;
  group: string;
  field: keyof RiderPose;
  kind: 'pos' | 'pole';
}[] = [
  { id: 'hips', label: 'Hips', group: 'Body', field: 'hips', kind: 'pos' },
  { id: 'gripL', label: 'Left hand', group: 'Hands', field: 'gripL', kind: 'pos' },
  { id: 'gripR', label: 'Right hand', group: 'Hands', field: 'gripR', kind: 'pos' },
  { id: 'pegL', label: 'Left foot', group: 'Feet', field: 'pegL', kind: 'pos' },
  { id: 'pegR', label: 'Right foot', group: 'Feet', field: 'pegR', kind: 'pos' },
  { id: 'elbowL', label: 'Left elbow', group: 'Elbows', field: 'armPoleL', kind: 'pole' },
  { id: 'elbowR', label: 'Right elbow', group: 'Elbows', field: 'armPoleR', kind: 'pole' },
  { id: 'kneeL', label: 'Left knee', group: 'Knees', field: 'legPoleL', kind: 'pole' },
  { id: 'kneeR', label: 'Right knee', group: 'Knees', field: 'legPoleR', kind: 'pole' },
];

/** Physics `restHubLocalY` per bike (the value the game derives). Override via `?hub=`. */
export function defaultHub(vehicleId: string): number {
  const known: Record<string, number> = { vehicle_bike: -0.2708, vehicle_jawa: -0.179 };
  return known[vehicleId] ?? -0.2708;
}

export function createPoseEditorEngine(opts: {
  canvas: HTMLCanvasElement;
  vehicleId: string;
  hub: number;
}): PoseEditorEngine {
  const { canvas, vehicleId, hub } = opts;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#10141b');

  const camera = new THREE.PerspectiveCamera(40, aspect(), 0.05, 100);
  camera.position.set(2.4, 1.3, 2.4);

  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.target.set(0, 0.6, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x404048, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(4, 6, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xbfd0ff, 0.6);
  fill.position.set(-4, 3, -2);
  scene.add(fill);

  const grid = new THREE.GridHelper(20, 20, 0x40556e, 0x27323f);
  scene.add(grid);

  function aspect(): number {
    return (canvas.clientWidth || window.innerWidth) / (canvas.clientHeight || window.innerHeight);
  }
  function onResize(): void {
    camera.aspect = aspect();
    camera.updateProjectionMatrix();
    renderer.setSize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
  }
  window.addEventListener('resize', onResize);

  const neutral: VehicleVisualSnapshot = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    speed: 0,
    wheels: Array.from({ length: 4 }, () => ({
      position: { x: 0, y: 0, z: 0 },
      steering: 0,
      rotation: 0,
      inContact: true,
    })),
  };

  // ── Mutable editor state ──────────────────────────────────────────────────
  const poseSet: RiderPoseSet = defaultPoseSet();
  let pose: RiderPoseName = 'idle';
  let target: TargetId = 'hips';
  let rig: RiderRig | null = null;
  let visual: BikeVisual | null = null;
  let changeCb: ((s: EditorState) => void) | null = null;
  let running = true;

  const handles = {} as Record<TargetId, THREE.Mesh>;
  const handleGeom = new THREE.SphereGeometry(0.028, 16, 12);
  const gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setMode('translate');
  gizmo.setSpace('world');
  gizmo.setSize(0.65);
  scene.add(gizmo.getHelper());
  gizmo.addEventListener('dragging-changed', (e) => {
    orbit.enabled = !e.value;
  });
  gizmo.addEventListener('objectChange', onGizmoDrag);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const _v = new THREE.Vector3();

  /** Base point a target's offset is measured from (container-local == world). */
  function baseOf(id: TargetId): THREE.Vector3 | null {
    const def = TARGETS[id];
    if (!rig) return null;
    if (def.kind === 'pos') {
      if (id === 'gripL') return rig.hardpoints.gripL;
      if (id === 'gripR') return rig.hardpoints.gripR;
      return rig.hardpoints.seat; // hips, pegL, pegR
    }
    return rig.boneWorld(def.rootBone ?? ''); // pole: shoulder / hip
  }

  function placeHandle(id: TargetId): void {
    const mesh = handles[id];
    const base = baseOf(id);
    const def = TARGETS[id];
    const val = poseSet[pose][def.field];
    if (!base) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    if (def.kind === 'pos') {
      mesh.position.set(base.x + val[0], base.y + val[1], base.z + val[2]);
    } else {
      // Float the handle out from the joint along the (normalized) pole dir.
      _v.set(val[0], val[1], val[2]);
      if (_v.lengthSq() < 1e-6) _v.set(0, 0, 1);
      _v.normalize().multiplyScalar(POLE_LEN);
      mesh.position.set(base.x + _v.x, base.y + _v.y, base.z + _v.z);
    }
  }
  function placeAllHandles(): void {
    for (const id of Object.keys(handles) as TargetId[]) placeHandle(id);
  }

  function attachGizmo(): void {
    const mesh = handles[target];
    if (mesh?.visible) gizmo.attach(mesh);
    else gizmo.detach();
  }

  function onGizmoDrag(): void {
    if (!rig) return;
    const def = TARGETS[target];
    const base = baseOf(target);
    if (!base) return;
    const p = handles[target].position;
    const out = poseSet[pose][def.field];
    if (def.kind === 'pos') {
      out[0] = p.x - base.x;
      out[1] = p.y - base.y;
      out[2] = p.z - base.z;
    } else {
      _v.set(p.x - base.x, p.y - base.y, p.z - base.z);
      if (_v.lengthSq() < 1e-6) _v.set(0, 0, 1);
      _v.normalize();
      out[0] = _v.x;
      out[1] = _v.y;
      out[2] = _v.z;
    }
    rig.applyPose(poseSet[pose]);
    notify(); // pole solves move the limbs; let the panel reflect the new numbers
  }

  function applyAndPlace(): void {
    if (rig) rig.applyPose(poseSet[pose]);
    placeAllHandles();
    attachGizmo();
  }

  function notify(): void {
    changeCb?.({ pose, target, current: clonePose(poseSet[pose]), hasRider: !!rig });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  async function boot(): Promise<void> {
    const manifest = await loadVehicleManifest(vehicleId, '0.1.0');
    const bundle = `/assets/vehicles/${vehicleId}/v0.1.0`;
    visual = await createBikeVisual({
      url: `${bundle}/${manifest.visual?.glb}`,
      manifest,
      restHubLocalY: hub,
      environment: null,
      riderUrl: manifest.rider ? `${bundle}/${manifest.rider.fbx}` : null,
      fallClipUrl: null,
    });
    scene.add(visual.group);
    visual.applySnapshot(neutral); // container → identity (the posing frame)
    grid.position.y = new THREE.Box3().setFromObject(visual.group).min.y;

    rig = visual.riderRig;
    for (const id of Object.keys(TARGETS) as TargetId[]) {
      const mat = new THREE.MeshBasicMaterial({ color: TARGET_COLORS[id], depthTest: false });
      const mesh = new THREE.Mesh(handleGeom, mat);
      mesh.renderOrder = 999;
      mesh.visible = false;
      scene.add(mesh);
      handles[id] = mesh;
    }
    applyAndPlace();
    notify();
    animate();
  }

  function animate(): void {
    if (!running) return;
    requestAnimationFrame(animate);
    orbit.update();
    renderer.render(scene, camera);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  const ready = boot();

  function setPose(name: RiderPoseName): void {
    pose = name;
    applyAndPlace();
    notify();
  }
  function setTarget(id: TargetId): void {
    target = id;
    attachGizmo();
    notify();
  }
  function setComponent(field: keyof RiderPose, axis: 0 | 1 | 2, value: number): void {
    poseSet[pose][field][axis] = value;
    applyAndPlace();
    notify();
  }
  function resetCurrentPose(): void {
    poseSet[pose] = clonePose(DEFAULT_RIDE_POSE);
    applyAndPlace();
    notify();
  }
  function copyCurrentToAll(): void {
    const src = poseSet[pose];
    for (const name of Object.keys(poseSet) as RiderPoseName[]) {
      if (name !== pose) poseSet[name] = clonePose(src);
    }
    notify();
  }
  function loadPoseSet(set: Partial<Record<RiderPoseName, Partial<RiderPose>>>): void {
    for (const name of Object.keys(poseSet) as RiderPoseName[]) {
      const incoming = migratePose(set[name]);
      if (incoming) poseSet[name] = { ...clonePose(DEFAULT_RIDE_POSE), ...incoming };
    }
    applyAndPlace();
    notify();
  }
  function poseSetJson(): string {
    return JSON.stringify(poseSet, null, 2);
  }
  function onChange(cb: (s: EditorState) => void): void {
    changeCb = cb;
    notify();
  }
  function dispose(): void {
    running = false;
    window.removeEventListener('resize', onResize);
    gizmo.removeEventListener('objectChange', onGizmoDrag);
    gizmo.detach();
    orbit.dispose();
    visual?.dispose();
    handleGeom.dispose();
    for (const m of Object.values(handles)) (m.material as THREE.Material).dispose();
    renderer.dispose();
  }

  return {
    ready,
    setPose,
    setTarget,
    setComponent,
    resetCurrentPose,
    copyCurrentToAll,
    loadPoseSet,
    poseSetJson,
    onChange,
    dispose,
  };
}

/** Back-compat: an old pose with a single `legPole` → per-side `legPoleL/R`. */
function migratePose(p: (Partial<RiderPose> & { legPole?: [number, number, number] }) | undefined):
  | Partial<RiderPose>
  | undefined {
  if (!p) return undefined;
  if (p.legPole && !p.legPoleL && !p.legPoleR) {
    const { legPole, ...rest } = p;
    return { ...rest, legPoleL: [...legPole], legPoleR: [...legPole] };
  }
  return p;
}
