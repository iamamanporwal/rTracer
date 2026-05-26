import { describe, expect, it } from 'vitest';
import { VehicleManifestSchema, vehicleManifestPath } from './vehicle';

const wheel = (driven: boolean, steered: boolean, x: number) => ({
  position: [x, 0.3, -1.5] as [number, number, number],
  radius: 0.31,
  isDriven: driven,
  isSteered: steered,
});

const valid = {
  id: 'vehicle_alpha',
  displayName: 'Alpha Demo',
  version: '0.1.0',
  visualMesh: 'visual.glb',
  proxyMesh: 'proxy.glb',
  skinning: 'skinning.bin',
  rig: {
    wheels: [
      wheel(false, true, -0.75),
      wheel(false, true, 0.75),
      wheel(true, false, -0.75),
      wheel(true, false, 0.75),
    ],
    seat: [0.4, 0.9, 0.1],
  },
  mass: 1200,
  inertiaTensor: [1400, 1500, 600],
  engine: {
    powerCurveHpAtRpm: [
      [1000, 30],
      [4000, 140],
      [7000, 220],
    ],
    redline: 7500,
  },
  gearbox: {
    ratios: [3.6, 2.1, 1.4, 1.0, 0.8],
    final: 3.9,
    type: 'manual',
  },
};

describe('VehicleManifestSchema', () => {
  it('accepts a valid manifest', () => {
    const out = VehicleManifestSchema.parse(valid);
    expect(out.id).toBe('vehicle_alpha');
    expect(out.rig.wheels).toHaveLength(4);
    expect(out.gearbox.type).toBe('manual');
  });

  it('rejects ids that miss the vehicle_ prefix', () => {
    const bad = { ...valid, id: 'alpha' };
    expect(() => VehicleManifestSchema.parse(bad)).toThrow(/vehicle_/);
  });

  it('rejects rigs with the wrong wheel count', () => {
    const bad = {
      ...valid,
      rig: { ...valid.rig, wheels: valid.rig.wheels.slice(0, 3) },
    };
    expect(() => VehicleManifestSchema.parse(bad)).toThrow();
  });

  it('rejects mass <= 0', () => {
    const bad = { ...valid, mass: 0 };
    expect(() => VehicleManifestSchema.parse(bad)).toThrow();
  });

  it('rejects engines with only one curve point', () => {
    const bad = { ...valid, engine: { ...valid.engine, powerCurveHpAtRpm: [[1000, 30]] } };
    expect(() => VehicleManifestSchema.parse(bad)).toThrow();
  });

  it('rejects unknown gearbox types', () => {
    const bad = { ...valid, gearbox: { ...valid.gearbox, type: 'cvt' } };
    expect(() => VehicleManifestSchema.parse(bad)).toThrow();
  });
});

describe('vehicleManifestPath', () => {
  it('builds the expected path', () => {
    expect(vehicleManifestPath('vehicle_alpha', '0.1.0')).toBe(
      '/assets/vehicles/vehicle_alpha/v0.1.0/manifest.json',
    );
  });
});
