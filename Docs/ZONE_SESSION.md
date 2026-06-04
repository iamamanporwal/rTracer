# Zone Session: Lifecycle & Runtime

The zone session is the heart of the game — the object that owns and coordinates physics, rendering, input, and audio for a single play session. It lives in `apps/web/src/zone/session.ts`.

---

## Session Lifecycle

```
User selects zone + vehicle
        ↓
Fetch + Zod-validate manifests  (loadZoneManifest, loadVehicleManifest)
        ↓
startZoneSession(init) ──────────────────────────────────────────────────┐
  │                                                                        │
  ├─ await initRapier()          (WASM, safe to call multiple times)       │
  ├─ createPhysicsWorld()        (Rapier world, fixed 1/60s timestep)      │
  ├─ createRenderer(canvas)      (WebGL, 2× pixel ratio cap)               │
  ├─ createScene()               (Three.js scene, sun, ambient)            │
  ├─ createSurfaceMaterials()    (one material per surface tag)            │
  ├─ createEventBus()            (per-session, not singleton)              │
  │                                                                        │
  ├─ if zoneManifest.world:                                                │
  │    await createGlbZoneVisual()   (load GLB, extract collision geo)     │
  │    createZoneCollider(vertices, indices)   (Rapier trimesh)            │
  │  else:                                                                 │
  │    createGround()            (flat 500×500m slab)                      │
  │    createObstacleField()     (speed bumps, crates)                     │
  │                                                                        │
  ├─ createVehicle()             (Rapier rigid body + raycast controller)  │
  ├─ if vehicleManifest.visual:                                            │
  │    await createGlbVehicleVisual()  (load GLB, rig wheels)             │
  │  else:                                                                 │
  │    createVehicleVisual()     (procedural SUV)                          │
  │                                                                        │
  ├─ createCameraRig()                                                     │
  ├─ createWeatherSystem()                                                 │
  ├─ createBodyDeformer()                                                  │
  ├─ createTireFx()                                                        │
  ├─ createEngineAudio()         (optional, gated on AudioContext)         │
  ├─ createPhysicsDebug()        (off by default)                          │
  │                                                                        │
  ├─ createKeyboardInput()       (WASD / arrows / space / R / O / C / Y)  │
  ├─ createCameraInput()         (mouse orbit)                             │
  │                                                                        │
  └─ createLoop({ step, render }).start()   ─────────── returns ZoneSession┘

ZoneSession = { events, toggleSkeleton(), dispose() }
        ↓
User navigates away  →  React effect cleanup  →  session.dispose()
  │
  ├─ loop.stop()
  ├─ physics.dispose()       (frees WASM heap)
  ├─ renderer.dispose()      (frees GPU buffers)
  ├─ vehicle.dispose()
  ├─ zoneVisual.dispose()
  └─ … all subsystems
```

---

## Game Loop

**File:** `apps/web/src/zone/loop.ts`

The loop implements the canonical fixed-timestep-with-interpolation pattern:

```
accumulator += wallClockDt

while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME):
    step(FIXED_DT)          ← physics + input (deterministic)
    accumulator -= FIXED_DT
    steps++

render(alpha = accumulator / FIXED_DT)   ← interpolated render
```

Constants:
- `FIXED_DT = 1/60` s
- `MAX_STEPS_PER_FRAME = 5` (prevents spiral of death on slow devices)

### `step(dt)` — what runs every physics tick

1. Read current `ControlInput` from keyboard driver
2. `vehicle.update(input, dt)` — apply drivetrain forces, update Rapier vehicle
3. `physics.world.step()` — advance Rapier simulation
4. `physics.drainImpacts()` — collect contacts → forward to deformer and event bus
5. Lap logic (if sidecar present) — check crossing start/finish, checkpoints

### `render(alpha, frameDt)` — what runs every display frame

1. `snapshot = vehicle.readSnapshot()` — interpolated pose at alpha
2. `vehicleVisual.applySnapshot(snapshot)` — update mesh transforms (zero alloc)
3. `camera.update(snapshot, alpha, frameDt)` — spring-damp follow camera
4. `weather.update(frameDt, camera.position)` — sky animation, rain anchor
5. `vehicle.setGripMultiplier(1 - weather.wetness * 0.3)` — live grip modulation
6. `tireFx.update(snapshot.wheels)` — skid marks, smoke
7. `audio.update(snapshot.speed, input.throttle)` — engine pitch
8. `debugDraw.update(...)` — if debug overlay enabled
9. `renderer.render(scene, camera.camera)` — GPU flush

---

## Input System

### Keyboard (`apps/web/src/zone/input.ts`)

```
WASD / Arrow keys  →  throttle / brake / steering
Space              →  handbrake
R                  →  reset vehicle to spawn
O                  →  toggle physics debug overlay
C                  →  cycle camera mode (chase → wide → fpv)
Y                  →  cycle weather preset
```

All keys produce a `ControlInput` each frame — a snapshot, not delta events. The keyboard driver is stateful (tracks which keys are currently held), polled once per fixed step.

### Camera Input (`apps/web/src/zone/camera-input.ts`)

Mouse movement → yaw/pitch delta → forwarded to `CameraRig.applyControl(control)`.

### Input normalization

```typescript
interface ControlInput {
  throttle:  number  // 0..1
  brake:     number  // 0..1
  steering:  number  // -1..1
  handbrake: number  // 0..1
  reset:     boolean
}
```

Inputs are clamped with `clampInput()` before entering the vehicle controller. Invalid ranges from gamepad noise are safely clipped.

---

## State Management (Zustand store)

**File:** `apps/web/src/store/`

The store is organized into slices, combined with Zustand + Immer:

| Slice | Key state | Purpose |
|-------|-----------|---------|
| `ZoneSlice` | `selectedZone`, `loadStatus` | Which zone is selected + load phase |
| `VehicleSlice` | `selectedVehicle`, `liveryColor` | Which vehicle + paint color |
| `SessionSlice` | `status`, `currentLapMs`, `bestLap`, `history` | Lap timing and session status |
| `PassportSlice` | `snapshot` (stamps) | Player's persistent achievement stamps |
| `UISlice` | `route`, `modal` | Navigation state, modal visibility |
| `EditorSlice` | `enabled`, `mode` | Editor tool state (Phase 1 W8) |

The store does **not** own physics or renderer state. It owns only UI-level and persistent state. The `ZoneSession` object is held in a React ref, not in the store.

---

## Routes

```
/                    → Garage (car + map select — production game mode)
├─ /maps             → Map selector
└─ /play/$zoneId     → Game canvas + HUD

/dev                 → Dev landing (alternate flow for testing)
├─ /zones            → Zone picker
├─ /vehicles         → Vehicle picker
├─ /ready            → Pre-drive manifest preview
└─ /passport         → Stamp collection view
```

The `/play/$zoneId` route is where `startZoneSession` is called. On unmount, the React cleanup effect calls `session.dispose()`.

---

## Manifest Loading

```typescript
// Fetch and validate — throws ManifestLoadError on schema failure
const zoneManifest  = await loadZoneManifest(zoneId, version)
const vehicleManifest = await loadVehicleManifest(vehicleId, version)
```

`ManifestLoadError` carries the URL and the Zod error chain so failures are traceable. The Play component has an error boundary that renders validation failures with the raw Zod message.

---

## Adding a New Zone

1. Place assets at `apps/web/public/assets/zones/{zone_id}/v0.1.0/`
2. Write `manifest.json` conforming to `ZoneManifest` schema
3. Add an entry to `apps/web/public/assets/zones/index.json`
4. If the zone has a GLB world mesh, set `manifest.world.glbPath` to the relative path
5. (Optional) Run the asset CLI to process the GLB: `pnpm trace asset ingest world.glb --kind zone --id {zone_id}`
6. Test locally: select the zone in the garage or `/dev/zones`, verify physics collider loads

## Adding a New Vehicle

1. Place assets at `apps/web/public/assets/vehicles/{vehicle_id}/v0.1.0/`
2. Write `manifest.json` conforming to `VehicleManifest` schema
3. Add an entry to `apps/web/public/assets/vehicles/index.json`
4. If the vehicle has a GLB model, set `manifest.visual.glbPath`
5. Tune parameters via `manifest.tuning` — start from the defaults in `trace-physics/src/movement/car/config.ts`
6. Test: verify wheels sit flush on the ground, car drives forward on throttle, handbrake causes rear slide
