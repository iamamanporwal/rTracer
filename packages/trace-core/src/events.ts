import type { Vec3 } from './math/vec';
import type { SurfaceTag } from './surface';

/**
 * Cross-module events per blueprint §5.3.
 *
 * Every system **publishes** events and **never reaches into another system's
 * internals**. Telemetry, HUD, scoring, and the soft-body worker all subscribe.
 *
 * Add a new event by extending {@link TraceEvents}; the bus stays type-safe
 * automatically.
 */
export type TraceEvents = {
  'collision:impact': {
    force: number;
    point: Vec3;
    normal: Vec3;
    otherId: number;
    tag: SurfaceTag;
  };
  'lap:crossed_start': { t: number; valid: boolean };
  'lap:crossed_checkpoint': { checkpointId: string; t: number };
  'track:left_limits': { wheelIndex: 0 | 1 | 2 | 3; durationMs: number };
  'vehicle:reset': { reason: 'manual' | 'flipped' | 'stuck' };
  'softbody:plastic': { totalDisplacement: number };
};

export type TraceEventKey = keyof TraceEvents;
export type TraceEventPayload<K extends TraceEventKey> = TraceEvents[K];

/** Unsubscribe handle returned by {@link EventBus.on}. */
export type Unsubscribe = () => void;

export interface EventBus {
  on<K extends TraceEventKey>(
    key: K,
    handler: (payload: TraceEventPayload<K>) => void,
  ): Unsubscribe;
  emit<K extends TraceEventKey>(key: K, payload: TraceEventPayload<K>): void;
  /** Remove every handler. Call from session teardown. */
  clear(): void;
}

/**
 * In-memory event bus. One instance per zone session — do not share across
 * sessions, do not promote to a module singleton (per §18.3, no mutable
 * singletons).
 *
 * @example
 *   const bus = createEventBus();
 *   const off = bus.on('collision:impact', e => console.log(e.force));
 *   bus.emit('collision:impact', { force: 12, point: [0,0,0], normal: [0,1,0], otherId: 1, tag: 'barrier' });
 *   off();
 */
export function createEventBus(): EventBus {
  const handlers = new Map<TraceEventKey, Set<(payload: unknown) => void>>();

  return {
    on(key, handler) {
      let set = handlers.get(key);
      if (!set) {
        set = new Set();
        handlers.set(key, set);
      }
      const erased = handler as (payload: unknown) => void;
      set.add(erased);
      return () => {
        set?.delete(erased);
      };
    },
    emit(key, payload) {
      const set = handlers.get(key);
      if (!set) return;
      for (const handler of set) {
        handler(payload);
      }
    },
    clear() {
      handlers.clear();
    },
  };
}
