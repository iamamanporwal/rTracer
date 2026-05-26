import { z } from 'zod';
import { Vec3Schema } from '../math/vec';

/**
 * Semantic sidecar — track-shaped knowledge over the raw mesh.
 *
 * Authored by the click-tool (blueprint §9) in Phase 1 W8. The W1 manifests
 * only reference its path; an empty-ish stub is enough until then.
 */
export const SemanticSidecarSchema = z.object({
  version: z.literal('1.0'),
  zoneId: z.string(),

  centerline: z.object({
    nodes: z.array(Vec3Schema).min(3, 'centerline needs at least three nodes'),
    splineType: z.literal('catmull_rom'),
    roadWidthM: z.number().positive().default(12.0),
  }),

  barriers: z.array(
    z.object({
      id: z.string().min(1),
      nodes: z.array(Vec3Schema).min(2),
    }),
  ),

  startFinish: z.object({
    a: Vec3Schema,
    b: Vec3Schema,
  }),

  checkpoints: z.array(
    z.object({
      id: z.string().min(1),
      a: Vec3Schema,
      b: Vec3Schema,
      sector: z.number().int().positive(),
    }),
  ),

  spawnPoints: z
    .array(
      z.object({
        id: z.string().min(1),
        position: Vec3Schema,
        facingYawDeg: z.number(),
      }),
    )
    .min(1),
});

export type SemanticSidecar = z.infer<typeof SemanticSidecarSchema>;
