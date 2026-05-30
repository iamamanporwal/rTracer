# Trace — Engineering Blueprint

> Browser-native motorsport sandbox. Hub world + addressable zones + a player passport.
> Single source of truth: technical architecture **and** phased execution plan.
> Derived from [Trace_PRD_v0.2.docx](Trace_PRD_v0.2.docx).

**Status:** v1.0 — normative for Phase 1, indicative for Phase 2/3.
**Audience:** every engineer (human or LLM) that touches Trace.

---

## 0. How to Read This

Two halves:

- **Part I (§1–§18): Architecture.** Every section names the module/file/contract you will build. If something is vague, fix the doc before writing code.
- **Part II (§19–§24): Planner.** Phase 0 → Phase 1 (week-by-week) → Phase 2 → Phase 3, with task IDs and exit gates.

Three rules everyone follows:

1. **No global mutable state.** Cross-module communication is (a) typed event bus, (b) Zustand store, or (c) `SharedArrayBuffer` for worker hot paths.
2. **Physics and render are decoupled** by a fixed-timestep accumulator. No rendering inside physics steps; no physics inside the render frame.
3. **Every imported asset is data.** Zones, vehicles, sidecars, procedural seeds — JSON manifests pointing at binary blobs. The runtime is a deterministic interpreter of those manifests.

---

# Part I — Architecture

## 1. The Product Surface (one screen)

| Surface    | What it is                                                     | Where it lives              |
| ---------- | -------------------------------------------------------------- | --------------------------- |
| Hub        | React UI: zone select, vehicle select, passport view           | DOM, React 18, Zustand      |
| Zone       | Three.js canvas: physics + rendering + telemetry               | WebGL2 + Rapier             |
| Passport   | Persistent player object (local-first in Phase 1, syncs later) | IndexedDB → Vercel KV later |
| Click-tool | In-browser editor for semantic sidecars                        | Editor mode of zone canvas  |

**Phase 1 ships exactly:** one hub + one zone + one vehicle + free-roam-with-timed-run + visible passport + soft-body on the player vehicle + a working click-tool. Everything else is parking-lot until Phase 1 exits.

**Explicit non-goals (Phase 1):** authentication, accounts, leaderboards, multiplayer, ghost cars, environment deformation, multiple zones, Sketchfab import, procedural maps, race mode.

---

## 2. System Topology

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Browser (Vite SPA on Vercel)                      │
│                                                                       │
│  ┌──────────────┐   ┌──────────────────┐   ┌────────────────────┐    │
│  │ Hub (React)  │   │ Zone (Three.js)  │   │ Click-tool (mode)  │    │
│  └──────┬───────┘   └────────┬─────────┘   └────────────────────┘    │
│         │                    │                                        │
│         │     ┌──────────────┴───────────────┐                        │
│         │     │ Sim orchestrator (60Hz loop) │                        │
│         │     └──────────────┬───────────────┘                        │
│         │                    │                                        │
│         │     ┌──────────────┴───────────────┐                        │
│         │     │ Rigid-body sim (Rapier)      │ main thread, 60 Hz    │
│         │     └──────────────┬───────────────┘                        │
│         │                    │ SharedArrayBuffer                      │
│         │     ┌──────────────┴───────────────┐                        │
│         │     │ Soft-body (Web Worker)       │ worker, 240/120 Hz    │
│         │     └──────────────────────────────┘                        │
│         │                                                             │
│         │     ┌──────────────────────────────┐                        │
│         │     │ Telemetry (Web Worker)       │ worker, 30Hz capture  │
│         │     │ → IndexedDB (Phase 1)        │                        │
│         │     └──────────────────────────────┘                        │
│         │                                                             │
│         └─── Zustand store (UI-facing state only) ────────────────────┘
│                                       │
└───────────────────────────────────────┼──────────────────────────────┘
                                        │  static fetch
                                        ▼
                        ┌──────────────────────────────┐
                        │ Vercel edge (CDN)            │
                        │ - /public assets (Phase 1)   │
                        │ - Vercel Blob (Phase 2+)     │
                        │ - manifests as static JSON   │
                        └──────────────────────────────┘
```

**Why no server in Phase 1:** there are no accounts, no leaderboards, no telemetry sync. Manifests and assets are static files served by Vercel's edge. The passport lives in IndexedDB. When we add accounts (Phase 2), we add Vercel Functions + Vercel Postgres — never sooner.

---

## 3. Technology Stack

### 3.1 Client (the whole product, Phase 1)

| Concern         | Choice                              | Why                                                    |
| --------------- | ----------------------------------- | ------------------------------------------------------ |
| Build           | **Vite 5 + SWC**                    | Fastest dev loop, native ESM, clean worker bundling    |
| Language        | **TypeScript 5, strict**            | `strict: true`, `noUncheckedIndexedAccess: true`       |
| UI framework    | **React 18**                        | Hub only. The canvas mounts once and runs React-free   |
| State           | **Zustand + Immer middleware**      | No provider tree, fine-grained selectors               |
| Router          | **TanStack Router**                 | Type-safe, deep-link friendly                          |
| Renderer        | **Three.js r16x**                   | Mature, vast example pool, WebGPU path open later      |
| GPU API         | **WebGL2** (Phase 1), WebGPU later  | WebGL2 is universal today                              |
| Physics         | **@dimforge/rapier3d-compat**       | Rust-compiled, deterministic, has a vehicle controller |
| Audio           | **WebAudio direct** (engine + cues) | Howler adds nothing we need; one less dep              |
| Validation      | **Zod**                             | Manifests, postMessage payloads, sidecar files         |
| Local storage   | **IndexedDB via `idb`**             | Passport, best lap, telemetry blobs (Phase 1)          |
| Styling         | **Tailwind CSS**                    | Hub only; no CSS-in-JS in canvas paths                 |
| Icons           | **lucide-react**                    | Tree-shakeable, consistent                             |
| Testing (unit)  | **Vitest + happy-dom**              | Same toolchain as Vite                                 |
| Testing (e2e)   | **Playwright**                      | Headless Chromium, can hook into WebGL                 |
| Error reporting | **Sentry (client only, Phase 1)**   | Source maps from CI                                    |

### 3.2 Server (only when we actually need one)

Phase 1: **none**. Everything is static on Vercel's edge.

Phase 2 introduces, as flat Vercel Functions:

| Concern        | Choice                                     | When                                            |
| -------------- | ------------------------------------------ | ----------------------------------------------- |
| Compute        | **Vercel Functions (Node runtime)**        | Sketchfab OAuth + ingest, leaderboards          |
| DB             | **Vercel Postgres (Neon)**                 | Accounts, records, stamps cloud sync            |
| KV / cache     | **Vercel KV (Upstash)**                    | Rate limits, ingest job state                   |
| Object storage | **Vercel Blob**                            | Imported zones/vehicles, telemetry blobs        |
| Cron           | **Vercel Cron**                            | Cleanup, leaderboard recomputation              |
| Long jobs      | **Vercel Functions w/ `maxDuration: 300`** | Asset processing; queue via Vercel KV if needed |

We deliberately do **not** introduce: BullMQ, Redis, Docker, Kubernetes, a separate API server, or a job orchestrator. If we hit a wall that genuinely needs one of those, we add it then — not before.

### 3.3 Why not X (short list)

- **Next.js:** server rendering is irrelevant for a canvas-first product. Vite SPA + Vercel static hosting is leaner and the dev loop is faster. We can still use Vercel Functions next to it.
- **Babylon.js / PlayCanvas:** Three has the bigger example surface; PlayCanvas locks us into their cloud.
- **Cannon.js / Ammo.js:** older, less deterministic. Rapier has a first-class vehicle controller.
- **Redux / Jotai:** unnecessary indirection. Zustand suffices.
- **WebGPU as a hard floor:** still spotty on mid-range mobile in 2026.

---

## 4. Repository Layout

`pnpm` workspaces + Turborepo. One repo. **One** deployable app in Phase 1.

```
trace/
├─ apps/
│  └─ web/                       # The whole product. Vite + React + Three. Deploys to Vercel.
│     ├─ public/
│     │  └─ assets/
│     │     ├─ zones/{id}/v{ver}/   # Phase 1: zone bundles as static files
│     │     │  ├─ manifest.json
│     │     │  ├─ mesh.glb           # Draco-compressed
│     │     │  ├─ collider.glb
│     │     │  ├─ textures.ktx2
│     │     │  ├─ skybox.hdr
│     │     │  └─ semantic.json
│     │     └─ vehicles/{id}/v{ver}/
│     │        ├─ manifest.json
│     │        ├─ visual.glb
│     │        ├─ proxy.glb
│     │        └─ skinning.bin
│     ├─ src/
│     │  ├─ hub/                 # React routes
│     │  ├─ zone/                # Canvas-mounting runtime + loop
│     │  ├─ editor/              # Click-tool (mounted into zone)
│     │  ├─ passport/            # Passport UI surface
│     │  ├─ store/               # Zustand slices
│     │  ├─ workers/             # Source for softbody + telemetry workers
│     │  ├─ ui/                  # Reusable hub primitives
│     │  ├─ app.tsx
│     │  └─ main.tsx
│     ├─ index.html
│     ├─ vite.config.ts
│     └─ vercel.json             # Headers (COOP/COEP), caching
│
├─ packages/
│  ├─ trace-core/                # Pure TS, zero deps. Math, types, manifests, scoring.
│  ├─ trace-physics/             # Rapier wrapper + vehicle controller + profiles
│  ├─ trace-softbody/            # Mass-spring solver + skinning (runs in a worker)
│  ├─ trace-renderer/            # Three.js scene factory, materials, decals, LOD
│  └─ trace-editor/              # Click-tool engine (sidecar fitter, undo stack)
│
├─ tools/
│  └─ asset-cli/                 # Local: `trace asset ingest path/to.glb` (decimate, KTX2, Draco, collider, proxy)
│
├─ pnpm-workspace.yaml
├─ turbo.json
├─ tsconfig.base.json
└─ README.md
```

**Why this shape:**

- One deployable app means one Vercel project, one preview URL per PR, one bundle to budget.
- `packages/trace-*` are framework-agnostic — they could be lifted into a Node tool or a Web Worker without React/Three baggage. This is what lets the soft-body solver run in a worker without code duplication.
- `tools/asset-cli` is how zone and vehicle bundles are produced for Phase 1. Run locally; check the output into `apps/web/public/assets/`. Zero serverless infrastructure until Phase 2 demands it.

---

## 5. Runtime — The Loop, Threads, Events

### 5.1 Threads and tick rates

| Thread            | Tick                           | Owns                                             |
| ----------------- | ------------------------------ | ------------------------------------------------ |
| Main (render)     | rAF (~60 Hz)                   | React, scene graph, input, HUD, audio            |
| Main (physics)    | 60 Hz fixed step               | Rapier rigid-body, vehicle controller            |
| Worker: softbody  | 240 Hz desktop / 120 Hz mobile | Mass-spring solver, skinning deltas              |
| Worker: telemetry | 60 Hz capture, 30 Hz flush     | Channel sampling, ring buffer, blob write to IDB |

### 5.2 Fixed-timestep loop ([apps/web/src/zone/loop.ts])

```ts
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;

let accumulator = 0;
let last = performance.now();

function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.25); // clamp on tab-resume
  last = now;
  accumulator += dt;

  let steps = 0;
  while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
    physics.step(FIXED_DT); // Rapier deterministic step
    softbody.drainImpulses(); // pass collision impulses to worker
    accumulator -= FIXED_DT;
    steps++;
  }

  const alpha = accumulator / FIXED_DT;
  renderer.render(scene, camera, alpha); // interpolate transforms
  hud.update(telemetry.snapshot());

  requestAnimationFrame(frame);
}
```

Three properties this buys us: **determinism within a session** (replays from telemetry work), **no render-induced physics jitter**, and a **mobile safety valve** (`MAX_SUBSTEPS` prevents spiral-of-death stutter).

### 5.3 Typed event bus

No string keys, no `any`. One mediator for cross-module events.

```ts
// packages/trace-core/src/events.ts
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

export interface EventBus {
  on<K extends keyof TraceEvents>(k: K, fn: (p: TraceEvents[K]) => void): () => void;
  emit<K extends keyof TraceEvents>(k: K, p: TraceEvents[K]): void;
}
```

Every system **publishes** events and **never reaches into another system's internals**. Telemetry, HUD, scoring all subscribe.

### 5.4 Zustand store

The store is for **UI-facing state only**. Hot per-frame data lives in module-local memory.

```ts
type RootStore = {
  zone: ZoneSlice; // current zone manifest, load progress
  vehicle: VehicleSlice; // current vehicle id, livery color
  session: SessionSlice; // active timed run, best lap, lap-history
  passport: PassportSlice; // local-first passport snapshot
  ui: UISlice; // modals, current hub route
  editor: EditorSlice; // click-tool state when editor mode is on
};
```

Slices are independently testable. Components subscribe with `useStore(s => s.zone.progress)` so re-renders are scoped.

---

## 6. Zones

A zone is **a manifest + an asset bundle + a semantic sidecar**. Nothing else.

### 6.1 Zone manifest

```ts
// packages/trace-core/src/manifests/zone.ts
import { z } from 'zod';

export const ZoneManifest = z.object({
  id: z.string().regex(/^zone_[a-z0-9_]+$/),
  name: z.string().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),

  physicsProfile: z.enum(['tarmac_circuit', 'dirt', 'snow', 'drift']),
  controlScheme: z.enum(['circuit', 'rally', 'drift', 'casual']),
  fidelityTier: z.enum(['low', 'medium', 'high']),

  assets: z.object({
    mesh: z.string(), // relative to /assets/zones/{id}/v{ver}/
    collider: z.string(),
    textures: z.string(),
    skybox: z.string(),
  }),

  semanticSidecar: z.string(),

  spawnPoints: z
    .array(
      z.object({
        id: z.string(),
        position: z.tuple([z.number(), z.number(), z.number()]),
        rotation: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      }),
    )
    .min(1),

  modesSupported: z.array(z.enum(['free_roam', 'timed_run', 'race'])),
  credits: z.string(),
});

export type ZoneManifest = z.infer<typeof ZoneManifest>;
```

### 6.2 Zone load sequence

```
1. UI: loadZone(id)
2. fetch /assets/zones/{id}/v{ver}/manifest.json → Zod-validate
3. Parallel fetch: mesh, collider, textures, skybox, sidecar (with progress)
4. Renderer builds scene from mesh + skybox
5. Physics builds collider; applies physicsProfile parameters
6. Vehicle spawns at requested spawn point
7. Orchestrator: 'loading' → 'ready' → 'driving'
8. Telemetry arms
```

Each step updates the store's progress field; the loading screen is data-driven.

### 6.3 Physics profiles

A profile is a **parameter set**, not a separate engine.

```ts
export type PhysicsProfile = {
  id: ProfileId;
  surfaceFriction: Record<SurfaceMaterial, number>;
  tireGripCurve: GripCurve;
  suspensionStiffness: number;
  damper: number;
  rollResistance: number;
};
```

Profile selection happens at zone load; switching mid-session is unsupported.

---

## 7. Vehicles

### 7.1 Manifest

```ts
export const VehicleManifest = z.object({
  id: z.string(),
  displayName: z.string(),
  visualMesh: z.string(),
  proxyMesh: z.string(),
  skinning: z.string(), // pre-baked visual→proxy weights, binary
  rig: z.object({
    wheels: z
      .array(
        z.object({
          position: z.tuple([z.number(), z.number(), z.number()]),
          radius: z.number(),
          isDriven: z.boolean(),
          isSteered: z.boolean(),
        }),
      )
      .length(4),
    seat: z.tuple([z.number(), z.number(), z.number()]),
  }),
  mass: z.number(),
  inertiaTensor: z.tuple([z.number(), z.number(), z.number()]),
  engine: z.object({
    powerCurveHpAtRpm: z.array(z.tuple([z.number(), z.number()])),
    redline: z.number(),
  }),
  gearbox: z.object({
    ratios: z.array(z.number()),
    final: z.number(),
    type: z.enum(['manual', 'automatic', 'dct']),
  }),
});
```

### 7.2 Controller

We do **not** use baked animations. The rig is purely physical:

- Body is one rigid body with `mass` + `inertiaTensor`.
- Wheels are **raycast vehicle wheels** (Rapier's `DynamicRayCastVehicleController`). Suspension travel, body roll, dive, and squat emerge from impulses.
- Engine torque from RPM via power curve × gear × final × throttle, applied to driven wheels.
- Brakes apply counter-torque scaled by input + brake bias.
- Steering applies a speed-sensitive angle to steered wheels.

### 7.3 Control schemes

| Scheme  | Mapping                                       | Aids                            |
| ------- | --------------------------------------------- | ------------------------------- |
| circuit | KB/M, gamepad, wheel; full pedal granularity  | TCS, ABS optional               |
| rally   | Wider countersteer, looser TCS                | Throttle-based stability assist |
| drift   | Wider steering range, lighter weight transfer | None (intentionally raw)        |
| casual  | Auto-throttle option, simplified steering     | Heavy stability assist          |

---

## 8. Soft-Body Deformation

This is the riskiest part of Phase 1. Risk is **contained** in one worker, communicated through a narrow contract.

### 8.1 Dual-mesh model

- **Visual mesh.** 30k–80k tris. Drawn every frame. Moved by rigid-body sim; vertices deformed by skinning to proxy nodes.
- **Deformation proxy.** 300 nodes desktop / 150 mobile. Generated at vehicle-import time by `asset-cli`'s voxel decimation + Poisson disk redistribution.
- **Skinning weights.** Each visual vertex bound to its 3 nearest proxy nodes by inverse-distance weighting. Stored as a binary file: `Uint32Array` (indices) + `Float32Array` (weights).

### 8.2 Solver (mass-spring + plastic threshold)

Position-based Verlet integration in `packages/trace-softbody/src/solver.ts`:

```
Per substep:
  1. For each node n: v[n] += (f[n]/m[n])*dt;  x[n] += v[n]*dt
  2. For each constraint c: solve(c)   // distance + plastic + volume
  3. Write displacements to skinning SAB
```

Plastic deformation is the trick:

```ts
type Spring = {
  a: NodeIndex;
  b: NodeIndex;
  restLength: number;
  plasticOffset: number; // accumulated permanent deformation
  yieldStrain: number; // when |strain| > yield, plasticOffset shifts
  hardening: number; // resistance after first yield
};
```

When a collision pushes a spring beyond `yieldStrain * restLength`, `plasticOffset` increases by the residual. Subsequent steps use `restLength + plasticOffset` as the new rest. Dents persist.

### 8.3 Worker boundary

Two `SharedArrayBuffer`s:

- `impulseSAB` — ring buffer, 256 entries. Main writes (collision events). Worker reads.
- `skinningSAB` — `proxyNodeCount × 3` floats of node displacements. Worker writes. Main reads.

`Atomics` on head/tail indices. No structured cloning, no GC churn.

### 8.4 Visual mesh deform (main thread, hot path)

Per frame, before render:

```ts
for (let v = 0; v < vertexCount; v++) {
  const i0 = boneIdx[v * 3 + 0],
    i1 = boneIdx[v * 3 + 1],
    i2 = boneIdx[v * 3 + 2];
  const w0 = boneW[v * 3 + 0],
    w1 = boneW[v * 3 + 1],
    w2 = boneW[v * 3 + 2];
  positions[v * 3 + 0] =
    base[v * 3 + 0] + (d[i0 * 3 + 0] * w0 + d[i1 * 3 + 0] * w1 + d[i2 * 3 + 0] * w2);
  positions[v * 3 + 1] =
    base[v * 3 + 1] + (d[i0 * 3 + 1] * w0 + d[i1 * 3 + 1] * w1 + d[i2 * 3 + 1] * w2);
  positions[v * 3 + 2] =
    base[v * 3 + 2] + (d[i0 * 3 + 2] * w0 + d[i1 * 3 + 2] * w1 + d[i2 * 3 + 2] * w2);
}
geometry.attributes.position.needsUpdate = true;
```

Allocate nothing. Tight loop. WebGPU compute path is Phase 2.

### 8.5 Environment damage

Car deforms; world does not. World gets **decals** instead:

- On impact with a barrier-tagged surface, spawn (a) a paint-transfer decal in the player's livery color and (b) a scratch normal-map perturbation. Decals batched into one dynamic atlas per zone, FIFO at 256.
- No mesh modification on the environment, ever.

### 8.6 Mobile fallback (single flag)

By Week 8 of Phase 1, if mid-range mobile (Pixel 6a, iPhone 12 mini) cannot hit 30 FPS with soft-body, **flip `disableSoftBodyForLowEndDevice`**. The vehicle then uses rigid-body + a swap to a "damaged" texture set. Same manifest, same UI. Phase 2 brings it back via the WebGPU path.

### 8.7 SharedArrayBuffer requires headers

`SharedArrayBuffer` needs cross-origin isolation. We set these in [vercel.json] (see §11):

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
```

This means cross-origin assets must opt in with `Cross-Origin-Resource-Policy: cross-origin`. Phase 1 sidesteps the issue by serving all assets from `/public/` (same origin).

---

## 9. Semantic Sidecar and Click-Tool

### 9.1 Sidecar

```ts
export const SemanticSidecar = z.object({
  version: z.literal('1.0'),
  zoneId: z.string(),

  centerline: z.object({
    nodes: z.array(z.tuple([z.number(), z.number(), z.number()])).min(3),
    splineType: z.literal('catmull_rom'),
    roadWidthM: z.number().positive().default(12.0),
  }),

  barriers: z.array(
    z.object({
      id: z.string(),
      nodes: z.array(z.tuple([z.number(), z.number(), z.number()])).min(2),
    }),
  ),

  startFinish: z.object({
    a: z.tuple([z.number(), z.number(), z.number()]),
    b: z.tuple([z.number(), z.number(), z.number()]),
  }),

  checkpoints: z.array(
    z.object({
      id: z.string(),
      a: z.tuple([z.number(), z.number(), z.number()]),
      b: z.tuple([z.number(), z.number(), z.number()]),
      sector: z.number().int().positive(),
    }),
  ),

  spawnPoints: z.array(
    z.object({
      id: z.string(),
      position: z.tuple([z.number(), z.number(), z.number()]),
      facingYawDeg: z.number(),
    }),
  ),
});
```

### 9.2 Consumers

- **Lap timing:** body trajectory vs. `startFinish` line in the horizontal plane.
- **Track limits:** road polygon = centerline spline expanded by `roadWidthM/2`. Per-wheel inside/outside test each tick.
- **Reset:** project body to nearest centerline node; align facing to tangent; lift 1.5 m; zero velocity.
- **Telemetry tagging:** collision events query barrier polylines to tag impact (`barrier` vs `terrain`).
- **Sector splits:** distance-along-centerline precomputed per checkpoint at sidecar load.

### 9.3 Click-tool

The editor is a **mode** of the zone runtime, not a separate page. Entering edit mode swaps input mapping and overlays gizmos.

```ts
export type EditorMode = 'view' | 'centerline' | 'barriers' | 'startFinish' | 'spawn';

export interface EditorState {
  mode: EditorMode;
  draft: Partial<SemanticSidecar>;
  undoStack: Command[];
  redoStack: Command[];
}
```

Every click is a `Command` with `execute()` and `undo()`. Catmull-Rom fit, road polygon expansion, and checkpoint distribution are pure functions over `draft`. "Generate Sidecar" validates with Zod and writes the file.

**In Phase 1**, "writes the file" means the editor offers the sidecar as a JSON download. The dev checks it into `apps/web/public/assets/zones/{id}/v{ver}/semantic.json`. No server endpoint, no auth. When we add accounts in Phase 2, the same code path POSTs to a Vercel Function.

**Authoring guarantees:**

- < 1 hour to author a sidecar for a 5 km zone.
- Hot-reload: drop the new file in `/public`, the running zone picks it up without page reload (dev mode HMR).
- The downloaded file is byte-identical to what the player will receive.

---

## 10. Asset Pipeline

Phase 1: a **local CLI**, not a serverless pipeline. Run it on a dev machine, commit the output.

```
$ pnpm trace asset ingest path/to/sketchfab.glb \
    --kind zone \
    --id zone_suzuka_demo \
    --version 1.0.0
```

Stages:

```
Source GLB
   ├─► Decimate (meshoptimizer)         → visual mesh (≤200k / ≤80k tris)
   ├─► Texture transcode (basis_universal → KTX2)
   ├─► Geometry compress (Draco)
   ├─► Collider build                   → simplified, watertight, ≤10k tris
   ├─► Ground-plane detection           → compatibility score 0–5
   └─► Manifest stub                    (filled in by author)
```

For vehicles, two more stages:

```
   ├─► Axis normalize (Y-up vs Z-up, meters)
   ├─► Proxy build (voxel decimation → 300/150 nodes)
   └─► Skinning weights (visual → proxy, inverse-distance, top-3, binary)
```

Output goes into `apps/web/public/assets/...`. Vercel serves it as static content with long cache headers (immutable per version).

**Phase 2** lifts this CLI into a Vercel Function (Node runtime, `maxDuration: 300`) that accepts an upload, runs the same code, and writes to Vercel Blob. Zero duplicated logic.

---

## 11. Vercel Deployment

### 11.1 What ships where

```
Vercel project: trace
├─ Source: monorepo, root = apps/web
├─ Framework preset: Vite
├─ Build: pnpm turbo run build --filter=@trace/web
├─ Output: apps/web/dist
├─ Static assets: apps/web/public/* (cached, immutable per version path)
└─ Functions: none in Phase 1
```

### 11.2 `apps/web/vercel.json`

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
      ]
    },
    {
      "source": "/assets/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" },
        { "key": "Cross-Origin-Resource-Policy", "value": "same-origin" }
      ]
    }
  ]
}
```

COOP/COEP unlocks `SharedArrayBuffer`. Asset caching is immutable because every version writes to a new `/v{ver}/` directory.

### 11.3 Preview deploys

Vercel gives us a preview URL per PR for free. No extra plumbing. Designers and PMs review there. We add a Playwright smoke check that runs against the preview URL in CI.

### 11.4 When we add the first Vercel Function (Phase 2)

```
apps/web/api/
├─ sketchfab/oauth.ts        # OAuth callback
├─ ingest/zone.ts            # multipart upload → asset pipeline → Vercel Blob
└─ leaderboard/[zone].ts     # read from Vercel Postgres
```

Same project. Same deploy. Same TypeScript config. Same `packages/trace-core` schemas. No second service, no second repo.

---

## 12. Telemetry (Phase 1: local-first)

### 12.1 Channels (all recorded, 60 Hz, downsampled to 30 Hz on flush)

`t`, `position` (xyz), `rotation` (quat), `velocity` (xyz), `speed`, `accel` (lat/lon/v),
`throttle`, `brake`, `steering`, `gear`, `rpm`,
`wheel.load[4]`, `wheel.slip[4]`, `wheel.slipAngle[4]`, `wheel.surface[4]`,
`onTrack`, `distAlongCenterline`, `softbodyDamage`,
`collisionEvents[]` (async event log).

### 12.2 Binary format (columnar, gzipped)

```
Header (32 bytes):
  magic        u32     "TRC1"
  version      u16
  channelCount u16
  sampleCount  u32
  startUnixMs  u64
  flags        u32
Channel table (16 B per channel):
  nameHash     u32     (FNV-1a of channel name)
  dtype        u8
  arity        u8
  flags        u16
  offsetBytes  u64
Body: column 0 | column 1 | …
Event log: gzipped JSON appended
```

5–10× smaller than JSON; a single channel reads without parsing the rest. `tools/asset-cli telemetry-inspect` dumps blobs for QA.

### 12.3 Storage

Phase 1: each session's blob goes to **IndexedDB** under `trace.telemetry`. Best lap per `(zone, vehicle)` is kept; older blobs roll off after 7 days locally.

Phase 2 (with accounts): upload the same blob to Vercel Blob via a Vercel Function; keep the IndexedDB write as an offline-first fallback.

### 12.4 Scorers (trial substrate)

```ts
export interface TrialScorer<R extends TrialResult> {
  id: string;
  score(stream: TelemetryStream, sidecar: SemanticSidecar): R;
}
```

Pure functions. Phase 1 ships only a best-lap scorer; Phase 2 adds drift, hot-lap, time-attack scorers without touching the recording layer.

---

## 13. Passport (Phase 1: local-first)

Passport is a JSON object in IndexedDB. Visible from the hub. No accounts.

```ts
type Passport = {
  id: string; // crypto.randomUUID, generated on first visit
  displayName: string; // user picks at first visit
  createdAt: number;
  stamps: Stamp[];
  records: Record<string, BestLap>; // key: `${zoneId}:${vehicleId}`
  collection: { vehicleIds: string[]; favoriteZoneIds: string[] };
};

type Stamp = {
  id: string;
  source: 'zone_visit' | 'timed_run' | 'first_crash';
  zoneId: string | null;
  earnedAt: number;
  metadata: unknown;
};

type BestLap = {
  zoneId: string;
  vehicleId: string;
  lapMs: number;
  setAt: number;
  telemetryBlobId: string; // IDB key for the binary blob
};
```

When we add accounts in Phase 2, we add a `userId` to the passport, a Vercel Function for sync, and a Postgres table. Phase 1 ships the **surface**; Phase 2 wires the persistence cloud-side.

**Visual.** Stamps must look real and tangible — this is the partner-credibility layer per PRD §4.4. Treat it as a design priority, not a coding one.

---

## 14. Rendering

### 14.1 Scene graph

```
Scene
├─ Skybox (HDR equirect, environment map for PBR)
├─ Sun (DirectionalLight) + ambient hemispheric
├─ Zone group (visual mesh, materials, decal projector)
├─ Vehicle group (body + 4 wheels + lights/mirrors/glass)
├─ Particles (skid smoke, dust, tire smoke)
└─ Postprocessing (tonemap + FXAA, optional SMAA on desktop)
```

### 14.2 Materials

- PBR everywhere. Roughness/metalness maps in KTX2.
- Car paint: layered material (clearcoat + flake + base); livery via texture atlas.
- Asphalt/dirt/snow: triplanar mapping, surface-tag-driven texture swap.
- Decals: projection onto barriers; max 256 active per zone, FIFO.

### 14.3 LOD + culling

- 3 LODs per zone, distance-banded.
- Frustum + occlusion (Three's `Frustum`). Per-zone occlusion bake is Phase 2 polish.
- Vehicle: 2 LODs (close camera = high; replay/distant = low).

### 14.4 Postprocessing budget

| Effect      | Desktop  | Mobile |
| ----------- | :------: | :----: |
| Tonemap     |    ✓     |   ✓    |
| FXAA        |    ✓     |   ✓    |
| SMAA        | optional |   ✗    |
| Motion blur | Phase 2  |   ✗    |
| Bloom       | optional |   ✗    |
| SSAO        | Phase 3  |   ✗    |

---

## 15. Audio

Two subsystems:

- **UI audio** — direct WebAudio: button clicks, lap-time chime, stamp earned. Mixed independently.
- **In-world audio** — WebAudio: engine (granular synthesis of a base loop, pitch-shifted by RPM with rate-of-change crossfading), tire (slip-driven), wind (speed-driven), collision (impact-force-driven). All routed through a `PannerNode` then a master `DynamicsCompressorNode`.

Spatial audio via HRTF where available; fall back to equal-power panning.

---

## 16. Performance Budgets (release gates)

Missing one blocks the release. We descope or revert.

### 16.1 Per zone

| Asset              | Desktop  |  Mobile  |
| ------------------ | :------: | :------: |
| Visual mesh tris   |  ≤ 200k  |  ≤ 80k   |
| Texture set (KTX2) | ≤ 80 MB  | ≤ 30 MB  |
| Collider tris      |  ≤ 10k   |  ≤ 10k   |
| Skybox HDR         |  ≤ 8 MB  |  ≤ 8 MB  |
| Sidecar JSON       | ≤ 200 KB | ≤ 200 KB |
| **Total bundle**   | ≤ 100 MB | ≤ 40 MB  |

### 16.2 Per vehicle

| Asset            | Desktop | Mobile  |
| ---------------- | :-----: | :-----: |
| Visual mesh tris |  ≤ 80k  |  ≤ 25k  |
| Proxy nodes      |   300   |   150   |
| Texture set      | ≤ 30 MB | ≤ 10 MB |
| **Total bundle** | ≤ 40 MB | ≤ 15 MB |

### 16.3 Runtime

| Metric                  | Desktop  |  Mobile  |
| ----------------------- | :------: | :------: |
| Frame time target       | 16.6 ms  | 33.3 ms  |
| Frame time p99          |  22 ms   |  50 ms   |
| Physics step            |  < 3 ms  |  < 5 ms  |
| Soft-body step (worker) |  < 2 ms  |  < 6 ms  |
| Render step             |  < 8 ms  | < 16 ms  |
| Hub initial load        |  < 10 s  |  < 15 s  |
| Zone load (warm cache)  |  < 5 s   |  < 8 s   |
| Zone load (cold)        |  < 20 s  |  < 30 s  |
| Initial JS bundle (gz)  | < 1.5 MB | < 1.5 MB |
| LCP (hub)               | < 2.5 s  | < 3.5 s  |

### 16.4 Memory

- Total client memory (excluding GPU-resident textures): ≤ 600 MB desktop, ≤ 300 MB mobile.
- No memory leak across 5 zone-load cycles (asserted by a Playwright soak test).

---

## 17. Testing

Three layers in CI on every PR:

1. **Unit (Vitest).** Every `packages/*` is unit-tested. Pure math, manifest schemas, scorers, sidecar fitter. Target ≥ 80% coverage on `trace-core`, ≥ 70% elsewhere.
2. **Integration.**
   - Headless physics: Rapier + vehicle controller in Node; canned input traces; assert positions/laps.
   - Asset pipeline goldens: known GLBs in → byte-identical KTX2/Draco/collider out.
3. **E2E (Playwright).**
   - Hub flow: load → pick zone → load zone → drive → see HUD update.
   - Click-tool flow: open → place centerline → save → reload.
   - Mobile emulation: same flow on Pixel 6a viewport with FPS hook.

### 17.1 Performance regression

Every PR runs a 60-second canned drive in headless Chromium. p99 frame time regression > 10% fails the PR.

### 17.2 Determinism

Same seed + same input trace must produce byte-identical telemetry. Catches non-determinism early.

---

## 18. Coding Standards

The whole point of "vibecoding" Trace is that the output is still **production code**. The rules are short.

1. **TypeScript strict everywhere.** No `any`. `unknown` at boundaries, narrowed inside.
2. **Validate at every external boundary** with Zod: manifests, postMessage payloads, IDB reads, fetch responses.
3. **No singletons of mutable state.** Modules expose `create…()` factories; tests instantiate their own.
4. **Hot paths allocate zero.** Reuse `THREE.Vector3` scratch pads. No `.map` / `.filter` per frame on big arrays.
5. **Package barrels.** `import { Spline } from 'trace-core'`, not deep paths.
6. **One reason to exist per file.** Two unrelated things → split.
7. **Public API: TSDoc + example** on every exported symbol from `packages/*`.
8. **No `console.log` in commits.** Use the typed `logger` (`debug | info | warn | error`).
9. **Comments answer "why", not "what".** Code already shows what.
10. **Naming.** Files `kebab-case.ts`, types `PascalCase`, constants `SCREAMING_SNAKE`, functions/vars `camelCase`. React components and their files match exactly.

ESLint enforces what's lintable. Prettier formats. No bikeshedding.

---

# Part II — Planner

## 19. Operating Principles

1. **Phases are sequential and shippable.** Each phase ends with a build a stranger can load and play. Nothing crosses a phase boundary half-done.
2. **Vertical slices, not horizontal scaffolds.** Every week delivers a visible improvement, even if narrow.
3. **PRD = spec. This doc = contract. The week plan = order.** If they disagree, fix the doc, not the code.
4. **Budgets are gates** (see §16). No "optimize later" lane.
5. **Risk first.** Soft-body in Week 4, not Week 12.

### Team assumption

| Role                     | Count | Notes                                            |
| ------------------------ | :---: | ------------------------------------------------ |
| Senior engine engineer   |   1   | Physics, soft-body, asset pipeline               |
| Senior frontend engineer |   1   | Hub, click-tool UI, passport UI                  |
| Full-stack engineer      |   1   | Telemetry, CI/CD, perf instrumentation           |
| Designer (visual + UX)   |   1   | Hub, HUD, brand, asset look-dev                  |
| Asset / 3D artist        |   1   | Phase 1 demo car + zone (or art-direct a vendor) |
| PM / producer            |  0.5  | Weekly review, owns external dependencies        |

Fewer people → phases stretch.

### Phase summary

| Phase | Theme              | Duration  | Exit build                                                                |
| :---- | :----------------- | :-------- | :------------------------------------------------------------------------ |
| 0     | Foundation         | ~2 weeks  | Empty hub loads on Vercel, repo green                                     |
| 1     | MVP vertical slice | ~14 weeks | Hub → one zone → one car → timed run → deformation → telemetry → passport |
| 2     | All features       | ~16 weeks | Sketchfab import + procedural + race mode + 3+ zones + ghosts             |
| 3     | Refined product    | ~20 weeks | Auto-rigging, AR continuity proto, partner zones                          |

---

## 20. Phase 0 — Foundation (Weeks −2 to 0)

Goal: every engineer can clone, run, deploy, merge.

| ID    | Task                                                                                  | Owner      |
| ----- | ------------------------------------------------------------------------------------- | ---------- |
| P0-01 | Initialize pnpm monorepo per §4                                                       | Eng L      |
| P0-02 | TS base config, ESLint, Prettier, lint-staged                                         | Eng L      |
| P0-03 | Vite app `apps/web` boots with "Hello Trace"                                          | Frontend   |
| P0-04 | Connect repo to Vercel; first deploy on `main`                                        | Full-stack |
| P0-05 | `vercel.json` with COOP/COEP headers + asset caching                                  | Full-stack |
| P0-06 | CI (GitHub Actions): lint, typecheck, unit, build                                     | Full-stack |
| P0-07 | Preview deploys verified (per-PR URL)                                                 | Full-stack |
| P0-08 | Sentry client init + sourcemap upload from CI                                         | Full-stack |
| P0-09 | Zustand store + TanStack Router skeleton                                              | Frontend   |
| P0-10 | `tools/asset-cli` runs a no-op pipeline locally                                       | Engine     |
| P0-11 | README + this blueprint committed; CONTRIBUTING with PR template referencing task IDs | Eng L      |

**Exit:** `pnpm dev` brings up the app; a PR opens a preview URL; CI green and < 8 min.

---

## 21. Phase 1 — MVP (Weeks 1–14)

### 21.1 Critical path

```
W1  W2  W3  W4  W5  W6  W7  W8  W9  W10 W11 W12 W13 W14
─────────────────────────────────────────────────────────
[Hub shell]
    [Physics + vehicle controller]
        [Zone load + first drive]
            [Soft-body proxy in worker]
                [Collision → real dents]
                    [Telemetry + post-session]
                        [Click-tool MVP]
                            [Lap timing + records]
                                [Passport UI]
                                    [Mobile + touch]
                                        [Polish + perf]
                                            [QA + bug burn-down]
                                                    [Phase 1 freeze]
```

### 21.2 Week-by-week

#### Week 1 — Hub shell + manifests

| ID    | Task                                                                       |
| ----- | -------------------------------------------------------------------------- |
| P1-01 | Hub UI shell: landing → zone select → vehicle select → start (mocked data) |
| P1-02 | Zod schemas for `ZoneManifest` + `VehicleManifest` in `trace-core`         |
| P1-03 | Static manifests checked in at `apps/web/public/assets/...`                |
| P1-04 | Design: hub mood-board, brand v0, font pairing locked                      |
| P1-05 | Decisions: Phase 1 zone identity (Q-1) and vehicle (Q-2)                   |

**Demo:** click through hub to "About to load zone" screen with the right manifest fetched.

#### Week 2 — Three.js scene + Rapier wheel

| ID    | Task                                                                       |
| ----- | -------------------------------------------------------------------------- |
| P1-06 | `zone/loop.ts`: fixed-timestep loop on canvas                              |
| P1-07 | `trace-renderer`: scene factory, HDR skybox, sun, basic PBR materials      |
| P1-08 | `trace-physics`: Rapier init, ground plane, debug box that drops           |
| P1-09 | Rapier `DynamicRayCastVehicleController`: a box-car drives with arrow keys |
| P1-10 | Surface tags + materials per §6.3                                          |

**Demo:** a primitive box drives on a flat plane with steering, throttle, brake.

#### Week 3 — Vehicle controller + first vehicle asset

| ID    | Task                                                     |
| ----- | -------------------------------------------------------- |
| P1-11 | Engine torque model + gearbox (manual + auto)            |
| P1-12 | Brake bias; ABS/TCS optional                             |
| P1-13 | Steering: speed-sensitive ratio, return-to-center torque |
| P1-14 | Demo vehicle visual mesh imported at 80k tris            |
| P1-15 | Wheel rotation + suspension travel visible               |
| P1-16 | Camera rig: chase + cockpit + hood; spline-damped follow |

**Demo:** demo car drives on a flat plane; suspension dives on braking.

#### Week 4 — Zone asset + collider; first real drive

| ID    | Task                                                         |
| ----- | ------------------------------------------------------------ |
| P1-17 | First zone asset processed: visual + collider GLBs at budget |
| P1-18 | `trace asset ingest` runs decimate + KTX2 + collider locally |
| P1-19 | Zone load sequence per §6.2                                  |
| P1-20 | Spawn at zone's spawn point; can drive a lap                 |
| P1-21 | Reset-to-spawn keybind (no sidecar yet — uses spawn list)    |
| P1-22 | Hub → zone transition with progress bar                      |

**Demo:** load Trace → pick zone → drive a lap on the real zone art. **Pillar #1 done.**

#### Week 5 — Soft-body solver in a worker

| ID    | Task                                                                          |
| ----- | ----------------------------------------------------------------------------- |
| P1-23 | Mass-spring solver in `trace-softbody`, unit-tested vs. analytical spring     |
| P1-24 | Worker bootstrap, SharedArrayBuffer transports, COOP/COEP confirmed live      |
| P1-25 | Proxy mesh generation in `asset-cli`: voxel decimate → 300 nodes              |
| P1-26 | Skinning weights bake (top-3 inverse-distance), binary file                   |
| P1-27 | Visual mesh deforms when worker writes to skinningSAB (with synthetic forces) |

**Demo:** still car; an injected sine-wave force visibly dents the hood.

#### Week 6 — Collision impulses → real dents

| ID    | Task                                                                  |
| ----- | --------------------------------------------------------------------- |
| P1-28 | Rapier collision events → impulseSAB ring buffer                      |
| P1-29 | Worker consumes impulses, applies to nearest proxy nodes              |
| P1-30 | Plastic threshold parameters tuned; crashes leave permanent dents     |
| P1-31 | Environment damage: decal projector + paint-transfer + scratch shader |
| P1-32 | Frame-budget audit; soft-body ≤ 2 ms desktop, ≤ 6 ms mobile           |

**Demo:** drive into a barrier → hood crumples and persists; barrier shows scratch + paint.

#### Week 7 — Telemetry recording + post-session

| ID    | Task                                                                           |
| ----- | ------------------------------------------------------------------------------ |
| P1-33 | Telemetry worker: 60 Hz capture of channels per §12.1                          |
| P1-34 | Ring buffer + 30 Hz downsample + binary writer per §12.2                       |
| P1-35 | Write binary blob to IndexedDB on session complete                             |
| P1-36 | Post-session screen: lap time, speed chart, sector view (sector model stubbed) |
| P1-37 | `tools/asset-cli telemetry-inspect` for QA                                     |

**Demo:** drive a lap → see lap time + speed/throttle/brake chart on a results screen.

#### Week 8 — Click-tool v1

| ID    | Task                                                                            |
| ----- | ------------------------------------------------------------------------------- |
| P1-38 | Editor mode toggle (gated by a dev flag in Phase 1)                             |
| P1-39 | Centerline mode: raycast clicks, Catmull-Rom fit                                |
| P1-40 | Barriers mode: polyline draw + edit                                             |
| P1-41 | Start/Finish mode (two-click line)                                              |
| P1-42 | Spawn mode (auto-yaw from nearest centerline tangent)                           |
| P1-43 | Sidecar serializer; download JSON; dev commits to `/public`                     |
| P1-44 | Hot-reload sidecar in dev without page reload                                   |
| P1-45 | **Gate decision:** if mobile soft-body target unreached, flip the fallback flag |

**Demo:** an unfamiliar team member authors the demo zone's sidecar end-to-end in < 1 hour.

#### Week 9 — Lap timing, track limits, real timed runs

| ID    | Task                                                       |
| ----- | ---------------------------------------------------------- |
| P1-46 | `LapTimer` uses sidecar's start/finish + checkpoints       |
| P1-47 | Road polygon expansion from centerline + width             |
| P1-48 | Track-limits detection per wheel; telemetry events emitted |
| P1-49 | Reset-to-track via centerline projection                   |

**Demo:** valid lap times persist; cutting a corner is flagged.

#### Week 10 — Passport UI + records (local-first)

| ID    | Task                                                         |
| ----- | ------------------------------------------------------------ |
| P1-50 | Passport surface in hub (persistent button)                  |
| P1-51 | First-visit displayName picker; passport created in IDB      |
| P1-52 | Stamps display: zone visited, first crash, timed run         |
| P1-53 | Records: best lap per (zone, vehicle)                        |
| P1-54 | Storefront tab placeholder ("Coming soon: Track day stamps") |
| P1-55 | Visual polish: stamps must look real and tangible            |

**Demo:** end of a lap auto-issues a stamp; passport shows it; best lap updates.

#### Week 11 — Mobile + touch

| ID    | Task                                                            |
| ----- | --------------------------------------------------------------- |
| P1-56 | Touch HUD: thumb-steer + throttle + brake, configurable layout  |
| P1-57 | Device-class detection; auto-select mobile asset variants       |
| P1-58 | Mobile soft-body 150-node path or fallback (depending on P1-45) |
| P1-59 | Frame-time histogram on Pixel 6a + iPhone 12 mini; budget gate  |
| P1-60 | Touch-friendly hub UI variant                                   |

**Demo:** Pixel 6a plays end-to-end at ≥ 30 FPS.

#### Week 12 — Polish, perf gates, art pass

| ID    | Task                                                           |
| ----- | -------------------------------------------------------------- |
| P1-61 | Lighting + tonemap pass with designer                          |
| P1-62 | Engine audio: granular synth tuned                             |
| P1-63 | Loading screen flow + per-asset progress                       |
| P1-64 | Performance regression gate live in CI                         |
| P1-65 | Memory leak soak test (5 zone-load cycles)                     |
| P1-66 | Bundle size audit; lazy-load editor mode behind dynamic import |

#### Week 13 — QA, bugs, accessibility

| ID    | Task                                                      |
| ----- | --------------------------------------------------------- |
| P1-67 | External QA pass on 8 device classes                      |
| P1-68 | Keyboard remap UI; gamepad + wheel detection              |
| P1-69 | Color-blind-safe HUD; min font sizes; reduced-motion mode |
| P1-70 | Crash report triage until zero p0/p1 open                 |
| P1-71 | Final asset re-export at frozen budgets                   |

#### Week 14 — Freeze + demo

| ID    | Task                                          |
| ----- | --------------------------------------------- |
| P1-72 | Feature freeze, branch cut: `release/phase-1` |
| P1-73 | Final perf gate run on all device tiers       |
| P1-74 | Phase 1 demo video on phone + desktop         |
| P1-75 | Retro; populate Phase 2 backlog               |
| P1-76 | Partner-conversation packet (per PRD §3.1)    |

### 21.3 Phase 1 exit criteria (verbatim from PRD §3.1)

- Player lands on URL → loads hub in **< 10 s desktop** → picks demo car → enters zone → drives a timed lap → crashes → sees deformation → views telemetry. ✓
- Same flow at **≥ 30 FPS** on a mid-range phone with touch controls. ✓
- Arbitrary mesh → click-tool → drivable zone **in < 1 hour**. ✓
- Build is sellable to a Phase 2 partner conversation. ✓

### 21.4 Risk register

| Risk                                           | Mitigation                                                     | Trigger                           |
| ---------------------------------------------- | -------------------------------------------------------------- | --------------------------------- |
| Soft-body misses mobile budget                 | Fallback flag (W8 gate)                                        | < 30 FPS on Pixel 6a by W7 end    |
| Asset pipeline runs over budget                | Decimation parameter library; manual cleanup pass              | Zone bundle > 100 MB at W4        |
| Rapier wheel controller instability on terrain | Constrain Phase 1 slopes; defer aggressive dirt to Phase 2     | Vehicle launches / glitches in QA |
| Touch fights iOS browser gestures              | `touch-action: none`, fullscreen API, viewport lockdown        | iOS bug report in W11             |
| `SharedArrayBuffer` blocked by headers         | Confirm COOP/COEP via Vercel preview in W2                     | Console error                     |
| Phase 1 art assets late                        | Build with programmer-art zone first; swap behind manifest URL | Vendor missed milestone at W3     |

---

## 22. Phase 2 — All Features (Weeks 15–30)

Parallelizable workstreams. Auth lands here, with the first Vercel Functions.

### A. Accounts + cloud passport (weeks 15–18)

Open `apps/web/api/` and add the first Vercel Functions. Vercel Postgres for users + passport sync. Provider TBD (Q-3).

### B. Sketchfab pipeline (weeks 15–22)

OAuth, ingest function (`maxDuration: 300`), Vercel Blob storage, compatibility scoring, "needs review" queue. Click-tool publishes to a function instead of downloading JSON.

### C. Race mode (weeks 17–22)

Checkpoint enforcement, race lobby, async ghost cars (telemetry replays from Vercel Blob), time penalties.

### D. Procedural maps (weeks 18–26)

Centerline-first spline, tile streaming, heightfield + corridor clamp, billboard veg. Becomes the default free-roam destination.

### E. Multiple zones (weeks 20–28)

Zone 2 dirt rally; Zone 3 snow; Zone 4 drift. Per-zone tuning, surface-friction validation.

### F. Environment overlay (weeks 22–26)

Skybox presets, dry/wet weather, ambient audio, distant horizon billboard.

### G. Live HUD + WebGPU prep (weeks 24–30)

Live HUD overlays (desktop), pedal/steering traces, `RenderBackend` abstraction with WebGPU behind a feature flag, GPU skinning compute path.

### Phase 2 exit

- Import → race in **< 30 min**.
- **3+ zones** with meaningfully different physics live.
- Procedural is the default free-roam destination.
- Race mode supports valid lap timing + checkpoint enforcement + track limits.
- Accounts work; passport syncs to cloud.

---

## 23. Phase 3 — Refined Product (Weeks 31–50)

### H. Auto-rigging + semantic auto-extraction (weeks 31–38)

Wheel detection by circular-geometry clustering near ground; ≥ 70% confidence auto-rigs. Draft sidecar from mesh segmentation; click-tool becomes a validator.

### I. Talent pipeline credentialing (weeks 33–42)

Six-tier model in passport (per PRD; resolve Q-5). Per-zone trial definitions. Tier-progression UI. Telemetry export (CSV + MoTeC i2).

### J. AR continuity prototype + scan-in (weeks 36–46)

Scan-in URL: `/scan?token=...` → stamp issuance. Partner venue Q-4. WebXR overlay where supported. Unlocks tied to stamp combinations.

### K. Partner zone surface (weeks 38–48)

Zone-as-partnership manifest fields (partner, branding, terms). Admin UI. At least one publicly-launched partner zone.

### L. Real-time multiplayer evaluation (weeks 42–50)

Tech spike: WebTransport vs WebRTC; authoritative-server cost model; go/no-go writeup.

### Phase 3 exit

- At least one auto-rigged vehicle in the wild without manual rigging.
- At least one zone shipped with auto-drafted sidecar (author-validated).
- Scan-in works at one real partner venue.
- AR continuity prototype on at least one supported device.
- First three credentialing tiers emit.

---

## 24. Definition of Done, Gates, Rituals

### Definition of Done (every task)

- [ ] PR title cites the task ID (e.g. `[P1-23] Soft-body solver`).
- [ ] Lint, typecheck, unit, integration, e2e in CI all green.
- [ ] Perf regression gate green (p99 frame time within 10% of baseline).
- [ ] If it touches a `packages/*` public API: TSDoc + example updated.
- [ ] If it touches a manifest schema: Zod schema diff in the PR.
- [ ] If it changes a budget: §16 updated in the same PR.
- [ ] Manually verified on desktop **and** mobile preview.
- [ ] Reviewed by at least one other engineer in the area.

### Quality gates (every release)

| Gate           | Tool                    | Threshold                                |
| -------------- | ----------------------- | ---------------------------------------- |
| Lint+typecheck | ESLint + tsc            | 0 errors                                 |
| Unit + integ   | Vitest                  | 0 failures, ≥ 80% coverage on trace-core |
| E2E flows      | Playwright              | 0 failures                               |
| Determinism    | Replay golden inputs    | Byte-identical telemetry                 |
| Performance    | Canned drive in CI      | p99 ≤ baseline + 10%                     |
| Memory         | Soak test, 5 zone loads | ≤ 600 MB desktop / 300 MB mobile         |

### Communication rituals

| Cadence   | Meeting               | Output                                                |
| --------- | --------------------- | ----------------------------------------------------- |
| Daily     | 15-min standup        | Blockers up, today's task IDs declared                |
| Weekly    | Demo + planner update | This file edited; next week scheduled                 |
| Bi-weekly | Risk review           | Risk register updated                                 |
| Per phase | Retro + go/no-go      | Phase exit criteria checked; next phase backlog ready |

Async: PR descriptions start with `[task ID]`, the exit criterion advanced, and a 30-sec demo (GIF/video).

---

## 25. Open Questions (must resolve when listed)

| #   | Question                                                                  | Gates        |
| --- | ------------------------------------------------------------------------- | ------------ |
| Q-1 | Phase 1 zone identity — real circuit twin (licensing) or original?        | Phase 1 W2   |
| Q-2 | Phase 1 vehicle — original / licensed / placeholder?                      | Phase 1 W1   |
| Q-3 | Phase 2 auth providers (Google + Discord + email magic link?)             | Phase 2 W1   |
| Q-4 | Phase 3 scan-in: first partner venue?                                     | Phase 3 plan |
| Q-5 | Six-tier credentialing — owned by Trace memo team or designed in-project? | Phase 3 plan |
| Q-6 | Sketchfab — public API at user-account rate limits or formal partnership? | Phase 2 W1   |

---

## 26. Backlog (post-Phase-3)

- Real-time multiplayer (if Phase 3 K-spike says go).
- Mod SDK beyond Sketchfab — community-authored vehicles/zones.
- Manufacturer-licensed vehicle packs.
- Replay editor (cinematic cameras over recorded telemetry).
- Photo mode (free camera, depth of field, color grade).
- Apex visualization (racing-line overlay from centerline + style).
- Damage-as-content: shareable "wreck card" image.
- Trial-scoring leagues across zones (cross-zone leaderboards).
- Native AR (Apple Vision / Quest, as WebXR matures).

---

## 27. Aman's PM Instincts

> **What this section is.** The blueprint is the contract; the build is where it
> meets reality. During the Week 2–3 build I (Aman, PM) made calls that diverge
> from or extend Parts I/II and aren't yet folded back into them. Per §19.3 —
> _"if they disagree, fix the doc, not the code"_ — this section records those
> calls, what each one overrides or extends, and the reasoning behind it, so the
> contract stays honest until the next planner pass reconciles the body.
>
> These are **adopted decisions**, not proposals. They are live in the working
> tree today. Where one contradicts a stated Phase 1 scope line or non-goal,
> that's called out explicitly.

### 27.1 Three real licensed cars now, not one procedural car

- **Overrides:** §1 ("one hub + **one** vehicle"), §1 non-goals ("Sketchfab
  import"), and pre-empts Q-2.
- **What shipped:** three downloaded glTF cars — `vehicle_corvette_c2` (light
  ~1.45 t RWD V8 sports), `vehicle_charger_rt` (heavier ~1.75 t RWD V8 muscle),
  and `vehicle_hummer_ev` (~4.1 t AWD electric truck). `vehicle_alpha` stays as
  the procedural fallback so nothing downstream breaks.
- **Why (the instinct):** a player feels the product through the cars, not the
  box. Three deliberately contrasting cars — light vs. heavy, combustion vs.
  electric, RWD vs. AWD — prove the physics/feel differentiation in one sitting,
  far better than a single primitive. It also de-risks the GLB pipeline now
  instead of at W14.
- **Hard constraint (Phase 2 gate):** all three are **CC-BY-NC-SA** Sketchfab
  models (credited in each `manifest.json`). _Non-commercial_ means this is an
  **internal prototype only** — it cannot ship to a public or partner build
  until these are replaced with owned or distribution-licensed assets. This is a
  blocker on the Phase 1 → "sellable" exit criterion, tracked here so it isn't
  forgotten.

### 27.2 Manifest extensions: `visual`, `tuning`, `audio`

- **Extends:** §7.1 `VehicleManifest`. Three new **optional** blocks; every one
  is absent on `vehicle_alpha`, so its behavior is byte-for-byte unchanged.
- `visual` — `format: 'procedural' | 'glb'`, plus `scale` / `yaw` / `offset` and
  a per-wheel mapping of glTF node names (`fl`/`fr`/`rl`/`rr`). Lets a manifest
  bind a rigged GLB without code changes.
- `tuning` — per-car dynamics that override the global feel constants in
  `@trace/physics`: `driveAccelG`, `brakeDecelG`, `reverseAccelG`, `maxSteerDeg`,
  `steerSpeedScale`, `frontBrakeBias`, `suspensionStiffnessScale`,
  `suspensionTravelScale`, `gripScale`, `comHeightScale`. Suspension stiffness is
  now **mass-scaled** against a reference mass so heavy cars don't bottom out.
- `audio` — engine-sound profile: `kind: 'v8' | 'flat' | 'inline' | 'electric'`,
  `idleHz`, `revHz`, `gain`.
- **Why:** §7.2 described a single global vehicle feel. Real cars need
  per-car character, and per Rule 3 ("every asset is data") that character
  belongs in the manifest, not in branching code.

### 27.3 GLB vehicle visual loader (production render path, pulled early)

- **Realizes:** P1-14 ("demo vehicle visual mesh imported"), for real, plus the
  wheel-rigging robustness the blueprint hand-waved.
- `packages/trace-renderer/src/glb-vehicle-visual.ts` honors the same
  `VehicleVisual` contract (`group` + `applySnapshot` + `dispose`) as the
  procedural body, so the session wires either interchangeably. It reparents
  each wheel cluster onto a pivot at the cluster's **bounding-box center** (the
  true axle — downloaded exports can't be trusted to put node origins there),
  matches pivots to physics wheels by nearest rig position, and mirrors
  `GLTFLoader`'s node-name sanitization.

### 27.4 Procedural engine audio, ahead of schedule

- **Pulls forward:** §15 in-world engine voice / P1-62 (scheduled W12).
- `packages/trace-renderer/src/engine-audio.ts` — a WebAudio synth (no samples):
  detuned-sawtooth combustion (`v8`/`flat`/`inline`) with an RPM model derived
  from wheel speed × gearbox, or a rising inverter whine for `electric` (the
  Hummer). Built once, nudged per frame via `setTargetAtTime` (alloc-free,
  click-free), resumes on first user gesture.
- **Why:** audio _is_ most of "feel." It's cheap to prototype now and it's the
  single biggest thing that makes the three cars read as different.

### 27.5 Image-based lighting placeholder

- **Extends:** §14 rendering.
- `createEnvironmentMap` bakes Three's neutral `RoomEnvironment` to a PMREM once
  at session start and feeds it to `scene.environment` and the GLB materials'
  `envMap`, so PBR paint, chrome, and glass actually reflect. This is a
  **placeholder** until the real HDRI skybox arrives with the zone art
  (W4 / P1-17), at which point that replaces it.

### 27.6 Two shells: Game mode vs. Dev mode

- **Overrides:** §1's single "Hub" surface.
- The manifest-driven hub is an **engineering console**, not a product. So the
  router now serves a player-facing front door at `/` and demotes the old hub to
  `/dev` (with `/zones`, `/vehicles`, `/ready`, `/passport` under a dev chrome
  layout). A discreet "dev" link bridges them; it gets buried in Settings later.
- **Why:** players should land in something that feels like a game on the first
  paint; engineers keep the raw manifest console. One router, two shells, zero
  duplicated data.

### 27.7 NFS-Most-Wanted "Garage" as the front door

- `apps/web/src/game/garage.tsx` — a cold-blue _Need for Speed: Most Wanted_-
  styled car select: hero-car carousel, segmented stat meters, a single **DRIVE**
  CTA that sets the store selection and drops straight into `/play`. It derives
  display specs (peak hp, hp/ton, drivetrain AWD/RWD/FWD, class label, grip /
  agility ratings) purely from the manifest + `tuning`. Adds an `mw` Tailwind
  palette and the Oswald display font.
- **Status:** M1 vertical slice — 2D, with a lucide car/truck glyph standing in
  for the model. Live 3D turntable render, livery, and the title/main-menu shell
  are **M2–M4**. The dev `vehicle-select` page was reworked into matching spec
  cards.

### 27.8 Milestone (Mx) vocabulary alongside the Week plan

- The build is being paced in **player-visible milestones** (M1 = playable
  garage → drive slice on real cars; M2–M4 = 3D garage, livery, menu shell, …)
  layered on top of the blueprint's W1–W14 critical path (§21). This is an
  **addition to the planner's vocabulary**, not a replacement — the two should be
  reconciled in the next planner pass so task IDs and milestones line up.

### 27.9 In-browser verification as a standing practice

- **Complements:** §17's automated test layers.
- Runtime/canvas changes are verified by **actually driving in the browser and
  capturing screenshots**, not just by green CI gates. Evidence lives in
  `Docs/_verify/` (`play-charger`, `play-corvette`, `play-hummer`,
  `vehicles-page`, `motion-corvette-accel`, `motion-corvette-turn`). This
  codifies a team norm: a gate being green is necessary, not sufficient — we look
  at the thing.

---

## 28. Change Log

| Date       | Version | Change                                                           |
| ---------- | ------- | ---------------------------------------------------------------- |
| 2026-05-26 | 1.0     | Combined arch + planner; pivoted to Vercel; removed Phase 1 auth |
| 2026-05-27 | 1.1     | Added §27 "Aman's PM Instincts" — recorded W2–W3 build divergences: three real (NC-licensed) cars vs. one procedural; manifest `visual`/`tuning`/`audio` blocks; GLB visual loader; procedural engine audio; IBL placeholder; game/dev shell split; NFS-MW Garage front door; Mx milestone vocabulary; in-browser verification norm |

---

_End of TRACE_BLUEPRINT.md v1.1._
