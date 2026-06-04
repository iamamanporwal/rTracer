import * as THREE from 'three';
import {
  createEventBus,
  vehicleBundleDir,
  zoneBundleDir,
  type EventBus,
  type VehicleManifest,
  type ZoneManifest,
} from '@trace/core';
import {
  createGround,
  createObstacleField,
  createPhysicsWorld,
  createVehicle,
  createZoneCollider,
  raycastGroundY,
  initRapier,
  PHYSICS_PROFILES,
  type ObstacleField,
  type PhysicsWorld,
  type VehicleHandle,
  type VehicleSnapshot,
} from '@trace/physics';
import {
  CAMERA_MODES,
  createBodyDeformer,
  createCameraRig,
  createEngineAudio,
  createEnvironmentMap,
  createGlbVehicleVisual,
  createGlbZoneVisual,
  createGroundVisual,
  createObstacleVisuals,
  createPhysicsDebug,
  createRenderer,
  createScene,
  createSurfaceMaterials,
  createTireFx,
  createVehicleVisual,
  createWeatherSystem,
  disposeSurfaceMaterials,
  type CameraRig,
  type EngineAudio,
  type EnvironmentMap,
  type GroundVisual,
  type ObstacleVisuals,
  type PhysicsDebug,
  type SceneBundle,
  type BodyDeformer,
  type SurfaceMaterials,
  type TireFx,
  type VehicleVisual,
  type WeatherSystem,
  type ZoneVisual,
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
  position: { x: number; y: number; z: number };
  /** Yaw heading in degrees — 0° = +Z, clockwise positive. Use this to set spawn rotation. */
  headingDeg: number;
};

/** Metres above the raycast-found surface to seat a car in a GLB world — the
 * chassis-centre height. Matches zone_alpha's flat-ground spawn (0.5): low
 * enough that the car barely drops (no settle bounce, no tunnel-prone
 * free-fall), high enough that the wheels' suspension rays reach the ground on
 * the first frame. */
const GLB_SPAWN_CLEARANCE_M = 0.5;

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
  /**
   * Called with the new state whenever the "invisible skeleton" (physics
   * debug overlay) is toggled — either via the O key or the HUD checkbox.
   * Lets the HUD keep its checkbox in sync with the runtime.
   */
  onSkeleton?: (enabled: boolean) => void;
};

export type ZoneSession = {
  readonly bus: EventBus;
  /**
   * Show or hide the physics-debug "invisible skeleton" overlay — colliders,
   * suspension rays, wheel contacts, COM, velocity arrow. Fires {@link
   * SessionInit.onSkeleton} so any external UI stays in sync.
   */
  setSkeleton(enabled: boolean): void;
  dispose(): void;
};

export async function startZoneSession(init: SessionInit): Promise<ZoneSession> {
  const {
    canvas,
    zoneManifest,
    vehicleManifest,
    liveryColor,
    onStats,
    onWeather,
    onCameraMode,
    onSkeleton,
  } = init;

  await initRapier();

  const bus = createEventBus();
  const physics: PhysicsWorld = createPhysicsWorld();
  const profile = PHYSICS_PROFILES[zoneManifest.physicsProfile];

  // Renderer + scene + image-based lighting (so car paint/chrome — and the GLB
  // world's PBR materials — reflect). Built before the world so the GLB loader
  // can apply the environment map to the track's materials.
  const renderer = createRenderer(canvas);
  const sceneBundle: SceneBundle = createScene();
  const environment: EnvironmentMap = createEnvironmentMap(renderer);
  sceneBundle.scene.environment = environment.texture;
  const materials: SurfaceMaterials = createSurfaceMaterials();

  // ── World ────────────────────────────────────────────────────────────────
  // Two paths, chosen by the manifest:
  //   • `world` declared → load a real GLB track and derive one static trimesh
  //     collider from the same geometry (zone_drift and future zones).
  //   • no `world`       → the W2 flat programmer-art ground + obstacle field
  //     (zone_alpha, the demo plane). Fully back-compatible.
  let zoneVisual: ZoneVisual | null = null;
  let groundVisual: GroundVisual | null = null;
  let obstacles: ObstacleField | null = null;
  let obstacleVisuals: ObstacleVisuals | null = null;

  if (zoneManifest.world) {
    const url = `${zoneBundleDir(zoneManifest.id, zoneManifest.version)}/${zoneManifest.world.glb}`;
    zoneVisual = await createGlbZoneVisual({
      url,
      config: zoneManifest.world,
      environment: environment.texture,
    });
    createZoneCollider(physics.world, {
      vertices: zoneVisual.collision.vertices,
      indices: zoneVisual.collision.indices,
      tag: zoneManifest.world.surface,
    });
    sceneBundle.scene.add(zoneVisual.group);
  } else {
    createGround(physics.world, { tag: 'tarmac' });
    // Spawn-area obstacle field — speed bump straight ahead + a few crates.
    obstacles = createObstacleField(physics.world);
    groundVisual = createGroundVisual(materials);
    sceneBundle.scene.add(groundVisual.group);
    // Obstacle visuals mirror the physics field. Initial snapshot positions the
    // meshes; `obstacleVisuals.update` syncs the dynamic crates each render frame.
    obstacleVisuals = createObstacleVisuals(obstacles.readSnapshot());
    sceneBundle.scene.add(obstacleVisuals.group);
  }

  // Vehicle. Spawn XZ + facing come from the manifest. For a GLB world the
  // ground sits at an arbitrary Y (the track origin can be metres below 0), so
  // we raycast down through the freshly-built collider and seat the car just
  // above the real surface — dropping from a fixed height would free-fall fast
  // enough to tunnel through the thin trimesh.
  const spawn = pickSpawn(zoneManifest);
  if (zoneManifest.world) {
    let groundY = raycastGroundY(physics.world, spawn.position[0], spawn.position[2]);

    // If the manifest spawn XZ misses all collision geometry (e.g. a freshly
    // added track whose GLB origin is far from 0,0), fall back to the zone's
    // bounding-box centre.  This guarantees the car lands on SOMETHING instead
    // of free-falling into the void for any map where the spawn hasn't been
    // hand-tuned yet.
    if (groundY == null && zoneVisual != null) {
      const centre = zoneVisual.bounds.getCenter(new THREE.Vector3());
      groundY = raycastGroundY(physics.world, centre.x, centre.z);
      if (groundY != null) {
        spawn.position = [centre.x, groundY + GLB_SPAWN_CLEARANCE_M, centre.z];
      }
    } else if (groundY != null) {
      spawn.position = [spawn.position[0], groundY + GLB_SPAWN_CLEARANCE_M, spawn.position[2]];
    }
  }
  const vehicle: VehicleHandle = createVehicle(physics.world, {
    manifest: vehicleManifest,
    profile,
    spawn,
  });

  // Vehicle visual: a rigged GLB when the manifest declares one, else the
  // procedural demo body. Both honour the same applySnapshot contract.
  let vehicleVisual: VehicleVisual;
  if (vehicleManifest.visual?.format === 'glb' && vehicleManifest.visual.glb) {
    const url = `${vehicleBundleDir(vehicleManifest.id, vehicleManifest.version)}/${vehicleManifest.visual.glb}`;
    vehicleVisual = await createGlbVehicleVisual({
      url,
      manifest: vehicleManifest,
      restHubLocalY: vehicle.restHubLocalY,
      environment: environment.texture,
    });
  } else {
    vehicleVisual = createVehicleVisual({ manifest: vehicleManifest, liveryColor });
  }
  sceneBundle.scene.add(vehicleVisual.group);

  // Body deformation — crumples the car's body mesh on hard contacts. Driven by
  // contact-force impacts harvested from Rapier each step (see `physics.step` /
  // `drainImpacts`), filtered to those involving the chassis body. Null if the
  // visual has no deformable mesh (it never does for the shipped cars).
  const deformer: BodyDeformer | null = createBodyDeformer({ group: vehicleVisual.group });
  const chassisBodyHandle = vehicle.body.handle;

  // Tire ground-contact FX — per-wheel skid marks + shared smoke pool. Reads
  // per-wheel `slip`/`contact` from the physics snapshot each render frame,
  // so handbrake yanks, burnouts, and ABS-locked panic stops all draw through
  // the same seam without the renderer knowing why a tire is sliding.
  const tireFx: TireFx = createTireFx({ wheelCount: vehicle.wheelCount });
  sceneBundle.scene.add(tireFx.group);

  // Physics debug overlay — the "invisible skeleton" that makes the tire and
  // chassis physics visible (colliders, suspension rays, wheel contacts, COM,
  // velocity). Off by default. Toggles from two surfaces:
  //   - O key (legacy keyboard shortcut)
  //   - HUD checkbox via `session.setSkeleton(...)`
  // Either path goes through `setSkeleton`, which fires `onSkeleton` so the
  // React HUD always sees the current state regardless of how it flipped.
  const debug: PhysicsDebug = createPhysicsDebug(sceneBundle.scene);
  const setSkeleton = (on: boolean): void => {
    if (debug.enabled === on) return;
    debug.setEnabled(on);
    onSkeleton?.(on);
  };
  const onDebugKey = (e: KeyboardEvent): void => {
    if (e.code === 'KeyO' && !e.repeat) setSkeleton(!debug.enabled);
  };
  window.addEventListener('keydown', onDebugKey);
  // Emit the initial state so the HUD checkbox starts in sync.
  onSkeleton?.(debug.enabled);

  // Procedural engine audio — resumes on the first user gesture (autoplay).
  const engineAudio: EngineAudio = createEngineAudio(vehicleManifest);
  const resumeAudio = (): void => engineAudio.resume();
  window.addEventListener('pointerdown', resumeAudio);
  window.addEventListener('keydown', resumeAudio);
  engineAudio.resume();

  // Weather system — anime sky + clouds + rain + lighting. One seam owns all of
  // it so a preset change is atomic across sky / rain / lighting. Wetness flows
  // into the car's grip multiplier each render frame so wet roads are slippery
  // without mutating the zone's authoritative physics profile (Blueprint §6.3).
  const weather: WeatherSystem = createWeatherSystem({
    scene: sceneBundle.scene,
    sun: sceneBundle.sun,
    ambient: sceneBundle.ambient,
  });
  let weatherIndex = 0;
  const setWeather = (index: number): void => {
    const len = weather.presets.length;
    weatherIndex = ((index % len) + len) % len;
    weather.applyPreset(weatherIndex);
    onWeather?.(weather.current.label);
  };
  setWeather(0);
  const onWeatherKey = (e: KeyboardEvent): void => {
    if (e.code === 'KeyY' && !e.repeat) setWeather(weatherIndex + 1);
  };
  window.addEventListener('keydown', onWeatherKey);

  /** Wet-road grip cut: full rain → 70% grip. Slippery but still driveable. */
  const wetnessToGrip = (w: number): number => 1 - w * 0.3;

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

  // Scratch buffers for the camera target — written from the discrete physics
  // pose each fixed step and handed to `rig.advance`. Alloc-free.
  const camTargetPos = new THREE.Vector3();
  const camTargetQuat = new THREE.Quaternion();
  // Quaternion scratch for slerp (Three's `slerpQuaternions` writes in-place).
  const prevQuat = new THREE.Quaternion();
  const currQuat = new THREE.Quaternion();

  // Render-side snapshot interpolation — eliminates camera/visual jitter when
  // rAF doesn't perfectly align with the fixed physics step (high-refresh
  // monitors, vsync miss, occasional double-step). Two reusable buffers hold
  // the pose at the previous and current physics step; each render frame lerps
  // them by the loop's `alpha` ∈ [0, 1).
  const initialSnap = vehicle.readSnapshot();
  const prevSnap = cloneSnapshot(initialSnap);
  const currSnap = cloneSnapshot(initialSnap);
  const lerpedSnap = cloneSnapshot(initialSnap);

  // FPS counter — exponential moving average over last frame durations.
  let fps = 60;
  // Latest engine load for the audio synth, captured in the fixed step.
  let lastThrottle = 0;
  let lastBrake = 0;

  const loop: Loop = createLoop({
    step(dt) {
      // The pose at the end of the previous step becomes "prev" for the next
      // render interpolation. Then run physics, then capture the new "curr".
      copySnapshot(currSnap, prevSnap);

      const ctrl = input.sample(dt);
      if (ctrl.reset) {
        vehicle.reset();
        deformer?.reset();
      }
      vehicle.update(ctrl, dt);
      lastThrottle = ctrl.throttle;
      lastBrake = ctrl.brake;
      physics.step();

      copySnapshot(vehicle.readSnapshot(), currSnap);

      // Advance the camera spring at the same fixed step the physics runs at,
      // chasing the authoritative (discrete) pose. The rig stores prev/curr
      // internally; `render` interpolates them by the loop's `alpha` — the same
      // `alpha` the car visual uses — so camera and car stay in lockstep with no
      // second clock. `cameraInput.sample` returns the live (mouse-driven)
      // orbit control; its dt arg is ignored by the sticky-orbit driver.
      camTargetPos.set(currSnap.position.x, currSnap.position.y, currSnap.position.z);
      camTargetQuat.set(
        currSnap.rotation.x,
        currSnap.rotation.y,
        currSnap.rotation.z,
        currSnap.rotation.w,
      );
      rig.advance(camTargetPos, camTargetQuat, dt, cameraInput.sample(dt));
    },
    render(alpha, frameDt) {
      // Single authoritative frame clock from the loop — no second
      // `performance.now()` read, so every subsystem advances together.
      const elapsed = frameDt;
      const instantaneous = elapsed > 0 ? 1 / elapsed : fps;
      fps = fps * 0.92 + instantaneous * 0.08;

      // Interpolated camera pose for this frame (lockstep with the car visual
      // below). Applied first so `rig.camera.position` is current for the
      // distance-culling reads in the tire FX and weather passes.
      rig.present(alpha);

      // Interpolate pose between the previous and current physics step. With
      // steps==1 per rAF (60 Hz monitor), alpha is near 0 and lerpedSnap ≈
      // prevSnap (one step lag, ~16 ms — invisible). On a 144 Hz monitor where
      // most frames have steps==0, alpha grows smoothly from 0 → 1, so the car
      // and camera move every frame instead of ticking at 60 Hz.
      lerpSnapshot(prevSnap, currSnap, alpha, lerpedSnap, prevQuat, currQuat);
      vehicleVisual.applySnapshot(lerpedSnap);

      // Crumple the body for any chassis impacts harvested since the last frame.
      // We always drain (even with no deformer) so the impact buffer can't grow.
      physics.drainImpacts((impact) => {
        if (!deformer) return;
        if (impact.bodyA === chassisBodyHandle || impact.bodyB === chassisBodyHandle) {
          deformer.applyImpact(impact.point, impact.magnitude);
        }
      });

      // Tire-ground FX. Feed the lerped wheel snapshots directly — they
      // already carry the per-tick slip + world contact point. The chassis
      // rotation feeds the band-width direction so skid stamps stay aligned
      // with the body axis through drifts (instead of zig-zagging on noisy
      // motion-vector deltas). Camera position is used to cull smoke spawns
      // at long range.
      tireFx.update(lerpedSnap.wheels, elapsed, rig.camera.position, lerpedSnap.rotation);

      // Sync the dynamic crates to whatever Rapier produced this step. The
      // speed bump is static so its entries no-op, but the read is cheap. Only
      // the legacy flat-ground zone has an obstacle field; GLB worlds skip it.
      if (obstacles && obstacleVisuals) obstacleVisuals.update(obstacles.readSnapshot());

      // Advance weather and feed wetness → tire grip. Sky/rain are GPU-driven,
      // so this is just uniform updates + one grip setter — cheap on mobile.
      weather.update(elapsed, rig.camera.position);
      vehicle.setGripMultiplier(wetnessToGrip(weather.wetness));

      // Refresh the debug overlay before rendering (it lives in the scene).
      // `debugRender()` is only walked when the overlay is on.
      if (debug.enabled) debug.update(physics.world.debugRender(), vehicle.readDebugFrame());

      renderer.render(sceneBundle.scene, rig.camera);

      // Engine note: load from throttle, or the brake when crawling (reverse rev).
      const spd = Math.abs(lerpedSnap.speed);
      engineAudio.update(spd, lastThrottle > 0 ? lastThrottle : spd < 1 ? lastBrake : 0);

      if (onStats) {
        const q = lerpedSnap.rotation;
        const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
        onStats({ speedMs: spd, fps, position: lerpedSnap.position, headingDeg: (yaw * 180) / Math.PI });
      }
    },
  });
  loop.start();

  return {
    bus,
    setSkeleton,
    dispose() {
      loop.stop();
      resizeObserver.disconnect();
      window.removeEventListener('keydown', onWeatherKey);
      window.removeEventListener('keydown', onCameraKey);
      window.removeEventListener('keydown', onDebugKey);
      debug.dispose();
      weather.dispose();
      window.removeEventListener('pointerdown', resumeAudio);
      window.removeEventListener('keydown', resumeAudio);
      engineAudio.dispose();
      input.dispose();
      cameraInput.dispose();
      tireFx.dispose();
      deformer?.dispose();
      vehicleVisual.dispose();
      obstacleVisuals?.dispose();
      obstacles?.dispose();
      groundVisual?.dispose();
      zoneVisual?.dispose();
      disposeSurfaceMaterials(materials);
      sceneBundle.scene.environment = null;
      environment.dispose();
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

// ── Snapshot interpolation helpers ───────────────────────────────────────────
// Cars use a reused-buffer snapshot (no allocation per readSnapshot call), so
// we keep our own buffers to hold "pose at last step" vs "pose at current
// step" and interpolate by the loop's `alpha`. Visuals + camera then move
// smoothly each rendered frame regardless of monitor refresh vs physics rate.

/** Clone a snapshot's shape (deep copy of nested objects). Run once at init. */
function cloneSnapshot(src: VehicleSnapshot): VehicleSnapshot {
  return {
    position: { x: src.position.x, y: src.position.y, z: src.position.z },
    rotation: { x: src.rotation.x, y: src.rotation.y, z: src.rotation.z, w: src.rotation.w },
    speed: src.speed,
    wheels: src.wheels.map((w) => ({
      position: { x: w.position.x, y: w.position.y, z: w.position.z },
      steering: w.steering,
      rotation: w.rotation,
      inContact: w.inContact,
      contact: { x: w.contact.x, y: w.contact.y, z: w.contact.z },
      slip: w.slip,
    })),
  };
}

/** Copy `src` into `dst` in place — no allocations. */
function copySnapshot(src: VehicleSnapshot, dst: VehicleSnapshot): void {
  dst.position.x = src.position.x;
  dst.position.y = src.position.y;
  dst.position.z = src.position.z;
  dst.rotation.x = src.rotation.x;
  dst.rotation.y = src.rotation.y;
  dst.rotation.z = src.rotation.z;
  dst.rotation.w = src.rotation.w;
  dst.speed = src.speed;
  for (let i = 0; i < src.wheels.length; i++) {
    const sw = src.wheels[i];
    const dw = dst.wheels[i];
    if (!sw || !dw) continue;
    dw.position.x = sw.position.x;
    dw.position.y = sw.position.y;
    dw.position.z = sw.position.z;
    dw.steering = sw.steering;
    dw.rotation = sw.rotation;
    dw.inContact = sw.inContact;
    dw.contact.x = sw.contact.x;
    dw.contact.y = sw.contact.y;
    dw.contact.z = sw.contact.z;
    dw.slip = sw.slip;
  }
}

/**
 * Linearly interpolate `a` → `b` by `t ∈ [0, 1]`, writing into `out`.
 * Rotation is slerped (not lerped) so quaternion direction stays unit-length.
 * `qScratchA` / `qScratchB` are temp THREE quaternions to avoid per-frame
 * allocation in `Quaternion.slerpQuaternions`.
 */
function lerpSnapshot(
  a: VehicleSnapshot,
  b: VehicleSnapshot,
  t: number,
  out: VehicleSnapshot,
  qScratchA: THREE.Quaternion,
  qScratchB: THREE.Quaternion,
): void {
  out.position.x = a.position.x + (b.position.x - a.position.x) * t;
  out.position.y = a.position.y + (b.position.y - a.position.y) * t;
  out.position.z = a.position.z + (b.position.z - a.position.z) * t;

  qScratchA.set(a.rotation.x, a.rotation.y, a.rotation.z, a.rotation.w);
  qScratchB.set(b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w);
  qScratchA.slerp(qScratchB, t);
  out.rotation.x = qScratchA.x;
  out.rotation.y = qScratchA.y;
  out.rotation.z = qScratchA.z;
  out.rotation.w = qScratchA.w;

  out.speed = a.speed + (b.speed - a.speed) * t;

  for (let i = 0; i < a.wheels.length; i++) {
    const aw = a.wheels[i];
    const bw = b.wheels[i];
    const ow = out.wheels[i];
    if (!aw || !bw || !ow) continue;
    ow.position.x = aw.position.x + (bw.position.x - aw.position.x) * t;
    ow.position.y = aw.position.y + (bw.position.y - aw.position.y) * t;
    ow.position.z = aw.position.z + (bw.position.z - aw.position.z) * t;
    ow.steering = aw.steering + (bw.steering - aw.steering) * t;
    ow.rotation = aw.rotation + (bw.rotation - aw.rotation) * t;
    // Contact is discrete — snap to the latest step rather than fading.
    ow.inContact = bw.inContact;
    // Lerp the contact point and slip magnitude the same way as position so
    // skid marks land smoothly between physics ticks on high-refresh monitors.
    ow.contact.x = aw.contact.x + (bw.contact.x - aw.contact.x) * t;
    ow.contact.y = aw.contact.y + (bw.contact.y - aw.contact.y) * t;
    ow.contact.z = aw.contact.z + (bw.contact.z - aw.contact.z) * t;
    ow.slip = aw.slip + (bw.slip - aw.slip) * t;
  }
}
