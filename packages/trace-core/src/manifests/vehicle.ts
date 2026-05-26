import { z } from 'zod';
import { Vec3Schema } from '../math/vec';

/**
 * Vehicle manifest — physical + visual parameters needed to instantiate a car.
 *
 * Authoritative shape per blueprint §7.1. Driving feel emerges from the engine
 * power curve × gearbox × Rapier vehicle controller; the rig fields define
 * suspension geometry the controller uses.
 */
export const VehicleManifestSchema = z.object({
  id: z.string().regex(/^vehicle_[a-z0-9_]+$/, 'id must match /^vehicle_[a-z0-9_]+$/'),
  displayName: z.string().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver MAJOR.MINOR.PATCH'),

  visualMesh: z.string(),
  proxyMesh: z.string(),
  skinning: z.string(),

  rig: z.object({
    wheels: z
      .array(
        z.object({
          position: Vec3Schema,
          radius: z.number().positive(),
          isDriven: z.boolean(),
          isSteered: z.boolean(),
        }),
      )
      .length(4, 'exactly four wheels required'),
    seat: Vec3Schema,
  }),

  mass: z.number().positive(),
  inertiaTensor: Vec3Schema,

  engine: z.object({
    powerCurveHpAtRpm: z
      .array(z.tuple([z.number().nonnegative(), z.number().nonnegative()]))
      .min(2, 'engine power curve needs at least two points'),
    redline: z.number().positive(),
  }),

  gearbox: z.object({
    ratios: z.array(z.number().positive()).min(1),
    final: z.number().positive(),
    type: z.enum(['manual', 'automatic', 'dct']),
  }),

  credits: z.string().optional(),
});

export type VehicleManifest = z.infer<typeof VehicleManifestSchema>;
export type GearboxType = VehicleManifest['gearbox']['type'];

/**
 * URL path where a vehicle bundle's manifest lives.
 *
 * @example
 *   vehicleManifestPath('vehicle_alpha', '0.1.0')
 *   // '/assets/vehicles/vehicle_alpha/v0.1.0/manifest.json'
 */
export function vehicleManifestPath(id: string, version: string): string {
  return `/assets/vehicles/${id}/v${version}/manifest.json`;
}

/** Directory holding a vehicle bundle. */
export function vehicleBundleDir(id: string, version: string): string {
  return `/assets/vehicles/${id}/v${version}`;
}
