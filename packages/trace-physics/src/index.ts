/**
 * @trace/physics — Rapier wrapper, vehicle controller, profile parameter sets.
 *
 * Phase 1 W2 surface: world lifecycle, ground collider, vehicle from manifest.
 * Soft-body (W5) lives in `@trace/softbody` and talks to this package over a
 * SharedArrayBuffer — never via direct imports.
 */
export const TRACE_PHYSICS_VERSION = '0.0.0';

export * from './profiles';
export * from './world';
export * from './ground';
export * from './obstacles';
export * from './input';
export * from './movement';
export * from './vehicle';
