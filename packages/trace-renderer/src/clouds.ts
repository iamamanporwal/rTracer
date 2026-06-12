import * as THREE from 'three';

/**
 * Realistic billboard cloud field, built from the source PNGs.
 *
 * The old sky dome painted clouds by spherically projecting a blob texture and
 * thresholding it — that sliced clouds along the horizon (the "cut") and pinched
 * them at the zenith. Clouds now live here as discrete soft-edged sprites in real
 * 3D, so a cloud is never cut.
 *
 * **Making real clouds from the images (the "brush" trick).** A flat crop of a
 * cloud photo stamped on a quad reads as a fake paper cut-out — hard rim, no
 * body. Instead we treat each source as a *brush*: at init we key its background
 * out to alpha once, then bake a set of cloud *stamps* by dabbing the brush
 * several times at random offsets, scales, rotations and opacities. Overlapping
 * soft dabs build a lumpy cloud with a dense core, ragged edges and real internal
 * shading — and every stamp is unique. The soft photo (`cloud-b`) carries the
 * realistic detail; the silhouette (`cloud-a`), heavily blurred, adds soft body
 * mass. A radial feather guarantees the rim fades (no rectangle), and a faint
 * underside darken fakes a shadowed base so the billboard reads as volume.
 *
 * **Infinite, drifting, no seam.** The field is a flat slab of sky centred on
 * the camera every frame (so it always surrounds the player). Each sprite drifts
 * with a global wind and wraps within the slab; sprites near the edge fade out,
 * so the wrap never pops. Pure scalar math per frame, zero allocations.
 *
 * **Weather-driven.** Coverage gates how many sprites show (scattered → overcast)
 * and a single tint recolours them all (white → storm-grey → golden).
 */

// Half-width of the cloud slab (m). The camera sits at the slab centre every
// frame, so clouds always surround the player regardless of where the car is.
const FIELD = 1100;
// Altitude band for the slab. Low enough to read as a believable ceiling, high
// enough that a cloud directly overhead never clips the camera near-plane.
const H_MIN = 150;
const H_MAX = 360;
// Distinct cloud stamps baked at init (each a unique composite of brush dabs).
const STAMP_COUNT = 8;
// Resolution of each baked stamp. Clouds can fill a good chunk of screen, so 512
// keeps edges crisp; it's a one-time bake of a handful of textures.
const STAMP_RES = 512;
// Fit box (px) a source brush is scaled into before dabbing.
const BRUSH_BOX = 300;

/**
 * A source cloud image + how to key its background to alpha + how much to blur
 * it into a brush.
 * - `dark`: cloud is darker than a white background (a soft photo) → alpha is
 *   distance-from-white, original shading kept for a realistic look.
 * - `bright`: cloud is the bright part on a dark background (a silhouette) →
 *   alpha is luminance, colour forced white. Blurred hard so it reads as soft
 *   body mass rather than a crisp cut-out.
 */
export type CloudSource = {
  url: string;
  key: 'bright' | 'dark';
  /** Source blur (px) before keying — softens hard silhouettes into puffs. */
  blurPx: number;
  /** Relative chance this brush is chosen for a dab. */
  weight: number;
};

export type CloudFieldOptions = {
  /** Override the source images. Defaults to the two shipped sky PNGs. */
  sources?: readonly CloudSource[];
  /** Hard cap on sprite count. Defaults to a device-aware value. */
  maxClouds?: number;
};

export type CloudFieldHandle = {
  /** Root group (added to the scene by this factory). */
  readonly group: THREE.Group;
  /** Tint every cloud (multiplied over the stamp). Weather recolours via this. */
  setTint(color: THREE.ColorRepresentation): void;
  /** 0..1 — fraction of the sky covered. Gates sprite visibility + opacity. */
  setCoverage(coverage: number): void;
  /** Re-centre the slab on the camera so the field reads as infinite. */
  setCameraAnchor(x: number, y: number, z: number): void;
  /** Advance the wind drift. `dt` in seconds. */
  update(dt: number): void;
  dispose(): void;
};

const DEFAULT_SOURCES: readonly CloudSource[] = [
  // The realistic soft photo is the primary detail brush.
  { url: '/assets/sky/cloud-b.png', key: 'dark', blurPx: 2, weight: 3 },
  // The silhouette, blurred hard, is soft filler body underneath the detail.
  { url: '/assets/sky/cloud-a.png', key: 'bright', blurPx: 8, weight: 1 },
];

type Brush = { canvas: HTMLCanvasElement; w: number; h: number; weight: number };
type CloudVariant = { texture: THREE.Texture };

/**
 * Build the cloud field. Sprites materialise asynchronously once the source
 * images load + their stamps are baked; until then the group is empty (clouds
 * fade in a beat after the session starts — they're purely cosmetic). Safe in a
 * headless/SSR context: with no `document` the handle's methods are inert.
 */
export function createCloudField(
  scene: THREE.Scene,
  options: CloudFieldOptions = {},
): CloudFieldHandle {
  const group = new THREE.Group();
  group.name = 'cloud-field';
  group.frustumCulled = false;
  scene.add(group);

  // Headless guard — no canvas to bake stamps, no GL to show them.
  if (typeof document === 'undefined') {
    return {
      group,
      setTint: () => undefined,
      setCoverage: () => undefined,
      setCameraAnchor: () => undefined,
      update: () => undefined,
      dispose: () => {
        group.removeFromParent();
      },
    };
  }

  const sources = options.sources ?? DEFAULT_SOURCES;
  const count = pickCloudCount(options.maxClouds);

  // Per-cloud state — pre-allocated, mutated in place (no per-frame allocation).
  const baseX = new Float32Array(count);
  const baseZ = new Float32Array(count);
  const baseY = new Float32Array(count);
  const baseOpacity = new Float32Array(count); // intrinsic opacity (cumulus vs wisp)
  const brightness = new Float32Array(count); // per-cloud shade variation
  const rank = new Float32Array(count); // coverage gate threshold ∈ [0,1)
  // Opacity after the coverage gate is applied — multiplied by the live edge
  // fade each frame. Recomputed only when coverage changes.
  const gatedOpacity = new Float32Array(count);
  const sprites: THREE.Sprite[] = [];
  const materials: THREE.SpriteMaterial[] = [];
  const variants: CloudVariant[] = [];

  // Gentle wind in a fixed direction (m/s) — slow enough to read as drift.
  const windX = 3.5;
  const windZ = 1.5;

  const tint = new THREE.Color('#ffffff');
  let coverage = 0.4;
  let camX = 0;
  let camZ = 0;
  let time = 0;
  let disposed = false;
  let ready = false;

  loadVariants(sources)
    .then((baked) => {
      if (disposed || baked.length === 0) return;
      variants.push(...baked);
      buildSprites();
      ready = true;
      recomputeGate();
      applyTint();
    })
    .catch(() => {
      /* Clouds are cosmetic — a load failure just leaves a clear sky. */
    });

  function buildSprites(): void {
    for (let i = 0; i < count; i++) {
      // hi ∈ [0,1): 0 = low, large, opaque cumulus; 1 = high, small, faint wisp.
      // Squaring biases the field toward more (smaller, higher) background puffs.
      const hi = Math.random() * Math.random();
      baseX[i] = (Math.random() * 2 - 1) * FIELD;
      baseZ[i] = (Math.random() * 2 - 1) * FIELD;
      baseY[i] = H_MIN + hi * (H_MAX - H_MIN);

      // Big low cumulus → smaller high wisps. Generous because the rim feather
      // trims the visible silhouette well inside the sprite quad.
      const size = (360 - 200 * hi) * (0.8 + Math.random() * 0.55);
      const aspect = 0.5 + Math.random() * 0.16; // clouds are wider than tall
      baseOpacity[i] = (0.95 - 0.45 * hi) * (0.85 + Math.random() * 0.25);
      brightness[i] = 0.88 + Math.random() * 0.12;
      rank[i] = Math.random();

      const variant = variants[(Math.random() * variants.length) | 0]!;
      const material = new THREE.SpriteMaterial({
        map: variant.texture,
        transparent: true,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        opacity: 0,
        rotation: (Math.random() * 2 - 1) * 0.1, // near-level, slight tilt
      });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(size, size * aspect, 1);
      sprite.position.set(baseX[i]!, baseY[i]!, baseZ[i]!);
      sprite.renderOrder = 0; // after the dome (renderOrder -1), before HUD
      materials.push(material);
      sprites.push(sprite);
      group.add(sprite);
    }
  }

  /** Recompute the coverage gate per cloud (visibility + base opacity). */
  function recomputeGate(): void {
    for (let i = 0; i < count; i++) {
      // Show a cloud when its rank falls under the coverage, with a soft edge so
      // clouds fade in/out across the threshold rather than popping.
      const gate = 1 - smoothstep(coverage - 0.06, coverage + 0.06, rank[i]!);
      gatedOpacity[i] = baseOpacity[i]! * gate;
    }
  }

  /** Push the current tint (× per-cloud brightness) onto every material. */
  function applyTint(): void {
    for (let i = 0; i < materials.length; i++) {
      const m = materials[i]!;
      m.color.copy(tint).multiplyScalar(brightness[i]!);
    }
  }

  return {
    group,
    setTint(color) {
      tint.set(color);
      if (ready) applyTint();
    },
    setCoverage(c) {
      coverage = clamp01(c);
      if (ready) recomputeGate();
    },
    setCameraAnchor(x, _y, z) {
      camX = x;
      camZ = z;
    },
    update(dt) {
      if (!ready) return;
      time += dt;
      const driftX = windX * time;
      const driftZ = windZ * time;
      for (let i = 0; i < sprites.length; i++) {
        // Drift within the slab and wrap symmetrically about the camera centre.
        const dx = wrapSym(baseX[i]! + driftX, FIELD);
        const dz = wrapSym(baseZ[i]! + driftZ, FIELD);
        const sprite = sprites[i]!;
        sprite.position.set(camX + dx, baseY[i]!, camZ + dz);

        // Fade clouds approaching the slab edge so the wrap never pops in.
        const edge = Math.max(Math.abs(dx), Math.abs(dz));
        const fade = 1 - smoothstep(FIELD * 0.72, FIELD, edge);
        const opacity = gatedOpacity[i]! * fade;
        const m = materials[i]!;
        m.opacity = opacity;
        sprite.visible = opacity > 0.01;
      }
    },
    dispose() {
      disposed = true;
      group.removeFromParent();
      for (const m of materials) m.dispose();
      for (const v of variants) v.texture.dispose();
      sprites.length = 0;
      materials.length = 0;
      variants.length = 0;
    },
  };
}

// ── Stamp baking ─────────────────────────────────────────────────────────────

/** Load every source, prep it into a brush, and bake the composite stamps. */
async function loadVariants(
  sources: readonly CloudSource[],
): Promise<CloudVariant[]> {
  const loaded = await Promise.all(
    sources.map((s) =>
      loadImage(s.url)
        .then((img) => ({ src: s, img }))
        .catch(() => null),
    ),
  );
  const brushes: Brush[] = [];
  for (const entry of loaded) {
    if (!entry) continue;
    const brush = prepBrush(entry.img, entry.src);
    if (brush) brushes.push(brush);
  }
  if (brushes.length === 0) return [];

  const variants: CloudVariant[] = [];
  for (let k = 0; k < STAMP_COUNT; k++) {
    const texture = bakeStamp(brushes);
    if (texture) variants.push({ texture });
  }
  return variants;
}

/**
 * Turn a source image into a reusable brush: scale it into a fit box, blur it,
 * and key its background out to alpha so it can be dabbed with normal alpha
 * compositing. Returns a canvas + its drawn size.
 */
function prepBrush(img: HTMLImageElement, src: CloudSource): Brush | null {
  const fit = Math.min(BRUSH_BOX / img.width, BRUSH_BOX / img.height);
  const w = Math.max(1, Math.round(img.width * fit));
  const h = Math.max(1, Math.round(img.height * fit));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // The white-background photo must key against white; prime it so the keyed
  // result has a transparent border (not an opaque black box). The silhouette
  // keys against transparent black.
  if (src.key === 'dark') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }
  if (src.blurPx > 0) ctx.filter = `blur(${src.blurPx}px)`;
  ctx.drawImage(img, 0, 0, w, h);
  ctx.filter = 'none';

  const image = ctx.getImageData(0, 0, w, h);
  applyCloudKey(image.data, src.key);
  ctx.putImageData(image, 0, 0);
  return { canvas, w, h, weight: src.weight };
}

/**
 * Bake one cloud stamp by dabbing brushes several times into a square canvas —
 * a dense, lumpy core that fades to ragged edges — then radial-feather + shade.
 */
function bakeStamp(brushes: Brush[]): THREE.Texture | null {
  const canvas = document.createElement('canvas');
  canvas.width = STAMP_RES;
  canvas.height = STAMP_RES;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, STAMP_RES, STAMP_RES);

  const dabs = 5 + ((Math.random() * 4) | 0); // 5–8 dabs per cloud
  for (let d = 0; d < dabs; d++) {
    const brush = pickBrush(brushes);
    // Keep dab centres in the middle, spread wider horizontally than vertically
    // so the composite reads as a wide cloud with a flattish base.
    const cx = STAMP_RES * (0.5 + (Math.random() - 0.5) * 0.46);
    const cy = STAMP_RES * (0.5 + (Math.random() - 0.5) * 0.26);
    const dw = STAMP_RES * (0.4 + Math.random() * 0.34);
    const dh = (dw * brush.h) / brush.w;
    ctx.save();
    ctx.globalAlpha = 0.55 + Math.random() * 0.4;
    ctx.translate(cx, cy);
    ctx.rotate((Math.random() * 2 - 1) * 0.5);
    ctx.scale(Math.random() < 0.5 ? -1 : 1, 1); // random mirror
    ctx.drawImage(brush.canvas, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  const image = ctx.getImageData(0, 0, STAMP_RES, STAMP_RES);
  featherStamp(image.data, STAMP_RES, STAMP_RES);
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipMapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 1; // mobile-cheap; sprites are distant
  texture.needsUpdate = true;
  return texture;
}

/**
 * Key a cloud image to alpha in place (RGBA, non-premultiplied). Pure pixel math
 * (no DOM) so it's unit-testable in Node. Exported for that.
 *
 * - `bright`: alpha = luminance (the cloud is the bright part), colour forced to
 *   white so a sprite tint multiplies cleanly to any weather palette.
 * - `dark`: alpha = distance from white, with a small dead-zone so a near-white
 *   background keys fully out and a gain that lifts the cloud body to opaque; the
 *   original shading is kept (and nudged brighter) for a realistic look.
 */
export function applyCloudKey(data: Uint8ClampedArray, key: 'bright' | 'dark'): void {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    if (key === 'bright') {
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(clamp01(lum * 1.15) * 255);
    } else {
      const whiteness = Math.min(r, g, b) / 255; // 1 on a pure-white background
      const a = clamp01((1 - whiteness - 0.02) * 3);
      data[i] = Math.min(255, r + 36);
      data[i + 1] = Math.min(255, g + 36);
      data[i + 2] = Math.min(255, b + 36);
      data[i + 3] = Math.round(a * 255);
    }
  }
}

/**
 * Radial-feather a baked stamp's alpha and shade its underside. Pure pixel math
 * over an RGBA buffer of `w`×`h` — DOM-free, so it's unit-testable in Node.
 *
 * - **Radial feather:** alpha is multiplied by a smooth window that reaches 0 at
 *   the rim, computed from the *circular* distance to the centre. A square
 *   (per-axis) window leaves a faint rectangle around the cloud; a radial one
 *   doesn't, and the sprite's wide aspect stretches the circle into a believable
 *   wide ellipse.
 * - **Underside shade:** the lower half is darkened a touch, faking a shadowed
 *   cloud base so the flat billboard reads as volume.
 */
export function featherStamp(data: Uint8ClampedArray, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    const ny = (y / (h - 1)) * 2 - 1; // [-1, 1], 0 = centre
    const shade = 1 - 0.18 * smoothstep(0.0, 1.0, ny); // darker toward the base
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const nx = (x / (w - 1)) * 2 - 1;
      const r = Math.sqrt(nx * nx + ny * ny);
      const win = 1 - smoothstep(0.62, 1.0, r);
      data[i + 3] = Math.round(data[i + 3]! * win);
      data[i] = Math.round(data[i]! * shade);
      data[i + 1] = Math.round(data[i + 1]! * shade);
      data[i + 2] = Math.round(data[i + 2]! * shade);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`cloud image failed to load: ${url}`));
    img.src = url;
  });
}

/** Pick a brush weighted by its `weight` (the detail photo dabs more often). */
function pickBrush(brushes: Brush[]): Brush {
  let total = 0;
  for (const b of brushes) total += b.weight;
  let r = Math.random() * total;
  for (const b of brushes) {
    r -= b.weight;
    if (r <= 0) return b;
  }
  return brushes[brushes.length - 1]!;
}

function pickCloudCount(max?: number): number {
  const cap = max ?? 28;
  if (typeof navigator === 'undefined') return Math.min(16, cap);
  const isMobile =
    /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints ?? 0) > 1;
  if (isMobile) return Math.min(12, cap);
  const cores = navigator.hardwareConcurrency ?? 4;
  if (cores >= 8) return Math.min(28, cap);
  return Math.min(20, cap);
}

/** Map `v` into the symmetric range [-half, half) — the slab wrap. */
function wrapSym(v: number, half: number): number {
  const span = half * 2;
  let m = (v + half) % span;
  if (m < 0) m += span;
  return m - half;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
