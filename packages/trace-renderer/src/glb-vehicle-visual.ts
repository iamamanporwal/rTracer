import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { VehicleManifest } from '@trace/core';
import type { VehicleVisual, VehicleVisualSnapshot } from './vehicle-visual';

/**
 * GLB-backed vehicle visual — the production path for real, downloaded car
 * models (blueprint P1-14). It honours the same {@link VehicleVisual} contract
 * as the procedural demo body (`group` + `applySnapshot` + `dispose`), so the
 * session wires it interchangeably.
 *
 * The hard part with downloaded models is rigging the wheels for a raycast
 * vehicle. We don't trust the wheel nodes' own pivots (several exports bake them
 * at the model origin, or split one wheel across sibling nodes). Instead, at
 * load we:
 *
 *   1. **Fit** the scene to game units — uniform `scale`, optional `yaw` to face
 *      +Z, and a recenter so the wheel centroid lands at the body origin and the
 *      hubs sit at their rest height.
 *   2. **Reparent** each of the four wheel clusters (named per-manifest) onto a
 *      fresh pivot placed at the cluster's *bounding-box center* — the true
 *      axle — using `Object3D.attach` to preserve world transform. The wheel
 *      therefore spins about its real axle no matter where its node origin was.
 *   3. **Match** each pivot to a physics wheel by nearest rig position, so the
 *      per-frame hub/steer/spin from Rapier drives the correct corner.
 *
 * Everything else stays parented under the body and rides the chassis pose.
 */

export type CreateGlbVehicleVisualOptions = {
  /** Absolute URL to the `.gltf`/`.glb` (textures resolve relative to it). */
  url: string;
  manifest: VehicleManifest;
  /**
   * Body-local Y the wheel hub rests at (= wheel radius − chassis-center height
   * above ground). Used only to seat the body mesh at the right height; the
   * wheels themselves are placed from physics each frame.
   */
  restHubLocalY: number;
  /** Optional environment map for PBR reflections (chrome/paint). */
  environment?: THREE.Texture | null;
};

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const WHEEL_KEYS = ['fl', 'fr', 'rl', 'rr'] as const;

type WheelPivot = {
  pivot: THREE.Group;
  /** Body-local rest center, used only as a fallback before the first frame. */
  rest: THREE.Vector3;
};

/**
 * Load + rig a GLB into a {@link VehicleVisual}. Async because it fetches the
 * model; the session already awaits it during `startZoneSession`.
 */
export async function createGlbVehicleVisual(
  options: CreateGlbVehicleVisualOptions,
): Promise<VehicleVisual> {
  const { url, manifest, restHubLocalY, environment } = options;
  const cfg = manifest.visual;
  if (!cfg) throw new Error(`vehicle ${manifest.id}: createGlbVehicleVisual called without visual config`);

  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene;

  // ── Fit: scale + yaw, then recenter so the wheel centroid sits at the body
  //    origin and hubs at rest height. ───────────────────────────────────────
  const container = new THREE.Group();
  container.name = `vehicle:${manifest.id}`;
  const fit = new THREE.Group();
  fit.name = 'glb-fit';
  fit.add(root);
  container.add(fit);

  const scale = cfg.scale ?? 1;
  fit.scale.setScalar(scale);
  fit.rotation.set(0, cfg.yaw ?? 0, 0);
  fit.position.set(0, 0, 0);
  container.updateMatrixWorld(true);

  // ── Static-body mode: no wheel nodes → ride the chassis as one rigid piece. ──
  // Used for models whose wheel geometry is fused into the body mesh (no
  // per-corner nodes to reparent). Wheels in the visual won't spin or steer,
  // but the car body tracks the physics chassis correctly.
  if (!cfg.wheels) {
    // Align the model's ground contact (bottom of filtered bbox) with the
    // physics ground level so the car sits correctly on the road surface.
    // We skip meshes whose any axis exceeds 10 m — these are Sketchfab camera /
    // light helpers that have wildly-off positions and corrupt a naive bbox.
    const MAX_MESH_SPAN = 10;
    const carBox = new THREE.Box3();
    const _spanVec = new THREE.Vector3();
    container.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mb = new THREE.Box3().setFromObject(obj);
      mb.getSize(_spanVec);
      if (Math.max(_spanVec.x, _spanVec.y, _spanVec.z) > MAX_MESH_SPAN) return;
      carBox.union(mb);
    });

    const avgRadius = manifest.rig.wheels.reduce((s, w) => s + w.radius, 0) / 4;
    // Physics: ground sits at (restHubLocalY - wheel radius) in body-local Y.
    const physicsGroundLocalY = restHubLocalY - avgRadius;
    // Model: ground contact = lowest Y in filtered bbox (wheel bottom).
    const modelGroundY = carBox.isEmpty() ? 0 : carBox.min.y;

    const offset = cfg.offset ?? [0, 0, 0];
    fit.position.set(
      offset[0],
      physicsGroundLocalY - modelGroundY + offset[1],
      offset[2],
    );
    container.updateMatrixWorld(true);

    container.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.castShadow = true;
      obj.receiveShadow = true;
      const mat = obj.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach(prepMaterialStatic);
      else prepMaterialStatic(mat);
    });
    function prepMaterialStatic(m: THREE.Material): void {
      const phys = m as THREE.MeshPhysicalMaterial;
      if (phys.isMeshPhysicalMaterial && phys.transmission > 0) {
        phys.transmission = 0;
        phys.transparent = false;
        phys.opacity = 1;
        phys.roughness = Math.min(phys.roughness, 0.2);
        phys.metalness = Math.max(phys.metalness, 0.1);
      }
      m.needsUpdate = true;
      if (environment) {
        const std = m as THREE.MeshStandardMaterial;
        if (std.isMeshStandardMaterial) {
          std.envMap = environment;
          std.envMapIntensity = 1.0;
        }
      }
    }

    return {
      group: container,
      applySnapshot(snapshot: VehicleVisualSnapshot): void {
        container.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
        container.quaternion.set(
          snapshot.rotation.x,
          snapshot.rotation.y,
          snapshot.rotation.z,
          snapshot.rotation.w,
        );
        container.updateMatrixWorld(true);
      },
      dispose(): void {
        container.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.geometry.dispose();
          const mat = mesh.material;
          if (Array.isArray(mat)) for (const m of mat) m.dispose();
          else mat.dispose();
        });
        container.removeFromParent();
      },
    };
  }

  // Resolve the four wheel clusters (node refs) up front, before any reparent.
  const clusterNodes: Record<(typeof WHEEL_KEYS)[number], THREE.Object3D[]> = {
    fl: resolveNodes(root, cfg.wheels.fl, manifest.id, 'fl'),
    fr: resolveNodes(root, cfg.wheels.fr, manifest.id, 'fr'),
    rl: resolveNodes(root, cfg.wheels.rl, manifest.id, 'rl'),
    rr: resolveNodes(root, cfg.wheels.rr, manifest.id, 'rr'),
  };

  // First pass: cluster centers with the model un-shifted → centroid.
  const box = new THREE.Box3();
  const centerOf = (nodes: THREE.Object3D[]): THREE.Vector3 => {
    box.makeEmpty();
    for (const n of nodes) box.expandByObject(n);
    return box.getCenter(new THREE.Vector3());
  };
  const rawCenters = Object.fromEntries(
    WHEEL_KEYS.map((k) => [k, centerOf(clusterNodes[k])]),
  ) as Record<(typeof WHEEL_KEYS)[number], THREE.Vector3>;

  const centroid = new THREE.Vector3();
  for (const k of WHEEL_KEYS) centroid.add(rawCenters[k]);
  centroid.multiplyScalar(0.25);

  const offset = cfg.offset ?? [0, 0, 0];
  fit.position.set(
    offset[0] - centroid.x,
    offset[1] + restHubLocalY - centroid.y,
    offset[2] - centroid.z,
  );
  container.updateMatrixWorld(true);

  // Dev aid: log the calibration numbers so you can tune offset[1] in the manifest.
  // Gap = centroid.y - restHubLocalY; a positive gap means the car sits too high.
  // Set visual.offset = [0, -gap, 0] to correct it.
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    const gap = centroid.y - restHubLocalY;
    console.log(
      `[${manifest.id}] centroid.y=${centroid.y.toFixed(4)}  restHubLocalY=${restHubLocalY.toFixed(4)}` +
      `  gap=${gap.toFixed(4)}  → set offset[1]=${(-gap).toFixed(4)} to flush wheels to ground`,
    );
  }

  // ── Reparent each cluster onto a pivot at its (now shifted) bbox center. ────
  const pivots: Record<(typeof WHEEL_KEYS)[number], WheelPivot> = {} as never;
  for (const k of WHEEL_KEYS) {
    const center = centerOf(clusterNodes[k]); // recompute after the shift
    const pivot = new THREE.Group();
    pivot.name = `wheel:${k}`;
    pivot.position.copy(center);
    container.add(pivot);
    for (const n of clusterNodes[k]) pivot.attach(n); // preserves world transform
    pivots[k] = { pivot, rest: center.clone() };
  }

  // ── Match each physics wheel to the nearest cluster by rig (x,z). ──────────
  const order: WheelPivot[] = manifest.rig.wheels.map((w) => {
    let best: (typeof WHEEL_KEYS)[number] = 'fl';
    let bestD = Infinity;
    for (const k of WHEEL_KEYS) {
      const c = pivots[k].rest;
      const dx = c.x - w.position[0];
      const dz = c.z - w.position[2];
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return pivots[best];
  });

  // ── Materials: shadows, environment reflections, and a mobile-perf pass. ────
  container.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      const mat = obj.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach(prepMaterial);
      else prepMaterial(mat);
    }
  });

  function prepMaterial(m: THREE.Material): void {
    const std = m as THREE.MeshStandardMaterial;
    if (!std.isMeshStandardMaterial) return;
    if (environment) {
      std.envMap = environment;
      std.envMapIntensity = 1.0;
    }
    // Perf: KHR_materials_transmission glass forces a full-screen transmission
    // render pass every frame — a mobile / software-GPU killer (and the reason
    // headless WebGL stalls on these cars). Downgrade transmissive glass to a
    // cheap glossy opaque material: visually close at car scale, vastly cheaper.
    const phys = m as THREE.MeshPhysicalMaterial;
    if (phys.isMeshPhysicalMaterial && phys.transmission > 0) {
      phys.transmission = 0;
      phys.transparent = false;
      phys.opacity = 1;
      phys.roughness = Math.min(phys.roughness, 0.2);
      phys.metalness = Math.max(phys.metalness, 0.1);
    }
    m.needsUpdate = true;
  }

  // ── Per-frame scratch (alloc-free). ────────────────────────────────────────
  const tmpHub = new THREE.Vector3();
  const tmpSteer = new THREE.Quaternion();
  const tmpSpin = new THREE.Quaternion();

  function applySnapshot(snapshot: VehicleVisualSnapshot): void {
    container.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
    container.quaternion.set(
      snapshot.rotation.x,
      snapshot.rotation.y,
      snapshot.rotation.z,
      snapshot.rotation.w,
    );
    container.updateMatrixWorld(true);

    for (let i = 0; i < order.length; i++) {
      const wp = order[i];
      const wheelSnap = snapshot.wheels[i];
      if (!wp || !wheelSnap) continue;
      tmpHub.set(wheelSnap.position.x, wheelSnap.position.y, wheelSnap.position.z);
      container.worldToLocal(tmpHub);
      wp.pivot.position.copy(tmpHub);
      // Steer about local Y, then spin about the (steered) axle — matches the
      // procedural visual so feel is identical across body types.
      tmpSteer.setFromAxisAngle(UP, wheelSnap.steering);
      tmpSpin.setFromAxisAngle(RIGHT, wheelSnap.rotation);
      wp.pivot.quaternion.copy(tmpSteer).multiply(tmpSpin);
    }
  }

  function dispose(): void {
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

  return { group: container, applySnapshot, dispose };
}

/**
 * Resolve named nodes in `root`, throwing a clear error if any are missing.
 *
 * GLTFLoader rewrites node names via `PropertyBinding.sanitizeNodeName` (spaces
 * → `_`, and `[ ] . : /` stripped) so the animation system can address them.
 * Manifests keep the human-readable original names, so we match the sanitized
 * form too — e.g. `wheel.001_57` → `wheel001_57`, `3DWheel Front L` →
 * `3DWheel_Front_L`.
 */
function resolveNodes(
  root: THREE.Object3D,
  names: string[],
  vehicleId: string,
  key: string,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const name of names) {
    const node = root.getObjectByName(name) ?? root.getObjectByName(sanitizeNodeName(name));
    if (!node) {
      throw new Error(
        `vehicle ${vehicleId}: wheel '${key}' references missing glTF node '${name}'`,
      );
    }
    out.push(node);
  }
  return out;
}

/** Mirror of three's `PropertyBinding.sanitizeNodeName`. */
function sanitizeNodeName(name: string): string {
  return name.replace(/\s/g, '_').replace(/[[\].:/]/g, '');
}
