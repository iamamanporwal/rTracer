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

export type PhysicsWorld = {
  /** The underlying Rapier world. Owned by this wrapper — do not free directly. */
  readonly world: RAPIER.World;
  /** Step the simulation by one fixed timestep. */
  step(): void;
  /** Free all Rapier-owned memory. After dispose, the world must not be used. */
  dispose(): void;
};

export type PhysicsWorldOptions = {
  /** Gravity vector (m/s²). Default: Earth Y-down. */
  gravity?: { x: number; y: number; z: number };
  /** Fixed timestep in seconds. Default: 1/60 (per §5.2). */
  timestep?: number;
};

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

  return {
    world,
    step() {
      world.step();
    },
    dispose() {
      world.free();
    },
  };
}
