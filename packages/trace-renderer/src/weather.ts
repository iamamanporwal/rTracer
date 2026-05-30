import * as THREE from 'three';
import { createAnimeSky, type SkyHandle, type SkyTint } from './sky';
import { createRain, type RainHandle } from './rain';
import type { SceneBundle } from './scene';

/**
 * Weather system per blueprint §14 + the anime-sky / rain addition.
 *
 * Consolidates sky + rain + lighting under a single seam so the session can
 * cycle presets atomically and push a single `wetness` value to physics.
 * Presets ship lighting *and* sky tint *and* rain intensity together; nothing
 * downstream gets to see them out of sync.
 *
 * - **Apply** is allocation-light (a couple scratch colors); fine for a
 *   key-press handler, not the render hot path.
 * - **Update** is the per-frame seam: it advances sky/rain time and anchors
 *   the rain field to the camera. Both subsystems are GPU-driven, so this is
 *   uniform-only work — basically free on mobile.
 * - **Wetness** is exposed for the gameplay layer to multiply tire grip live
 *   without mutating the zone's authoritative physics profile (§6.3).
 */
export type WeatherId = 'clear' | 'overcast' | 'golden' | 'night' | 'storm';

export type WeatherPreset = {
  id: WeatherId;
  /** Short label for the HUD. */
  label: string;
  /** Sky zenith (top of dome). */
  skyTop: `#${string}`;
  /** Sky horizon. */
  skyHorizon: `#${string}`;
  /** Stylized cloud tint — gray for rain, golden for sunset. */
  cloudColor: `#${string}`;
  /** 0..1 — fraction of sky covered. */
  cloudCoverage: number;
  /** 0..1 — rain particle intensity. Also drives `wetness` (tire-grip cut). */
  rainIntensity: number;
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

/** Ordered cycle. The first entry matches `createScene` defaults. */
export const WEATHER_PRESETS: readonly WeatherPreset[] = [
  {
    id: 'clear',
    label: 'Clear',
    // Anime-saturated: deep zenith blue, still-blue horizon. Horizon stays
    // saturated enough that chase-cam framing reads as sky, not fog.
    skyTop: '#2a8cff',
    skyHorizon: '#9fd5ff',
    cloudColor: '#ffffff',
    cloudCoverage: 0.32,
    rainIntensity: 0,
    sunColor: '#fff4e0',
    sunIntensity: 2.2,
    sunDirection: [-0.6, 1, 0.4],
    ambientSky: '#7ab0d8',
    ambientGround: '#3a2a1a',
    ambientIntensity: 0.55,
    fogColor: '#bfe5ff',
    fogNear: 260,
    fogFar: 1200,
  },
  {
    id: 'overcast',
    label: 'Overcast',
    skyTop: '#8a96a3',
    skyHorizon: '#c3c8cd',
    cloudColor: '#c5cad0',
    cloudCoverage: 0.85,
    rainIntensity: 0,
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
    skyTop: '#3a6fc8',
    skyHorizon: '#ff9b4a',
    cloudColor: '#ffc070',
    cloudCoverage: 0.42,
    rainIntensity: 0,
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
    cloudColor: '#3b4666',
    cloudCoverage: 0.5,
    rainIntensity: 0,
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
    cloudColor: '#3a4048',
    cloudCoverage: 0.95,
    rainIntensity: 1.0,
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

export type CreateWeatherSystemOptions = {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  ambient: THREE.HemisphereLight;
  /** Hard cap on rain particles. Defaults to a device-aware value. */
  maxRainParticles?: number;
  /** Starting preset index. Defaults to 0 (Clear). */
  initialIndex?: number;
};

export type WeatherSystem = {
  readonly presets: readonly WeatherPreset[];
  readonly current: WeatherPreset;
  /** 0..1 — current rain saturation. Pipe this to vehicle grip each frame. */
  readonly wetness: number;
  /** Apply a preset (object or index in `presets`). Atomic across subsystems. */
  applyPreset(preset: WeatherPreset | number): void;
  /** Per-frame animation. `cameraPos` anchors rain to the player. */
  update(dtSeconds: number, cameraPos: { x: number; y: number; z: number }): void;
  dispose(): void;
};

/**
 * Build the weather system. Adds the sky dome + rain points to `scene` and
 * holds refs to `sun` / `ambient` so {@link WeatherSystem.applyPreset} can
 * retarget lighting in one call.
 */
export function createWeatherSystem(opts: CreateWeatherSystemOptions): WeatherSystem {
  const { scene, sun, ambient, maxRainParticles, initialIndex = 0 } = opts;

  const sky: SkyHandle = createAnimeSky(scene);
  const rain: RainHandle = createRain(scene, { maxParticles: maxRainParticles });

  // Reused scratch buffers for `applyPreset` — alloc-light.
  const tint: SkyTint = {
    zenith: '#000000',
    horizon: '#000000',
    cloud: '#000000',
    coverage: 0,
  };

  let current: WeatherPreset = WEATHER_PRESETS[clampIndex(initialIndex)]!;

  function applyPreset(p: WeatherPreset | number): void {
    const next =
      typeof p === 'number' ? WEATHER_PRESETS[clampIndex(p)]! : p;
    current = next;

    // Lighting.
    sun.color.set(next.sunColor);
    sun.intensity = next.sunIntensity;
    sun.position
      .set(next.sunDirection[0], next.sunDirection[1], next.sunDirection[2])
      .normalize()
      .multiplyScalar(100);
    ambient.color.set(next.ambientSky);
    ambient.groundColor.set(next.ambientGround);
    ambient.intensity = next.ambientIntensity;

    // Fog (the dome ignores fog, but ground/objects do).
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.color.set(next.fogColor);
      scene.fog.near = next.fogNear;
      scene.fog.far = next.fogFar;
    }
    // Background is hidden behind the dome; setting it to the horizon keeps
    // canvas-clear coherent on the one frame before the dome paints.
    if (scene.background instanceof THREE.Color) scene.background.set(next.skyHorizon);
    else scene.background = new THREE.Color(next.skyHorizon);

    // Sky shader uniforms.
    tint.zenith = next.skyTop;
    tint.horizon = next.skyHorizon;
    tint.cloud = next.cloudColor;
    tint.coverage = next.cloudCoverage;
    sky.setTint(tint);

    // Rain.
    rain.setIntensity(next.rainIntensity);
  }

  // Apply initial state.
  applyPreset(current);

  return {
    presets: WEATHER_PRESETS,
    get current(): WeatherPreset {
      return current;
    },
    get wetness(): number {
      return current.rainIntensity;
    },
    applyPreset,
    update(dt, cameraPos) {
      // Anchor sky + rain to the camera each frame so an "infinite sky" reads
      // without clipping and the rain field always wraps the player.
      sky.setCameraAnchor(cameraPos.x, cameraPos.y, cameraPos.z);
      sky.update(dt);
      rain.setCameraAnchor(cameraPos.x, cameraPos.z);
      rain.update(dt);
    },
    dispose() {
      sky.dispose();
      rain.dispose();
    },
  };
}

/**
 * Convenience back-compat helper for callers that just want to retarget the
 * lighting on a SceneBundle without owning a full WeatherSystem (e.g. tests).
 * Prefer {@link createWeatherSystem} in the runtime.
 */
export function applyWeather(bundle: SceneBundle, preset: WeatherPreset): void {
  bundle.sun.color.set(preset.sunColor);
  bundle.sun.intensity = preset.sunIntensity;
  bundle.sun.position
    .set(preset.sunDirection[0], preset.sunDirection[1], preset.sunDirection[2])
    .normalize()
    .multiplyScalar(100);
  bundle.ambient.color.set(preset.ambientSky);
  bundle.ambient.groundColor.set(preset.ambientGround);
  bundle.ambient.intensity = preset.ambientIntensity;
  if (bundle.scene.fog instanceof THREE.Fog) {
    bundle.scene.fog.color.set(preset.fogColor);
    bundle.scene.fog.near = preset.fogNear;
    bundle.scene.fog.far = preset.fogFar;
  }
  if (bundle.scene.background instanceof THREE.Color) {
    bundle.scene.background.set(preset.skyHorizon);
  } else {
    bundle.scene.background = new THREE.Color(preset.skyHorizon);
  }
}

function clampIndex(i: number): number {
  const len = WEATHER_PRESETS.length;
  return ((i % len) + len) % len;
}
