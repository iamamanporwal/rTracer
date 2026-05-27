import * as THREE from 'three';
import type { VehicleManifest } from '@trace/core';
import { createTireMaterial } from './materials';

/**
 * Detailed demo vehicle — a boxy, lifted off-road SUV (Rezvani "Cyberoad"-style)
 * built procedurally from the {@link VehicleManifest} rig, so no GLB asset is
 * required. Tall upright greenhouse with raked glass, big black multi-spoke
 * beadlock alloys on tall off-road tires, and a visible suspension at each
 * corner — coilover, lower control arm, and drive half-shaft — plus front/rear
 * bumpers with LED bars, rock sliders, and mirrors.
 *
 * The body is purely visual; the physics collider in `@trace/physics` is its own
 * cuboid. The visual is sized from the same wheel footprint so the wheels line
 * up with the physics raycasts.
 *
 * Three things move every frame from a {@link VehicleVisualSnapshot}:
 *   - the whole body (chassis pose, including suspension dive/roll/pitch),
 *   - each wheel pivot (steering + spin), and
 *   - each suspension link (coilover, control arm, half-shaft), which spans from
 *     a fixed body anchor to the wheel hub so suspension travel is legible.
 *
 * The {@link VehicleVisual.applySnapshot} contract is the stable seam; when a
 * real rigged GLB lands (blueprint P1-14) it swaps the body construction here
 * and keeps the same per-frame update.
 */

/** Read-only snapshot consumed by the renderer — matches `VehicleSnapshot` in `@trace/physics`. */
export type VehicleVisualSnapshot = {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  wheels: {
    position: { x: number; y: number; z: number };
    steering: number;
    rotation: number;
    inContact: boolean;
  }[];
};

export type VehicleVisual = {
  /** Root group — add to scene. Holds the body, wheels, and suspension. */
  group: THREE.Group;
  /** Update transforms from a physics snapshot. Allocates nothing. */
  applySnapshot(snapshot: VehicleVisualSnapshot): void;
  dispose(): void;
};

export type CreateVehicleVisualOptions = {
  manifest: VehicleManifest;
  liveryColor: `#${string}`;
};

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

export function createVehicleVisual(options: CreateVehicleVisualOptions): VehicleVisual {
  const { manifest, liveryColor } = options;
  const d = bodyDimensions(manifest);

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const reg = <T extends THREE.BufferGeometry>(g: T): T => (geometries.push(g), g);
  const regM = <T extends THREE.Material>(m: T): T => (materials.push(m), m);

  // ── Materials ────────────────────────────────────────────────────────────
  // Satin clearcoat body paint in the chosen livery color.
  const paint = regM(
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(liveryColor),
      metalness: 0.35,
      roughness: 0.42,
      clearcoat: 0.65,
      clearcoatRoughness: 0.3,
    }),
  );
  // Textured satin black for flares, bumpers, rack, sliders, grille.
  const black = regM(
    new THREE.MeshStandardMaterial({ color: new THREE.Color('#0e1013'), metalness: 0.25, roughness: 0.72 }),
  );
  // Dark gunmetal alloy for the wheels.
  const alloy = regM(
    new THREE.MeshStandardMaterial({ color: new THREE.Color('#26292e'), metalness: 0.8, roughness: 0.4 }),
  );
  const bolt = regM(
    new THREE.MeshStandardMaterial({ color: new THREE.Color('#0a0b0d'), metalness: 0.9, roughness: 0.35 }),
  );
  // Bright machined steel for shock shafts / skid plates.
  const steel = regM(
    new THREE.MeshStandardMaterial({ color: new THREE.Color('#9aa0a8'), metalness: 0.95, roughness: 0.3 }),
  );
  // Spring steel (slightly darker, glossy).
  const spring = regM(
    new THREE.MeshStandardMaterial({ color: new THREE.Color('#3a3d42'), metalness: 0.9, roughness: 0.35 }),
  );
  const tire = regM(createTireMaterial());
  const glass = regM(
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#0b0e13'),
      metalness: 0.2,
      roughness: 0.08,
      transmission: 0,
      clearcoat: 1,
    }),
  );
  const headlight = regM(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#0a0d12'),
      emissive: new THREE.Color('#eaf2ff'),
      emissiveIntensity: 2.6,
      roughness: 0.35,
    }),
  );
  const taillight = regM(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#180404'),
      emissive: new THREE.Color('#ff241c'),
      emissiveIntensity: 2.2,
      roughness: 0.4,
    }),
  );

  const group = new THREE.Group();
  group.name = `vehicle:${manifest.id}`;

  const HW = d.bodyWidth / 2;

  // ── Lower body tub (extruded side profile, +z = front) ──────────────────────
  const tub = new THREE.Shape();
  tub.moveTo(-d.halfLength, d.floorY); // rear bottom
  tub.lineTo(d.halfLength, d.floorY); // front bottom
  tub.lineTo(d.halfLength, d.floorY + 0.3); // front fascia
  tub.lineTo(d.halfLength - 0.16, d.floorY + 0.42); // hood leading edge
  tub.lineTo(0.72, d.floorY + 0.46); // flat hood to cowl
  tub.lineTo(0.46, d.beltY); // cowl rise to beltline (base of A-pillar)
  tub.lineTo(-1.5, d.beltY); // beltline along the doors
  tub.lineTo(-d.halfLength, d.beltY - 0.05); // rear quarter
  tub.lineTo(-d.halfLength, d.floorY); // tailgate down
  const tubGeom = reg(extrudeAcross(tub, d.bodyWidth, 0.03));
  const tubMesh = new THREE.Mesh(tubGeom, paint);
  tubMesh.castShadow = true;
  tubMesh.receiveShadow = true;
  group.add(tubMesh);

  // Side body crease — a thin shadow line along the doors.
  const creaseGeom = reg(new THREE.BoxGeometry(0.02, 0.05, 2.3));
  for (const sx of [-1, 1]) {
    const crease = new THREE.Mesh(creaseGeom, black);
    crease.position.set(sx * (HW + 0.005), d.floorY + 0.34, -0.1);
    group.add(crease);
  }

  // ── Greenhouse glass (inset, raked windshield + flat roofline) ───────────────
  const gh = new THREE.Shape();
  gh.moveTo(0.46, d.beltY);
  gh.lineTo(0.12, d.roofY - 0.03);
  gh.lineTo(-1.46, d.roofY - 0.03);
  gh.lineTo(-1.5, d.beltY);
  const ghGeom = reg(extrudeAcross(gh, d.bodyWidth * 0.94, 0));
  const greenhouse = new THREE.Mesh(ghGeom, glass);
  group.add(greenhouse);

  // Painted roof cap.
  const roofGeom = reg(new THREE.BoxGeometry(d.bodyWidth * 0.96, 0.07, 1.62));
  const roof = new THREE.Mesh(roofGeom, paint);
  roof.position.set(0, d.roofY, -0.66);
  roof.castShadow = true;
  group.add(roof);

  // Upright C-pillars, body color. (The windshield/A-pillars are read straight
  // off the raked greenhouse glass — no separate struts, which otherwise poked
  // up as stray rods in front of the windshield.)
  const cPillarGeom = reg(new THREE.BoxGeometry(0.07, 0.5, 0.16));
  for (const sx of [-1, 1]) {
    const c = new THREE.Mesh(cPillarGeom, paint);
    c.position.set(sx * (d.bodyWidth * 0.47), (d.beltY + d.roofY) / 2, -1.42);
    c.castShadow = true;
    group.add(c);
  }

  // ── Front end: grille, LED bar, headlights, bumper, skid ─────────────────────
  const fz = d.halfLength;
  const grilleGeom = reg(new THREE.BoxGeometry(d.bodyWidth * 0.82, 0.22, 0.06));
  const grille = new THREE.Mesh(grilleGeom, black);
  grille.position.set(0, d.floorY + 0.18, fz - 0.01);
  group.add(grille);

  const grilleBarGeom = reg(new THREE.BoxGeometry(d.bodyWidth * 0.7, 0.05, 0.07));
  const grilleBar = new THREE.Mesh(grilleBarGeom, headlight);
  grilleBar.position.set(0, d.floorY + 0.2, fz);
  group.add(grilleBar);

  // Optional CYBEROAD badge on the grille (browser only).
  const badgeTex = makeBadgeTexture('CYBEROAD');
  if (badgeTex) {
    const badgeMat = regM(new THREE.MeshBasicMaterial({ map: badgeTex, transparent: true }));
    const badgeGeom = reg(new THREE.PlaneGeometry(0.5, 0.12));
    const badge = new THREE.Mesh(badgeGeom, badgeMat);
    badge.position.set(0, d.floorY + 0.14, fz + 0.005);
    group.add(badge);
  }

  // Angular headlight units flanking the grille.
  const headGeom = reg(new THREE.BoxGeometry(0.16, 0.12, 0.05));
  for (const sx of [-1, 1]) {
    const h = new THREE.Mesh(headGeom, headlight);
    h.position.set(sx * d.bodyWidth * 0.42, d.floorY + 0.26, fz - 0.005);
    group.add(h);
  }

  // Front bumper + lower LED bar + skid plate.
  const bumperGeom = reg(new THREE.BoxGeometry(d.bodyWidth * 1.02, 0.22, 0.26));
  const fBumper = new THREE.Mesh(bumperGeom, black);
  fBumper.position.set(0, d.floorY + 0.04, fz + 0.05);
  fBumper.castShadow = true;
  group.add(fBumper);
  const lowBarGeom = reg(new THREE.BoxGeometry(d.bodyWidth * 0.6, 0.05, 0.05));
  const lowBar = new THREE.Mesh(lowBarGeom, headlight);
  lowBar.position.set(0, d.floorY + 0.06, fz + 0.18);
  group.add(lowBar);
  const skidGeom = reg(new THREE.BoxGeometry(d.bodyWidth * 0.5, 0.04, 0.3));
  const fSkid = new THREE.Mesh(skidGeom, steel);
  fSkid.position.set(0, d.floorY - 0.05, fz + 0.04);
  group.add(fSkid);

  // ── Rear end: taillights, bumper, exhaust ────────────────────────────────────
  const rz = -d.halfLength;
  const tailGeom = reg(new THREE.BoxGeometry(0.12, 0.3, 0.05));
  for (const sx of [-1, 1]) {
    const t = new THREE.Mesh(tailGeom, taillight);
    t.position.set(sx * d.bodyWidth * 0.42, d.beltY - 0.1, rz + 0.005);
    group.add(t);
  }
  const rBumper = new THREE.Mesh(bumperGeom, black);
  rBumper.position.set(0, d.floorY + 0.04, rz - 0.05);
  rBumper.castShadow = true;
  group.add(rBumper);
  const rSkid = new THREE.Mesh(skidGeom, steel);
  rSkid.position.set(0, d.floorY - 0.05, rz - 0.04);
  group.add(rSkid);
  const exhaustGeom = reg(new THREE.CylinderGeometry(0.04, 0.04, 0.12, 10));
  exhaustGeom.rotateX(Math.PI / 2);
  const exhaust = new THREE.Mesh(exhaustGeom, steel);
  exhaust.position.set(d.bodyWidth * 0.3, d.floorY - 0.02, rz - 0.1);
  group.add(exhaust);

  // ── Rock sliders + mirrors ───────────────────────────────────────────────────
  const sliderGeom = reg(new THREE.BoxGeometry(0.09, 0.09, 1.5));
  const mirrorArmGeom = reg(new THREE.BoxGeometry(0.12, 0.03, 0.03));
  const mirrorGeom = reg(new THREE.BoxGeometry(0.05, 0.1, 0.12));
  for (const sx of [-1, 1]) {
    const slider = new THREE.Mesh(sliderGeom, black);
    slider.position.set(sx * (HW + 0.04), d.floorY - 0.02, -0.05);
    slider.castShadow = true;
    group.add(slider);

    const arm = new THREE.Mesh(mirrorArmGeom, black);
    arm.position.set(sx * (HW + 0.06), d.beltY + 0.06, 0.42);
    group.add(arm);
    const mirror = new THREE.Mesh(mirrorGeom, paint);
    mirror.position.set(sx * (HW + 0.14), d.beltY + 0.08, 0.42);
    group.add(mirror);
  }

  // ── Wheels + suspension (coilover + lower control arm + drive half-shaft) ─────
  const wheelParts = buildOffroadWheel(d.wheelRadius, alloy, tire, bolt, reg);
  const coilParts = buildCoilover(spring, steel, reg);
  // Link base geometries are unit-height along Y, centered — scaled to length
  // each frame by spanLink().
  const armGeom = reg(new THREE.BoxGeometry(0.14, 1, 0.07));
  const shaftGeom = reg(new THREE.CylinderGeometry(0.05, 0.05, 1, 12));

  type WheelRig = {
    pivot: THREE.Group; // rotates with steer + spin
    coil: THREE.Group; // coilover, spans body mount → hub
    arm: THREE.Mesh; // lower control arm, spans inner pivot → hub
    shaft: THREE.Mesh; // drive half-shaft, spans axle center → hub
    mount: THREE.Vector3; // coilover top, body-local
    armAnchor: THREE.Vector3; // control-arm inner pivot, body-local
    shaftAnchor: THREE.Vector3; // half-shaft inner (diff) end, body-local
  };
  const wheelRigs: WheelRig[] = [];

  for (const w of manifest.rig.wheels) {
    const restLocal = new THREE.Vector3(w.position[0], d.hubRestY, w.position[2]);

    const pivot = new THREE.Group();
    for (const part of wheelParts) pivot.add(part.clone());
    group.add(pivot);

    const coil = new THREE.Group();
    for (const part of coilParts) coil.add(part.clone());
    group.add(coil);

    const arm = new THREE.Mesh(armGeom, alloy);
    arm.castShadow = true;
    group.add(arm);

    const shaft = new THREE.Mesh(shaftGeom, steel);
    group.add(shaft);

    // Fixed body-local anchors each link pivots from; the hub end moves with
    // suspension travel. Coilover mounts high under the body, the control arm
    // low and inboard, the half-shaft at the axle centerline (the diff).
    const mount = new THREE.Vector3(restLocal.x * 0.72, d.floorY + 0.3, restLocal.z);
    const armAnchor = new THREE.Vector3(restLocal.x * 0.3, d.hubRestY + 0.02, restLocal.z);
    const shaftAnchor = new THREE.Vector3(restLocal.x * 0.12, d.hubRestY, restLocal.z);
    wheelRigs.push({ pivot, coil, arm, shaft, mount, armAnchor, shaftAnchor });
  }

  // ── Reused scratchpads — alloc-free hot path (§18.4) ─────────────────────────
  const tmpHub = new THREE.Vector3();
  const tmpSteer = new THREE.Quaternion();
  const tmpSpin = new THREE.Quaternion();
  const tmpDir = new THREE.Vector3();
  const tmpMid = new THREE.Vector3();
  const tmpOrient = new THREE.Quaternion();

  /** Stretch a unit-height link so it spans `anchor` → `hub` (both body-local). */
  function spanLink(obj: THREE.Object3D, anchor: THREE.Vector3, hub: THREE.Vector3): void {
    tmpDir.copy(hub).sub(anchor);
    const len = Math.max(tmpDir.length(), 0.001);
    tmpMid.copy(anchor).addScaledVector(tmpDir, 0.5);
    obj.position.copy(tmpMid);
    tmpDir.multiplyScalar(1 / len);
    tmpOrient.setFromUnitVectors(UP, tmpDir);
    obj.quaternion.copy(tmpOrient);
    obj.scale.set(1, len, 1);
  }

  function applySnapshot(snapshot: VehicleVisualSnapshot): void {
    group.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
    group.quaternion.set(
      snapshot.rotation.x,
      snapshot.rotation.y,
      snapshot.rotation.z,
      snapshot.rotation.w,
    );
    group.updateMatrixWorld(true);

    for (let i = 0; i < wheelRigs.length; i++) {
      const rig = wheelRigs[i];
      const wheelSnap = snapshot.wheels[i];
      if (!rig || !wheelSnap) continue;

      // World hub position → body-local.
      tmpHub.set(wheelSnap.position.x, wheelSnap.position.y, wheelSnap.position.z);
      group.worldToLocal(tmpHub);

      rig.pivot.position.copy(tmpHub);
      // Steer about local Y, then spin about the (steered) axle.
      tmpSteer.setFromAxisAngle(UP, wheelSnap.steering);
      tmpSpin.setFromAxisAngle(RIGHT, wheelSnap.rotation);
      rig.pivot.quaternion.copy(tmpSteer).multiply(tmpSpin);

      // Suspension links each telescope from a fixed body anchor to the hub.
      spanLink(rig.coil, rig.mount, tmpHub);
      spanLink(rig.arm, rig.armAnchor, tmpHub);
      spanLink(rig.shaft, rig.shaftAnchor, tmpHub);
    }
  }

  function dispose(): void {
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    badgeTex?.dispose();
    group.removeFromParent();
  }

  return { group, applySnapshot, dispose };
}

/**
 * One off-road wheel = chunky tire + dark multi-spoke alloy with a beadlock ring
 * and bolts. Returned as a list of meshes so the caller can clone them per
 * pivot; geometries are registered for disposal via {@link reg}.
 */
function buildOffroadWheel(
  radius: number,
  alloy: THREE.Material,
  tire: THREE.Material,
  bolt: THREE.Material,
  reg: <T extends THREE.BufferGeometry>(g: T) => T,
): THREE.Mesh[] {
  const width = 0.44;
  const parts: THREE.Mesh[] = [];

  const tireGeom = reg(new THREE.CylinderGeometry(radius, radius, width, 30));
  tireGeom.rotateZ(Math.PI / 2); // axle along X
  const tireMesh = new THREE.Mesh(tireGeom, tire);
  tireMesh.castShadow = true;
  parts.push(tireMesh);

  // Rim barrel (dark) sits inside the tire.
  const rimR = radius * 0.6;
  const barrelGeom = reg(new THREE.CylinderGeometry(rimR, rimR, width * 0.9, 20));
  barrelGeom.rotateZ(Math.PI / 2);
  parts.push(new THREE.Mesh(barrelGeom, alloy));

  // Spoke face disc just proud of the outer tire face.
  const faceX = width / 2 + 0.01;
  const discGeom = reg(new THREE.CylinderGeometry(rimR * 0.95, rimR * 0.95, 0.03, 24));
  discGeom.rotateZ(Math.PI / 2);
  const disc = new THREE.Mesh(discGeom, alloy);
  disc.position.x = faceX;
  parts.push(disc);

  // Ten spokes radiating on the outer face.
  const spokeGeom = reg(new THREE.BoxGeometry(0.025, rimR * 1.5, 0.06));
  for (let s = 0; s < 10; s++) {
    const spoke = new THREE.Mesh(spokeGeom, alloy);
    spoke.position.x = faceX;
    spoke.rotation.x = (s / 10) * Math.PI * 2;
    parts.push(spoke);
  }

  // Beadlock ring + bolts around the rim lip.
  const ringGeom = reg(new THREE.TorusGeometry(rimR * 0.98, 0.025, 8, 24));
  const ring = new THREE.Mesh(ringGeom, bolt);
  ring.rotation.y = Math.PI / 2;
  ring.position.x = faceX + 0.01;
  parts.push(ring);
  const boltGeom = reg(new THREE.CylinderGeometry(0.015, 0.015, 0.04, 6));
  boltGeom.rotateZ(Math.PI / 2);
  for (let b = 0; b < 8; b++) {
    const a = (b / 8) * Math.PI * 2;
    const bm = new THREE.Mesh(boltGeom, bolt);
    bm.position.set(faceX + 0.02, Math.cos(a) * rimR * 0.98, Math.sin(a) * rimR * 0.98);
    parts.push(bm);
  }

  // Center hub cap.
  const hubGeom = reg(new THREE.CylinderGeometry(radius * 0.16, radius * 0.16, width + 0.04, 12));
  hubGeom.rotateZ(Math.PI / 2);
  parts.push(new THREE.Mesh(hubGeom, alloy));

  return parts;
}

/**
 * Exposed coilover: a steel shock shaft inside a helical spring, both modelled
 * to a unit height centered on the origin so the caller can scale Y to the
 * suspension length each frame.
 */
function buildCoilover(
  spring: THREE.Material,
  steel: THREE.Material,
  reg: <T extends THREE.BufferGeometry>(g: T) => T,
): THREE.Mesh[] {
  const coils = 7;
  const segs = 112;
  const sr = 0.075; // spring coil radius
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = t * coils * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * sr, t - 0.5, Math.sin(a) * sr));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const springGeom = reg(new THREE.TubeGeometry(curve, segs, 0.02, 7, false));
  const springMesh = new THREE.Mesh(springGeom, spring);

  const shaftGeom = reg(new THREE.CylinderGeometry(0.03, 0.03, 1, 12));
  const shaft = new THREE.Mesh(shaftGeom, steel);

  return [springMesh, shaft];
}

/** Draw a small badge texture in-browser; returns null when there's no DOM. */
function makeBadgeTexture(text: string): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, 256, 64);
  ctx.fillStyle = '#e8edf4';
  ctx.font = 'bold 38px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = '4px';
  ctx.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Extrude a side profile drawn in the (z, y) plane across the vehicle width.
 * The shape's x maps to vehicle +z (front), its y to vehicle height, and the
 * extrude depth to vehicle width.
 */
function extrudeAcross(shape: THREE.Shape, width: number, bevel: number): THREE.ExtrudeGeometry {
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: width,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
  });
  geom.translate(0, 0, -width / 2); // center across width
  geom.rotateY(-Math.PI / 2); // shape-x → world z, extrude → world x
  return geom;
}

/**
 * Visual body dimensions derived from the wheel footprint. The body is a bit
 * wider/taller than the physics cuboid — purely cosmetic overhang for the
 * lifted-SUV stance.
 */
function bodyDimensions(manifest: VehicleManifest): {
  halfLength: number;
  bodyWidth: number;
  floorY: number;
  beltY: number;
  roofY: number;
  hubRestY: number;
  wheelRadius: number;
} {
  let maxX = 0;
  let maxZ = 0;
  let radius = 0.31;
  for (const w of manifest.rig.wheels) {
    if (Math.abs(w.position[0]) > maxX) maxX = Math.abs(w.position[0]);
    if (Math.abs(w.position[2]) > maxZ) maxZ = Math.abs(w.position[2]);
    radius = w.radius;
  }
  // The physics body center sits at ~halfExtentY(0.5) + ride height above the
  // ground, with wheels resting on the ground. In body-local space the wheel hub
  // rests at hubRestY (set by the suspension equilibrium, independent of tire
  // radius), so the body is lifted clear of the taller tires: a wheel reaches
  // hubRestY + radius at the top, which must stay below floorY.
  return {
    halfLength: maxZ + 0.35,
    bodyWidth: (maxX - 0.05) * 2, // a touch wider so the cabin doesn't read narrow
    floorY: 0.04, // body underside rides well clear of the tall wheels (lifted stance)
    beltY: 0.62, // taller doors / lower body
    roofY: 1.5, // tall greenhouse with real headroom — looks like people fit inside
    hubRestY: -0.49,
    wheelRadius: radius,
  };
}
