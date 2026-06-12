# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install          # install all workspace dependencies (pnpm ≥9, Node ≥20.11)
pnpm dev              # Vite dev server at http://localhost:5173
pnpm build            # production build — apps/web → dist/
pnpm typecheck        # tsc across all packages
pnpm lint             # ESLint across all packages
pnpm test             # Vitest unit tests across all packages
pnpm test:e2e         # Playwright E2E (requires build)

# Run a single test file
pnpm --filter @trace/physics test -- packages/trace-physics/src/movement/car/chassis.test.ts

# Run tests for one package only
pnpm --filter @trace/physics test

# Asset CLI (currently a no-op stub until Phase 1 W4)
pnpm trace asset ingest path/to.glb --kind zone --id zone_demo --version 0.1.0
```

## Architecture

### Monorepo

Three roots: `apps/` (deployable SPA), `packages/` (framework-agnostic libraries), `tools/` (CLI). Turbo runs tasks in dependency order. Build graph, innermost first:

```
@trace/core → @trace/physics
@trace/core → @trace/renderer
@trace/core + @trace/physics + @trace/renderer → apps/web (@trace/web)
```

### Package roles

- **`@trace/core`** — Zero runtime deps (Zod only). Math tuples (`Vec3`, `Quat`), Zod manifest schemas (`ZoneManifest`, `VehicleManifest`, `SemanticSidecar`), typed event bus factory, surface tag constants. Safe in any environment.
- **`@trace/physics`** — Only package that imports Rapier. Owns the rigid-body world, raycast vehicle controller, and drivetrain math. Outputs plain `MovementSnapshot` — Rapier types never cross the package boundary.
- **`@trace/renderer`** — Only package that imports Three.js. Owns scene, materials, vehicle/zone visuals, camera rig, FX, weather. Never imports from physics — takes `MovementSnapshot` as input.
- **`apps/web`** — Vite + React SPA. Coordinates everything via `startZoneSession()` in `apps/web/src/zone/session.ts`. React manages UI; the session manages 3D/physics.
- **`@trace/softbody`** / **`@trace/editor`** — Phase 0 stubs; version constants only.

### Physics ↔ Renderer seam

These two packages never import each other. Communication is via:
- **`MovementSnapshot`** — position, quaternion, per-wheel pose, speed. Written by physics, read by renderer each frame.
- **`TraceEvents`** (typed event bus from `@trace/core`) — physics emits `collision:impact`, renderer/UI subscribes.

### Game loop (`apps/web/src/zone/loop.ts`)

Fixed-timestep with interpolated render:
```
accumulator += wallClockDt
while accumulator >= FIXED_DT and steps < 5:
    physics.world.step()
    accumulator -= FIXED_DT
renderer.render(alpha = accumulator / FIXED_DT)
```
`FIXED_DT = 1/60`. The render's `alpha` is the interpolation factor for smooth visuals between physics ticks.

### Zone session (`apps/web/src/zone/session.ts`)

`startZoneSession(init)` creates and wires all subsystems, starts the loop, and returns a `ZoneSession` with `dispose()`. React's cleanup effect calls `dispose()` on unmount. Every subsystem (physics world, Three.js renderer, vehicle, zone visual) is created fresh per session and torn down completely — there are no shared globals.

### Manifests

Everything is manifest-driven. Zone geometry, vehicle parameters, physics profiles — runtime never hardcodes vehicle- or track-specific values. Manifests are JSON fetched from `/assets/{zones,vehicles}/{id}/v{ver}/manifest.json` and Zod-validated before use. `ManifestLoadError` carries the URL and Zod chain for traceable failures.

### Car controller layering (`packages/trace-physics/src/movement/car/`)

Three pure layers under the Rapier wiring:
- `chassis.ts` — `deriveCarChassis()`: pure geometry (extents, COM, strut Y, ride height). Unit-testable without Rapier.
- `drivetrain.ts` — `computeDriveCommand()`: engine force, ABS, handbrake drift, burnout. Unit-testable.
- `controller.ts` — `createCarController()`: wires Rapier using the above two.

**Critical sign constants** in `config.ts`: `FORWARD_SIGN = -1` and `STEER_SIGN = -1` are locked by `vehicle.drive.test.ts`. Do not change these without re-deriving the full force/steer chain.

### Vehicle visuals

Two implementations of the same `VehicleVisual` interface:
- `createVehicleVisual()` — procedural SUV, no assets needed (dev/test)
- `createGlbVehicleVisual()` — rigged GLB. Wheels are reparented onto spin pivots at construction; `applySnapshot()` drives transforms. GLB glass (`KHR_materials_transmission`) is intentionally downgraded to glossy-opaque for mobile performance.

### Weather + wet grip

`createWeatherSystem()` owns the sky dome, cloud field, rain particles, and lighting atomically. `weather.wetness` (0–1) is piped to `vehicle.setGripMultiplier(1 - wetness * 0.3)` each render frame — grip is modified at runtime without mutating the zone's physics profile (the profile is read-only per session).

The **sky dome** (`sky.ts`) is a gradient + sun (disc/halo, aligned to the directional light) — no clouds. **Clouds** (`clouds.ts`) are a separate billboard field: at init it keys the source PNGs in `public/assets/sky/` into alpha "brushes" (the realistic photo `cloud-b` for detail, the silhouette `cloud-a` blurred for soft body) and bakes cloud stamps by dabbing those brushes several times — a lumpy core with ragged, radial-feathered edges (so a cloud is never "cut" and shows no sprite-quad rectangle). It then scatters camera-following sprites that drift on wind and fade at the slab edge. Each preset in `weather.ts` sets the cloud tint + coverage and the dome's sun-glow.

### Input contract

All input devices (keyboard, gamepad) normalize to:
```typescript
{ throttle: 0..1, brake: 0..1, steering: -1..1, handbrake: 0..1, reset: boolean }
```
Polled once per fixed step from `createKeyboardInput()` / `createCameraInput()`.

## Key invariants

- **No `any`** — use `unknown` at boundaries, narrow inside.
- **Zod at every external boundary** — manifests, `fetch()`, `postMessage`, IndexedDB.
- **Factory functions, not singletons** — `createEventBus()`, `createPhysicsWorld()`, etc. Tests own their instances.
- **Zero allocations in hot paths** — no `.map`/`.filter`/`new THREE.Vector3()` per frame. Pre-allocate scratch pads.
- **Import from package barrels** — `import { x } from '@trace/core'`, never deep paths.
- **PR title format** — `[P1-23] short description` (cite blueprint task IDs).

## Asset conventions

Assets are static files under `apps/web/public/assets/`. Path: `assets/{zones,vehicles}/{id}/v{ver}/manifest.json`. The `index.json` in each root lists available items. See `Docs/ASSETS.md` for manifest field reference.

## Testing notes

Physics unit tests in `packages/trace-physics/src/movement/car/*.test.ts` test `chassis.ts` and `drivetrain.ts` directly (no Rapier world needed). Stability tests (`stability.test.ts`) run a full Rapier sim for 600 steps. Web unit tests in `apps/web/src/**/*.test.ts` use Vitest + jsdom.

## Docs

`Docs/` contains practical engineering references:
- `ENGINEERING_GUIDE.md` — setup, architecture overview, house rules, navigation map
- `PACKAGES.md` — per-package public API reference
- `ZONE_SESSION.md` — session lifecycle, game loop, input, state management, how to add zones/vehicles
- `ASSETS.md` — manifest schemas, GLB requirements, surface tags, physics profiles
- `TRACE_BLUEPRINT.md` — canonical spec (architecture §1–§18, week plan §19–§24). Cite section numbers in commits/PRs.
