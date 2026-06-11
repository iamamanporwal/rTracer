import * as THREE from 'three';

/**
 * Visual side of the stunt park. The physics package owns the static Rapier
 * bodies; we mirror its snapshot into Three.js meshes 1:1 — wedge prisms for the
 * ramps, flat boxes for the loop segments and rails. Everything is static, so we
 * build once at construction and never touch it per frame (unlike the dynamic
 * crates in `obstacles.ts`).
 *
 * Mesh shape matches the collider exactly, so what the rider sees is what they
 * launch off / loop around.
 */

export type StuntVisualShape = 'wedge' | 'box';
export type StuntVisualSurface = 'ramp' | 'loop' | 'rail' | 'pad';

export type StuntVisualSnapshot = {
  id: string;
  shape: StuntVisualShape;
  surface: StuntVisualSurface;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  halfExtents: { x: number; y: number; z: number };
};

export type StuntVisuals = {
  group: THREE.Group;
  dispose(): void;
};

export function createStuntVisuals(pieces: readonly StuntVisualSnapshot[]): StuntVisuals {
  const group = new THREE.Group();
  group.name = 'stunts';

  // Skatepark palette — distinct, grippy-reading materials so the test surfaces
  // pop against the grey ground and crates.
  const rampMat = new THREE.MeshStandardMaterial({
    color: 0xe8531f, // hot safety orange
    roughness: 0.85,
    metalness: 0.0,
  });
  const loopMat = new THREE.MeshStandardMaterial({
    color: 0x2b6fb3, // steel blue ring
    roughness: 0.55,
    metalness: 0.25,
  });
  const railMat = new THREE.MeshStandardMaterial({
    color: 0xf5c116, // hazard yellow kerbs
    roughness: 0.6,
    metalness: 0.0,
  });
  const lipMat = new THREE.MeshStandardMaterial({
    color: 0xf5f5f5, // bright launch-lip stripe
    roughness: 0.7,
    metalness: 0.0,
  });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x0a0a0a });
  const materials: THREE.Material[] = [rampMat, loopMat, railMat, lipMat, edgeMat];

  const boxMatFor = (s: StuntVisualSurface): THREE.MeshStandardMaterial =>
    s === 'loop' ? loopMat : s === 'rail' ? railMat : rampMat;

  const geoms: THREE.BufferGeometry[] = [];
  const q = new THREE.Quaternion();

  for (const p of pieces) {
    const obj =
      p.shape === 'wedge'
        ? buildWedge(p, rampMat, lipMat, edgeMat, geoms)
        : buildBox(p, boxMatFor(p.surface), geoms);
    obj.name = p.id;
    obj.position.set(p.position.x, p.position.y, p.position.z);
    q.set(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w);
    obj.quaternion.copy(q);
    group.add(obj);
  }

  return {
    group,
    dispose() {
      for (const g of geoms) g.dispose();
      for (const m of materials) m.dispose();
      group.removeFromParent();
    },
  };
}

/** Flat box collider → BoxGeometry of matching full extents. */
function buildBox(
  p: StuntVisualSnapshot,
  mat: THREE.MeshStandardMaterial,
  geoms: THREE.BufferGeometry[],
): THREE.Object3D {
  const geom = new THREE.BoxGeometry(
    p.halfExtents.x * 2,
    p.halfExtents.y * 2,
    p.halfExtents.z * 2,
  );
  geoms.push(geom);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Right triangular prism matching the physics convex hull: width X∈[-hx,hx],
 * depth Z∈[-hz,hz], height Y∈[0,2hy], base on y=0, low lip at +Z, launch lip at
 * -Z. A thin bright stripe caps the launch lip so the takeoff edge reads clearly.
 */
function buildWedge(
  p: StuntVisualSnapshot,
  rampMat: THREE.MeshStandardMaterial,
  lipMat: THREE.MeshStandardMaterial,
  edgeMat: THREE.LineBasicMaterial,
  geoms: THREE.BufferGeometry[],
): THREE.Object3D {
  const hx = p.halfExtents.x;
  const hz = p.halfExtents.z;
  const H = p.halfExtents.y * 2;

  // Six corners (same order as the hull).
  const A = [-hx, 0, hz]; // front-bottom (low lip)
  const B = [hx, 0, hz];
  const C = [-hx, 0, -hz]; // back-bottom
  const D = [hx, 0, -hz];
  const E = [-hx, H, -hz]; // back-top (launch lip)
  const F = [hx, H, -hz];

  // Non-indexed tris → computeVertexNormals gives clean flat faces.
  const tri = (...verts: number[][]): number[] => verts.flat();
  const positions = new Float32Array([
    // base (y=0), facing down
    ...tri(A, C, B),
    ...tri(B, C, D),
    // back wall (z=-hz), facing -Z
    ...tri(C, E, D),
    ...tri(D, E, F),
    // slope (hypotenuse) from low lip up to launch lip, facing up/+Z
    ...tri(A, B, F),
    ...tri(A, F, E),
    // left cap (x=-hx)
    ...tri(A, E, C),
    // right cap (x=+hx)
    ...tri(B, D, F),
  ]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  geoms.push(geom);

  const mesh = new THREE.Mesh(geom, rampMat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // Crisp dark outline so the wedge silhouette pops.
  const edgeGeom = new THREE.EdgesGeometry(geom);
  geoms.push(edgeGeom);
  mesh.add(new THREE.LineSegments(edgeGeom, edgeMat));

  // Bright stripe across the launch lip (the -Z top edge).
  const lipGeom = new THREE.BoxGeometry(hx * 2 * 1.02, 0.08, 0.5);
  geoms.push(lipGeom);
  const lip = new THREE.Mesh(lipGeom, lipMat);
  lip.position.set(0, H, -hz + 0.2);
  mesh.add(lip);

  return mesh;
}
