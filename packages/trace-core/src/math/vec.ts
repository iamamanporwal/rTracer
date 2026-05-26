import { z } from 'zod';

/**
 * Spatial primitives shared by manifests, sidecars, and the runtime.
 *
 * These are tuples on purpose: serializable, zero-allocation when passed by
 * reference, and unambiguous on the wire. The renderer/physics convert into
 * THREE.Vector3 / RAPIER vectors at the boundary — never store classes in
 * manifests.
 */

/** Right-handed, Y-up, meters. */
export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3Schema>;

/** Unit quaternion: [x, y, z, w]. */
export const QuatSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Quat = z.infer<typeof QuatSchema>;
