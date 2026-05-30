import * as THREE from 'three';

/**
 * Anime-stylized sky — bright saturated gradient + soft puffy clouds.
 *
 * Implemented as a large inverted icosahedron rendered with a custom shader.
 * One draw call, two texture lookups per fragment, ~640 verts — basically free
 * even on mobile. Tone-mapping and fog are disabled on the sky material so the
 * saturated palette survives ACES (clouds stay punchy in golden hour, not
 * washed out into beige). Render order is forced to `-1` so the dome paints
 * behind everything.
 *
 * Clouds are a procedurally-generated `CanvasTexture` of soft white blobs,
 * sampled twice at different scales with opposite scroll directions — gives
 * believable parallax for free. Cloud color/coverage are uniforms so the
 * weather system can tint them gray for rain or golden for sunset live.
 */

// Radius is well within the chase camera's far plane (2000m) so frustum
// clipping never eats the dome. Since `setCameraAnchor` re-centers it on the
// camera every frame, any "infinite sky" feel is preserved regardless of where
// the car drives.
const SKY_RADIUS = 1200;
const SKY_DETAIL = 3;

export type SkyTint = {
  zenith: THREE.ColorRepresentation;
  horizon: THREE.ColorRepresentation;
  cloud: THREE.ColorRepresentation;
  /** 0..1 — fraction of the sky covered by clouds. */
  coverage: number;
};

export type SkyHandle = {
  /** Root mesh (added to the scene by this factory). */
  readonly mesh: THREE.Mesh;
  /** Tween the sky/cloud colors to a new tint. */
  setTint(tint: SkyTint): void;
  /**
   * Re-center the dome on the camera each frame so an "infinite sky" reads
   * without clipping at the camera's far plane no matter where the car drives.
   */
  setCameraAnchor(x: number, y: number, z: number): void;
  /** Advance the cloud-drift time. `dt` in seconds. */
  update(dt: number): void;
  dispose(): void;
};

export function createAnimeSky(scene: THREE.Scene): SkyHandle {
  const cloudTex = createCloudTexture();

  const uniforms: Record<string, THREE.IUniform> = {
    uZenith: { value: new THREE.Color('#5fb6ff') },
    uHorizon: { value: new THREE.Color('#cfeeff') },
    uCloudColor: { value: new THREE.Color('#ffffff') },
    uCloudCoverage: { value: 0.35 },
    uCloudTex: { value: cloudTex },
    uTime: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: false,
  });

  const geometry = new THREE.IcosahedronGeometry(SKY_RADIUS, SKY_DETAIL);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'anime-sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  scene.add(mesh);

  return {
    mesh,
    setTint(tint) {
      (uniforms.uZenith!.value as THREE.Color).set(tint.zenith);
      (uniforms.uHorizon!.value as THREE.Color).set(tint.horizon);
      (uniforms.uCloudColor!.value as THREE.Color).set(tint.cloud);
      uniforms.uCloudCoverage!.value = clamp01(tint.coverage);
    },
    setCameraAnchor(x, y, z) {
      mesh.position.set(x, y, z);
    },
    update(dt) {
      uniforms.uTime!.value += dt;
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
      cloudTex.dispose();
    },
  };
}

// ── Shaders ────────────────────────────────────────────────────────────────

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    // Sky direction = normalized object-space position (dome is centered at origin).
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision mediump float;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uCloudColor;
  uniform float uCloudCoverage;
  uniform float uTime;
  uniform sampler2D uCloudTex;
  varying vec3 vDir;

  void main() {
    vec3 dir = normalize(vDir);
    float up = clamp(dir.y, 0.0, 1.0);

    // Vertical sky gradient — smoothstep ramps fast so the saturated zenith
    // dominates most of the visible sky (chase cams mostly see the lower half).
    vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.32, up));

    // Spherical projection for cloud UVs.
    float az = atan(dir.z, dir.x) * 0.15915494; // / (2π)
    vec2 uv = vec2(az + 0.5, up);

    // Two scrolling layers at different scales → cheap parallax. R channel only.
    float c1 = texture2D(uCloudTex, uv * vec2(2.2, 1.0) + vec2(uTime * 0.003, 0.0)).r;
    float c2 = texture2D(uCloudTex, uv * vec2(3.6, 1.6) + vec2(uTime * -0.005, 0.07)).r;
    float clouds = max(c1, c2 * 0.85);

    // Coverage maps to threshold (low coverage = high threshold = few clouds).
    // Tuned so the default coverage produces a clearly visible scattered field.
    float thresh = mix(0.62, 0.12, clamp(uCloudCoverage, 0.0, 1.0));
    // Tight band → crisp anime cloud edges (soft, not foggy).
    float mask = smoothstep(thresh, thresh + 0.08, clouds);

    // Subtle taper at the very bottom — keep clouds visible at chase-cam look
    // angles (the camera mostly sees the lower hemisphere of the sky).
    mask *= smoothstep(-0.02, 0.06, up);

    vec3 col = mix(sky, uCloudColor, mask);
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ── Cloud texture (procedural, generated once at init) ─────────────────────

/**
 * Generate a 256×128 soft-blob cloud texture: black background with overlapping
 * Gaussian splats. Sampled twice at different scales by the sky shader for a
 * parallaxed anime-cloud look. Texture is RGBA but only the R channel is read.
 */
function createCloudTexture(): THREE.Texture {
  if (typeof document === 'undefined') {
    // Headless / SSR — return a 1×1 transparent texture as a harmless fallback.
    const data = new Uint8Array([0, 0, 0, 0]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    return tex;
  }
  const w = 256;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    const data = new Uint8Array([0, 0, 0, 0]);
    return new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter';

  // Sparse soft blobs — the texture must be MOSTLY dark with rare bright peaks,
  // because the sky shader treats "bright pixel" as "this is a cloud". 50 blobs
  // at radius up to 52 px overlapped so heavily that the texture was nearly
  // saturated, which flipped the look: sky reads as overcast white with rare
  // dark holes (the inverse of an anime "clear sky with a few puffs"). 16 small
  // blobs gives a histogram with a clear dark majority + isolated bright peaks.
  const blobs = 16;
  for (let i = 0; i < blobs; i++) {
    const x = Math.random() * w;
    const y = 0.18 * h + Math.pow(Math.random(), 1.3) * h * 0.82;
    const r = 10 + Math.random() * 18;
    const alpha = 0.35 + Math.random() * 0.45;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${alpha})`);
    g.addColorStop(0.55, `rgba(255,255,255,${alpha * 0.35})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // Mirror near the seam so wrapping doesn't show a hard edge at azimuth 0.
    if (x < r) {
      ctx.beginPath();
      ctx.arc(x + w, y, r, 0, Math.PI * 2);
      ctx.fill();
    } else if (x > w - r) {
      ctx.beginPath();
      ctx.arc(x - w, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace; // we read it as a luminance mask, not a color
  tex.anisotropy = 1; // mobile-cheap
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
