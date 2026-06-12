/**
 * Race gate visuals — the NFS-Most-Wanted-style flame markers a designer drops
 * to bookend a race in the Dev-Mode Race Builder.
 *
 * A gate is purely cosmetic (no physics collider): two flickering flame jets on
 * posts flank the road, a glowing strip lies across the ground between them, and
 * a floating label hovers above. START reads green; FINISH reads checkered + a
 * hotter ember tint, so the two are distinguishable at a glance from any angle.
 *
 * The flame and checker textures are baked once and shared across every gate;
 * each gate only owns its label texture + the meshes it adds to its group. The
 * caller positions the gate with {@link RaceGate.setTransform} and must call
 * {@link RaceGate.update} each frame to animate the flicker.
 */
import * as THREE from 'three';

export type RaceGateKind = 'start' | 'finish';

export type RaceGate = {
  /** The gate's scene group — add this to the scene; the caller owns parenting. */
  readonly group: THREE.Group;
  /** Seat the gate at a world position with a yaw (radians) about +Y. */
  setTransform(x: number, y: number, z: number, yaw: number): void;
  /** Advance the flame flicker by `dt` seconds. */
  update(dt: number): void;
  dispose(): void;
};

/** Default road span the flame jets straddle (metres). */
const GATE_WIDTH = 9;
const POST_HEIGHT = 1.1;

type FlameJet = {
  group: THREE.Group;
  sprites: { sprite: THREE.Sprite; base: number; baseY: number; phase: number }[];
  light: THREE.PointLight;
};

export function createRaceGate(opts: { kind: RaceGateKind; width?: number }): RaceGate {
  const { kind } = opts;
  const width = opts.width ?? GATE_WIDTH;
  const half = width / 2;
  const accent = kind === 'start' ? 0x39ff88 : 0xff3b2f; // green = go, red = finish
  const emberTint = kind === 'start' ? 0xfff0d8 : 0xffcaa0; // start flames whiter, finish hotter

  const group = new THREE.Group();
  // Disposables this gate owns (shared baked textures are excluded — they live
  // for the app lifetime, like the cloud brushes).
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const ownTextures: THREE.Texture[] = [];
  const flames: FlameJet[] = [];

  // ── Posts + emissive collars + flame jets, one per side ───────────────────
  const postGeo = new THREE.CylinderGeometry(0.1, 0.15, POST_HEIGHT, 10);
  const postMat = new THREE.MeshStandardMaterial({
    color: 0x0e141c,
    metalness: 0.6,
    roughness: 0.5,
  });
  const collarGeo = new THREE.TorusGeometry(0.26, 0.055, 8, 20);
  const collarMat = new THREE.MeshStandardMaterial({
    color: accent,
    emissive: new THREE.Color(accent),
    emissiveIntensity: 2.4,
    roughness: 0.4,
  });
  geos.push(postGeo, collarGeo);
  mats.push(postMat, collarMat);

  for (const sx of [-half, half]) {
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(sx, POST_HEIGHT / 2, 0);
    group.add(post);

    const collar = new THREE.Mesh(collarGeo, collarMat);
    collar.position.set(sx, POST_HEIGHT + 0.02, 0);
    collar.rotation.x = Math.PI / 2;
    group.add(collar);

    const jet = makeFlameJet(emberTint, mats);
    jet.group.position.set(sx, POST_HEIGHT + 0.02, 0);
    group.add(jet.group);
    flames.push(jet);
  }

  // ── Ground line between the posts ─────────────────────────────────────────
  const lineGeo = new THREE.PlaneGeometry(width, 1.5);
  geos.push(lineGeo);
  let lineMat: THREE.Material;
  if (kind === 'finish') {
    const tex = checkerTexture();
    tex.repeat.set(Math.max(2, Math.round(width / 1.5)), 1);
    lineMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  } else {
    lineMat = new THREE.MeshStandardMaterial({
      color: accent,
      emissive: new THREE.Color(accent),
      emissiveIntensity: 1.5,
      roughness: 0.5,
      transparent: true,
      opacity: 0.9,
    });
  }
  mats.push(lineMat);
  const line = new THREE.Mesh(lineGeo, lineMat);
  line.rotation.x = -Math.PI / 2; // lay the plane flat
  line.position.y = 0.03;
  group.add(line);

  // ── Floating label ────────────────────────────────────────────────────────
  const labelTex = labelTexture(
    kind === 'start' ? 'START' : 'FINISH',
    kind === 'start' ? '#5dff9e' : '#ff6a4d',
  );
  ownTextures.push(labelTex);
  const labelMat = new THREE.SpriteMaterial({
    map: labelTex,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });
  mats.push(labelMat);
  const label = new THREE.Sprite(labelMat);
  label.scale.set(3.4, 1.06, 1);
  label.position.set(0, 2.7, 0);
  label.renderOrder = 12;
  group.add(label);

  let t = 0;

  return {
    group,
    setTransform(x, y, z, yaw) {
      group.position.set(x, y, z);
      group.rotation.set(0, yaw, 0);
    },
    update(dt) {
      t += dt;
      let i = 0;
      for (const jet of flames) {
        for (const s of jet.sprites) {
          const f = 1 + 0.16 * Math.sin(t * 9 + s.phase) + 0.07 * Math.sin(t * 23 + s.phase * 2);
          s.sprite.scale.set(s.base * f, s.base * 1.4 * f, 1);
          s.sprite.position.y = s.baseY + 0.05 * Math.sin(t * 7 + s.phase);
          s.sprite.material.opacity = 0.74 + 0.2 * Math.sin(t * 16 + s.phase * 1.3);
        }
        jet.light.intensity = 5 + 1.9 * Math.sin(t * 18 + i * 2.1);
        i += 1;
      }
    },
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      for (const tex of ownTextures) tex.dispose();
    },
  };
}

/** Build a single flickering flame jet: three stacked additive sprites + a light. */
function makeFlameJet(tint: number, mats: THREE.Material[]): FlameJet {
  const group = new THREE.Group();
  const tex = flameTexture();
  const defs = [
    { s: 1.7, y: 0.95, phase: 0.0 },
    { s: 1.15, y: 1.28, phase: 1.7 },
    { s: 0.72, y: 1.6, phase: 3.3 },
  ];
  const sprites: FlameJet['sprites'] = [];
  for (const d of defs) {
    const mat = new THREE.SpriteMaterial({
      map: tex,
      color: new THREE.Color(tint),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      opacity: 0.9,
    });
    mats.push(mat);
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(d.s, d.s * 1.4, 1);
    sprite.position.y = d.y;
    group.add(sprite);
    sprites.push({ sprite, base: d.s, baseY: d.y, phase: d.phase });
  }
  const light = new THREE.PointLight(0xff7a2a, 6, 14, 2);
  light.position.y = 1.15;
  light.castShadow = false;
  group.add(light);
  return { group, sprites, light };
}

// ── Baked textures (shared, app-lifetime) ────────────────────────────────────

let _flameTex: THREE.Texture | null = null;
function flameTexture(): THREE.Texture {
  if (_flameTex) return _flameTex;
  const s = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s * 0.62, 3, s / 2, s * 0.55, s * 0.5);
  g.addColorStop(0, 'rgba(255,255,245,1)');
  g.addColorStop(0.3, 'rgba(255,226,140,0.95)');
  g.addColorStop(0.62, 'rgba(255,135,40,0.55)');
  g.addColorStop(1, 'rgba(255,70,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  _flameTex = tex;
  return tex;
}

let _checkerTex: THREE.Texture | null = null;
function checkerTexture(): THREE.Texture {
  if (_checkerTex) return _checkerTex;
  const n = 8;
  const px = 16;
  const s = n * px;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#0b0b0c' : '#f4f4f5';
      ctx.fillRect(x * px, y * px, px, px);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  _checkerTex = tex;
  return tex;
}

/** A per-gate label texture (its text/colour are fixed, so it's owned + disposed). */
function labelTexture(text: string, color: string): THREE.Texture {
  const w = 256;
  const h = 80;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.font = 'bold 54px Oswald, Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 7;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, w / 2, h / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
