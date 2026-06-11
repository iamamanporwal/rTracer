import * as THREE from 'three';
import type { VehicleVisualSnapshot } from '@trace/renderer';
import type { ReplayCapture } from './telemetry';

/**
 * Dev-mode 3D replay — the "video player" half of the telemetry recorder.
 *
 * Two cooperating pieces, both pure of any session wiring so they're trivially
 * testable and the session just owns instances:
 *
 *   - {@link createReplayPlayer} — a transport (play / pause / reverse / scrub /
 *     speed) over the recorded {@link ReplayCapture}. Each rendered frame it
 *     advances its own clock and returns an interpolated {@link
 *     VehicleVisualSnapshot} (slerped rotation, lerped position + wheels) so the
 *     car reads smoothly at any speed or monitor refresh — exactly the same
 *     interpolation the live loop uses, just driven by a scrubbable clock
 *     instead of physics. Allocation-free per frame (one reused output buffer).
 *
 *   - {@link createReplayCamera} — a free orbit / pan / zoom camera so the dev
 *     can fly around the recorded run with a bird's-eye default. It owns its own
 *     pointer + touch listeners (no pointer lock, so the cursor stays free for
 *     the transport UI) and writes straight onto the shared scene camera. While
 *     `following` it keeps the car framed; the first pan drops follow so the dev
 *     can travel the whole environment.
 */

/** Discrete playback rates offered by the transport UI. */
export const REPLAY_SPEEDS = [0.25, 0.5, 1, 2] as const;

/** Snapshot of the transport state, surfaced to the React overlay each frame. */
export type ReplayState = {
  /** Current frame index (rounded), for the scrubber + readout. */
  frame: number;
  frameCount: number;
  /** Playback head, seconds from the start of the capture. */
  timeS: number;
  /** Total capture length, seconds. */
  durationS: number;
  playing: boolean;
  /** Playing backward. */
  reversed: boolean;
  speed: number;
  /** Camera is locked onto the car (false once the dev pans away to free-fly). */
  following: boolean;
};

export type ReplayPlayer = {
  /**
   * Advance the clock by `frameDt` real seconds (scaled internally by speed and
   * direction) and return the interpolated visual snapshot for this frame. The
   * returned object is reused — read it, don't retain it.
   */
  advance(frameDt: number): VehicleVisualSnapshot;
  /** Play forward. Rewinds to the start first if parked at the end. */
  play(): void;
  /** Play backward. Jumps to the end first if parked at the start. */
  reverse(): void;
  pause(): void;
  /** Pause⇄play forward. */
  toggle(): void;
  /** Restart from frame 0 and play forward. */
  restart(): void;
  setSpeed(mult: number): void;
  /** Seek to a normalized [0, 1] position; leaves play/pause untouched. */
  seekFrac(frac: number): void;
  /** Live transport state (a stable object, mutated in place). */
  readonly state: ReplayState;
  /** Current interpolated chassis position — used to keep the camera framed. */
  readonly focusPosition: THREE.Vector3;
};

export function createReplayPlayer(capture: ReplayCapture): ReplayPlayer {
  const { frames, fixedDt } = capture;
  const n = frames.length;
  // Frame i sits at t = i * fixedDt, so the last frame is (n-1)*fixedDt.
  const duration = n > 1 ? (n - 1) * fixedDt : 0;
  const wheelCount = frames[0]?.wheels.length ?? 0;

  let timeS = 0;
  let playing = false;
  let dir: 1 | -1 = 1;
  let speed = 1;

  // Reused output snapshot + slerp scratch — no per-frame allocation.
  const out: VehicleVisualSnapshot = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    speed: 0,
    wheels: Array.from({ length: wheelCount }, () => ({
      position: { x: 0, y: 0, z: 0 },
      steering: 0,
      rotation: 0,
      inContact: false,
    })),
  };
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  const focus = new THREE.Vector3();

  const state: ReplayState = {
    frame: 0,
    frameCount: n,
    timeS: 0,
    durationS: duration,
    playing: false,
    reversed: false,
    speed: 1,
    following: true,
  };

  const clampTime = (t: number): number => (t < 0 ? 0 : t > duration ? duration : t);

  /** Resolve the playback head into `out` (interpolating between two frames). */
  function sampleInto(): void {
    const f = duration > 0 ? timeS / fixedDt : 0;
    let i0 = Math.floor(f);
    if (i0 < 0) i0 = 0;
    else if (i0 > n - 1) i0 = n - 1;
    const i1 = i0 + 1 > n - 1 ? n - 1 : i0 + 1;
    const frac = f - i0;
    const a = frames[i0]!;
    const b = frames[i1]!;

    out.position.x = a.position.x + (b.position.x - a.position.x) * frac;
    out.position.y = a.position.y + (b.position.y - a.position.y) * frac;
    out.position.z = a.position.z + (b.position.z - a.position.z) * frac;

    qa.set(a.rotation.x, a.rotation.y, a.rotation.z, a.rotation.w);
    qb.set(b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w);
    qa.slerp(qb, frac);
    out.rotation.x = qa.x;
    out.rotation.y = qa.y;
    out.rotation.z = qa.z;
    out.rotation.w = qa.w;

    out.speed = a.speed + (b.speed - a.speed) * frac;

    for (let i = 0; i < wheelCount; i++) {
      const aw = a.wheels[i];
      const bw = b.wheels[i];
      const ow = out.wheels[i];
      if (!aw || !bw || !ow) continue;
      ow.position.x = aw.position.x + (bw.position.x - aw.position.x) * frac;
      ow.position.y = aw.position.y + (bw.position.y - aw.position.y) * frac;
      ow.position.z = aw.position.z + (bw.position.z - aw.position.z) * frac;
      ow.steering = aw.steering + (bw.steering - aw.steering) * frac;
      ow.rotation = aw.rotation + (bw.rotation - aw.rotation) * frac;
      // Contact is discrete — snap to the later frame rather than fading.
      ow.inContact = bw.inContact;
    }

    focus.set(out.position.x, out.position.y, out.position.z);
    state.frame = Math.round(f);
    state.timeS = timeS;
  }

  function syncState(): void {
    state.playing = playing;
    state.reversed = dir === -1;
    state.speed = speed;
  }

  // Prime to frame 0.
  sampleInto();
  syncState();

  return {
    advance(frameDt) {
      if (playing && duration > 0) {
        timeS = clampTime(timeS + frameDt * speed * dir);
        // Park (and stop) at whichever end we reach.
        if (dir === 1 && timeS >= duration) playing = false;
        else if (dir === -1 && timeS <= 0) playing = false;
      }
      sampleInto();
      syncState();
      return out;
    },
    play() {
      dir = 1;
      if (timeS >= duration) timeS = 0;
      playing = duration > 0;
      sampleInto();
      syncState();
    },
    reverse() {
      dir = -1;
      if (timeS <= 0) timeS = duration;
      playing = duration > 0;
      sampleInto();
      syncState();
    },
    pause() {
      playing = false;
      syncState();
    },
    toggle() {
      if (playing) {
        playing = false;
      } else {
        dir = 1;
        if (timeS >= duration) timeS = 0;
        playing = duration > 0;
      }
      sampleInto();
      syncState();
    },
    restart() {
      timeS = 0;
      dir = 1;
      playing = duration > 0;
      sampleInto();
      syncState();
    },
    setSpeed(mult) {
      speed = mult;
      syncState();
    },
    seekFrac(frac) {
      const c = frac < 0 ? 0 : frac > 1 ? 1 : frac;
      timeS = c * duration;
      sampleInto();
      syncState();
    },
    get state() {
      return state;
    },
    get focusPosition() {
      return focus;
    },
  };
}

// ── Free replay camera ───────────────────────────────────────────────────────

export type ReplayCamera = {
  /** Place the shared scene camera from the current orbit/pan/zoom state. */
  update(camera: THREE.PerspectiveCamera): void;
  /** Set the orbit focus (world). Used to frame the car while {@link following}. */
  setFocus(x: number, y: number, z: number): void;
  /** Whether the orbit focus tracks the car. The first pan clears it. */
  following: boolean;
  /** Remove all listeners. */
  dispose(): void;
};

const PITCH_MIN = 0.12; // ~7° above the horizon
const PITCH_MAX = 1.5; // near top-down
const DIST_MIN = 3;
const DIST_MAX = 240;
const ORBIT_SENS = 0.005; // rad per pixel
const PAN_SENS = 0.0018; // world units per pixel, per metre of distance
const ZOOM_RATE = 1.1;

/**
 * Orbit / pan / zoom viewer for the replay. Bird's-eye by default (high pitch,
 * pulled back). Left-drag (or one finger) orbits; right-drag / shift-drag (or
 * two-finger drag) pans the focus across the ground; wheel / pinch zooms. No
 * pointer lock — the cursor stays usable for the transport UI.
 */
export function createReplayCamera(canvas: HTMLCanvasElement): ReplayCamera {
  let yaw = 0.6;
  let pitch = 0.95; // looking down ~54°
  let distance = 22;
  let following = true;
  const focus = new THREE.Vector3();

  // Pointer drag state.
  let drag: 'orbit' | 'pan' | null = null;
  let lastX = 0;
  let lastY = 0;
  // Touch state.
  let pinchDist = 0;
  let midX = 0;
  let midY = 0;

  // Scratch for the ground-plane pan basis + camera placement (alloc-free).
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const pos = new THREE.Vector3();

  const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

  function orbitBy(dx: number, dy: number): void {
    yaw -= dx * ORBIT_SENS;
    pitch = clamp(pitch + dy * ORBIT_SENS, PITCH_MIN, PITCH_MAX);
  }

  function panBy(dx: number, dy: number): void {
    following = false; // taking manual control of where we look
    // Ground-plane basis from yaw alone (independent of pitch) so dragging
    // glides the focus over the floor like grabbing the world.
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    fwd.set(-s, 0, -c); // screen-forward, projected to the ground
    right.set(c, 0, -s); // screen-right
    const scale = distance * PAN_SENS;
    focus.addScaledVector(right, -dx * scale);
    focus.addScaledVector(fwd, dy * scale);
  }

  function zoomBy(deltaY: number): void {
    distance = clamp(distance * (deltaY > 0 ? ZOOM_RATE : 1 / ZOOM_RATE), DIST_MIN, DIST_MAX);
  }

  function onMouseDown(e: MouseEvent): void {
    drag = e.button === 2 || e.shiftKey ? 'pan' : 'orbit';
    lastX = e.clientX;
    lastY = e.clientY;
  }
  function onMouseMove(e: MouseEvent): void {
    if (!drag) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (drag === 'pan') panBy(dx, dy);
    else orbitBy(dx, dy);
  }
  function onMouseUp(): void {
    drag = null;
  }
  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    zoomBy(e.deltaY);
  }
  function onContextMenu(e: Event): void {
    e.preventDefault(); // let right-drag pan without popping the browser menu
  }

  function touchDist(a: Touch, b: Touch): number {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }
  function onTouchStart(e: TouchEvent): void {
    if (e.touches.length === 1) {
      const t = e.touches[0]!;
      lastX = t.clientX;
      lastY = t.clientY;
      drag = 'orbit';
    } else if (e.touches.length === 2) {
      const a = e.touches[0]!;
      const b = e.touches[1]!;
      pinchDist = touchDist(a, b);
      midX = (a.clientX + b.clientX) / 2;
      midY = (a.clientY + b.clientY) / 2;
      drag = 'pan';
    }
  }
  function onTouchMove(e: TouchEvent): void {
    if (e.touches.length === 1 && drag === 'orbit') {
      const t = e.touches[0]!;
      orbitBy(t.clientX - lastX, t.clientY - lastY);
      lastX = t.clientX;
      lastY = t.clientY;
      e.preventDefault();
    } else if (e.touches.length === 2) {
      const a = e.touches[0]!;
      const b = e.touches[1]!;
      const d = touchDist(a, b);
      if (pinchDist > 0) zoomBy(pinchDist - d); // spreading fingers zooms in
      pinchDist = d;
      const mx = (a.clientX + b.clientX) / 2;
      const my = (a.clientY + b.clientY) / 2;
      panBy(mx - midX, my - midY);
      midX = mx;
      midY = my;
      e.preventDefault();
    }
  }
  function onTouchEnd(e: TouchEvent): void {
    if (e.touches.length === 0) {
      drag = null;
      pinchDist = 0;
    }
  }

  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('touchstart', onTouchStart, { passive: true });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: true });

  return {
    get following(): boolean {
      return following;
    },
    set following(on: boolean) {
      following = on;
    },
    setFocus(x, y, z) {
      focus.set(x, y, z);
    },
    update(camera) {
      const cp = Math.cos(pitch);
      pos.set(
        focus.x + Math.sin(yaw) * cp * distance,
        focus.y + Math.sin(pitch) * distance,
        focus.z + Math.cos(yaw) * cp * distance,
      );
      camera.position.copy(pos);
      camera.lookAt(focus);
    },
    dispose() {
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
    },
  };
}
