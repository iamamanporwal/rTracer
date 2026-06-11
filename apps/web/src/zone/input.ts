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

/**
 * Raw on/off state of each control intent — the OR of keyboard and touch, BEFORE
 * the analog ramping `sample()` applies. The dev-mode input logger reads this so
 * a keycap lights crisply the instant a key goes down and clears the instant it
 * comes up, instead of trailing the smoothed throttle/steer value.
 *
 * WASD + Space are *intents* (keyboard ∪ touch). The four arrow keys are tracked
 * *literally* and separately: they're the bike's lean/steer controls, and both
 * the dev input logger and the telemetry recorder need to know which physical
 * arrow is down — not just the merged steering/lean value it folds into.
 */
export type InputActive = {
  /** W — throttle intent (keyboard or touch). */
  throttle: boolean;
  /** S — brake intent. */
  brake: boolean;
  /** A — steer-left intent (keyboard A or touch pad). */
  left: boolean;
  /** D — steer-right intent. */
  right: boolean;
  /** Space — handbrake. */
  handbrake: boolean;
  /** ↑ arrow — bike lean-forward (stoppie). Raw key state. */
  up: boolean;
  /** ↓ arrow — bike lean-back (wheelie). Raw key state. */
  down: boolean;
  /** ← arrow — steer-left (also folds into the steering intent). Raw key state. */
  arrowLeft: boolean;
  /** → arrow — steer-right (also folds into the steering intent). Raw key state. */
  arrowRight: boolean;
};

export type InputDriver = {
  /** Advance smoothing by `dt` and return the latest control state. Allocates nothing. */
  sample(dt: number): ControlInput;
  /**
   * Live raw button state, refreshed by each {@link sample}. A stable object
   * mutated in place (alloc-free) — read it, don't retain a snapshot. Drives the
   * dev-mode input logger.
   */
  readonly active: InputActive;
  /** On-screen touch control surface — driven by the mobile HUD buttons. */
  readonly touch: TouchControls;
  /** Remove window listeners and reset state. */
  dispose(): void;
};

type Held = {
  throttle: boolean;
  brake: boolean;
  /** A key. */
  steerLeftKey: boolean;
  /** D key. */
  steerRightKey: boolean;
  handbrake: boolean;
  /** ↑ arrow — lean forward (with brake → stoppie). */
  arrowUp: boolean;
  /** ↓ arrow — lean back (with throttle → wheelie). */
  arrowDown: boolean;
  /** ← arrow — steer left (mirrors A into the steering intent). */
  arrowLeft: boolean;
  /** → arrow — steer right (mirrors D into the steering intent). */
  arrowRight: boolean;
  reset: boolean;
};

function blankHeld(): Held {
  return {
    throttle: false,
    brake: false,
    steerLeftKey: false,
    steerRightKey: false,
    handbrake: false,
    arrowUp: false,
    arrowDown: false,
    arrowLeft: false,
    arrowRight: false,
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
    pitchLean: 0,
    reset: false,
  };

  // Live raw button state for the dev input logger. Mutated in place each sample.
  const active: InputActive = {
    throttle: false,
    brake: false,
    left: false,
    right: false,
    handbrake: false,
    up: false,
    down: false,
    arrowLeft: false,
    arrowRight: false,
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
      tap.steerLeftKey = dir === -1;
      tap.steerRightKey = dir === 1;
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
      tap.steerLeftKey = false;
      tap.steerRightKey = false;
      tap.handbrake = false;
    },
  };

  return {
    touch,
    active,
    sample(dt) {
      const throttle = held.throttle || tap.throttle;
      const brake = held.brake || tap.brake;
      const handbrake = held.handbrake || tap.handbrake;
      // Steering folds A/D and ←/→ together (either steers); touch feeds the A/D
      // side. Lean comes only from the ↑/↓ arrows (keyboard).
      const steerLeft = held.steerLeftKey || held.arrowLeft || tap.steerLeftKey;
      const steerRight = held.steerRightKey || held.arrowRight || tap.steerRightKey;
      const leanBack = held.arrowDown;
      const leanForward = held.arrowUp;

      // Mirror the raw state for the dev logger (pre-ramp, crisp on/off). WASD
      // are intents (key ∪ touch); the arrows are the literal key so the logger
      // and telemetry can show / record each physical arrow distinctly.
      active.throttle = throttle;
      active.brake = brake;
      active.left = held.steerLeftKey || tap.steerLeftKey;
      active.right = held.steerRightKey || tap.steerRightKey;
      active.handbrake = handbrake;
      active.up = held.arrowUp;
      active.down = held.arrowDown;
      active.arrowLeft = held.arrowLeft;
      active.arrowRight = held.arrowRight;

      state.throttle = rampToward(state.throttle, throttle ? 1 : 0, THROTTLE_RAMP_PER_SEC * dt);
      state.brake = rampToward(state.brake, brake ? 1 : 0, BRAKE_RAMP_PER_SEC * dt);
      state.handbrake = handbrake ? 1 : 0;
      // Pitch-lean is a discrete modifier (no ramp): ↓ = +1 (lean back/wheelie),
      // ↑ = -1 (lean forward/stoppie).
      state.pitchLean = leanBack ? 1 : leanForward ? -1 : 0;

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
    case 'KeyW':
      held.throttle = pressed;
      return true;
    case 'KeyS':
      held.brake = pressed;
      return true;
    // ↑/↓ are the bike's rider-lean (GTA wheelie/stoppie), distinct from W/S so
    // "↓ + W" (lean back + throttle) and "↑ + S" (lean forward + brake) don't
    // collide with throttle/brake. Cars ignore lean. (W/S/A/D still drive.)
    case 'ArrowUp':
      held.arrowUp = pressed;
      return true;
    case 'ArrowDown':
      held.arrowDown = pressed;
      return true;
    // A/D and ←/→ both steer, but they live on separate flags so the dev logger
    // and telemetry can tell an arrow press apart from a WASD press.
    case 'KeyA':
      held.steerLeftKey = pressed;
      return true;
    case 'KeyD':
      held.steerRightKey = pressed;
      return true;
    case 'ArrowLeft':
      held.arrowLeft = pressed;
      return true;
    case 'ArrowRight':
      held.arrowRight = pressed;
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
