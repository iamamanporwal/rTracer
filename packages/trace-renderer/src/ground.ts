import * as THREE from 'three';
import type { SurfaceTag } from '@trace/core';
import type { SurfaceMaterials } from './materials';

/**
 * Visual ground plane matching `@trace/physics` ground collider — same surface
 * tag, same extents, both centered at (0, 0, 0).
 *
 * A 1-meter grid overlay gives the driver a sense of motion before the W4
 * zone art lands. The grid is its own line mesh so the surface material can be
 * swapped later (e.g. triplanar tarmac) without touching the grid.
 */
export type GroundVisual = {
  group: THREE.Group;
  dispose(): void;
};

export type GroundVisualOptions = {
  tag?: SurfaceTag;
  size?: number;
  gridDivisions?: number;
};

export function createGroundVisual(
  materials: SurfaceMaterials,
  options: GroundVisualOptions = {},
): GroundVisual {
  const tag = options.tag ?? 'tarmac';
  const size = options.size ?? 1000;
  const gridDivisions = options.gridDivisions ?? 100;

  const group = new THREE.Group();
  group.name = `ground:${tag}`;

  const surfaceMat = materials[tag];
  const planeGeom = new THREE.PlaneGeometry(size, size);
  planeGeom.rotateX(-Math.PI / 2);
  const surface = new THREE.Mesh(planeGeom, surfaceMat);
  surface.receiveShadow = true;
  group.add(surface);

  const grid = new THREE.GridHelper(size, gridDivisions, 0x202830, 0x182028);
  grid.position.y = 0.005;
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  group.add(grid);

  return {
    group,
    dispose() {
      planeGeom.dispose();
      grid.geometry.dispose();
      grid.material.dispose();
      group.removeFromParent();
    },
  };
}
