import type { CameraControl } from '@trace/renderer';

/**
 * Mouse → {@link CameraControl} mapping — a GTA-style orbit camera.
 *
 *   - Click the canvas to lock the pointer; moving the mouse then swings the
 *     camera around the car (yaw + pitch). Dragging with a held button works
 *     too, for browsers/users that don't want pointer lock. Esc releases.
 *   - The mouse wheel zooms the follow distance.
 *   - When the mouse goes idle, the orbit decays back to directly behind the
 *     car's heading — the signature GTA "camera drifts back when you drive".
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
const IDLE_DELAY_MS = 1600; // how long after the last look input before drifting back
const RECENTER_RATE = 1.8; // gentle yaw/pitch decay once idle (smooth, not a snap)

export type CameraInputDriver = {
  /** Advance recenter smoothing by `dt` and return the latest camera control. Allocates nothing. */
  sample(dt: number): CameraControl;
  dispose(): void;
};

export function createCameraInput(canvas: HTMLCanvasElement): CameraInputDriver {
  const control: CameraControl = { yaw: 0, pitch: 0.12, distance: 1 };
  let locked = false;
  let dragging = false;
  let lastInputTs = -Infinity;

  function onMouseMove(e: MouseEvent): void {
    if (!locked && !dragging) return;
    control.yaw -= e.movementX * YAW_SENS;
    control.pitch = clamp(control.pitch + e.movementY * PITCH_SENS, PITCH_MIN, PITCH_MAX);
    lastInputTs = performance.now();
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
    lastInputTs = performance.now();
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
    sample(dt) {
      const idle = performance.now() - lastInputTs > IDLE_DELAY_MS;
      if (idle) {
        // Critically-damped decay back behind the car. Distance is sticky.
        const alpha = 1 - Math.exp(-RECENTER_RATE * dt);
        control.yaw += (0 - control.yaw) * alpha;
        control.pitch += (0.12 - control.pitch) * alpha;
      }
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
