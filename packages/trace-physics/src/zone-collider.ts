import RAPIER from '@dimforge/rapier3d-compat';
import type { SurfaceTag } from '@trace/core';
import { DEFAULT_SURFACE_FRICTION } from '@trace/core';

/**
 * Static trimesh collider derived from a zone's GLB world (blueprint W4 /
 * P1-19). The renderer loads the GLB and hands us the merged, world-space
 * vertex/index buffers (see `@trace/renderer` `createGlbZoneVisual`); we wrap
 * them in one fixed Rapier trimesh body.
 *
 * This replaces {@link createGround}'s flat cuboid for GLB-backed zones. The
 * raycast vehicle's wheel rays and the chassis cuboid both collide against the
 * trimesh exactly as they did the flat plane — no per-triangle surface tags yet
 * (whole-world friction from `tag`); per-material tagging is a later pass.
 */
export type ZoneCollider = {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  tag: SurfaceTag;
};

export type ZoneColliderOptions = {
  /** Flat XYZ vertex positions in world meters, length = 3·N. */
  vertices: Float32Array;
  /** Triangle indices into the vertex array (÷3). */
  indices: Uint32Array;
  /** Surface tag → friction. Default `'tarmac'`. */
  tag?: SurfaceTag;
};

/** Build one static trimesh collider for a GLB zone world. */
export function createZoneCollider(
  world: RAPIER.World,
  options: ZoneColliderOptions,
): ZoneCollider {
  const tag = options.tag ?? 'tarmac';

  if (options.vertices.length === 0 || options.indices.length === 0) {
    throw new Error('createZoneCollider: empty trimesh — GLB produced no collidable geometry');
  }

  const bodyDesc = RAPIER.RigidBodyDesc.fixed();
  const body = world.createRigidBody(bodyDesc);

  const colliderDesc = RAPIER.ColliderDesc.trimesh(options.vertices, options.indices)
    .setFriction(DEFAULT_SURFACE_FRICTION[tag])
    .setRestitution(0.0);
  const collider = world.createCollider(colliderDesc, body);

  // Populate the query pipeline so a spawn-placement raycast works before the
  // first `world.step()` (castRay reads the pipeline, which a step would
  // otherwise be the first thing to fill).
  world.updateSceneQueries();

  return { body, collider, tag };
}

/**
 * Cast a ray straight down through the world at `(x, z)` and return the Y of the
 * first surface hit, or `null` if the ray misses everything.
 *
 * Used to seat a vehicle on a GLB world without hand-authoring the exact ground
 * height in the manifest: the spawn XZ is fixed, but the drivable surface there
 * can sit at any Y (the drift track's origin, for instance, is several meters
 * below y=0). Dropping the car from a fixed height instead free-falls it into a
 * thin trimesh fast enough to tunnel — so we find the surface and spawn on it.
 */
export function raycastGroundY(
  world: RAPIER.World,
  x: number,
  z: number,
  fromY = 500,
  maxDistance = 1000,
): number | null {
  const ray = new RAPIER.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 });
  const hit = world.castRay(ray, maxDistance, true);
  return hit ? fromY - hit.timeOfImpact : null;
}
