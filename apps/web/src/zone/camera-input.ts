import type { CameraControl } from '@trace/renderer';

/**
 * Mouse → {@link CameraControl} mapping — a free-look orbit camera.
 *
 *   - Click the canvas to lock the pointer; moving the mouse then swings the
 *     camera around the car (yaw + pitch). Dragging with a held button works
 *     too, for browsers/users that don't want pointer lock. Esc releases.
 *   - The mouse wheel zooms the follow distance.
 *   - Orbit is sticky: once the player has aimed the camera it stays there
 *     until the next mouse movement (no auto-recenter behind the car).
 *
 * The driver owns its own listeners and is sampled once per rendered frame.
 */

const YAW_SENS = 0.0022; // rad per pixel of horizontal movement
const PITCH_SENS = 0.0018; // rad per pixel of vertical movement
const PITCH_MIN = -0.35; // looking up at the car
const PITCH_MAX = 1.15; // looking down on the car
const ZOOM_STEP = 0.12;
const ZOOM_MIN = 0.55;
const ZOOM_MAX = 2.4;

export type CameraInputDriver = {
  /** Advance recenter smoothing by `dt` and return the latest camera control. Allocates nothing. */
  sample(dt: number): CameraControl;
  dispose(): void;
};

export function createCameraInput(canvas: HTMLCanvasElement): CameraInputDriver {
  const control: CameraControl = { yaw: 0, pitch: 0.12, distance: 1 };
  let locked = false;
  let dragging = false;

  function onMouseMove(e: MouseEvent): void {
    if (!locked && !dragging) return;
    control.yaw -= e.movementX * YAW_SENS;
    control.pitch = clamp(control.pitch + e.movementY * PITCH_SENS, PITCH_MIN, PITCH_MAX);
  }

  function onMouseDown(): void {
    dragging = true;
    // Try pointer lock for free-look; harmless if it's rejected. Newer DOM
    // typings return a Promise, so discard it with `void`.
    if (!locked && canvas.requestPointerLock) void canvas.requestPointerLock();
  }
  function onMouseUp(): void {
    dragging = false;
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const dir = e.deltaY > 0 ? 1 : -1;
    control.distance = clamp(control.distance + dir * ZOOM_STEP, ZOOM_MIN, ZOOM_MAX);
  }

  function onPointerLockChange(): void {
    locked = document.pointerLockElement === canvas;
  }

  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('pointerlockchange', onPointerLockChange);

  return {
    sample() {
      // Sticky orbit — the camera holds wherever the player last left it. No
      // idle decay back behind the car (that was fighting the player's aim).
      return control;
    },
    dispose() {
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('wheel', onWheel);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    },
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
