/**
 * Fixed-timestep loop per blueprint §5.2.
 *
 * Three properties this buys us:
 *   - **determinism within a session** (replays from telemetry work),
 *   - **no render-induced physics jitter**,
 *   - **mobile safety valve** (`MAX_SUBSTEPS` prevents spiral-of-death).
 *
 * The loop is renderer-agnostic and physics-agnostic. Callers wire it to
 * Rapier + Three by passing `step` and `render` callbacks.
 */

export const FIXED_DT = 1 / 60;
export const MAX_SUBSTEPS = 5;
const MAX_FRAME_DT = 0.25;

export type LoopCallbacks = {
  /** Called at fixed `FIXED_DT` intervals. May fire up to `MAX_SUBSTEPS` times per frame. */
  step(dt: number): void;
  /**
   * Called once per rAF after `step`s.
   *
   * `alpha` is `accumulator / FIXED_DT`, **clamped to [0, 1]** — use it to
   * interpolate transforms between the previous and current physics step.
   * Clamping matters when a heavy frame saturates `MAX_SUBSTEPS`: without it the
   * leftover accumulator pushes `alpha > 1` and consumers extrapolate *past* the
   * latest pose, then snap back next frame (visible jitter). Renderers that
   * don't interpolate may ignore it.
   *
   * `frameDt` is the wall-clock delta for this rendered frame (seconds, already
   * clamped to `MAX_FRAME_DT`). It is the single authoritative frame clock —
   * consumers must use it for time-based effects (smoke, weather, FPS) rather
   * than reading `performance.now()` again, so every subsystem advances on one
   * consistent clock.
   */
  render(alpha: number, frameDt: number): void;
};

export type Loop = {
  readonly running: boolean;
  start(): void;
  stop(): void;
};

/**
 * Build a loop. Does not start until `start()` is called.
 *
 * @example
 *   const loop = createLoop({
 *     step: (dt) => physics.step(dt),
 *     render: (alpha) => renderer.render(scene, camera),
 *   });
 *   loop.start();
 *   // ...
 *   loop.stop();
 */
export function createLoop(callbacks: LoopCallbacks): Loop {
  let rafId = 0;
  let accumulator = 0;
  let last = 0;
  let running = false;

  function frame(now: number): void {
    if (!running) return;
    const dtRaw = (now - last) / 1000;
    const dt = dtRaw > MAX_FRAME_DT ? MAX_FRAME_DT : dtRaw;
    last = now;
    accumulator += dt;

    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      callbacks.step(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }

    // Clamp to [0, 1]. After the loop the accumulator is normally < FIXED_DT,
    // but if we hit MAX_SUBSTEPS it can still hold a full step or more — capping
    // alpha keeps interpolation strictly *between* prev and curr (no overshoot).
    const alpha = accumulator >= FIXED_DT ? 1 : accumulator / FIXED_DT;
    callbacks.render(alpha, dt);

    rafId = requestAnimationFrame(frame);
  }

  return {
    get running(): boolean {
      return running;
    },
    start(): void {
      if (running) return;
      running = true;
      last = performance.now();
      accumulator = 0;
      rafId = requestAnimationFrame(frame);
    },
    stop(): void {
      if (!running) return;
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    },
  };
}
