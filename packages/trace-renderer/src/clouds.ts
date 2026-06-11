import * as THREE from 'three';

/**
 * Volumetric-looking billboard cloud field, built from a couple of source PNGs.
 *
 * The old sky dome painted clouds by spherically projecting a procedural blob
 * texture and hard-thresholding it. That projection sliced clouds along the
 * horizon taper (the "cut in the middle") and pinched them at the zenith. This
 * replaces that approach with discrete, soft-edged sprites floating in real 3D —
 * so a cloud is never cut: it's a stamp with its own alpha, sorted and blended
 * like any other transparent object.
 *
 * **Making many clouds from two images (simple algos).** At init we bake a
 * handful of distinct cloud *stamps* from each source by cropping a sub-region,
 * randomly mirroring it, rotating it a few degrees, and keying out the
 * background to alpha. One big cumulus photo yields many believable smaller
 * clouds this way; mirror + rotation keep repeats from reading as repeats. Two
 * source images (a bold silhouette + a soft puff) give a cumulus/wisp mix.
 *
 * **Infinite, drifting, no seam.** The field is a flat slab of sky centred on
 * the camera every frame (so it always surrounds the player). Each sprite drifts
 * with a global wind and wraps within the slab; sprites near the slab edge fade
 * out, so the wrap never pops. Pure scalar math per frame, zero allocations.
 *
 * **Weather-driven.** Coverage gates how many sprites show (scattered → overcast)
 * and a single tint recolours them all (white → storm-grey → golden). Nothing
 * here hardcodes a palette; the weather system pushes both live.
 */

// Half-width of the cloud slab (m). The camera sits at the slab centre every
// frame, so clouds always surround the player regardless of where the car is.
const FIELD = 1100;
// Altitude band for the slab. Low enough to read as a believable ceiling, high
// enough that a cloud directly overhead never clips the camera near-plane.
const H_MIN = 140;
const H_MAX = 340;
// Distinct stamps baked per source image (mirror/rotate/crop variations).
const STAMPS_PER_SOURCE = 4;
// Resolution of each baked stamp. 256² is plenty for a soft cloud and cheap to
// upload; sprites are far away so they never fill many pixels.
const STAMP_RES = 256;

/**
 * A source cloud image and how to extract its alpha.
 * - `bright`: cloud is the bright part on a dark background (white-on-black
 *   silhouette) → alpha is luminance, colour forced white so it tints cleanly.
 * - `dark`: cloud is darker than a white background (a soft photo) → alpha is
 *   distance-from-white, original shading kept for a realistic look.
 */
export type CloudSource = {
  url: string;
  key: 'bright' | 'dark';
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
  { url: '/assets/sky/cloud-a.png', key: 'bright' },
  { url: '/assets/sky/cloud-b.png', key: 'dark' },
];

type CloudVariant = { texture: THREE.Texture; key: 'bright' | 'dark' };

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
  const windX = 4.5;
  const windZ = 2.0;

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
      const size = (320 - 170 * hi) * (0.85 + Math.random() * 0.5);
      const aspect = 0.46 + Math.random() * 0.16; // clouds are wide and flat
      baseOpacity[i] = (0.92 - 0.5 * hi) * (0.82 + Math.random() * 0.3);
      brightness[i] = 0.86 + Math.random() * 0.14;
      rank[i] = Math.random();

      // Low clouds prefer the bold silhouette; high wisps the soft photo.
      const variant = pickVariant(variants, hi < 0.5 ? 'bright' : 'dark');
      const material = new THREE.SpriteMaterial({
        map: variant.texture,
        transparent: true,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        opacity: 0,
        rotation: (Math.random() * 2 - 1) * 0.14, // near-level, slight tilt
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

/** Load every source, bake its stamps, and collect the resulting textures. */
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
  const variants: CloudVariant[] = [];
  for (const entry of loaded) {
    if (!entry) continue;
    for (let k = 0; k < STAMPS_PER_SOURCE; k++) {
      const texture = bakeStamp(entry.img, entry.src.key);
      if (texture) variants.push({ texture, key: entry.src.key });
    }
  }
  return variants;
}

/**
 * Bake one cloud stamp: crop a sub-region of the source that's guaranteed to
 * include its centre (where the cloud lives), draw it mirrored/rotated into a
 * square canvas, key the background out to alpha, then feather the rim.
 *
 * The feather is what kills the "cut": the source images are a single cloud that
 * fills the frame, so any sub-crop slices through the cloud body and leaves it
 * meeting the crop's straight edge. Fading alpha toward the stamp border turns
 * that hard edge into a soft puff — and softens every cloud's silhouette while
 * we're at it. A gentle vertical darken on the bright (silhouette) source fakes a
 * shadowed underside so the billboards read as volume, not paper cut-outs.
 */
function bakeStamp(img: HTMLImageElement, key: 'bright' | 'dark'): THREE.Texture | null {
  const canvas = document.createElement('canvas');
  canvas.width = STAMP_RES;
  canvas.height = STAMP_RES;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // For the white-background source, prime the canvas white so any transparent
  // border in the PNG keys out (distance-from-white → 0) rather than reading as
  // an opaque black blob. The dark-background source primes transparent.
  if (key === 'dark') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, STAMP_RES, STAMP_RES);
  } else {
    ctx.clearRect(0, 0, STAMP_RES, STAMP_RES);
  }

  const iw = img.width;
  const ih = img.height;
  // Crop 55–90% of each axis, positioned so the source centre stays inside the
  // crop — the cloud occupies the middle of both source images, so this keeps
  // every stamp non-empty while still yielding distinct shapes.
  const cropW = iw * (0.55 + Math.random() * 0.35);
  const cropH = ih * (0.55 + Math.random() * 0.35);
  const cropX = clamp(iw * 0.5 - cropW * (0.3 + Math.random() * 0.4), 0, iw - cropW);
  const cropY = clamp(ih * 0.5 - cropH * (0.3 + Math.random() * 0.4), 0, ih - cropH);

  // Draw the crop preserving its aspect (fit inside the inner box), mirrored and
  // slightly rotated. Padding + the rim feather below mean a rotated draw poking
  // past the box just fades out — never a hard clip.
  const pad = 0.82;
  const box = STAMP_RES * pad;
  const fit = Math.min(box / cropW, box / cropH);
  const dw = cropW * fit;
  const dh = cropH * fit;
  ctx.save();
  ctx.translate(STAMP_RES / 2, STAMP_RES / 2);
  ctx.rotate((Math.random() * 2 - 1) * 0.4); // ±~23°
  ctx.scale(Math.random() < 0.5 ? -1 : 1, 1); // random mirror
  // Blur the source before keying. The silhouette PNG has hard, jagged edges; a
  // little blur turns them into soft puffy gradients (and bleeds the edge out a
  // touch for a fuller cloud). The photo source needs only a hair of smoothing.
  ctx.filter = key === 'bright' ? 'blur(3.5px)' : 'blur(1.5px)';
  ctx.drawImage(img, cropX, cropY, cropW, cropH, -dw / 2, -dh / 2, dw, dh);
  ctx.filter = 'none';
  ctx.restore();

  const image = ctx.getImageData(0, 0, STAMP_RES, STAMP_RES);
  applyCloudKey(image.data, key);
  featherStamp(image.data, STAMP_RES, STAMP_RES, key);
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
 * Key a cloud image to alpha in place (RGBA, non-premultiplied).
 *
 * Pure pixel math — no DOM — so it's unit-testable in Node. Exported for that.
 *
 * - `bright`: alpha = luminance (the cloud is the bright part), colour forced to
 *   white so a sprite tint multiplies cleanly to any weather palette.
 * - `dark`: alpha = distance from white, with a small dead-zone so a near-white
 *   background keys fully out and a gain that lifts the cloud body to opaque;
 *   the original shading is kept (and nudged brighter) for a realistic look.
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
      data[i] = Math.min(255, r + 30);
      data[i + 1] = Math.min(255, g + 30);
      data[i + 2] = Math.min(255, b + 30);
      data[i + 3] = Math.round(a * 255);
    }
  }
}

/**
 * Feather a baked stamp's alpha toward its rim and (for `bright` clouds) shade
 * the underside. Pure pixel math over an RGBA buffer of `w`×`h` — DOM-free, so
 * it's unit-testable in Node. Exported for that.
 *
 * - **Rim feather:** alpha is multiplied by a smooth window that reaches 0 at the
 *   border, so a cropped cloud fades out instead of ending on a hard straight
 *   edge (the "cut"). Applied per-axis so corners feather twice (rounder puffs).
 * - **Underside shade (bright only):** the lower half of the stamp is darkened a
 *   touch, faking a shadowed cloud base for a sense of volume. Skipped for `dark`
 *   clouds, whose source photo already carries real shading.
 */
export function featherStamp(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  key: 'bright' | 'dark',
): void {
  for (let y = 0; y < h; y++) {
    // ny ∈ [-1, 1] across the stamp height; 0 = centre.
    const ny = (y / (h - 1)) * 2 - 1;
    const winY = 1 - smoothstep(0.62, 0.98, Math.abs(ny));
    // Underside (bottom half) darken for bright silhouettes only.
    const shade = key === 'bright' ? 1 - 0.22 * smoothstep(0.0, 1.0, ny) : 1;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const nx = (x / (w - 1)) * 2 - 1;
      const winX = 1 - smoothstep(0.62, 0.98, Math.abs(nx));
      data[i + 3] = Math.round(data[i + 3]! * winX * winY);
      if (shade !== 1) {
        data[i] = Math.round(data[i]! * shade);
        data[i + 1] = Math.round(data[i + 1]! * shade);
        data[i + 2] = Math.round(data[i + 2]! * shade);
      }
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

/** Pick a variant matching `key` if any were baked, else any variant. */
function pickVariant(variants: CloudVariant[], key: 'bright' | 'dark'): CloudVariant {
  let matchCount = 0;
  for (const v of variants) if (v.key === key) matchCount++;
  if (matchCount === 0) return variants[(Math.random() * variants.length) | 0]!;
  let pick = (Math.random() * matchCount) | 0;
  for (const v of variants) {
    if (v.key !== key) continue;
    if (pick === 0) return v;
    pick--;
  }
  return variants[0]!;
}

function pickCloudCount(max?: number): number {
  const cap = max ?? 46;
  if (typeof navigator === 'undefined') return Math.min(24, cap);
  const isMobile =
    /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints ?? 0) > 1;
  if (isMobile) return Math.min(16, cap);
  const cores = navigator.hardwareConcurrency ?? 4;
  if (cores >= 8) return Math.min(46, cap);
  return Math.min(30, cap);
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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
