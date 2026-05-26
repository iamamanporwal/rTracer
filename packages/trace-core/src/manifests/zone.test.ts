import { describe, expect, it } from 'vitest';
import { ZoneManifestSchema, zoneManifestPath, zoneBundleDir } from './zone';

const valid = {
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
  modesSupported: ['free_roam', 'timed_run'],
  credits: 'Trace team',
};

describe('ZoneManifestSchema', () => {
  it('accepts a valid manifest', () => {
    const out = ZoneManifestSchema.parse(valid);
    expect(out.id).toBe('zone_alpha');
    expect(out.modesSupported).toEqual(['free_roam', 'timed_run']);
  });

  it('rejects ids that miss the zone_ prefix', () => {
    const bad = { ...valid, id: 'alpha' };
    expect(() => ZoneManifestSchema.parse(bad)).toThrow(/zone_/);
  });

  it('rejects non-semver versions', () => {
    const bad = { ...valid, version: '1.0' };
    expect(() => ZoneManifestSchema.parse(bad)).toThrow(/semver/);
  });

  it('rejects unknown physics profiles', () => {
    const bad = { ...valid, physicsProfile: 'gravel' };
    expect(() => ZoneManifestSchema.parse(bad)).toThrow();
  });

  it('rejects empty spawn list', () => {
    const bad = { ...valid, spawnPoints: [] };
    expect(() => ZoneManifestSchema.parse(bad)).toThrow(/spawn/);
  });

  it('rejects empty modesSupported', () => {
    const bad = { ...valid, modesSupported: [] };
    expect(() => ZoneManifestSchema.parse(bad)).toThrow();
  });
});

describe('zoneManifestPath / zoneBundleDir', () => {
  it('builds the expected path', () => {
    expect(zoneManifestPath('zone_alpha', '0.1.0')).toBe(
      '/assets/zones/zone_alpha/v0.1.0/manifest.json',
    );
    expect(zoneBundleDir('zone_alpha', '0.1.0')).toBe('/assets/zones/zone_alpha/v0.1.0');
  });
});
