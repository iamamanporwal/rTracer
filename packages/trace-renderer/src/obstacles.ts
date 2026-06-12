import * as THREE from 'three';

/**
 * Visual side of the spawn-area obstacle field. The physics package owns the
 * Rapier bodies; we just mirror its snapshot into Three.js meshes each frame.
 *
 * Mesh shape matches the collider half-extents 1:1, so what the driver sees is
 * exactly what they collide with.
 */

export type ObstacleVisualSnapshot = {
  id: string;
  kind: 'speedBump' | 'crate';
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  halfExtents: { x: number; y: number; z: number };
};

export type ObstacleVisuals = {
  group: THREE.Group;
  /** Copy positions + rotations from the physics snapshot. */
  update(snapshots: readonly ObstacleVisualSnapshot[]): void;
  dispose(): void;
};

export function createObstacleVisuals(
  initial: readonly ObstacleVisualSnapshot[],
): ObstacleVisuals {
  const group = new THREE.Group();
  group.name = 'obstacles';

  // Shared materials so all crates / bumps batch the same draw state.
  // Crates are heavy steel boxes — brushed gunmetal with a strong metallic
  // response so they read as solid weight, not cardboard.
  const crateMat = new THREE.MeshStandardMaterial({
    color: 0x8a9099,
    roughness: 0.38,
    metalness: 0.9,
  });
  const bumpMat = new THREE.MeshStandardMaterial({
    color: 0xf5c116,
    roughness: 0.7,
    metalness: 0.0,
  });
  const stripeMat = new THREE.MeshStandardMaterial({
    color: 0x101010,
    roughness: 0.8,
    metalness: 0.0,
  });

  const meshes = new Map<string, THREE.Object3D>();
  const geoms: THREE.BufferGeometry[] = [];

  for (const s of initial) {
    const w = s.halfExtents.x * 2;
    const h = s.halfExtents.y * 2;
    const d = s.halfExtents.z * 2;

    let obj: THREE.Object3D;
    if (s.kind === 'speedBump') {
      // Base body + thin painted stripes on top so the bump reads as a hazard.
      const bumpGeom = new THREE.BoxGeometry(w, h, d);
      const bump = new THREE.Mesh(bumpGeom, bumpMat);
      bump.castShadow = true;
      bump.receiveShadow = true;
      geoms.push(bumpGeom);

      const stripeWidth = w / 7;
      const stripeGeom = new THREE.BoxGeometry(stripeWidth, h + 0.002, d * 1.01);
      geoms.push(stripeGeom);
      for (let i = -2; i <= 2; i += 2) {
        const stripe = new THREE.Mesh(stripeGeom, stripeMat);
        stripe.position.x = i * stripeWidth;
        bump.add(stripe);
      }
      obj = bump;
    } else {
      const geom = new THREE.BoxGeometry(w, h, d);
      geoms.push(geom);
      const crate = new THREE.Mesh(geom, crateMat);
      crate.castShadow = true;
      crate.receiveShadow = true;
      // Bright machined edge so the steel box's corners catch the light.
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geom),
        new THREE.LineBasicMaterial({ color: 0xc8ced6 }),
      );
      crate.add(edges);
      obj = crate;
    }

    obj.name = s.id;
    meshes.set(s.id, obj);
    group.add(obj);
  }

  const q = new THREE.Quaternion();

  return {
    group,
    update(snapshots) {
      for (const s of snapshots) {
        const obj = meshes.get(s.id);
        if (!obj) continue;
        obj.position.set(s.position.x, s.position.y, s.position.z);
        q.set(s.rotation.x, s.rotation.y, s.rotation.z, s.rotation.w);
        obj.quaternion.copy(q);
      }
    },
    dispose() {
      for (const g of geoms) g.dispose();
      crateMat.dispose();
      bumpMat.dispose();
      stripeMat.dispose();
      // EdgesGeometry instances aren't tracked; walk children to free them too.
      group.traverse((o) => {
        if (o instanceof THREE.LineSegments) {
          (o.geometry as THREE.BufferGeometry).dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      group.removeFromParent();
      meshes.clear();
    },
  };
}
