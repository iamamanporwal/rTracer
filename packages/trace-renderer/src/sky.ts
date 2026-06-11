import * as THREE from 'three';

/**
 * Dramatic stylized sky dome — a rich vertical gradient with a real sun (disc +
 * atmospheric halo) and a night star field. One draw call, a handful of cheap
 * fragment ops, ~640 verts — basically free on mobile.
 *
 * Clouds used to be painted here by spherically projecting a blob texture and
 * thresholding it; that sliced clouds along the horizon and pinched them at the
 * zenith (the "cut" bug). Clouds now live in {@link createCloudField} as real
 * billboards, so this dome owns only the sky itself: gradient, sun, stars.
 *
 * Tone-mapping and fog are disabled on the dome so the saturated palette and the
 * sun bloom survive ACES (golden hour stays punchy, not washed to beige). Render
 * order is forced to `-1` so the dome paints behind everything, and it doesn't
 * write depth — so the cloud billboards (and the world) composite over it.
 */

// Radius is well within the chase camera's far plane (2000m) so frustum clipping
// never eats the dome. `setCameraAnchor` re-centres it on the camera each frame,
// so the "infinite sky" feel holds wherever the car drives.
const SKY_RADIUS = 1200;
const SKY_DETAIL = 3;

export type SkyTint = {
  /** Top of the dome. */
  zenith: THREE.ColorRepresentation;
  /** Mid band — the second gradient stop above the horizon. */
  mid: THREE.ColorRepresentation;
  /** Horizon band. */
  horizon: THREE.ColorRepresentation;
  /** Sun disc + core colour. */
  sunColor: THREE.ColorRepresentation;
  /** Broad atmospheric halo colour around the sun. */
  sunGlow: THREE.ColorRepresentation;
  /** 0..~1.5 — intensity of the halo. 0 hides the sun glow (overcast/storm). */
  sunGlowStrength: number;
  /** Direction toward the sun; normalized in-shader. Match the directional light. */
  sunDir: [number, number, number];
  /** 0..1 — night star field intensity. 0 on daytime presets. */
  starStrength: number;
};

export type SkyHandle = {
  /** Root mesh (added to the scene by this factory). */
  readonly mesh: THREE.Mesh;
  /** Retarget the sky palette + sun + stars. */
  setTint(tint: SkyTint): void;
  /**
   * Re-centre the dome on the camera each frame so an "infinite sky" reads
   * without clipping at the camera's far plane no matter where the car drives.
   */
  setCameraAnchor(x: number, y: number, z: number): void;
  /** Advance time (drives the subtle star twinkle). `dt` in seconds. */
  update(dt: number): void;
  dispose(): void;
};

export function createAnimeSky(scene: THREE.Scene): SkyHandle {
  const uniforms: Record<string, THREE.IUniform> = {
    uZenith: { value: new THREE.Color('#1e7fff') },
    uMid: { value: new THREE.Color('#5aa6ff') },
    uHorizon: { value: new THREE.Color('#bfe4ff') },
    uSunColor: { value: new THREE.Color('#fff4d6') },
    uSunGlow: { value: new THREE.Color('#ffe9b0') },
    uSunGlowStrength: { value: 0.5 },
    uSunDir: { value: new THREE.Vector3(-0.6, 1, 0.4).normalize() },
    uStarStrength: { value: 0 },
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
  mesh.name = 'sky-dome';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  scene.add(mesh);

  return {
    mesh,
    setTint(tint) {
      (uniforms.uZenith!.value as THREE.Color).set(tint.zenith);
      (uniforms.uMid!.value as THREE.Color).set(tint.mid);
      (uniforms.uHorizon!.value as THREE.Color).set(tint.horizon);
      (uniforms.uSunColor!.value as THREE.Color).set(tint.sunColor);
      (uniforms.uSunGlow!.value as THREE.Color).set(tint.sunGlow);
      uniforms.uSunGlowStrength!.value = Math.max(0, tint.sunGlowStrength);
      (uniforms.uSunDir!.value as THREE.Vector3)
        .set(tint.sunDir[0], tint.sunDir[1], tint.sunDir[2])
        .normalize();
      uniforms.uStarStrength!.value = clamp01(tint.starStrength);
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
    },
  };
}

// ── Shaders ────────────────────────────────────────────────────────────────

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    // Sky direction = normalized object-space position (dome centred at origin).
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision mediump float;
  uniform vec3 uZenith;
  uniform vec3 uMid;
  uniform vec3 uHorizon;
  uniform vec3 uSunColor;
  uniform vec3 uSunGlow;
  uniform float uSunGlowStrength;
  uniform vec3 uSunDir;
  uniform float uStarStrength;
  uniform float uTime;
  varying vec3 vDir;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    vec3 dir = normalize(vDir);
    float up = clamp(dir.y, 0.0, 1.0);

    // Three-stop vertical gradient: horizon → mid → zenith. Two smoothsteps give
    // a luminous band above the horizon that a single ramp can't — the look that
    // sells golden hour and clear-blue depth at chase-cam framing.
    vec3 sky = mix(uHorizon, uMid, smoothstep(0.0, 0.18, up));
    sky = mix(sky, uZenith, smoothstep(0.15, 0.62, up));

    // Sun: a tight bright disc plus a broad halo. The halo rides the gradient
    // additively (so it survives the no-tonemap path) and is biased toward the
    // horizon for that golden-hour bloom. uSunGlowStrength 0 → no sun at all.
    vec3 sd = normalize(uSunDir);
    float sun = max(dot(dir, sd), 0.0);
    float disc = pow(sun, 900.0);
    float halo = pow(sun, 6.0);
    float horizonBias = 1.0 - smoothstep(0.0, 0.5, up);
    sky += uSunGlow * (halo * uSunGlowStrength) * (0.55 + 0.45 * horizonBias);
    sky += uSunColor * disc * 1.6;

    // Stars (night only): a fixed pattern quantized on the view sphere so there's
    // no pole pinch or horizon blow-up, masked to the upper sky, slowly twinkling.
    if (uStarStrength > 0.001) {
      vec3 q = floor(dir * 140.0);
      float s = hash(q.xy + vec2(q.z * 13.1, q.z * 7.7));
      float star = step(0.984, s) * smoothstep(0.02, 0.22, up);
      float tw = 0.55 + 0.45 * sin(uTime * 2.0 + s * 100.0);
      sky += vec3(star * tw * uStarStrength) * vec3(0.9, 0.95, 1.0);
    }

    gl_FragColor = vec4(sky, 1.0);
  }
`;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
