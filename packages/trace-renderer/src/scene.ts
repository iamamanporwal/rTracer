import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

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
 * Build a vertical-gradient sky as a small cube texture. Cheap, no shaders, no
 * HDR — kept as a stand-in for the one frame before the anime sky dome
 * (`createWeatherSystem`) paints over it.
 */
function makeGradientBackground(top: THREE.Color, horizon: THREE.Color): THREE.Color {
  const mid = top.clone().lerp(horizon, 0.35);
  return mid;
}

export type RendererOptions = {
  /**
   * Upper bound on the device-pixel-ratio. Defaults to `2` (desktop / retina).
   * Mobile GPUs choke filling a 3× framebuffer, so the web app passes ~1.5 on
   * phones — the single biggest fill-rate win without touching the look.
   */
  maxPixelRatio?: number;
  /**
   * Trade shadow softness for speed on weak GPUs. When set, antialiasing is
   * dropped (the pixel-ratio cap already softens edges) and shadows use the
   * cheaper non-PCF filter. Defaults to `false` — desktop is unchanged.
   */
  lowPower?: boolean;
};

/**
 * Renderer factory. WebGL2 per §3.1. Returns a configured `WebGLRenderer`
 * already bound to the supplied canvas. With no options the behaviour is
 * identical to before (DPR ≤ 2, MSAA on, soft shadows).
 */
export function createRenderer(
  canvas: HTMLCanvasElement,
  options: RendererOptions = {},
): THREE.WebGLRenderer {
  const { maxPixelRatio = 2, lowPower = false } = options;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !lowPower,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = lowPower ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  return renderer;
}

export type EnvironmentMap = {
  texture: THREE.Texture;
  dispose(): void;
};

/**
 * Pre-filtered image-based lighting from Three's neutral {@link RoomEnvironment}.
 *
 * Real car paint, chrome, and glass are physically-based and look flat under
 * direct lights alone — they need an environment to reflect. We bake the room
 * to a PMREM once at session start and hand the texture to `Scene.environment`
 * (and to GLB materials' `envMap`). Cheap: generated a single time, not per
 * frame. A real HDRI skybox replaces this with the zone art (W4).
 */
export function createEnvironmentMap(renderer: THREE.WebGLRenderer): EnvironmentMap {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = new RoomEnvironment();
  const target = pmrem.fromScene(env, 0.04);
  pmrem.dispose();
  // RoomEnvironment holds its own geometries/materials; free them now that the
  // PMREM is baked.
  env.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const m = mesh.material;
    if (Array.isArray(m)) for (const mm of m) mm.dispose();
    else m.dispose();
  });
  return {
    texture: target.texture,
    dispose() {
      target.dispose();
    },
  };
}
