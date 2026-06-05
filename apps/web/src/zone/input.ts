import type { ControlInput } from '@trace/physics';

/**
 * Keyboard + on-screen touch → {@link ControlInput} mapping.
 *
 * One global keyboard listener feeds the desktop `Held` state; the mobile HUD
 * buttons feed a parallel `touch` state through the imperative {@link
 * TouchControls} surface. `sample()` ORs the two each tick, so a Bluetooth
 * keyboard paired to a tablet and the on-screen pad both drive the same car —
 * neither path knows about the other. Throttle/brake/steering still ramp toward
 * the held value so the car feels driveable; the physics side owns the
 * speed-sensitive return-to-center torque.
 */

const THROTTLE_RAMP_PER_SEC = 4;
/**
 * 60 ms ramp from 0 → 1 for the foot brake — avoids the instant-brake "stoppie"
 * by giving the chassis ~3 frames at 60 fps to compress the front struts before
 * full brake torque hits the wheels. Per the brake-fix spec.
 */
const BRAKE_RAMP_PER_SEC = 1000 / 60;
const STEER_RAMP_PER_SEC = 4;
const STEER_RECENTER_PER_SEC = 6;

/**
 * Imperative control surface for the on-screen mobile pad. The React touch
 * buttons flip these on `pointerdown` / off on `pointerup`; the driver reads
 * them on the next `sample()`. Setters are idempotent and allocation-free.
 */
export type TouchControls = {
  setThrottle(on: boolean): void;
  setBrake(on: boolean): void;
  /** -1 = full left, 0 = centre, 1 = full right. */
  setSteer(dir: -1 | 0 | 1): void;
  setHandbrake(on: boolean): void;
  /** Edge-triggered reset — applied on the next sampled tick. */
  triggerReset(): void;
  /** Release every held touch input (called when the pad unmounts / pauses). */
  releaseAll(): void;
};

export type InputDriver = {
  /** Advance smoothing by `dt` and return the latest control state. Allocates nothing. */
  sample(dt: number): ControlInput;
  /** On-screen touch control surface — driven by the mobile HUD buttons. */
  readonly touch: TouchControls;
  /** Remove window listeners and reset state. */
  dispose(): void;
};

type Held = {
  throttle: boolean;
  brake: boolean;
  steerLeft: boolean;
  steerRight: boolean;
  handbrake: boolean;
  reset: boolean;
};

function blankHeld(): Held {
  return {
    throttle: false,
    brake: false,
    steerLeft: false,
    steerRight: false,
    handbrake: false,
    reset: false,
  };
}

export function createKeyboardInput(): InputDriver {
  const held = blankHeld();
  // Parallel state for the on-screen pad. ORed with `held` each sample so
  // keyboard and touch coexist (e.g. a keyboard paired to a tablet).
  const tap = blankHeld();

  const state: ControlInput = {
    throttle: 0,
    brake: 0,
    steering: 0,
    handbrake: 0,
    reset: false,
  };

  function onKeyDown(e: KeyboardEvent): void {
    if (e.repeat) return;
    if (apply(held, e.code, true)) e.preventDefault();
  }
  function onKeyUp(e: KeyboardEvent): void {
    if (apply(held, e.code, false)) e.preventDefault();
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  const touch: TouchControls = {
    setThrottle: (on) => {
      tap.throttle = on;
    },
    setBrake: (on) => {
      tap.brake = on;
    },
    setSteer: (dir) => {
      tap.steerLeft = dir === -1;
      tap.steerRight = dir === 1;
    },
    setHandbrake: (on) => {
      tap.handbrake = on;
    },
    triggerReset: () => {
      tap.reset = true;
    },
    releaseAll: () => {
      tap.throttle = false;
      tap.brake = false;
      tap.steerLeft = false;
      tap.steerRight = false;
      tap.handbrake = false;
    },
  };

  return {
    touch,
    sample(dt) {
      const throttle = held.throttle || tap.throttle;
      const brake = held.brake || tap.brake;
      const handbrake = held.handbrake || tap.handbrake;
      const steerLeft = held.steerLeft || tap.steerLeft;
      const steerRight = held.steerRight || tap.steerRight;

      state.throttle = rampToward(state.throttle, throttle ? 1 : 0, THROTTLE_RAMP_PER_SEC * dt);
      state.brake = rampToward(state.brake, brake ? 1 : 0, BRAKE_RAMP_PER_SEC * dt);
      state.handbrake = handbrake ? 1 : 0;

      const target = steerLeft ? -1 : steerRight ? 1 : 0;
      if (target === 0) {
        state.steering = rampToward(state.steering, 0, STEER_RECENTER_PER_SEC * dt);
      } else {
        state.steering = rampToward(state.steering, target, STEER_RAMP_PER_SEC * dt);
      }
      state.reset = held.reset || tap.reset;
      held.reset = false; // edge-trigger
      tap.reset = false;
      return state;
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    },
  };
}

function apply(held: Held, code: string, pressed: boolean): boolean {
  switch (code) {
    case 'ArrowUp':
    case 'KeyW':
      held.throttle = pressed;
      return true;
    case 'ArrowDown':
    case 'KeyS':
      held.brake = pressed;
      return true;
    case 'ArrowLeft':
    case 'KeyA':
      held.steerLeft = pressed;
      return true;
    case 'ArrowRight':
    case 'KeyD':
      held.steerRight = pressed;
      return true;
    case 'Space':
      held.handbrake = pressed;
      return true;
    case 'KeyR':
      if (pressed) held.reset = true;
      return true;
    default:
      return false;
  }
}

function rampToward(current: number, target: number, step: number): number {
  if (current < target) return Math.min(current + step, target);
  if (current > target) return Math.max(current - step, target);
  return current;
}
