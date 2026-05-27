import * as THREE from 'three';
import type { SurfaceTag } from '@trace/core';
import { SURFACE_DEBUG_COLOR } from '@trace/core';

/**
 * Material palette per blueprint §14.2.
 *
 * Phase 1 W2 ships flat-colored PBR materials per surface tag. W4 (real zone
 * art) swaps in KTX2 albedo/roughness/normal maps with triplanar mapping — the
 * material *factory* shape stays stable so the renderer doesn't churn.
 */

export type SurfaceMaterials = Readonly<Record<SurfaceTag, THREE.MeshStandardMaterial>>;

const ROUGHNESS_BY_TAG: Record<SurfaceTag, number> = {
  tarmac: 0.78,
  kerb: 0.7,
  grass: 0.92,
  dirt: 0.95,
  gravel: 0.88,
  snow: 0.4,
  sand: 0.95,
  barrier: 0.6,
  unknown: 0.8,
};

const METALNESS_BY_TAG: Record<SurfaceTag, number> = {
  tarmac: 0.05,
  kerb: 0.1,
  grass: 0.0,
  dirt: 0.0,
  gravel: 0.05,
  snow: 0.1,
  sand: 0.0,
  barrier: 0.2,
  unknown: 0.05,
};

/**
 * Build one material per surface tag. The renderer creates these once at scene
 * construction and reuses them across all meshes — never call from a hot path.
 */
export function createSurfaceMaterials(): SurfaceMaterials {
  const entries = Object.entries(SURFACE_DEBUG_COLOR) as [SurfaceTag, `#${string}`][];
  const palette: Partial<Record<SurfaceTag, THREE.MeshStandardMaterial>> = {};
  for (const [tag, color] of entries) {
    palette[tag] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: ROUGHNESS_BY_TAG[tag],
      metalness: METALNESS_BY_TAG[tag],
    });
  }
  return palette as SurfaceMaterials;
}

/**
 * Car-paint material. Layered clearcoat happens in W12 polish; for W2 it's a
 * single PBR slab with the livery color.
 */
export function createCarPaintMaterial(liveryColor: `#${string}`): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(liveryColor),
    roughness: 0.4,
    metalness: 0.6,
  });
}

/** Black rubber for wheels. */
export function createTireMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color('#1a1a1a'),
    roughness: 0.92,
    metalness: 0.0,
  });
}

/** Dispose every material in a palette. Call from scene teardown. */
export function disposeSurfaceMaterials(palette: SurfaceMaterials): void {
  for (const mat of Object.values(palette)) {
    mat.dispose();
  }
}
