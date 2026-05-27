import * as THREE from 'three';

/**
 * Scene factory per blueprint §14.1.
 *
 * Phase 1 W2 ships:
 *   - flat-color sky (gradient bg via Scene.background)
 *   - one sun (directional) with shadow
 *   - hemispheric ambient
 *
 * HDR skybox + environment map land at W4 when the first real zone bundle
 * arrives. The scene-construction API is stable across that change.
 */

export type SceneBundle = {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  ambient: THREE.HemisphereLight;
  /** Dispose every owned object — call from session teardown. */
  dispose(): void;
};

export type CreateSceneOptions = {
  /** Sky top color. */
  skyTop?: `#${string}`;
  /** Sky horizon color. */
  skyHorizon?: `#${string}`;
  /** Sun color. */
  sunColor?: `#${string}`;
  /** Sun direction (will be normalized). */
  sunDirection?: THREE.Vector3;
  /** Sun intensity. */
  sunIntensity?: number;
};

export function createScene(options: CreateSceneOptions = {}): SceneBundle {
  const scene = new THREE.Scene();

  const skyTop = new THREE.Color(options.skyTop ?? '#7ab0d8');
  const skyHorizon = new THREE.Color(options.skyHorizon ?? '#cfd9e3');
  scene.background = makeGradientBackground(skyTop, skyHorizon);
  scene.fog = new THREE.Fog(skyHorizon, 200, 900);

  const ambient = new THREE.HemisphereLight(skyTop.getHex(), 0x3a2a1a, 0.55);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(
    new THREE.Color(options.sunColor ?? '#fff4e0'),
    options.sunIntensity ?? 2.2,
  );
  const dir = options.sunDirection?.clone().normalize() ?? new THREE.Vector3(-0.6, 1, 0.4).normalize();
  sun.position.copy(dir).multiplyScalar(100);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40;
  sun.shadow.camera.bottom = -40;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 200;
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  scene.add(sun.target);

  return {
    scene,
    sun,
    ambient,
    dispose() {
      scene.background = null;
      scene.fog = null;
      scene.clear();
      sun.shadow.map?.dispose();
    },
  };
}

/**
 * A lighting / atmosphere condition the player cycles at runtime (press Y).
 *
 * Phase 1 W3 ships the *lighting* half — each preset retargets the sun, the
 * hemispheric ambient, the sky background, and the fog. Precipitation and its
 * physics consequences (rain → lower grip, ice → much lower, wind → lateral
 * force) are future work; the `id` here is the stable seam they will extend, so
 * a `snow`/`drift` physics profile can be paired with the matching condition.
 */
export type WeatherId = 'clear' | 'overcast' | 'golden' | 'night' | 'storm';

export type WeatherPreset = {
  id: WeatherId;
  /** Short label for the HUD. */
  label: string;
  skyTop: `#${string}`;
  skyHorizon: `#${string}`;
  sunColor: `#${string}`;
  sunIntensity: number;
  /** Sun direction before normalization; a low vector reads as a low sun. */
  sunDirection: [number, number, number];
  ambientSky: `#${string}`;
  ambientGround: `#${string}`;
  ambientIntensity: number;
  fogColor: `#${string}`;
  fogNear: number;
  fogFar: number;
};

/** Ordered cycle. The first entry matches {@link createScene}'s defaults. */
export const WEATHER_PRESETS: readonly WeatherPreset[] = [
  {
    id: 'clear',
    label: 'Clear',
    skyTop: '#7ab0d8',
    skyHorizon: '#cfd9e3',
    sunColor: '#fff4e0',
    sunIntensity: 2.2,
    sunDirection: [-0.6, 1, 0.4],
    ambientSky: '#7ab0d8',
    ambientGround: '#3a2a1a',
    ambientIntensity: 0.55,
    fogColor: '#cfd9e3',
    fogNear: 200,
    fogFar: 900,
  },
  {
    id: 'overcast',
    label: 'Overcast',
    skyTop: '#9aa3ad',
    skyHorizon: '#c3c8cd',
    sunColor: '#dfe4ea',
    sunIntensity: 0.9,
    sunDirection: [-0.3, 1, 0.2],
    ambientSky: '#b3bcc4',
    ambientGround: '#4a4640',
    ambientIntensity: 0.95,
    fogColor: '#b9bec4',
    fogNear: 90,
    fogFar: 520,
  },
  {
    id: 'golden',
    label: 'Golden Hour',
    skyTop: '#3f5e84',
    skyHorizon: '#f0a860',
    sunColor: '#ff9a48',
    sunIntensity: 2.7,
    sunDirection: [-0.92, 0.22, 0.32],
    ambientSky: '#caa07a',
    ambientGround: '#2a1d12',
    ambientIntensity: 0.5,
    fogColor: '#e0996a',
    fogNear: 140,
    fogFar: 760,
  },
  {
    id: 'night',
    label: 'Night',
    skyTop: '#070b16',
    skyHorizon: '#16213a',
    sunColor: '#aebcff',
    sunIntensity: 0.5,
    sunDirection: [-0.4, 0.9, -0.3],
    ambientSky: '#26324d',
    ambientGround: '#0a0c12',
    ambientIntensity: 0.3,
    fogColor: '#0d1424',
    fogNear: 70,
    fogFar: 480,
  },
  {
    id: 'storm',
    label: 'Storm',
    skyTop: '#2a2f37',
    skyHorizon: '#4b525b',
    sunColor: '#8f9aa8',
    sunIntensity: 0.6,
    sunDirection: [-0.5, 0.85, 0.15],
    ambientSky: '#525a64',
    ambientGround: '#1a1d22',
    ambientIntensity: 0.6,
    fogColor: '#3c424b',
    fogNear: 50,
    fogFar: 360,
  },
];

/**
 * Retarget an existing {@link SceneBundle}'s lighting to a weather preset.
 * Mutates in place (no re-creation) and allocates only a couple of scratch
 * colors — fine for a key-press handler, not the render hot path.
 */
export function applyWeather(bundle: SceneBundle, preset: WeatherPreset): void {
  const skyTop = new THREE.Color(preset.skyTop);
  const mid = skyTop.clone().lerp(new THREE.Color(preset.skyHorizon), 0.35);
  if (bundle.scene.background instanceof THREE.Color) bundle.scene.background.copy(mid);
  else bundle.scene.background = mid;

  if (bundle.scene.fog instanceof THREE.Fog) {
    bundle.scene.fog.color.set(preset.fogColor);
    bundle.scene.fog.near = preset.fogNear;
    bundle.scene.fog.far = preset.fogFar;
  }

  bundle.sun.color.set(preset.sunColor);
  bundle.sun.intensity = preset.sunIntensity;
  bundle.sun.position
    .set(preset.sunDirection[0], preset.sunDirection[1], preset.sunDirection[2])
    .normalize()
    .multiplyScalar(100);

  bundle.ambient.color.set(preset.ambientSky);
  bundle.ambient.groundColor.set(preset.ambientGround);
  bundle.ambient.intensity = preset.ambientIntensity;
}

/**
 * Build a vertical-gradient sky as a small cube texture. Cheap, no shaders, no
 * HDR — exactly what blueprint §14.1 calls for as a stand-in until W4.
 */
function makeGradientBackground(top: THREE.Color, horizon: THREE.Color): THREE.Color {
  // A single solid background color (mid of top and horizon) is good enough as
  // a stand-in; Three's `Scene.background` accepts a Color directly. A real
  // gradient sky lands with the HDR skybox in W4.
  const mid = top.clone().lerp(horizon, 0.35);
  return mid;
}

/**
 * Renderer factory. WebGL2 per §3.1. Returns a configured `WebGLRenderer`
 * already bound to the supplied canvas.
 */
export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}
