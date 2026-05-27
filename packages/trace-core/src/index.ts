/**
 * @trace/core — pure TS, manifests + math + scoring substrate.
 *
 * No runtime deps beyond Zod. Safe to import from main thread, worker, or
 * Node tooling.
 */
export const TRACE_CORE_VERSION = '0.0.0';

export * from './math';
export * from './manifests';
export * from './events';
export * from './surface';
