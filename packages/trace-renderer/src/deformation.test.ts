import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createBodyDeformer } from './deformation';

/**
 * Deformation is pure geometry + material math (no WebGL), so we can drive it
 * deterministically in Node: build a car-like body mesh, fire an impact, and
 * assert the panel crumpled inward, the paint darkened, and `reset` undoes it.
 */

function makeBody(): { group: THREE.Group; mesh: THREE.Mesh } {
  // A finely subdivided box stands in for a car body (centroid at the origin).
  const geom = new THREE.BoxGeometry(2, 1, 4, 10, 10, 10);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.6 });
  const mesh = new THREE.Mesh(geom, mat);
  const group = new THREE.Group();
  group.add(mesh);
  group.updateMatrixWorld(true);
  return { group, mesh };
}

/**
 * Index of the rest vertex nearest a local point — the dent centre. We track its
 * x as the crush depth: it sits on the +x face (x≈1) and, hit on that face, must
 * move toward the centroid (smaller x). Averaging the whole face wouldn't work —
 * the crease ring deliberately bulges *outward*, and crushed vertices leave any
 * "x ≈ 1" filter, so a face average reads the lip, not the dent.
 */
function nearestIndex(mesh: THREE.Mesh, x: number, y: number, z: number): number {
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - x;
    const dy = pos.getY(i) - y;
    const dz = pos.getZ(i) - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

const vx = (mesh: THREE.Mesh, i: number): number =>
  (mesh.geometry.getAttribute('position') as THREE.BufferAttribute).getX(i);

describe('createBodyDeformer', () => {
  it('returns null for a group with no mesh', () => {
    expect(createBodyDeformer({ group: new THREE.Group() })).toBeNull();
  });

  it('crushes the struck panel inward and darkens the paint', () => {
    const { group, mesh } = makeBody();
    const deformer = createBodyDeformer({ group });
    expect(deformer).not.toBeNull();

    const idx = nearestIndex(mesh, 1, 0, 0);
    const beforeX = vx(mesh, idx);
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const beforeColor = mat.color.getHex();

    // Hard hit on the +x face (world == local here). Inward = toward the
    // centroid (−x), so the dent centre should move to smaller x.
    deformer!.applyImpact({ x: 1, y: 0, z: 0 }, 50_000);

    expect(vx(mesh, idx)).toBeLessThan(beforeX); // dent centre pushed inward
    expect(mat.color.getHex()).not.toBe(beforeColor); // paint darkened
    expect(mat.roughness).toBeGreaterThan(0.3); // scuffed
  });

  it('compounds repeated hits but clamps total travel', () => {
    const { group, mesh } = makeBody();
    const deformer = createBodyDeformer({ group })!;
    const idx = nearestIndex(mesh, 1, 0, 0);

    deformer.applyImpact({ x: 1, y: 0, z: 0 }, 50_000);
    const afterOne = vx(mesh, idx);
    for (let i = 0; i < 20; i++) deformer.applyImpact({ x: 1, y: 0, z: 0 }, 50_000);
    const afterMany = vx(mesh, idx);

    // More hits dent further...
    expect(afterMany).toBeLessThan(afterOne);
    // ...but the clamp (maxDeformFraction ≈ 0.045 × body size 4 ≈ 0.18 of travel)
    // keeps denting minor — the panel stays near its rest x, never caves in.
    expect(afterMany).toBeGreaterThan(0.7);
  });

  it('ignores impacts below the force threshold', () => {
    const { group, mesh } = makeBody();
    const deformer = createBodyDeformer({ group })!;
    const idx = nearestIndex(mesh, 1, 0, 0);
    const beforeX = vx(mesh, idx);
    const beforeColor = (mesh.material as THREE.MeshStandardMaterial).color.getHex();

    deformer.applyImpact({ x: 1, y: 0, z: 0 }, 100); // < minForce (800)

    expect(vx(mesh, idx)).toBeCloseTo(beforeX, 6);
    expect((mesh.material as THREE.MeshStandardMaterial).color.getHex()).toBe(beforeColor);
  });

  it('reset restores the pristine geometry and paint', () => {
    const { group, mesh } = makeBody();
    const deformer = createBodyDeformer({ group })!;
    const idx = nearestIndex(mesh, 1, 0, 0);
    const pristineX = vx(mesh, idx);
    const pristineColor = (mesh.material as THREE.MeshStandardMaterial).color.getHex();

    deformer.applyImpact({ x: 1, y: 0, z: 0 }, 50_000);
    expect(vx(mesh, idx)).not.toBeCloseTo(pristineX, 6);

    deformer.reset();
    expect(vx(mesh, idx)).toBeCloseTo(pristineX, 6);
    expect((mesh.material as THREE.MeshStandardMaterial).color.getHex()).toBe(pristineColor);
  });

  it('picks the body over a higher-poly rigged wheel mesh', () => {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(2, 1, 4, 4, 4, 4),
      new THREE.MeshStandardMaterial(),
    );
    group.add(body);
    // A wheel pivot whose mesh has MORE vertices than the body — must be skipped.
    const wheelPivot = new THREE.Group();
    wheelPivot.name = 'wheel:fl';
    wheelPivot.add(new THREE.Mesh(new THREE.SphereGeometry(0.4, 32, 32)));
    group.add(wheelPivot);
    group.updateMatrixWorld(true);

    const deformer = createBodyDeformer({ group });
    expect(deformer?.mesh).toBe(body);
  });
});
