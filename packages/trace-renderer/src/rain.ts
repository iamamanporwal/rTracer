import * as THREE from 'three';

/**
 * Rain particle system — GPU-driven, camera-anchored, mobile-first.
 *
 * The particle base positions are randomized inside a fixed box (width × height
 * × depth meters) at init and never written again. Each render frame only
 * pushes uniforms: time, camera-XZ, intensity. The vertex shader translates the
 * field by the camera-XZ (so rain follows the player) and wraps Y with
 * `time × fallSpeed` — zero per-particle CPU work, one draw call total.
 *
 * Streaks are carved in the fragment shader from `gl_PointCoord` (no texture):
 * a thin vertical strip with a soft taper at the head/tail. Tone-mapping is
 * disabled so the streaks read pure white over any sky tint.
 *
 * Pool size is chosen by device — mobile ≤ 600, mid desktop ≤ 1200, beefier
 * desktop up to 2000. When intensity falls to 0 the group is hidden, dropping
 * cost to literally nothing.
 */

const FIELD_W = 50; // meters across (X)
const FIELD_H = 25; // meters tall (Y wrap window) — small to limit overdraw
const FIELD_D = 50; // meters across (Z)
const FALL_SPEED = 26; // m/s
const TOP_Y = 18; // top of the wrap window in world space (clouds-ish height)

export type RainOptions = {
  /** Hard cap on particles. Defaults to a device-appropriate count. */
  maxParticles?: number;
};

export type RainHandle = {
  readonly points: THREE.Points;
  /** Active particle count this run (post device-scaling). */
  readonly count: number;
  /** 0..1 — particle alpha + visible size. 0 disables the system entirely. */
  setIntensity(intensity: number): void;
  /** Anchor the rain field to a camera position (only XZ is used). */
  setCameraAnchor(x: number, z: number): void;
  /** Advance the rain time. `dt` in seconds. */
  update(dt: number): void;
  dispose(): void;
};

export function createRain(scene: THREE.Scene, options: RainOptions = {}): RainHandle {
  const count = pickParticleCount(options.maxParticles);

  // Base positions inside the field; seeds give per-particle phase offset.
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * FIELD_W;
    positions[i * 3 + 1] = Math.random() * FIELD_H;
    positions[i * 3 + 2] = (Math.random() - 0.5) * FIELD_D;
    seeds[i] = Math.random() * 100;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  // Static bounds — the vertex shader places points dynamically, so frustum
  // culling is disabled on the Points object below.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), FIELD_W);

  const uniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 },
    uCam: { value: new THREE.Vector2(0, 0) },
    uIntensity: { value: 0 },
    uFallSpeed: { value: FALL_SPEED },
    uTopY: { value: TOP_Y },
    uHeight: { value: FIELD_H },
    uPixelRatio: { value: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    toneMapped: false,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'rain';
  points.frustumCulled = false;
  points.visible = false; // start dry
  scene.add(points);

  let lastIntensity = 0;

  return {
    points,
    count,
    setIntensity(intensity) {
      const v = clamp01(intensity);
      uniforms.uIntensity!.value = v;
      // Off entirely when fully dry → zero GPU/CPU work.
      points.visible = v > 0.001;
      lastIntensity = v;
    },
    setCameraAnchor(x, z) {
      const cam = uniforms.uCam!.value as THREE.Vector2;
      cam.x = x;
      cam.y = z;
    },
    update(dt) {
      if (lastIntensity <= 0.001) return;
      uniforms.uTime!.value += dt;
    },
    dispose() {
      points.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}

// ── Device-aware sizing ─────────────────────────────────────────────────────

function pickParticleCount(max?: number): number {
  const cap = max ?? 1500;
  if (typeof navigator === 'undefined') return Math.min(600, cap);
  const isMobile =
    /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints ?? 0) > 1;
  if (isMobile) return Math.min(400, cap);
  const cores = navigator.hardwareConcurrency ?? 4;
  if (cores >= 8) return Math.min(1500, cap);
  return Math.min(900, cap);
}

// ── Shaders ────────────────────────────────────────────────────────────────

const VERT = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  uniform vec2 uCam;        // camera XZ
  uniform float uFallSpeed;
  uniform float uTopY;
  uniform float uHeight;
  uniform float uIntensity;
  uniform float uPixelRatio;
  varying float vAlpha;

  void main() {
    // Wrap Y by time with a per-particle phase. Field is anchored to camera XZ
    // so the rain "follows" the player — no per-frame CPU work. Time adds to
    // the wrap window so the mod result grows over time, and p.y = uTopY - y
    // therefore decreases → drops fall toward the ground.
    float y = mod(position.y + uTime * uFallSpeed + aSeed * 11.0, uHeight);
    vec3 p = vec3(position.x + uCam.x, uTopY - y, position.z + uCam.y);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    // Streak size: thin and short, grows mildly with intensity, shrinks with
    // distance. Clamped tight — bigger sprites cause big overdraw under additive
    // blending which murders mobile fillrate.
    float dist = max(1.0, -mv.z);
    float sz = (5.0 + 9.0 * uIntensity) * (18.0 / dist) * uPixelRatio;
    gl_PointSize = clamp(sz, 3.0, 22.0);

    vAlpha = uIntensity;
  }
`;

const FRAG = /* glsl */ `
  precision mediump float;
  varying float vAlpha;
  void main() {
    vec2 uv = gl_PointCoord;
    // Very thin vertical strip — discard outside it (no texture needed).
    // Tight strip + low alpha keeps overdraw under additive blending mobile-safe.
    float dx = abs(uv.x - 0.5);
    if (dx > 0.06) discard;
    // Soft head/tail taper.
    float dy = abs(uv.y - 0.5) * 2.0;
    float fall = 1.0 - smoothstep(0.6, 1.0, dy);
    // Soft edges within the strip so streaks don't read as hard bars.
    float strip = 1.0 - smoothstep(0.025, 0.06, dx);
    float a = fall * strip * vAlpha * 0.4;
    gl_FragColor = vec4(0.86, 0.92, 1.0, a);
  }
`;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
