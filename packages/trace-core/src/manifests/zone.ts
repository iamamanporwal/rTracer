import { z } from 'zod';
import { QuatSchema, Vec3Schema } from '../math/vec';
import { SURFACE_TAGS } from '../surface';

/**
 * Zone manifest — the only thing the runtime needs to load a zone.
 *
 * Authoritative shape per blueprint §6.1. The fields here are intentionally
 * minimal: anything that can be computed from the source assets (LOD bands,
 * occlusion bake, etc.) lives in the binary bundle, not here.
 */
export const ZoneManifestSchema = z.object({
  id: z.string().regex(/^zone_[a-z0-9_]+$/, 'id must match /^zone_[a-z0-9_]+$/'),
  name: z.string().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver MAJOR.MINOR.PATCH'),

  physicsProfile: z.enum(['tarmac_circuit', 'dirt', 'snow', 'drift']),
  controlScheme: z.enum(['circuit', 'rally', 'drift', 'casual']),
  fidelityTier: z.enum(['low', 'medium', 'high']),

  assets: z.object({
    mesh: z.string(),
    collider: z.string(),
    textures: z.string(),
    skybox: z.string(),
  }),

  /**
   * Optional GLB world binding. When present, the renderer loads this glTF/GLB
   * as the drivable environment (instead of the flat programmer-art ground) and
   * the physics layer derives a static trimesh collider from the same geometry.
   * Absent → the legacy flat ground + obstacle field is used (back-compat with
   * `zone_alpha`, the W2 demo plane).
   *
   * The GLB is the single source of truth for both visual and collision: we load
   * it once on the renderer, build the Three scene, then hand the merged
   * world-space vertex/index buffers to Rapier for the collider. This avoids a
   * second fetch and keeps visual and physics geometry exactly in sync.
   */
  world: z
    .object({
      format: z.literal('glb'),
      /** GLB/glTF path relative to the zone bundle dir, e.g. `world.glb`. */
      glb: z.string(),
      /** Uniform scale applied to the loaded scene (model units → meters). */
      scale: z.number().positive().optional(),
      /** Yaw about Y (radians) applied to orient the world. */
      yaw: z.number().optional(),
      /** Post-fit world-space nudge (meters) for fine alignment. */
      offset: Vec3Schema.optional(),
      /** Surface tag driving collider friction (audio/decals later). Default `tarmac`. */
      surface: z.enum(SURFACE_TAGS).optional(),
      /**
       * Material-name substrings (case-insensitive) whose meshes are excluded
       * from the collision trimesh but still rendered — e.g. tree foliage cards.
       * Default `['leaf']` so canopy doesn't become an invisible wall.
       */
      collisionExcludeMaterials: z.array(z.string()).optional(),
    })
    .optional(),

  semanticSidecar: z.string(),

  spawnPoints: z
    .array(
      z.object({
        id: z.string().min(1),
        position: Vec3Schema,
        rotation: QuatSchema,
      }),
    )
    .min(1, 'at least one spawn point required'),

  modesSupported: z.array(z.enum(['free_roam', 'timed_run', 'race'])).min(1),
  credits: z.string(),
});

export type ZoneManifest = z.infer<typeof ZoneManifestSchema>;
export type ZoneWorldConfig = NonNullable<ZoneManifest['world']>;
export type ZonePhysicsProfile = ZoneManifest['physicsProfile'];
export type ZoneControlScheme = ZoneManifest['controlScheme'];
export type ZoneFidelityTier = ZoneManifest['fidelityTier'];
export type ZoneMode = ZoneManifest['modesSupported'][number];

/**
 * URL path where a zone bundle's manifest lives.
 *
 * @example
 *   zoneManifestPath('zone_alpha', '0.1.0')
 *   // '/assets/zones/zone_alpha/v0.1.0/manifest.json'
 */
export function zoneManifestPath(id: string, version: string): string {
  return `/assets/zones/${id}/v${version}/manifest.json`;
}

/** Directory holding a zone bundle (mesh, collider, textures, skybox, sidecar). */
export function zoneBundleDir(id: string, version: string): string {
  return `/assets/zones/${id}/v${version}`;
}
