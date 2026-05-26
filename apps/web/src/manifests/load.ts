import { z } from 'zod';
import {
  VehicleManifestSchema,
  ZoneManifestSchema,
  type VehicleManifest,
  type ZoneManifest,
  vehicleManifestPath,
  zoneManifestPath,
} from '@trace/core';

/**
 * Manifest loaders — fetch JSON, validate with Zod, return typed objects.
 *
 * Every external boundary in Trace runs through Zod (blueprint §18.2). A
 * malformed manifest is a hard error: the runtime cannot recover, so we
 * surface a typed `ManifestLoadError` instead of partially-built state.
 */

export class ManifestLoadError extends Error {
  override readonly name = 'ManifestLoadError';
  constructor(
    message: string,
    readonly url: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

const ZoneIndexSchema = z.object({
  zones: z.array(z.object({ id: z.string(), version: z.string() })).min(1),
});

const VehicleIndexSchema = z.object({
  vehicles: z.array(z.object({ id: z.string(), version: z.string() })).min(1),
});

export type ZoneIndex = z.infer<typeof ZoneIndexSchema>['zones'];
export type VehicleIndex = z.infer<typeof VehicleIndexSchema>['vehicles'];

async function fetchJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (cause) {
    throw new ManifestLoadError(`network error fetching ${url}`, url, cause);
  }
  if (!res.ok) {
    throw new ManifestLoadError(`HTTP ${res.status} fetching ${url}`, url);
  }
  try {
    return (await res.json()) as unknown;
  } catch (cause) {
    throw new ManifestLoadError(`invalid JSON at ${url}`, url, cause);
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, json: unknown, url: string): T {
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ManifestLoadError(
      `schema validation failed for ${url}: ${result.error.message}`,
      url,
      result.error,
    );
  }
  return result.data;
}

export async function loadZoneIndex(): Promise<ZoneIndex> {
  const url = '/assets/zones/index.json';
  const json = await fetchJson(url);
  return parseOrThrow(ZoneIndexSchema, json, url).zones;
}

export async function loadVehicleIndex(): Promise<VehicleIndex> {
  const url = '/assets/vehicles/index.json';
  const json = await fetchJson(url);
  return parseOrThrow(VehicleIndexSchema, json, url).vehicles;
}

export async function loadZoneManifest(id: string, version: string): Promise<ZoneManifest> {
  const url = zoneManifestPath(id, version);
  const json = await fetchJson(url);
  return parseOrThrow(ZoneManifestSchema, json, url);
}

export async function loadVehicleManifest(id: string, version: string): Promise<VehicleManifest> {
  const url = vehicleManifestPath(id, version);
  const json = await fetchJson(url);
  return parseOrThrow(VehicleManifestSchema, json, url);
}
