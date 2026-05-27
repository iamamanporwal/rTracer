import * as THREE from 'three';
import {
  createEventBus,
  type EventBus,
  type VehicleManifest,
  type ZoneManifest,
} from '@trace/core';
import {
  createGround,
  createPhysicsWorld,
  createVehicle,
  initRapier,
  PHYSICS_PROFILES,
  type PhysicsWorld,
  type VehicleHandle,
} from '@trace/physics';
import {
  applyWeather,
  CAMERA_MODES,
  createCameraRig,
  createGroundVisual,
  createRenderer,
  createScene,
  createSurfaceMaterials,
  createVehicleVisual,
  disposeSurfaceMaterials,
  WEATHER_PRESETS,
  type CameraRig,
  type GroundVisual,
  type SceneBundle,
  type SurfaceMaterials,
  type VehicleVisual,
} from '@trace/renderer';
import { createKeyboardInput, type InputDriver } from './input';
import { createCameraInput, type CameraInputDriver } from './camera-input';
import { createLoop, type Loop } from './loop';

/**
 * Zone session — one canvas-bound runtime instance per `/play/$zoneId` mount.
 *
 * Owns the lifecycle of: Rapier world, Three.js scene, vehicle physics, vehicle
 * visual, ground, camera, keyboard input, the main loop. Disposing the session
 * frees every Rapier and Three resource — the React effect cleanup is the only
 * caller.
 */

export type SessionStats = {
  speedMs: number;
  fps: number;
};

export type SessionInit = {
  canvas: HTMLCanvasElement;
  zoneManifest: ZoneManifest;
  vehicleManifest: VehicleManifest;
  liveryColor: `#${string}`;
  /** Called every frame with a fresh stats snapshot. May be undefined for headless setup. */
  onStats?: (stats: SessionStats) => void;
  /** Called with the current weather/lighting label on init and each Y-key cycle. */
  onWeather?: (label: string) => void;
  /** Called with the current camera-mode label on init and each C-key cycle. */
  onCameraMode?: (label: string) => void;
};

export type ZoneSession = {
  readonly bus: EventBus;
  dispose(): void;
};

export async function startZoneSession(init: SessionInit): Promise<ZoneSession> {
  const { canvas, zoneManifest, vehicleManifest, liveryColor, onStats, onWeather, onCameraMode } =
    init;

  await initRapier();

  const bus = createEventBus();
  const physics: PhysicsWorld = createPhysicsWorld();
  const profile = PHYSICS_PROFILES[zoneManifest.physicsProfile];

  // Ground (W4 will swap this for the zone's collider asset).
  createGround(physics.world, { tag: 'tarmac' });

  // Vehicle.
  const spawn = pickSpawn(zoneManifest);
  const vehicle: VehicleHandle = createVehicle(physics.world, {
    manifest: vehicleManifest,
    profile,
    spawn,
  });

  // Renderer + scene.
  const renderer = createRenderer(canvas);
  const sceneBundle: SceneBundle = createScene();
  const materials: SurfaceMaterials = createSurfaceMaterials();
  const ground: GroundVisual = createGroundVisual(materials);
  sceneBundle.scene.add(ground.group);

  const vehicleVisual: VehicleVisual = createVehicleVisual({
    manifest: vehicleManifest,
    liveryColor,
  });
  sceneBundle.scene.add(vehicleVisual.group);

  // Weather / lighting conditions — press Y to cycle. Future rain/ice/wind and
  // their physics hooks extend WEATHER_PRESETS (see @trace/renderer scene.ts).
  let weatherIndex = 0;
  const setWeather = (index: number): void => {
    weatherIndex = ((index % WEATHER_PRESETS.length) + WEATHER_PRESETS.length) % WEATHER_PRESETS.length;
    const preset = WEATHER_PRESETS[weatherIndex];
    if (!preset) return;
    applyWeather(sceneBundle, preset);
    onWeather?.(preset.label);
  };
  setWeather(0);
  const onWeatherKey = (e: KeyboardEvent): void => {
    if (e.code === 'KeyY' && !e.repeat) setWeather(weatherIndex + 1);
  };
  window.addEventListener('keydown', onWeatherKey);

  // Camera.
  const rig: CameraRig = createCameraRig({ seat: vehicleManifest.rig.seat });
  const initialPose = vehicle.readSnapshot();
  rig.snap(
    new THREE.Vector3(initialPose.position.x, initialPose.position.y, initialPose.position.z),
    new THREE.Quaternion(
      initialPose.rotation.x,
      initialPose.rotation.y,
      initialPose.rotation.z,
      initialPose.rotation.w,
    ),
  );

  // Camera modes — press C to cycle Chase → Wide → First-person.
  let cameraModeIndex = 0;
  const setCameraMode = (index: number): void => {
    cameraModeIndex = ((index % CAMERA_MODES.length) + CAMERA_MODES.length) % CAMERA_MODES.length;
    const m = CAMERA_MODES[cameraModeIndex];
    if (!m) return;
    rig.setMode(m.id);
    onCameraMode?.(m.label);
  };
  setCameraMode(0);
  const onCameraKey = (e: KeyboardEvent): void => {
    if (e.code === 'KeyC' && !e.repeat) setCameraMode(cameraModeIndex + 1);
  };
  window.addEventListener('keydown', onCameraKey);

  // Input.
  const input: InputDriver = createKeyboardInput();
  const cameraInput: CameraInputDriver = createCameraInput(canvas);

  // Canvas sizing. `clientWidth/Height` can be 0 mid-mount, so prefer the parent then the window.
  const resize = (): void => {
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const w = cw > 0 ? cw : (canvas.parentElement?.clientWidth ?? window.innerWidth);
    const h = ch > 0 ? ch : (canvas.parentElement?.clientHeight ?? window.innerHeight);
    renderer.setSize(w, h, false);
    rig.resize(w / Math.max(h, 1));
  };
  resize();
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);

  // Scratch buffers for camera follow — alloc-free per frame.
  const camTargetPos = new THREE.Vector3();
  const camTargetQuat = new THREE.Quaternion();

  // FPS counter — exponential moving average over last frame durations.
  let fps = 60;
  let lastFrameTs = performance.now();

  const loop: Loop = createLoop({
    step(dt) {
      const ctrl = input.sample(dt);
      if (ctrl.reset) vehicle.reset();
      vehicle.update(ctrl, dt);
      physics.step();
    },
    render(_alpha) {
      const now = performance.now();
      const elapsed = (now - lastFrameTs) / 1000;
      lastFrameTs = now;
      const instantaneous = elapsed > 0 ? 1 / elapsed : fps;
      fps = fps * 0.92 + instantaneous * 0.08;

      const snap = vehicle.readSnapshot();
      vehicleVisual.applySnapshot(snap);

      camTargetPos.set(snap.position.x, snap.position.y, snap.position.z);
      camTargetQuat.set(snap.rotation.x, snap.rotation.y, snap.rotation.z, snap.rotation.w);
      rig.follow(camTargetPos, camTargetQuat, elapsed, cameraInput.sample(elapsed));

      renderer.render(sceneBundle.scene, rig.camera);

      if (onStats) onStats({ speedMs: Math.abs(snap.speed), fps });
    },
  });
  loop.start();

  return {
    bus,
    dispose() {
      loop.stop();
      resizeObserver.disconnect();
      window.removeEventListener('keydown', onWeatherKey);
      window.removeEventListener('keydown', onCameraKey);
      input.dispose();
      cameraInput.dispose();
      vehicleVisual.dispose();
      ground.dispose();
      disposeSurfaceMaterials(materials);
      sceneBundle.dispose();
      renderer.dispose();
      vehicle.dispose();
      physics.dispose();
      bus.clear();
    },
  };
}

function pickSpawn(zone: ZoneManifest): { position: [number, number, number]; rotation: [number, number, number, number] } {
  const first = zone.spawnPoints[0];
  if (!first) throw new Error(`zone ${zone.id} has no spawn points`);
  return { position: first.position, rotation: first.rotation };
}
