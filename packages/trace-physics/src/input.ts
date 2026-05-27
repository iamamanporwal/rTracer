/**
 * Control input — the only thing the vehicle controller reads each tick.
 *
 * Per blueprint §7.3, the same shape is produced by keyboard, gamepad, wheel,
 * and touch HUD. The mapping layer lives in `apps/web/src/zone/input.ts`; this
 * package only defines the contract.
 *
 * All fields are normalized:
 * - throttle/brake/handbrake: 0..1
 * - steering: -1..1 (left negative, right positive)
 * - gear: integer; 0 = neutral, 1..N = forward, -1 = reverse. Phase 1 W2 uses
 *   automatic shifting, so the controller may write back.
 */
export type ControlInput = {
  throttle: number;
  brake: number;
  steering: number;
  handbrake: number;
  reset: boolean;
};

export const NEUTRAL_INPUT: ControlInput = Object.freeze({
  throttle: 0,
  brake: 0,
  steering: 0,
  handbrake: 0,
  reset: false,
});

/** Clamp every channel to its legal range. The input pipeline is paranoid because gamepads lie. */
export function clampInput(input: ControlInput): ControlInput {
  return {
    throttle: clamp01(input.throttle),
    brake: clamp01(input.brake),
    steering: clampSigned(input.steering),
    handbrake: clamp01(input.handbrake),
    reset: input.reset,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clampSigned(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
