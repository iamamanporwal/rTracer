import { z } from 'zod';
import { QuatSchema, Vec3Schema } from '../math/vec';

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
