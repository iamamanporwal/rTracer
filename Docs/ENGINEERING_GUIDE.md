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
  pitchLean: number  // -1..1  bikes only: +1 lean back (wheelie), -1 lean forward (stoppie)
  reset:     boolean
}
```

**Key layout** (see [input.ts](../apps/web/src/zone/input.ts)):

- **W / A / S / D** — drive (throttle, steer-left, brake, steer-right). These are "intents": a key press OR a touch button press both count.
- **← / →** — also steer (they fold into the same steering value as A / D).
- **↑ / ↓** — bike *rider lean*. ↓ leans back (with throttle → wheelie), ↑ leans forward (with brake → stoppie). Cars ignore lean.
- **Space** — handbrake. **R** — reset/respawn.

The four arrow keys are tracked as their own separate flags (not merged into WASD) so the dev input logger and telemetry recorder can show exactly which physical arrow is held. `pitchLean` is a plain on/off modifier (no analog ramping): ↓ = +1, ↑ = −1, neither = 0.

---

## Vehicles: Cars and Bikes

Every vehicle is described by a JSON manifest ([vehicle.ts](../packages/trace-core/src/manifests/vehicle.ts) is the schema). One new field decides the whole flavour:

```jsonc
"class": "car"   // or "bike". Missing = "car" (all the original vehicles).
```

When the session builds a vehicle ([session.ts](../apps/web/src/zone/session.ts)), it looks at `class` to pick which *visual* to construct. The **physics is the same engine either way** — both cars and bikes are raycast vehicles. Only the look changes.

### Cars (the default)

- Physics: a 4-wheel raycast vehicle. The pure math layers live in [packages/trace-physics/src/movement/car/](../packages/trace-physics/src/movement/car/).
- Visual: `createGlbVehicleVisual()` (a rigged GLB) or `createVehicleVisual()` (a procedural SUV for dev/test).

### Bikes (the two-wheel path)

A motorbike can't physically be a 2-wheel raycast vehicle: with both wheels on the centreline there's no side-to-side base, so it tips over instantly. The trick we use:

> **The physics is a stable, narrow FOUR-wheel rig that never falls over. The two wheels you actually see are cosmetic. Everything that makes it look and feel like a bike is done in the renderer.**

So a bike manifest still lists four wheels in its `rig` (two close pairs, front and rear), and it reuses all the carefully-tuned car dynamics. The schema now accepts "at least two wheels" instead of "exactly four", but bikes in practice use the narrow four.

The bike visual is [bike-visual.ts](../packages/trace-renderer/src/bike-visual.ts) (`createBikeVisual`). It does four things on top of the shared chassis pose:

1. **Body + named rig nodes.** The GLB is prepared *offline* (see the Blender pipeline below) so it already contains the nodes the renderer drives: `wheel_front`, `wheel_rear`, a `steer` pivot on the real steering axis, and a `grips` mesh for the handlebars. No mesh surgery happens at load time.
2. **Steering.** The `steer` node is rotated about the bike's *rake axis* (the tilted-back steering axis, given by `visual.steer.axis`) by the front wheel's steer angle, clamped to `visual.steer.maxDeg`. The front wheel and handlebar grips turn together on the true steering axis.
3. **Cosmetic lean.** The body rolls into corners by an angle of roughly `gain × speed × steer`, clamped to ~35° and smoothed frame to frame. The *physics* body stays upright (the anti-roll keeps it level); only the visual leans. It always eases back to upright as you slow or straighten.
4. **Rider.** A rigged human (a Mixamo FBX) is seated on the bike and parented under the body, so it leans with it. On a hard enough crash it can play a falling animation.

One extra subtlety: because the physics rig has four wheels but the bike shows two, skid marks would otherwise draw as two parallel streaks. The session collapses the rig's left/right wheel pairs onto the centreline and feeds the tire FX **two** merged wheels (front + rear), so the rear lays down a single believable skid.

### The rider rig

How the rider is posed lives in one place: [rider-rig.ts](../packages/trace-renderer/src/rider-rig.ts). Both the game and the dev pose editor build a rig from the same FBX and pose it the same way, so a pose authored in the editor looks identical in-game.

Instead of hand-setting bone angles (which break when the model's skeleton differs), the rig uses **inverse kinematics (IK)**:

- It tucks the spine and neck forward (the one place plain rotations are used).
- It seats the hips on the bike's seat point.
- It runs a 2-bone IK so the **hands** land on the bike's actual handlebar grips and the **feet** land on the footpegs.

A `RiderPose` is just a set of offsets layered on those hardpoints (hand/foot/hip nudges, spine tuck, and "pole" hints for which way elbows and knees bend). `DEFAULT_RIDE_POSE` reproduces the original hand-tuned sport tuck. There's a named pose for each riding state — `idle`, `corner`, `brake`, `wheelie`, `stoppie` — authored as deltas from the default.

> ⚠️ **Known limitation:** the IK is solved in the bike container's local frame *treated as world*, which is only exact while the container sits at the origin (true at asset load and in the pose editor). Re-posing the rider every frame on a *moving* bike would need the targets transformed by the container's world matrix — that's a deliberate follow-up, not wired up yet. Today the rider holds the one tuck pose while riding.

### When a bike crashes

The manifest's `rider.crashImpulse` is a force threshold. When a chassis contact harder than that lands, the session calls the visual's `crash()`, which plays the rider's fall clip (`rider.fallClip`) if one was supplied. For cars (and bikes with no rider) the threshold is effectively infinite, so it never fires.

### Bike manifest fields (quick reference)

```jsonc
{
  "class": "bike",
  "visual": {
    "format": "glb",
    "glb": "model/scene.glb",
    "steer": { "axis": [0, 0.9135, -0.4067], "maxDeg": 26 }  // raked steering axis + lock
  },
  "rider": {
    "fbx": "rider/x_bot.fbx",   // Mixamo humanoid, loaded at runtime
    "fallClip": "rider/fall.fbx",  // optional, played on a hard crash
    "scale": 0.01,              // Mixamo exports are in cm → ~0.01
    "offset": [0, -0.86, -0.12],   // seat alignment nudge (metres)
    "crashImpulse": 4000        // N·s above which the fall animation triggers
  }
}
```

The shipped bikes are `vehicle_bike` (Honda NR750) and `vehicle_jawa` (Jawa cafe racer). The garage shows them with a motorcycle icon and a "Bike" class label.

---

## Stunts

### Wheelie & stoppie (rider lean)

Bikes get GTA-style stunt controls driven by the `pitchLean` input:

- **↓ + throttle, while moving** → **wheelie** (front wheel lifts).
- **↑ + brake, while moving faster** → **stoppie** (rear wheel lifts).

The car controller ([controller.ts](../packages/trace-physics/src/movement/car/controller.ts), bikes only) handles this by **PD-driving the chassis pitch to a fixed target angle** (about 38° nose-up for a wheelie, 30° nose-down for a stoppie). Because it balances *at* a target rather than just pushing, the bike holds the angle instead of looping all the way over. The moment you release the keys it lets the normal "anti-pitch" restore pull the bike back level. There are minimum throttle/brake and minimum speed gates so a stunt only pops when you actually mean it. The tuning constants (`WHEELIE_TARGET_RAD`, `STOPPIE_TARGET_RAD`, `WHEELIE_PITCH_KP`, the min-speed/throttle gates) live in [config.ts](../packages/trace-physics/src/movement/car/config.ts).

Cars ignore `pitchLean` completely.

### The stunt park (ramps + a loop)

On the **procedural flat plane only** (the dev/alpha zone with no GLB track), the session builds a small stunt course next to the obstacle field. The physics side is [stunts.ts](../packages/trace-physics/src/stunts.ts); the renderer mirrors it 1:1 in [stunts.ts](../packages/trace-renderer/src/stunts.ts). Everything is a *static* collider, so the visuals are built once and never touched per frame. What you see is exactly what you collide with.

The course has two lanes:

- **Ramp lane** — a small kicker, a big launch ramp, then a long-jump (takeoff wedge, a gap, a down-sloped landing ramp).
- **Loop lane** — a lead-in ramp feeding a vertical **360° loop**.

The loop deliberately needs a **minimum entry speed**. Physics says a vehicle on the inside of a loop of radius R needs entry speed ≥ √(5·g·R) just in the ideal case (~15 m/s for our R≈4.5 m); friction and suspension losses push the real threshold to roughly ~20 m/s. Roll in too slow and the bike stalls partway up and slides back down — exactly the "hit it fast enough to make it" behaviour. This is proven by a real Rapier sim in [loop-stunt.test.ts](../packages/trace-physics/src/movement/car/loop-stunt.test.ts), and the lean/stunt gating by [bike-stunts.test.ts](../packages/trace-physics/src/movement/car/bike-stunts.test.ts).

---

## Driving feel: the main tuning levers

A few physics constants ([config.ts](../packages/trace-physics/src/movement/car/config.ts)) have the biggest effect on how the car feels. Each is also overridable per-car through `manifest.tuning`. The driving target is "NFS Most Wanted — never flips, fully tunable."

| Lever | What it does |
|-------|--------------|
| **`angularDamping`** (default 1.2) | The primary **anti-oversteer** control. It resists how fast the chassis can rotate, so the rear can't snap around faster than you steer — the car settles into a turn instead of sliding. The handbrake drift still overpowers it, so deliberate slides still work. (Was hardcoded at 0.6; now tunable per car.) |
| **`maxSteerDeg`** (default 26) | Steering lock. Lowered from 30 so corner entry is calmer — a street-car rack, not a twitchy go-kart. |
| **`steerSpeedScale`** (default 15) | The speed at which steering lock has halved. Lowered from 22 so the front bites *less* at high speed (can't snap into oversteer in fast corners) while staying agile when parking. |
| **Suspension force cap** (`SUSPENSION_MAX_FORCE_HEADROOM` = 4) | Rapier defaults each wheel's max suspension force to a flat 6000 N — fine for a light hatchback, but **far too low for a heavy vehicle** (a 4-tonne Hummer needs ~10 kN per corner). When the spring saturates, the chassis sinks until its box rests on the ground and friction drags it like a parking brake (feels like the car "auto-brakes" and won't accelerate). The fix: size the cap to *this* car's own weight (`mass · g · 4 / wheelCount`), so every vehicle gets the same headroom no matter its mass. |

> See also the saved notes on these: the brake-impulse units, the suspension force cap, and the "never flip / fully tunable" feel are documented in project memory.

---

## Dev Tools (developer-only)

These exist to build and debug content. None of them ship to players; the telemetry/replay UI is gated behind **dev mode** in the play view, and the preview pages aren't linked by any route.

### Telemetry recorder

[telemetry.ts](../apps/web/src/zone/telemetry.ts) records a whole run as a flat table — one row per physics step (60 per second). Each row holds the exact chassis pose, speed, heading, the control input fed to the controller that step, the raw arrow keys, and any contact "hits" (where the car got hit and how hard). It's **opt-in**: while not recording it's a complete no-op, so normal play keeps its zero-allocation hot path.

Two consumers shape what's recorded:
- **Analytics** — you can download the capture as a **CSV** (a `#`-commented metadata header with zone/vehicle/spawn, then one row per step).
- **Replay** — each row also keeps the per-wheel visual pose in memory (not in the CSV) so the 3D replay can pose the vehicle frame-for-frame.

A safety cap stops recording after 30 minutes so a forgotten capture can't grow forever.

### 3D replay player

[replay.ts](../apps/web/src/zone/replay.ts) turns a finished capture into a scrubbable "video player" inside the live canvas:

- `createReplayPlayer` is the **transport** — play / pause / reverse / scrub / speed (0.25× to 2×). It interpolates between recorded frames (slerp for rotation, lerp for position and wheels) so the car reads smoothly at any playback speed, allocation-free.
- `createReplayCamera` is a **free bird's-eye camera** — drag to orbit, scroll to zoom, right-drag or two-finger to pan. It follows the car until your first pan, then frees up to fly anywhere.

When you press Play, the session ([session.ts](../apps/web/src/zone/session.ts) `enterReplay`) **freezes the live sim** — physics never steps in replay — hands the canvas to the free camera, and poses the vehicle straight from the recorded frames. Exit and the live car snaps back exactly where it was. The on-screen chrome is [replay-overlay.tsx](../apps/web/src/zone/replay-overlay.tsx).

### Input logger

Part of [telemetry-overlay.tsx](../apps/web/src/zone/telemetry-overlay.tsx): live WASD + Space + arrow keycaps that light the instant a key goes down. It reads the raw `InputActive` state (the on/off intents *before* analog smoothing), so a keycap is crisp instead of trailing the smoothed throttle/steer value. The record/replay/download buttons live in the same bottom-left column.

### Bike preview & pose editor (standalone pages)

Two HTML entry points at the web app root, not referenced by any route (safe to delete):

- **`/bike-preview.html`** ([bike-preview.ts](../apps/web/src/dev/bike-preview.ts)) — loads a bike + rider through the real `createBikeVisual` so you can inspect the surgered GLB, the steering rig, and the rider posture from any angle, with programmable steer/spin/speed. Used by a Playwright screenshot script. URL params pick the bike: `?v=vehicle_jawa&hub=-0.179`.
- **`/pose-editor.html`** ([pose-editor.ts](../apps/web/src/dev/pose-editor.ts)) — author the rider poses by eye instead of editing constants. Draggable gizmos sit on the IK targets (hips, both grips, both pegs); drag one and the rider re-solves live. A GUI panel exposes the spine/neck tuck, foot aim, elbow/knee poles, a pose-state selector, and **Export/Import of the whole pose set as JSON**. Because it uses the real rig, a pose authored here lands identically in-game.

### Blender asset pipeline

Raw downloaded bike models aren't ready to drive — wheels are fused into the body, side-stands are deployed, there's no steering pivot. Rather than do fragile mesh surgery at runtime, we **bake the edits into the GLB offline** with Python scripts in [tools/blender/](../tools/blender/):

- **`bike_surgery.py`** — for the Honda NR750 (one fused 38k-vert chassis). Strips the cosmetic floor plane and side-stand, splits the fused wheels into clean `wheel_front` / `wheel_rear` with origins on the true hub (so they spin without wobble), and builds the `steer` pivot on the rake axis parenting the front wheel + grips. (The fork is fused into the fairing and can't be separated cleanly, so it stays fixed — it's occluded by the fairing and rider from the chase cam anyway.)
- **`jawa_surgery.py`** — for the Jawa (which ships as ~175 separate parts, so it can be grouped by region with no cutting and gets true fork + handlebar steering).
- **`pose-editor-smoke.mjs`** — a smoke test for the pose editor.

Run them with Blender headless, e.g.:

```bash
blender --background --python tools/blender/bike_surgery.py -- input.glb apps/web/public/assets/vehicles/vehicle_bike/v0.1.0/model/scene.glb
```

After surgery, the renderer just drives the named nodes — no geometry work at load.

---

## Navigation: Where to Find Things

| Question | Where to look |
|----------|---------------|
| How does the car physics work? | [`PACKAGES.md#trace-physics`](PACKAGES.md#tracephysics) + `packages/trace-physics/src/movement/car/` |
| How does rendering work? | [`PACKAGES.md#trace-renderer`](PACKAGES.md#tracerenderer) + `packages/trace-renderer/src/` |
| How does a zone session start? | [`ZONE_SESSION.md`](ZONE_SESSION.md) + `apps/web/src/zone/session.ts` |
| What goes in a manifest? | [`ASSETS.md`](ASSETS.md) + `packages/trace-core/src/manifests/` |
| How does a bike work? | "Vehicles: Cars and Bikes" above + `packages/trace-renderer/src/bike-visual.ts`, `rider-rig.ts` |
| Wheelie / stoppie / the loop? | "Stunts" above + `packages/trace-physics/src/stunts.ts`, `movement/car/controller.ts` |
| Why does the car feel like X? | "Driving feel: the main tuning levers" above + `packages/trace-physics/src/movement/car/config.ts` |
| How do I record / replay a run? | "Dev Tools" above + `apps/web/src/zone/telemetry.ts`, `replay.ts` |
| How do I prep a new bike model? | "Blender asset pipeline" above + `tools/blender/` |
| What tasks are left? | [`TRACE_BLUEPRINT.md`](TRACE_BLUEPRINT.md) §19–§24 |
| How to deploy? | [`PHASE_0_HANDOFF.md`](PHASE_0_HANDOFF.md) |
| App routing and state | `apps/web/src/router.tsx`, `apps/web/src/store/` |
