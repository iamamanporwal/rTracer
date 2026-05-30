import type { ControlInput } from '@trace/physics';

/**
 * Keyboard → {@link ControlInput} mapping for Phase 1 W2.
 *
 * One global keyboard listener — gamepad + wheel sources are additive and land
 * in W3 (P1-13). Throttle/brake/steering ramp toward the held value so the
 * box-car feels driveable; W3 adds the speed-sensitive return-to-center torque
 * on the physics side and removes the simple ramp on this side.
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

export type InputDriver = {
  /** Advance smoothing by `dt` and return the latest control state. Allocates nothing. */
  sample(dt: number): ControlInput;
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

export function createKeyboardInput(): InputDriver {
  const held: Held = {
    throttle: false,
    brake: false,
    steerLeft: false,
    steerRight: false,
    handbrake: false,
    reset: false,
  };

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

  return {
    sample(dt) {
      state.throttle = rampToward(state.throttle, held.throttle ? 1 : 0, THROTTLE_RAMP_PER_SEC * dt);
      state.brake = rampToward(state.brake, held.brake ? 1 : 0, BRAKE_RAMP_PER_SEC * dt);
      state.handbrake = held.handbrake ? 1 : 0;

      const target = held.steerLeft ? -1 : held.steerRight ? 1 : 0;
      if (target === 0) {
        state.steering = rampToward(state.steering, 0, STEER_RECENTER_PER_SEC * dt);
      } else {
        state.steering = rampToward(state.steering, target, STEER_RAMP_PER_SEC * dt);
      }
      state.reset = held.reset;
      held.reset = false; // edge-trigger
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
