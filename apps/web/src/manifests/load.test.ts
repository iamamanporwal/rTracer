import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManifestLoadError, loadVehicleManifest, loadZoneIndex, loadZoneManifest } from './load';

const validZone = {
  id: 'zone_alpha',
  name: 'Trace Alpha',
  version: '0.1.0',
  physicsProfile: 'tarmac_circuit',
  controlScheme: 'circuit',
  fidelityTier: 'low',
  assets: {
    mesh: 'mesh.glb',
    collider: 'collider.glb',
    textures: 'textures.ktx2',
    skybox: 'skybox.hdr',
  },
  semanticSidecar: 'semantic.json',
  spawnPoints: [{ id: 'pit', position: [0, 0.5, 0], rotation: [0, 0, 0, 1] }],
  modesSupported: ['free_roam'],
  credits: 'tests',
};

const validVehicle = {
  id: 'vehicle_alpha',
  displayName: 'Alpha Demo',
  version: '0.1.0',
  visualMesh: 'visual.glb',
  proxyMesh: 'proxy.glb',
  skinning: 'skinning.bin',
  rig: {
    wheels: [
      { position: [-0.75, 0.3, 1.35], radius: 0.31, isDriven: false, isSteered: true },
      { position: [0.75, 0.3, 1.35], radius: 0.31, isDriven: false, isSteered: true },
      { position: [-0.75, 0.3, -1.35], radius: 0.31, isDriven: true, isSteered: false },
      { position: [0.75, 0.3, -1.35], radius: 0.31, isDriven: true, isSteered: false },
    ],
    seat: [0.4, 0.9, 0.1],
  },
  mass: 1200,
  inertiaTensor: [1400, 1500, 600],
  engine: {
    powerCurveHpAtRpm: [
      [1000, 30],
      [7000, 220],
    ],
    redline: 7500,
  },
  gearbox: { ratios: [3.6, 2.1, 1.4, 1.0, 0.8], final: 3.9, type: 'manual' },
};

function mockFetchJson(payload: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
  } as unknown as Response);
}

describe('manifest loaders', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('loadZoneManifest returns a typed manifest on success', async () => {
    globalThis.fetch = mockFetchJson(validZone);
    const manifest = await loadZoneManifest('zone_alpha', '0.1.0');
    expect(manifest.name).toBe('Trace Alpha');
    expect(manifest.physicsProfile).toBe('tarmac_circuit');
  });

  it('loadVehicleManifest returns a typed manifest on success', async () => {
    globalThis.fetch = mockFetchJson(validVehicle);
    const manifest = await loadVehicleManifest('vehicle_alpha', '0.1.0');
    expect(manifest.displayName).toBe('Alpha Demo');
    expect(manifest.rig.wheels).toHaveLength(4);
  });

  it('throws ManifestLoadError on HTTP error', async () => {
    globalThis.fetch = mockFetchJson({}, 404);
    await expect(loadZoneManifest('zone_alpha', '0.1.0')).rejects.toBeInstanceOf(ManifestLoadError);
  });

  it('throws ManifestLoadError on Zod validation failure', async () => {
    globalThis.fetch = mockFetchJson({ ...validZone, id: 'not_a_zone_id' });
    await expect(loadZoneManifest('zone_alpha', '0.1.0')).rejects.toBeInstanceOf(ManifestLoadError);
  });

  it('loadZoneIndex returns the parsed list', async () => {
    globalThis.fetch = mockFetchJson({
      zones: [{ id: 'zone_alpha', version: '0.1.0' }],
    });
    const list = await loadZoneIndex();
    expect(list).toEqual([{ id: 'zone_alpha', version: '0.1.0' }]);
  });
});
