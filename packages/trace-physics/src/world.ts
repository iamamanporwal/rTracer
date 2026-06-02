import RAPIER from '@dimforge/rapier3d-compat';

/**
 * Rapier world wrapper. One per zone session — owns the WASM lifecycle so the
 * runtime never sees Rapier types in a "not yet initialized" state.
 *
 * Call {@link initRapier} once per page load, then {@link createPhysicsWorld}
 * per zone load. `dispose()` frees Rapier-owned memory (the chassis body, all
 * colliders, the vehicle controller) — call from the React effect cleanup.
 */

let rapierReady: Promise<typeof RAPIER> | null = null;

/**
 * Initialize Rapier's WASM module exactly once. Safe to call from concurrent
 * effects; subsequent calls await the first.
 */
export function initRapier(): Promise<typeof RAPIER> {
  if (!rapierReady) {
    rapierReady = RAPIER.init().then(() => RAPIER);
  }
  return rapierReady;
}

/**
 * A single collision impact harvested from the last {@link PhysicsWorld.step}.
 *
 * Pure plain numbers — no Rapier handles leak past `step`. The renderer's mesh
 * deformation reads these each frame: `point` is the world-space contact, and
 * `magnitude` (summed contact-force magnitude, Newtons-ish) scales the crush
 * depth. `bodyA`/`bodyB` are the rigid-body handles of the two colliders so a
 * consumer can tell whether the player's chassis was involved.
 *
 * Only pairs where at least one collider has `ActiveEvents.CONTACT_FORCE_EVENTS`
 * enabled (the chassis — see the car controller) produce these, and only when
 * the summed force exceeds that collider's contact-force threshold.
 */
export type Impact = {
  /** Rigid-body handle of the first collider's parent (−1 if none). */
  bodyA: number;
  /** Rigid-body handle of the second collider's parent (−1 if none). */
  bodyB: number;
  /** World-space contact point (averaged over the pair's solver contacts). */
  point: { x: number; y: number; z: number };
  /** Summed magnitude of the contact forces this step. */
  magnitude: number;
};

export type PhysicsWorld = {
  /** The underlying Rapier world. Owned by this wrapper — do not free directly. */
  readonly world: RAPIER.World;
  /** Step the simulation by one fixed timestep, collecting contact impacts. */
  step(): void;
  /**
   * Invoke `cb` for every impact harvested since the previous drain, then clear
   * the buffer. Impacts accumulate across all `step`s between two drains, so a
   * frame that ran several fixed steps still sees every collision exactly once.
   */
  drainImpacts(cb: (impact: Impact) => void): void;
  /** Free all Rapier-owned memory. After dispose, the world must not be used. */
  dispose(): void;
};

export type PhysicsWorldOptions = {
  /** Gravity vector (m/s²). Default: Earth Y-down. */
  gravity?: { x: number; y: number; z: number };
  /** Fixed timestep in seconds. Default: 1/60 (per §5.2). */
  timestep?: number;
  /**
   * Constraint solver iterations. More iterations = stiffer, less jittery
   * stacks/suspension at a modest CPU cost. Default 8 (Rapier's own default is
   * 4) — chosen to keep the raycast vehicle planted without hurting mobile.
   */
  numSolverIterations?: number;
};

/** Hard cap on buffered impacts between drains — a runaway guard, never hit in practice. */
const MAX_BUFFERED_IMPACTS = 256;

/**
 * Create a fresh Rapier world. Caller must have awaited {@link initRapier}.
 *
 * @example
 *   await initRapier();
 *   const physics = createPhysicsWorld();
 *   // ...
 *   physics.dispose();
 */
export function createPhysicsWorld(options: PhysicsWorldOptions = {}): PhysicsWorld {
  const gravity = options.gravity ?? { x: 0, y: -9.81, z: 0 };
  const timestep = options.timestep ?? 1 / 60;

  const world = new RAPIER.World(gravity);
  world.timestep = timestep;
  world.numSolverIterations = options.numSolverIterations ?? 8;

  // Contact-force events flow through this queue each step. `autoDrain: true`
  // clears the WASM-side buffer at the start of every `world.step`, so the only
  // bookkeeping we own is the JS-side `pending` array below.
  const events = new RAPIER.EventQueue(true);

  // Impacts harvested this drain-cycle. Reused (length reset) on drain, with a
  // small object pool so a steady stream of collisions allocates nothing.
  const pending: Impact[] = [];
  const pool: Impact[] = [];

  const acquire = (): Impact => {
    const reused = pool.pop();
    if (reused) return reused;
    return { bodyA: -1, bodyB: -1, point: { x: 0, y: 0, z: 0 }, magnitude: 0 };
  };

  /** Average the world-space solver contact points of a collider pair into `out`. */
  function contactPointInto(
    a: RAPIER.Collider,
    b: RAPIER.Collider,
    out: { x: number; y: number; z: number },
  ): boolean {
    let n = 0;
    out.x = 0;
    out.y = 0;
    out.z = 0;
    world.contactPair(a, b, (manifold) => {
      const count = manifold.numSolverContacts();
      for (let i = 0; i < count; i++) {
        const p = manifold.solverContactPoint(i);
        if (!p) continue;
        out.x += p.x;
        out.y += p.y;
        out.z += p.z;
        n++;
      }
    });
    if (n === 0) return false;
    out.x /= n;
    out.y /= n;
    out.z /= n;
    return true;
  }

  return {
    world,
    step() {
      world.step(events);
      events.drainContactForceEvents((event) => {
        if (pending.length >= MAX_BUFFERED_IMPACTS) return;
        const h1 = event.collider1();
        const h2 = event.collider2();
        const c1 = world.getCollider(h1);
        const c2 = world.getCollider(h2);
        if (!c1 || !c2) return;

        const impact = acquire();
        if (!contactPointInto(c1, c2, impact.point)) {
          // No solver contacts to localize the hit — fall back to the midpoint
          // of the two body translations so the dent still lands sensibly.
          const p1 = c1.parent()?.translation();
          const p2 = c2.parent()?.translation();
          if (p1 && p2) {
            impact.point.x = (p1.x + p2.x) * 0.5;
            impact.point.y = (p1.y + p2.y) * 0.5;
            impact.point.z = (p1.z + p2.z) * 0.5;
          } else {
            pool.push(impact);
            return;
          }
        }
        impact.bodyA = c1.parent()?.handle ?? -1;
        impact.bodyB = c2.parent()?.handle ?? -1;
        impact.magnitude = event.totalForceMagnitude();
        pending.push(impact);
      });
    },
    drainImpacts(cb) {
      for (const impact of pending) {
        cb(impact);
        pool.push(impact);
      }
      pending.length = 0;
    },
    dispose() {
      events.free();
      world.free();
    },
  };
}
