import RAPIER from '@dimforge/rapier3d-compat';
import type { SurfaceTag } from '@trace/core';
import { DEFAULT_SURFACE_FRICTION } from '@trace/core';

/**
 * Flat infinite ground per blueprint §21.2 W2 demo — "a primitive box drives on
 * a flat plane". Replaced by zone-mesh-derived collider in W4 (P1-17/P1-19).
 *
 * The ground is a static rigid body (cuboid, half-extents 500×0.5×500 m) sitting
 * with its top face at y = 0. We deliberately don't use Rapier's infinite plane
 * because the vehicle controller raycasts and needs a finite target.
 */
export type GroundCollider = {
  /** Static rigid body so its user data is queryable from collision events. */
  body: RAPIER.RigidBody;
  /** Cuboid collider — its `userData` holds a numeric handle into the surface map. */
  collider: RAPIER.Collider;
  /** Surface tag for this ground patch. Looked up by collision dispatcher. */
  tag: SurfaceTag;
};

export type GroundOptions = {
  /** Surface tag — drives friction + audio + decals. Default: `'tarmac'`. */
  tag?: SurfaceTag;
  /** Half-extent on X. Default: 500. */
  halfWidth?: number;
  /** Half-extent on Z. Default: 500. */
  halfDepth?: number;
};

/** Create a flat ground patch at y = 0 with the given surface tag. */
export function createGround(world: RAPIER.World, options: GroundOptions = {}): GroundCollider {
  const tag = options.tag ?? 'tarmac';
  const halfWidth = options.halfWidth ?? 500;
  const halfDepth = options.halfDepth ?? 500;
  const halfHeight = 0.5;

  const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, -halfHeight, 0);
  const body = world.createRigidBody(bodyDesc);

  const colliderDesc = RAPIER.ColliderDesc.cuboid(halfWidth, halfHeight, halfDepth)
    .setFriction(DEFAULT_SURFACE_FRICTION[tag])
    .setRestitution(0.0);
  const collider = world.createCollider(colliderDesc, body);

  return { body, collider, tag };
}
