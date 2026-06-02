import * as THREE from 'three';

/**
 * Real-time mesh deformation for the player's car body — BeamNG-style crumpling
 * driven by physics contact impacts.
 *
 * The car's GLB (or procedural body) is a regular Three mesh; on a hard hit we
 * push the vertices nearest the impact *inward* along a Gaussian falloff, with a
 * raised crease ring at the dent boundary (where real sheet metal folds and
 * bulges). Damage accumulates: the live `position` attribute is mutated in place
 * and never reset between hits, so repeated strikes to the same panel compound,
 * and the body material darkens toward crushed, paint-scraped metal.
 *
 * Everything happens in the body mesh's *local* space, so it is independent of
 * the vehicle's world pose and of the GLB's authored scale:
 *
 *   1. On construction, find the body mesh (the largest mesh that isn't a rigged
 *      wheel) and snapshot its rest vertex positions into an `origin` buffer.
 *   2. Per impact, transform the world-space contact point into the mesh's local
 *      frame via `matrixWorld⁻¹`, and crush vertices toward the body centroid.
 *   3. Recompute vertex normals so lighting follows the new dented surface.
 *
 * This is the pragmatic, main-thread visual approximation. The full mass-spring
 * solver (blueprint §8, `@trace/softbody`, worker-side) supersedes it later; the
 * seam here — "apply a world-space impact to the car body" — stays the same.
 */

export type BodyDeformerConfig = {
  /**
   * Contact-force magnitude below which an impact does nothing. Should match (or
   * exceed) the chassis collider's contact-force threshold so light scrapes are
   * ignored.
   */
  minForce: number;
  /** Contact-force magnitude that produces a full-strength single dent. */
  refForce: number;
  /** Max single-hit crush depth, as a fraction of the body's largest dimension. */
  depthFraction: number;
  /** Gaussian falloff radius, as a fraction of the body's largest dimension. */
  sigmaFraction: number;
  /** Hard clamp on a vertex's total displacement from rest, as a fraction of body size. */
  maxDeformFraction: number;
  /**
   * Crease ring strength. The displacement profile is `falloff − crease·ring`
   * where `ring` is a derivative-of-Gaussian peaking at the dent boundary; a
   * value > 1 flips the profile negative there, raising a folded metal lip.
   */
  creaseStrength: number;
  /** How much cumulative damage (0..1) a full-strength hit adds. */
  darkenPerHit: number;
  /** Colour the body tends toward as damage → 1 (crushed, scorched metal). */
  damageColor: THREE.ColorRepresentation;
};

export const DEFAULT_BODY_DEFORMER_CONFIG: BodyDeformerConfig = {
  minForce: 800,
  refForce: 25000,
  // Minor, localized denting. Small depth keeps hits subtle; a tight sigma means
  // only a small patch bends inward while the rest of the panel holds its shape
  // (so the part reads as creased, not translated). maxDeform caps cumulative
  // travel low so even repeated hits stay a dent, never a caved-in shell.
  depthFraction: 0.012,
  sigmaFraction: 0.06,
  maxDeformFraction: 0.045,
  creaseStrength: 1.1,
  darkenPerHit: 0.07,
  damageColor: 0x1a1a1d,
};

export type BodyDeformer = {
  /** The body mesh being deformed (exposed for tests / debugging). */
  readonly mesh: THREE.Mesh;
  /**
   * Crumple the body around a world-space contact `point`, scaled by the
   * contact-force `magnitude`. No-op if the magnitude is below `minForce`.
   */
  applyImpact(point: { x: number; y: number; z: number }, magnitude: number): void;
  /** Restore the pristine body (geometry + material) — wire to the car reset. */
  reset(): void;
  /** Drop references; the owning visual disposes the geometry/material. */
  dispose(): void;
};

type DamageMaterial = {
  mat: THREE.MeshStandardMaterial;
  baseColor: THREE.Color;
  baseRoughness: number;
  baseMetalness: number;
};

export type CreateBodyDeformerOptions = {
  /** Root group of the vehicle visual (contains body + rigged wheels). */
  group: THREE.Object3D;
  config?: Partial<BodyDeformerConfig>;
};

/**
 * Build a deformer for the largest non-wheel mesh under `group`. Returns `null`
 * if no suitable mesh is found (e.g. an empty group), so callers can no-op
 * cleanly rather than guard everywhere.
 */
export function createBodyDeformer(options: CreateBodyDeformerOptions): BodyDeformer | null {
  const cfg = { ...DEFAULT_BODY_DEFORMER_CONFIG, ...options.config };

  const found = findBodyMesh(options.group);
  if (!found) return null;
  // Re-bind to a non-nullable-typed const so the deformation closures below
  // don't depend on guard-narrowing flowing into a nested function (it doesn't).
  const mesh: THREE.Mesh = found;

  const geometry = mesh.geometry;
  const rawPos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!rawPos || rawPos.count === 0) return null;
  const posAttr: THREE.BufferAttribute = rawPos;

  const count = posAttr.count;

  // Rest snapshot. Read component-wise so interleaved buffers work too.
  const origin = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    origin[i * 3] = posAttr.getX(i);
    origin[i * 3 + 1] = posAttr.getY(i);
    origin[i * 3 + 2] = posAttr.getZ(i);
  }

  // Body size + centroid from the rest pose. The centroid is the crush target:
  // every dent pushes its panel toward the body's interior.
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < count; i++) {
    const x = origin[i * 3]!;
    const y = origin[i * 3 + 1]!;
    const z = origin[i * 3 + 2]!;
    if (x < min.x) min.x = x;
    if (y < min.y) min.y = y;
    if (z < min.z) min.z = z;
    if (x > max.x) max.x = x;
    if (y > max.y) max.y = y;
    if (z > max.z) max.z = z;
  }
  const centerLocal = new THREE.Vector3(
    (min.x + max.x) * 0.5,
    (min.y + max.y) * 0.5,
    (min.z + max.z) * 0.5,
  );
  const maxDim = Math.max(max.x - min.x, max.y - min.y, max.z - min.z) || 1;

  // Derived (rest-frame) deformation scales.
  const sigma = cfg.sigmaFraction * maxDim;
  const twoSigma2 = 2 * sigma * sigma;
  const cutoff2 = (sigma * 3) * (sigma * 3); // ignore vertices beyond 3σ
  const maxDeform = cfg.maxDeformFraction * maxDim;
  const maxDeform2 = maxDeform * maxDeform;
  const fullDepth = cfg.depthFraction * maxDim;
  const forceSpan = Math.max(cfg.refForce - cfg.minForce, 1e-6);

  // Darken the body's own standard materials in place as damage accrues — we
  // snapshot the base look so `reset()` can restore it. Mutating in place (vs.
  // cloning + reassigning `mesh.material`) keeps the owning visual the sole owner
  // of the materials, so there's no orphaned original to leak and no double-free.
  // Each session builds a fresh visual with fresh materials, so this never bleeds
  // across cars.
  const damageColor = new THREE.Color(cfg.damageColor);
  const damageMats: DamageMaterial[] = [];
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    const std = m as THREE.MeshStandardMaterial;
    if (!std.isMeshStandardMaterial) continue;
    damageMats.push({
      mat: std,
      baseColor: std.color.clone(),
      baseRoughness: std.roughness,
      baseMetalness: std.metalness,
    });
  }

  let damage = 0;

  // Reused scratch — alloc-free hot path.
  const invMatrix = new THREE.Matrix4();
  const localHit = new THREE.Vector3();
  const inward = new THREE.Vector3();

  function applyDamageToMaterials(): void {
    for (const dm of damageMats) {
      dm.mat.color.copy(dm.baseColor).lerp(damageColor, damage);
      dm.mat.roughness = THREE.MathUtils.lerp(dm.baseRoughness, 0.95, damage * 0.85);
      dm.mat.metalness = THREE.MathUtils.lerp(dm.baseMetalness, 0.15, damage * 0.6);
      dm.mat.needsUpdate = true;
    }
  }

  function applyImpact(point: { x: number; y: number; z: number }, magnitude: number): void {
    const intensity = Math.min(Math.max((magnitude - cfg.minForce) / forceSpan, 0), 1);
    if (intensity <= 0) return;

    // World contact → body-local. Refresh the mesh's world matrix first so the
    // dent lands on the panel that was actually hit at the current pose.
    mesh.updateWorldMatrix(true, false);
    invMatrix.copy(mesh.matrixWorld).invert();
    localHit.set(point.x, point.y, point.z).applyMatrix4(invMatrix);

    // Crush direction: from the hit toward the body centroid (always inward).
    inward.copy(centerLocal).sub(localHit);
    const inwardLen = inward.length();
    if (inwardLen < 1e-6) return; // hit dead-centre — no well-defined inward dir
    inward.multiplyScalar(1 / inwardLen);

    const depth = fullDepth * intensity;
    let touched = false;

    for (let i = 0; i < count; i++) {
      const ox = origin[i * 3]!;
      const oy = origin[i * 3 + 1]!;
      const oz = origin[i * 3 + 2]!;

      // Region by rest distance to the hit — stable across repeated dents.
      const dx = ox - localHit.x;
      const dy = oy - localHit.y;
      const dz = oz - localHit.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > cutoff2) continue;

      const falloff = Math.exp(-d2 / twoSigma2);
      const dist = Math.sqrt(d2);
      // Derivative-of-Gaussian ring: 0 at the centre, peaks at d = σ.
      const ring = (dist / sigma) * falloff;
      const profile = depth * (falloff - cfg.creaseStrength * ring);
      if (profile === 0) continue;

      // Compound onto the live (possibly already-dented) position.
      let nx = posAttr.getX(i) + inward.x * profile;
      let ny = posAttr.getY(i) + inward.y * profile;
      let nz = posAttr.getZ(i) + inward.z * profile;

      // Clamp total travel from rest so repeated hits can't punch through.
      const ex = nx - ox;
      const ey = ny - oy;
      const ez = nz - oz;
      const e2 = ex * ex + ey * ey + ez * ez;
      if (e2 > maxDeform2) {
        const s = maxDeform / Math.sqrt(e2);
        nx = ox + ex * s;
        ny = oy + ey * s;
        nz = oz + ez * s;
      }

      posAttr.setXYZ(i, nx, ny, nz);
      touched = true;
    }

    if (!touched) return;

    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    damage = Math.min(1, damage + intensity * cfg.darkenPerHit);
    applyDamageToMaterials();
  }

  function reset(): void {
    for (let i = 0; i < count; i++) {
      posAttr.setXYZ(i, origin[i * 3]!, origin[i * 3 + 1]!, origin[i * 3 + 2]!);
    }
    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    damage = 0;
    applyDamageToMaterials();
  }

  function dispose(): void {
    damageMats.length = 0;
  }

  return { mesh, applyImpact, reset, dispose };
}

/** True if `obj` (or an ancestor) is a rigged wheel pivot (`wheel:*`). */
function isUnderWheel(obj: THREE.Object3D): boolean {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    if (cur.name.startsWith('wheel:')) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * The body mesh = the mesh with the most vertices that isn't a rigged wheel.
 * Robust to both the procedural body (the extruded tub dwarfs every greeble) and
 * a two-mesh GLB (body vs. tires): the painted shell always wins on vertex count
 * once wheels are excluded.
 */
function findBodyMesh(group: THREE.Object3D): THREE.Mesh | null {
  let best: THREE.Mesh | null = null;
  let bestVerts = -1;
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (isUnderWheel(mesh)) return;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    if (pos.count > bestVerts) {
      bestVerts = pos.count;
      best = mesh;
    }
  });
  return best;
}
