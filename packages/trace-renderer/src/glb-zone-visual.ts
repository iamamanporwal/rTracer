import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ZoneWorldConfig } from '@trace/core';

/**
 * GLB-backed zone world — the production path for real, downloaded track models
 * (blueprint W4 / P1-17). It loads a glTF/GLB once and produces two things from
 * the *same* geometry:
 *
 *   1. A Three.js {@link THREE.Group} ready to drop into the scene (visual).
 *   2. A merged, world-space {@link ZoneCollisionGeometry} (positions + indices)
 *      the physics layer turns into one static Rapier trimesh collider.
 *
 * Loading the GLB on the renderer and forwarding only the raw buffers to physics
 * keeps the heavy three/Rapier boundary clean (physics never touches GLTFLoader)
 * and guarantees the collider matches what the player sees — no second fetch, no
 * drift between a separate `collider.glb` and `mesh.glb`.
 */

export type ZoneCollisionGeometry = {
  /** Flat XYZ vertex positions in world space (game meters), length = 3·N. */
  vertices: Float32Array;
  /** Triangle vertex indices into {@link vertices} (÷3), length = 3·triangles. */
  indices: Uint32Array;
};

export type ZoneVisual = {
  group: THREE.Group;
  /** Merged trimesh geometry for the physics collider. */
  collision: ZoneCollisionGeometry;
  /** World-space AABB of the loaded (and fitted) world, for spawn/debug. */
  bounds: THREE.Box3;
  dispose(): void;
};

export type CreateGlbZoneVisualOptions = {
  /** Absolute URL to the `.glb`/`.gltf` (textures resolve relative to it). */
  url: string;
  /** The manifest `world` block — scale, yaw, offset, surface, exclusions. */
  config: ZoneWorldConfig;
  /** Optional environment map for PBR reflections. */
  environment?: THREE.Texture | null;
};

const DEFAULT_EXCLUDE = ['leaf'];

/**
 * Load + fit a GLB into a {@link ZoneVisual}. Async because it fetches the model;
 * the session already awaits it during `startZoneSession`.
 */
export async function createGlbZoneVisual(
  options: CreateGlbZoneVisualOptions,
): Promise<ZoneVisual> {
  const { url, config, environment } = options;

  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene;

  // ── Fit: scale + yaw + offset under a container so the world transform is a
  //    single matrix we can read off each mesh. ────────────────────────────────
  const container = new THREE.Group();
  container.name = 'zone-world';
  const fit = new THREE.Group();
  fit.name = 'glb-fit';
  fit.add(root);
  container.add(fit);

  fit.scale.setScalar(config.scale ?? 1);
  fit.rotation.set(0, config.yaw ?? 0, 0);
  const offset = config.offset ?? [0, 0, 0];
  fit.position.set(offset[0], offset[1], offset[2]);
  container.updateMatrixWorld(true);

  // ── Materials: shadows, environment reflections, mobile-perf glass downgrade.
  //    Identical treatment to the vehicle loader so paint/chrome/glass match. ───
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
    if (std.isMeshStandardMaterial && environment) {
      std.envMap = environment;
      std.envMapIntensity = 1.0;
    }
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

  // ── Collision extraction: merge every collidable mesh into one world-space
  //    trimesh. Foliage (and any author-listed materials) is rendered but kept
  //    out of the collider so the canopy isn't an invisible wall. ──────────────
  const exclude = (config.collisionExcludeMaterials ?? DEFAULT_EXCLUDE).map((s) => s.toLowerCase());
  const isExcluded = (mesh: THREE.Mesh): boolean => {
    const mat = mesh.material;
    const names = (Array.isArray(mat) ? mat : [mat]).map((m) => (m?.name ?? '').toLowerCase());
    return names.some((n) => exclude.some((e) => e && n.includes(e)));
  };

  // Two passes: count first (so we allocate exact typed arrays — no GC churn on
  // a 300k-triangle world), then fill.
  let vertCount = 0;
  let indexCount = 0;
  const collidable: THREE.Mesh[] = [];
  container.updateMatrixWorld(true);
  container.traverse((obj) => {
    // `as` cast (not `instanceof`) keeps the concrete `Mesh<BufferGeometry,…>`
    // type — `instanceof` widens the generics to `any` and trips no-unsafe-*.
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (isExcluded(mesh)) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) return;
    collidable.push(mesh);
    vertCount += pos.count;
    const idx = mesh.geometry.getIndex();
    indexCount += idx ? idx.count : pos.count;
  });

  const vertices = new Float32Array(vertCount * 3);
  const indices = new Uint32Array(indexCount);
  let vBase = 0; // vertex index offset (in vertices, ÷3) for the current mesh
  let vOff = 0; // write cursor into `vertices`
  let iOff = 0; // write cursor into `indices`
  const v = new THREE.Vector3();
  for (const mesh of collidable) {
    const geom = mesh.geometry;
    const pos = geom.getAttribute('position');
    const world = mesh.matrixWorld;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(world);
      vertices[vOff++] = v.x;
      vertices[vOff++] = v.y;
      vertices[vOff++] = v.z;
    }
    const idx = geom.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices[iOff++] = idx.getX(i) + vBase;
    } else {
      for (let i = 0; i < pos.count; i++) indices[iOff++] = i + vBase;
    }
    vBase += pos.count;
  }

  const bounds = new THREE.Box3().setFromObject(container);

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

  return { group: container, collision: { vertices, indices }, bounds, dispose };
}
