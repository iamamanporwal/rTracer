/**
 * Race director — the brain of the Dev-Mode Race Builder.
 *
 * Owns the authored race (track type + start/finish gates), the live stopwatch
 * state machine, gate-crossing detection, lap counting, and per-zone persistence
 * ({@link ~/lib/race-store}). It creates the flame-gate *visuals* from the
 * renderer ({@link createRaceGate}) and adds them to the scene, but stays
 * framework-free — the React HUD drives it through plain methods and renders
 * from the cloned {@link RaceState} pushed to {@link RaceDirectorInit.onState}.
 *
 * It never imports Rapier or touches the physics world directly: the session
 * hands it a `teleport` callback (spawn the car at the start) and feeds it the
 * car's interpolated snapshot each frame. Placement raycasts are done with a
 * plain THREE.Raycaster against ground meshes the session supplies.
 */
import * as THREE from 'three';
import { createRaceGate, type RaceGate, type RaceGateKind } from '@trace/renderer';
import type { MovementSpawn, VehicleSnapshot } from '@trace/physics';
import { clearRace, loadRace, saveRace, type RaceMarkerData, type RaceTrackType } from '~/lib/race-store';

export type { RaceGateKind } from '@trace/renderer';
export type { RaceTrackType } from '~/lib/race-store';

/** Race stopwatch phases. */
export type RacePhase = 'idle' | 'countdown' | 'running' | 'finished';

/** Immutable snapshot the React HUD renders from (a fresh object each emit). */
export type RaceState = {
  trackType: RaceTrackType;
  phase: RacePhase;
  hasStart: boolean;
  hasFinish: boolean;
  /** Which gate is currently armed for click-placement, or null. */
  placing: RaceGateKind | null;
  /** Seconds remaining on the 3-2-1 countdown (only meaningful in 'countdown'). */
  countdownMs: number;
  /** Live elapsed time of the current run, in milliseconds. */
  elapsedMs: number;
  /** Time of the last completed run, or null. */
  lastMs: number | null;
  /** Best completed time on this map, or null. */
  bestMs: number | null;
  /** Current lap (loop races); 0 before the first crossing. */
  lap: number;
  /** Target laps to finish a loop race. */
  totalLaps: number;
};

export type RaceDirector = {
  setTrackType(type: RaceTrackType): void;
  setLaps(n: number): void;
  /** Arm (or disarm with null) click-to-place for a gate. */
  armPlacement(kind: RaceGateKind | null): void;
  /** Which gate is armed for click-placement, if any. */
  readonly placing: RaceGateKind | null;
  /** Place the armed gate where a camera ray through NDC hits the ground. */
  placeAtScreen(ndcX: number, ndcY: number): boolean;
  /** Drop a gate at the car's current position + heading. */
  placeAtCar(kind: RaceGateKind): void;
  /** Standing-start a run: spawn at the start gate, then 3-2-1, then time. */
  startRace(): void;
  /** Stop a running race now and bank the time (manual finish / free run). */
  stopRace(): void;
  /** Return the car to the start gate and reset the stopwatch to idle. */
  resetRace(): void;
  /** Remove all gates and forget the authored race for this zone. */
  clear(): void;
  /** Show/hide the gate visuals — the gates are a dev-only authoring artifact,
   * so the session ties this to dev mode (hidden for normal players). */
  setActive(on: boolean): void;
  /** Per-frame tick: feed the car pose + frame delta (ms). */
  update(snap: VehicleSnapshot, dtMs: number): void;
  dispose(): void;
};

export type RaceDirectorInit = {
  scene: THREE.Scene;
  /** The live render camera (for screen→world placement rays). */
  camera: THREE.Camera;
  /** Meshes a placement ray may hit (drivable ground / track). */
  groundTargets: () => THREE.Object3D[];
  /** Teleport the car to a spawn pose (session wires this to vehicle.reset). */
  teleport: (spawn: MovementSpawn) => void;
  zoneId: string;
  onState: (state: RaceState) => void;
};

/** Car must come within this XZ distance (m) of a gate to trigger it. */
const TRIGGER_RADIUS = 6;
/** And must leave beyond this before it can re-trigger (hysteresis). */
const EXIT_RADIUS = 9;
/** Standing-start countdown length. */
const COUNTDOWN_MS = 3000;
/** Car-centre height above the gated ground point when seating a spawn. Mirrors
 * the session's GLB_SPAWN_CLEARANCE_M so the car drops onto its springs cleanly. */
const SPAWN_CLEARANCE_M = 0.5;

export function createRaceDirector(init: RaceDirectorInit): RaceDirector {
  const { scene, camera, groundTargets, teleport, zoneId, onState } = init;

  // ── Persisted authoring ────────────────────────────────────────────────────
  const saved = loadRace(zoneId);
  let trackType: RaceTrackType = saved?.type ?? 'sprint';
  let totalLaps = saved?.laps ?? 1;
  let bestMs: number | null = saved?.bestMs ?? null;
  const markers: Record<RaceGateKind, RaceMarkerData | null> = {
    start: saved?.start ?? null,
    finish: saved?.finish ?? null,
  };
  const gates: Record<RaceGateKind, RaceGate | null> = { start: null, finish: null };

  // ── Live state machine ──────────────────────────────────────────────────────
  let phase: RacePhase = 'idle';
  let countdownMs = 0;
  let elapsedMs = 0;
  let lastMs: number | null = null;
  let lap = 0;
  let placing: RaceGateKind | null = null;
  // Gate visuals are dev-only; hidden until the session enables dev mode.
  let active = false;

  // Crossing hysteresis. `inside*` is the gate-occupancy latch; `startArmed`
  // gates lap/finish counting so a standing start on the line doesn't instantly
  // trigger — the car must first leave the start radius.
  let insideStart = false;
  let insideFinish = false;
  let startArmed = false;

  const lastSnap = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };

  // Scratch — no per-frame allocation.
  const raycaster = new THREE.Raycaster();
  const _origin = new THREE.Vector3();
  const _down = new THREE.Vector3(0, -1, 0);
  const _ndc = new THREE.Vector2();

  // Rebuild any persisted gates.
  if (markers.start) ensureGate('start');
  if (markers.finish && trackType === 'sprint') ensureGate('finish');

  function emit(): void {
    onState({
      trackType,
      phase,
      hasStart: markers.start != null,
      hasFinish: markers.finish != null,
      placing,
      countdownMs,
      elapsedMs,
      lastMs,
      bestMs,
      lap,
      totalLaps,
    });
  }

  function persist(): void {
    saveRace(zoneId, {
      type: trackType,
      start: markers.start,
      finish: markers.finish,
      laps: totalLaps,
      bestMs,
    });
  }

  // ── Gate lifecycle ──────────────────────────────────────────────────────────
  function ensureGate(kind: RaceGateKind): RaceGate {
    let gate = gates[kind];
    if (!gate) {
      gate = createRaceGate({ kind });
      gate.group.visible = active;
      scene.add(gate.group);
      gates[kind] = gate;
    }
    const data = markers[kind];
    if (data) gate.setTransform(data.position[0], data.position[1], data.position[2], yawFromQuat(data.quat));
    return gate;
  }

  function removeGate(kind: RaceGateKind): void {
    const gate = gates[kind];
    if (!gate) return;
    scene.remove(gate.group);
    gate.dispose();
    gates[kind] = null;
  }

  /** Place/replace a gate from a ground point + orientation quaternion. */
  function setMarker(kind: RaceGateKind, position: [number, number, number], quat: [number, number, number, number]): void {
    markers[kind] = { position, quat };
    ensureGate(kind);
    placing = null;
    // Placing a gate resets the run — the layout changed under it.
    phase = 'idle';
    elapsedMs = 0;
    persist();
    emit();
  }

  /** Down-cast to find the ground Y at (x, z); null if the ray misses. */
  function groundYAt(x: number, z: number): number | null {
    _origin.set(x, 500, z);
    raycaster.set(_origin, _down);
    const hit = raycaster.intersectObjects(groundTargets(), true)[0];
    return hit ? hit.point.y : null;
  }

  /** Spawn pose derived from the start gate (gate ground point + clearance). */
  function startSpawn(): MovementSpawn | null {
    const s = markers.start;
    if (!s) return null;
    return {
      position: [s.position[0], s.position[1] + SPAWN_CLEARANCE_M, s.position[2]],
      rotation: s.quat,
    };
  }

  // ── Public commands ─────────────────────────────────────────────────────────
  function setTrackType(type: RaceTrackType): void {
    if (trackType === type) return;
    trackType = type;
    // A loop has no separate finish gate — drop it from the scene + record.
    if (type === 'loop') {
      markers.finish = null;
      removeGate('finish');
    }
    phase = 'idle';
    elapsedMs = 0;
    persist();
    emit();
  }

  function setLaps(n: number): void {
    totalLaps = Math.max(1, Math.min(20, Math.floor(n)));
    persist();
    emit();
  }

  function armPlacement(kind: RaceGateKind | null): void {
    // Can't place a finish on a loop (start is the finish).
    placing = kind === 'finish' && trackType === 'loop' ? null : kind;
    emit();
  }

  function placeAtScreen(ndcX: number, ndcY: number): boolean {
    if (!placing) return false;
    _ndc.set(ndcX, ndcY);
    raycaster.setFromCamera(_ndc, camera);
    const hit = raycaster.intersectObjects(groundTargets(), true)[0];
    if (!hit) return false;
    const kind = placing;
    const p = hit.point;
    setMarker(kind, [p.x, p.y, p.z], headingQuat(kind, p.x, p.z));
    return true;
  }

  function placeAtCar(kind: RaceGateKind): void {
    if (kind === 'finish' && trackType === 'loop') return;
    const groundY = groundYAt(lastSnap.x, lastSnap.z);
    const y = groundY ?? lastSnap.y - SPAWN_CLEARANCE_M;
    // @-car keeps the car's exact facing — most faithful for the start spawn.
    setMarker(kind, [lastSnap.x, y, lastSnap.z], [lastSnap.qx, lastSnap.qy, lastSnap.qz, lastSnap.qw]);
  }

  function startRace(): void {
    const spawn = startSpawn();
    if (!spawn) return; // no start gate yet — HUD disables the button
    teleport(spawn);
    phase = 'countdown';
    countdownMs = COUNTDOWN_MS;
    elapsedMs = 0;
    lap = 0;
    startArmed = false;
    insideStart = true; // we just spawned on the line
    insideFinish = false;
    emit();
  }

  function stopRace(): void {
    if (phase === 'running') {
      finish(); // bank the live time
    } else if (phase === 'countdown') {
      // Cancel before the flag drops — don't record a 0.00.
      phase = 'idle';
      elapsedMs = 0;
      countdownMs = 0;
      emit();
    }
  }

  function resetRace(): void {
    const spawn = startSpawn();
    if (spawn) teleport(spawn);
    phase = 'idle';
    elapsedMs = 0;
    countdownMs = 0;
    lap = 0;
    emit();
  }

  function clear(): void {
    removeGate('start');
    removeGate('finish');
    markers.start = null;
    markers.finish = null;
    placing = null;
    phase = 'idle';
    elapsedMs = 0;
    lap = 0;
    clearRace(zoneId);
    emit();
  }

  function finish(): void {
    phase = 'finished';
    lastMs = elapsedMs;
    if (bestMs == null || elapsedMs < bestMs) {
      bestMs = elapsedMs;
      persist();
    }
    emit();
  }

  // ── Per-frame ───────────────────────────────────────────────────────────────
  function update(snap: VehicleSnapshot, dtMs: number): void {
    lastSnap.x = snap.position.x;
    lastSnap.y = snap.position.y;
    lastSnap.z = snap.position.z;
    lastSnap.qx = snap.rotation.x;
    lastSnap.qy = snap.rotation.y;
    lastSnap.qz = snap.rotation.z;
    lastSnap.qw = snap.rotation.w;

    // Flames flicker every frame, whatever the race phase.
    const dt = dtMs / 1000;
    gates.start?.update(dt);
    gates.finish?.update(dt);

    if (phase !== 'countdown' && phase !== 'running') return;

    const enteredStart = updateGateLatch('start', () => (insideStart = true), () => (insideStart = false), insideStart);
    const enteredFinish = updateGateLatch('finish', () => (insideFinish = true), () => (insideFinish = false), insideFinish);

    if (phase === 'countdown') {
      countdownMs -= dtMs;
      if (countdownMs <= 0) {
        countdownMs = 0;
        phase = 'running';
        elapsedMs = 0;
      }
      emit();
      return;
    }

    // phase === 'running'
    elapsedMs += dtMs;

    // The car must clear the start area before any lap / re-cross counts.
    if (!startArmed && distXZ('start') > TRIGGER_RADIUS) startArmed = true;

    if (trackType === 'sprint') {
      if (markers.finish && enteredFinish) {
        finish();
        return;
      }
    } else {
      // Loop: each armed re-entry of the start gate completes a lap.
      if (startArmed && enteredStart) {
        lap += 1;
        startArmed = false; // must leave again for the next lap
        if (lap >= totalLaps) {
          finish();
          return;
        }
      }
    }
    emit();
  }

  /** XZ distance from the car to a gate, or Infinity if the gate is unplaced. */
  function distXZ(kind: RaceGateKind): number {
    const m = markers[kind];
    if (!m) return Infinity;
    const dx = lastSnap.x - m.position[0];
    const dz = lastSnap.z - m.position[2];
    return Math.hypot(dx, dz);
  }

  /**
   * Advance a gate's occupancy latch with enter/exit hysteresis and return
   * whether the car *entered* this frame. `wasInside` is the latch's prior value.
   */
  function updateGateLatch(kind: RaceGateKind, enter: () => void, exit: () => void, wasInside: boolean): boolean {
    const d = distXZ(kind);
    if (wasInside) {
      if (d > EXIT_RADIUS) exit();
      return false;
    }
    if (d < TRIGGER_RADIUS) {
      enter();
      return true;
    }
    return false;
  }

  /** Orientation for a click-placed gate: face along the start→finish axis if
   * both exist, else keep the car's current heading. */
  function headingQuat(kind: RaceGateKind, x: number, z: number): [number, number, number, number] {
    const other = kind === 'start' ? markers.finish : markers.start;
    if (other) {
      const dx = kind === 'start' ? other.position[0] - x : x - other.position[0];
      const dz = kind === 'start' ? other.position[2] - z : z - other.position[2];
      if (dx * dx + dz * dz > 1e-4) return yawQuat(Math.atan2(dx, dz));
    }
    return [lastSnap.qx, lastSnap.qy, lastSnap.qz, lastSnap.qw];
  }

  emit(); // initial state (reflects any persisted layout)

  return {
    setTrackType,
    setLaps,
    armPlacement,
    get placing() {
      return placing;
    },
    placeAtScreen,
    placeAtCar,
    startRace,
    stopRace,
    resetRace,
    clear,
    setActive(on) {
      active = on;
      if (gates.start) gates.start.group.visible = on;
      if (gates.finish) gates.finish.group.visible = on;
    },
    update,
    dispose() {
      removeGate('start');
      removeGate('finish');
    },
  };
}

/** Yaw (radians) of a quaternion about +Y — 0 = facing +Z. */
function yawFromQuat(q: [number, number, number, number]): number {
  const [x, y, z, w] = q;
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
}

/** A yaw-only (about +Y) quaternion for a heading where 0 = facing +Z. */
function yawQuat(yaw: number): [number, number, number, number] {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}
