import type { CameraControl } from '@trace/renderer';

/**
 * Pointer → {@link CameraControl} mapping — a free-look orbit camera that works
 * with a mouse or a finger.
 *
 *   - Click the canvas to lock the pointer; moving the mouse then swings the
 *     camera around the car (yaw + pitch). Dragging with a held button works
 *     too, for browsers/users that don't want pointer lock. Esc releases.
 *   - The mouse wheel zooms the follow distance.
 *   - On touch: a one-finger drag on open canvas swings the camera (the HUD
 *     buttons sit on top, so dragging them never reaches here); a two-finger
 *     pinch zooms. Drag-look uses absolute deltas rather than `movementX`,
 *     which mobile browsers report unreliably for touch.
 *   - Orbit is sticky: once the player has aimed the camera it stays there
 *     until the next movement (no auto-recenter behind the car).
 *
 * The driver owns its own listeners and is sampled once per rendered frame.
 */

const YAW_SENS = 0.0022; // rad per pixel of horizontal movement
const PITCH_SENS = 0.0018; // rad per pixel of vertical movement
const TOUCH_YAW_SENS = 0.005; // rad per pixel of finger drag (touch screens are smaller)
const TOUCH_PITCH_SENS = 0.004;
const PINCH_SENS = 0.9; // pinch-distance ratio → zoom factor
const PITCH_MIN = -0.35; // looking up at the car
const PITCH_MAX = 1.15; // looking down on the car
const ZOOM_STEP = 0.12;
const ZOOM_MIN = 0.55;
const ZOOM_MAX = 2.4;

export type CameraInputDriver = {
  /** Advance recenter smoothing by `dt` and return the latest camera control. Allocates nothing. */
  sample(dt: number): CameraControl;
  /**
   * Enable / disable the driver. While disabled, every listener early-returns
   * and any active pointer lock is released — the replay player calls this so
   * its free camera owns the canvas without the live orbit fighting it.
   */
  setEnabled(on: boolean): void;
  dispose(): void;
};

export function createCameraInput(canvas: HTMLCanvasElement): CameraInputDriver {
  const control: CameraControl = { yaw: 0, pitch: 0.12, distance: 1 };
  let locked = false;
  let dragging = false;
  let enabled = true;

  function onMouseMove(e: MouseEvent): void {
    if (!enabled) return;
    if (!locked && !dragging) return;
    control.yaw -= e.movementX * YAW_SENS;
    control.pitch = clamp(control.pitch + e.movementY * PITCH_SENS, PITCH_MIN, PITCH_MAX);
  }

  function onMouseDown(): void {
    if (!enabled) return;
    dragging = true;
    // Try pointer lock for free-look; harmless if it's rejected. Newer DOM
    // typings return a Promise, so discard it with `void`.
    if (!locked && canvas.requestPointerLock) void canvas.requestPointerLock();
  }
  function onMouseUp(): void {
    dragging = false;
  }

  function onWheel(e: WheelEvent): void {
    if (!enabled) return;
    e.preventDefault();
    const dir = e.deltaY > 0 ? 1 : -1;
    control.distance = clamp(control.distance + dir * ZOOM_STEP, ZOOM_MIN, ZOOM_MAX);
  }

  function onPointerLockChange(): void {
    locked = document.pointerLockElement === canvas;
  }

  // ── Touch: one-finger drag-look + two-finger pinch-zoom ───────────────────
  // Only fires for touches that *start* on the canvas; the HUD buttons sit on
  // top of it, so dragging them never reaches the camera.
  let lastTouchX = 0;
  let lastTouchY = 0;
  let pinchDist = 0;

  function touchDistance(t0: Touch, t1: Touch): number {
    const dx = t0.clientX - t1.clientX;
    const dy = t0.clientY - t1.clientY;
    return Math.hypot(dx, dy);
  }

  function onTouchStart(e: TouchEvent): void {
    if (!enabled) return;
    if (e.touches.length === 1) {
      const t = e.touches[0];
      if (!t) return;
      lastTouchX = t.clientX;
      lastTouchY = t.clientY;
    } else if (e.touches.length === 2) {
      const a = e.touches[0];
      const b = e.touches[1];
      if (a && b) pinchDist = touchDistance(a, b);
    }
  }

  function onTouchMove(e: TouchEvent): void {
    if (!enabled) return;
    if (e.touches.length === 1) {
      const t = e.touches[0];
      if (!t) return;
      control.yaw -= (t.clientX - lastTouchX) * TOUCH_YAW_SENS;
      control.pitch = clamp(
        control.pitch + (t.clientY - lastTouchY) * TOUCH_PITCH_SENS,
        PITCH_MIN,
        PITCH_MAX,
      );
      lastTouchX = t.clientX;
      lastTouchY = t.clientY;
      e.preventDefault();
    } else if (e.touches.length === 2) {
      const a = e.touches[0];
      const b = e.touches[1];
      if (!a || !b) return;
      const dist = touchDistance(a, b);
      if (pinchDist > 0) {
        const ratio = dist / pinchDist;
        // Spreading fingers (ratio > 1) pulls the camera in (smaller distance).
        const delta = (1 - ratio) * PINCH_SENS;
        control.distance = clamp(control.distance + delta, ZOOM_MIN, ZOOM_MAX);
      }
      pinchDist = dist;
      e.preventDefault();
    }
  }

  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('touchstart', onTouchStart, { passive: true });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('pointerlockchange', onPointerLockChange);

  return {
    sample() {
      // Sticky orbit — the camera holds wherever the player last left it. No
      // idle decay back behind the car (that was fighting the player's aim).
      return control;
    },
    setEnabled(on) {
      enabled = on;
      if (!on) {
        dragging = false;
        if (document.pointerLockElement === canvas) document.exitPointerLock();
      }
    },
    dispose() {
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    },
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
