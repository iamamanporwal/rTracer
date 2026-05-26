import { describe, expect, it } from 'vitest';
import { SemanticSidecarSchema } from './sidecar';

const valid = {
  version: '1.0',
  zoneId: 'zone_alpha',
  centerline: {
    nodes: [
      [0, 0, 0],
      [50, 0, 0],
      [100, 0, 0],
    ],
    splineType: 'catmull_rom',
    roadWidthM: 10,
  },
  barriers: [],
  startFinish: {
    a: [0, 0, -5],
    b: [0, 0, 5],
  },
  checkpoints: [],
  spawnPoints: [{ id: 'pit', position: [0, 0.5, 0], facingYawDeg: 0 }],
};

describe('SemanticSidecarSchema', () => {
  it('accepts a valid sidecar', () => {
    const out = SemanticSidecarSchema.parse(valid);
    expect(out.centerline.nodes).toHaveLength(3);
    expect(out.centerline.roadWidthM).toBe(10);
  });

  it('defaults roadWidthM when omitted', () => {
    const partial = {
      ...valid,
      centerline: {
        nodes: valid.centerline.nodes,
        splineType: 'catmull_rom',
      },
    };
    const out = SemanticSidecarSchema.parse(partial);
    expect(out.centerline.roadWidthM).toBe(12);
  });

  it('rejects centerlines with fewer than three nodes', () => {
    const bad = {
      ...valid,
      centerline: { ...valid.centerline, nodes: valid.centerline.nodes.slice(0, 2) },
    };
    expect(() => SemanticSidecarSchema.parse(bad)).toThrow(/three/);
  });
});
