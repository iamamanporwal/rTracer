# rTracer Engineering Guide

> Quick orientation for engineers joining the project. For the canonical spec, always refer to [`TRACE_BLUEPRINT.md`](TRACE_BLUEPRINT.md). This guide is the _practical_ companion.

---

## What is this?

**Trace** is a browser-native motorsport sandbox — a single-player racing game built for the web. It runs entirely in the browser using WebGL (Three.js) for rendering and WASM (Rapier) for physics. The app is a Vite + React SPA deployed to Vercel.

The core loop: pick a zone (track), pick a vehicle, drive. Physics runs at a fixed 60 Hz timestep; rendering runs at whatever the display supports. Input arrives from keyboard or gamepad and is normalized to a simple `ControlInput` structure before being passed to the physics engine.

---

## Monorepo Layout

```
trace/
├── apps/
│   └── web/                    # The product — Vite + React SPA
├── packages/
│   ├── trace-core/             # Pure TS: math types, schemas, events. No deps beyond Zod.
│   ├── trace-physics/          # Rapier wrapper + car controller + physics profiles
│   ├── trace-renderer/         # Three.js scene, materials, camera, FX, weather
│   ├── trace-softbody/         # Mass-spring solver stub (Phase 1 W5)
│   └── trace-editor/           # Sidecar authoring tool stub (Phase 1 W8)
└── tools/
    └── asset-cli/              # Local CLI for ingesting/processing 3D assets
```

**Package dependency order** (build graph, innermost first):

```
trace-core → trace-physics
trace-core → trace-renderer
trace-core + trace-physics + trace-renderer → apps/web
```

`trace-core` has zero runtime deps (Zod only). It is safe to import from workers, Node scripts, or any package.

---

## Tech Stack

| Layer | Library | Version | Why |
|-------|---------|---------|-----|
| Physics | Rapier | 0.14.0 | Deterministic WASM rigid-body + raycast vehicle |
| Graphics | Three.js | 0.169.0 | Mature WebGL abstraction |
| App | React | 18.3.1 | UI framework |
| Routing | TanStack Router | 1.79.0 | Type-safe SPA routing |
| State | Zustand + Immer | 5.0.0 | Minimal reactive state |
| Schema | Zod | 3.23.8 | Runtime validation at all external boundaries |
| Build | Vite | 5.4.10 | Fast HMR dev server, ESM bundles |
| Monorepo | Turbo | 2.1.3 | Task orchestration (build order, caching) |
| Packages | pnpm | ≥9.0.0 | Workspace management |
| Language | TypeScript | 5.6.3 | Strict mode — no `any`, no `unknown` leaks |
| Testing | Vitest | 2.1.4 | Unit tests (physics math, schemas) |
| E2E | Playwright | 1.48.2 | Browser-level integration tests |
| Error tracking | Sentry | 8.36.0 | Production error reporting |
| CSS | Tailwind | 3.4.14 | Utility-first styling |

---

## Development Workflow

### Requirements
- Node ≥ 20.11 (pin via `.nvmrc`)
- pnpm ≥ 9.0.0

### Common commands

```bash
pnpm install          # Install all workspace dependencies
pnpm dev              # Start dev server at http://localhost:5173
pnpm build            # Production build (apps/web → dist/)
pnpm typecheck        # tsc across all packages
pnpm lint             # ESLint across all packages
pnpm test             # Vitest unit tests across all packages
pnpm test:e2e         # Playwright E2E (requires build first)
pnpm trace asset ingest path/to.glb --kind zone --id zone_demo  # Asset CLI
```

### Branching & PRs

Branch naming: `p1-23-softbody-solver` (task ID prefix)
PR title: `[P1-23] Short description`

Every PR must pass: `lint → typecheck → unit tests → E2E → perf gate (p99 frame time ≤ 110% of baseline)`.

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the full definition of done.

---

## House Rules

These rules exist to prevent the most common performance and correctness regressions. Do not compromise on them in a hot path.

| Rule | Rationale |
|------|-----------|
| **No `any`** | Use `unknown` at boundaries, narrow with type guards |
| **Zod at every external boundary** | Manifests, `fetch()`, `postMessage`, IndexedDB reads |
| **Factory functions, not singletons** | Tests must be able to create isolated instances |
| **Zero allocations in hot paths** | No `.map`/`.filter`/`new Vector3()` per frame — reuse scratch pads |
| **Package barrels only** | `import { x } from '@trace/core'`, never `import { x } from '@trace/core/src/math/vec'` |
| **One reason per file** | Two unrelated things → split |
| **Comments answer "why", not "what"** | Code shows what; comments explain the constraint or invariant |
| **`kebab-case.ts` files, `PascalCase` types, `SCREAMING_SNAKE` constants** | Consistent, searchable |
| **No `console.log` in commits** | Use the typed logger: `debug/info/warn/error` |

---

## Key Architectural Patterns

### Manifests → Runtime

Everything starts from a JSON manifest validated by Zod. Zone geometry, vehicle parameters, physics profiles — all driven by manifest data. The runtime never hardcodes track-specific or vehicle-specific values.

```
/assets/zones/{id}/v{ver}/manifest.json  →  ZoneManifest (Zod)  →  startZoneSession()
/assets/vehicles/{id}/v{ver}/manifest.json  →  VehicleManifest (Zod)  →  createVehicle()
```

### Physics ↔ Renderer seam

These two systems never import each other. They communicate through plain data types:

- **`MovementSnapshot`** — position, quaternion, per-wheel pose, speed. Written by physics, read by renderer.
- **`TraceEvents`** — typed event bus (collision impacts, lap events). Physics emits; renderer/UI subscribes.

```
Physics step → MovementSnapshot → renderer.applySnapshot(snapshot)
Physics step → events.emit('collision:impact', data) → deformer / HUD
```

### Fixed-timestep loop

The game loop in `apps/web/src/zone/loop.ts` runs physics at a fixed 1/60s step and renders at the display's native rate. Up to 5 physics steps can run per render frame to handle frame drops. The render function receives an `alpha` (0..1) interpolation factor for smooth visuals between steps.

```typescript
// Each frame:
for (let i = 0; i < maxSteps && accumulator >= FIXED_DT; i++) {
  physics.step(FIXED_DT)
  accumulator -= FIXED_DT
}
renderer.render(alpha = accumulator / FIXED_DT)
```

### Input contract

All inputs are normalized before entering physics. Keyboard, gamepad, or touch all produce the same `ControlInput`:

```typescript
interface ControlInput {
  throttle:  number  // 0..1
  brake:     number  // 0..1
  steering:  number  // -1..1 (left negative, right positive)
  handbrake: number  // 0..1
  reset:     boolean
}
```

---

## Navigation: Where to Find Things

| Question | Where to look |
|----------|---------------|
| How does the car physics work? | [`PACKAGES.md#trace-physics`](PACKAGES.md#tracephysics) + `packages/trace-physics/src/movement/car/` |
| How does rendering work? | [`PACKAGES.md#trace-renderer`](PACKAGES.md#tracerenderer) + `packages/trace-renderer/src/` |
| How does a zone session start? | [`ZONE_SESSION.md`](ZONE_SESSION.md) + `apps/web/src/zone/session.ts` |
| What goes in a manifest? | [`ASSETS.md`](ASSETS.md) + `packages/trace-core/src/manifests/` |
| What tasks are left? | [`TRACE_BLUEPRINT.md`](TRACE_BLUEPRINT.md) §19–§24 |
| How to deploy? | [`PHASE_0_HANDOFF.md`](PHASE_0_HANDOFF.md) |
| App routing and state | `apps/web/src/router.tsx`, `apps/web/src/store/` |
