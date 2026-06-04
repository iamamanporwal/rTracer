# Package Reference

Deep-dive documentation for every package in `packages/`. For the dependency graph, see [ENGINEERING_GUIDE.md](ENGINEERING_GUIDE.md).

---

## @trace/core

**Path:** `packages/trace-core/`
**Dependencies:** Zod only
**Safe in:** Main thread, Web Workers, Node.js, test environment

### Purpose

The substrate — pure TypeScript with no runtime side effects. Contains math primitives, Zod-validated manifest schemas, the event bus type definitions, and surface tag constants. Every other package imports from here; nothing imports from physics or renderer.

### Public API

#### Math (`src/math/vec.ts`)

```typescript
type Vec3 = [number, number, number]  // [x, y, z]
type Quat = [number, number, number, number]  // [x, y, z, w]

const Vec3Schema: z.ZodTuple  // Zod validator for Vec3
const QuatSchema: z.ZodTuple  // Zod validator for Quat
```

Tuples rather than classes — directly serializable to JSON, safe across `postMessage` boundaries.

#### Manifests (`src/manifests/`)

All manifests are Zod schemas with corresponding TypeScript types inferred from them.

**ZoneManifest** — track configuration:

```typescript
type ZoneManifest = {
  id: string
  version: string
  name: string
  physicsProfile: 'tarmac_circuit' | 'dirt' | 'snow' | 'drift'
  controlScheme: 'circuit' | 'rally' | 'drift' | 'casual'
  modesSupported: Array<'free_roam' | 'timed_run' | 'race'>
  world?: {            // present if zone has a GLB mesh
    glbPath: string    // path relative to manifest location
    scale: number
    yaw: number        // degrees — align track to +Z forward
    offset: Vec3
    surfaceTag: SurfaceTag
    materialExclusions?: string[]  // material names skipped for collision
  }
  spawnPoints: Array<{ position: Vec3; yaw: number }>
  thumbnailPath?: string
}
```

**VehicleManifest** — vehicle parameters:

```typescript
type VehicleManifest = {
  id: string
  version: string
  name: string
  mass: number           // kg
  rig: {
    wheels: WheelRig[]   // exactly 4, order: FL, FR, RL, RR
  }
  engine: {
    powerCurve: Array<{ rpm: number; hp: number }>
    redlineRpm: number
  }
  gearbox: {
    ratios: number[]     // forward gears
    finalDrive: number
    reverseRatio: number
  }
  visual?: {
    glbPath: string      // relative path to GLB model
  }
  tuning?: Partial<CarTuning>   // per-vehicle overrides to physics defaults
  audio?: {
    engineType: 'v8' | 'flat' | 'inline' | 'electric'
    idleHz: number
    revHz: number
  }
}

type WheelRig = {
  position: Vec3    // local position of hub center
  radius: number    // m
  isDriven: boolean
  isSteered: boolean
}
```

**SemanticSidecar** — authored track geometry annotations (centerline, checkpoints, barriers):

```typescript
type SemanticSidecar = {
  version: string
  centerline: Vec3[]         // ordered spline points
  barriers: BarrierSegment[]
  startFinish: { position: Vec3; normal: Vec3 }
  checkpoints: Array<{ position: Vec3; normal: Vec3; index: number }>
  spawnPoints: Array<{ position: Vec3; yaw: number }>
}
```

#### Events (`src/events.ts`)

```typescript
// Create one bus per session — never a global singleton
const events = createEventBus()

// Available event types
type TraceEvents = {
  'collision:impact':         ImpactEvent
  'lap:crossed_start':        LapStartEvent
  'lap:checkpoint':           CheckpointEvent
  'track:left_limits':        void
  'vehicle:reset':            void
  'softbody:plastic':         PlasticEvent
}

events.emit('collision:impact', { force, point, normal })
events.on('collision:impact', handler)
events.off('collision:impact', handler)
```

#### Surface Tags (`src/surface.ts`)

```typescript
type SurfaceTag =
  | 'tarmac' | 'kerb' | 'grass' | 'dirt'
  | 'gravel' | 'snow' | 'sand' | 'barrier' | 'unknown'

const SURFACE_FRICTION: Record<SurfaceTag, number>  // default friction per tag
const SURFACE_DEBUG_COLOR: Record<SurfaceTag, string>  // hex colors for editor
```

---

## @trace/physics

**Path:** `packages/trace-physics/`
**Dependencies:** `@trace/core`, `@dimforge/rapier3d-compat`

### Purpose

All physics simulation. Owns the Rapier world, vehicle rigging, drivetrain math, and wheel/suspension dynamics. The only package that touches Rapier types. Outputs plain `MovementSnapshot` objects — no Rapier types cross the package boundary.

### Initialization

```typescript
// WASM must be loaded before any Rapier usage. Safe to call multiple times.
await initRapier()

// Create one world per zone session
const physics = createPhysicsWorld({ gravity: 9.81, timestep: 1/60 })

// Fixed step in game loop
physics.world.step()

// Harvest contacts for deformation/damage (clears the buffer)
const impacts = physics.drainImpacts()  // Impact[]

// Cleanup
physics.dispose()
```

### Vehicle Controller

```typescript
// Create via the movement framework
const vehicle = createVehicle({
  world: physics.world,
  manifest: vehicleManifest,
  profile: PHYSICS_PROFILES[zoneManifest.physicsProfile],
  spawn: { position, yaw },
  tuning: vehicleManifest.tuning  // optional overrides
})

// Each fixed step:
vehicle.update(input: ControlInput, dt: number)

// Read state for renderer (zero alloc after first call)
const snapshot: MovementSnapshot = vehicle.readSnapshot()

// Runtime weather modifier (from weather system)
vehicle.setGripMultiplier(1 - weather.wetness * 0.3)

// Debug frame (off-by-default, toggled with O key)
const debug: MovementDebugFrame = vehicle.readDebugFrame()

// Cleanup
vehicle.dispose()
```

### MovementSnapshot shape

```typescript
type MovementSnapshot = {
  position: Vec3
  rotation: Quat
  speed: number           // m/s, signed (negative = reversing)
  wheels: WheelSnapshot[]
}

type WheelSnapshot = {
  position: Vec3          // world-space hub center
  rotation: Quat          // accumulated spin + steer angle
  isInContact: boolean
  contactPoint?: Vec3
  slip: number            // 0..1 (1 = full lockup/burnout)
}
```

### Ground and Zone Colliders

```typescript
// Flat infinite ground (for procedural test zones)
createGround(world)

// GLB-based zone mesh → Rapier trimesh collider
// Geometry extracted by @trace/renderer's createGlbZoneVisual
createZoneCollider(world, vertices: Float32Array, indices: Uint32Array)

// Demo: speed bump + dynamic crates
createObstacleField(world)
```

### Physics Profiles

```typescript
const PHYSICS_PROFILES: Record<PhysicsProfileId, PhysicsProfile>

// PhysicsProfileId: 'tarmac_circuit' | 'dirt' | 'snow' | 'drift'
// PhysicsProfile contains:
//   surfaceFriction, tireFrictionSlip, sideFrictionStiffness,
//   suspensionStiffness, suspensionTravel, rollResistance
```

### File Structure

```
movement/
├── types.ts          # MovementController interface, MovementSnapshot, WheelSnapshot
├── index.ts          # createMovement() dispatcher — routes by kind to controller
└── car/
    ├── config.ts     # FORWARD_SIGN, STEER_SIGN, CarFeel defaults
    ├── chassis.ts    # deriveCarChassis() — pure geometry math (unit-testable)
    ├── drivetrain.ts # computeDriveCommand() — force/steer/ABS math (unit-testable)
    ├── controller.ts # createCarController() — Rapier wiring
    ├── slip.ts       # tire slip math
    ├── stability.ts  # rollover detection, yaw damping
    └── wet.ts        # wet-road grip modifier
```

The three-layer separation (chassis → drivetrain → controller) allows the pure math to be unit-tested without a Rapier world.

---

## @trace/renderer

**Path:** `packages/trace-renderer/`
**Dependencies:** `@trace/core`, `three`

### Purpose

All graphics. Creates and manages the Three.js scene, loads GLB assets, drives vehicle and zone visuals, and owns the camera. Never imports from `@trace/physics` — input is always `MovementSnapshot` and plain events.

### Scene Setup

```typescript
const { scene, sun, ambient, dispose } = createScene({
  antialias: true,
  pixelRatio: Math.min(devicePixelRatio, 2)
})

const renderer = createRenderer(canvas)
```

### Vehicle Visuals

Two implementations, same `VehicleVisual` interface:

```typescript
interface VehicleVisual {
  root: THREE.Object3D          // attach to scene
  applySnapshot(snapshot: MovementSnapshot): void  // zero alloc
  dispose(): void
}

// Procedural SUV (no assets needed, good for dev/test)
const visual = createVehicleVisual({ manifest, liveryColor: '#ff3300' })

// GLB rigged model (production)
const visual = await createGlbVehicleVisual({
  url: '/assets/vehicles/vehicle_hummer_ev/v0.1.0/model/scene.gltf',
  manifest,
  restHubLocalY,   // from vehicle.readSnapshot() after first physics settle
  environment      // THREE.Texture for PBR reflections
})
```

Both are driven by calling `applySnapshot(snapshot)` every render frame — transforms are pre-allocated and reused.

### Zone Visuals

```typescript
const zoneVisual = await createGlbZoneVisual({
  url: '/assets/zones/zone_highway/v0.1.0/world.glb',
  config: zoneManifest.world,  // scale, yaw, offset, materialExclusions
  environment
})

scene.add(zoneVisual.group)

// Extracted collision geometry for Rapier
const { vertices, indices } = zoneVisual.collisionGeometry
createZoneCollider(physicsWorld, vertices, indices)
```

### Camera

```typescript
const camera = createCameraRig({
  fov: 65,
  aspect: canvas.width / canvas.height,
  near: 0.1,
  far: 2000
})

// Modes: 'chase' | 'wide' | 'fpv'
camera.setMode('chase')

// Each render frame (with alpha interpolation):
camera.update(snapshot, alpha, frameDt)

renderer.render(scene, camera.camera)
```

### Weather System

```typescript
const weather = createWeatherSystem(scene, { sun, ambient })

// Presets: 'clear' | 'overcast' | 'golden' | 'night' | 'storm'
weather.applyPreset('storm')

// Each render frame:
weather.update(frameDt, cameraPosition)

// Pipe wetness to physics (0 = dry, 1 = fully wet)
vehicle.setGripMultiplier(1 - weather.wetness * 0.3)
```

### Materials

```typescript
// One material per surface tag — shared across all zone geometry
const surfaceMaterials = createSurfaceMaterials()
// Returns: Record<SurfaceTag, THREE.MeshStandardMaterial>

// Cleanup
disposeSurfaceMaterials(surfaceMaterials)
```

### FX and Deformation

```typescript
// Body crumple on hard impacts (contact-force driven)
const deformer = createBodyDeformer(visual.root)
deformer.applyImpact(impact: Impact)

// Per-wheel skid marks + smoke (driven by wheel slip)
const tireFx = createTireFx(scene)
tireFx.update(snapshot.wheels)

// WebAudio engine synth
const audio = createEngineAudio({ engineType: 'v8', idleHz: 40, revHz: 120 })
audio.update(speed, throttle)
```

### Debug Overlay

```typescript
// Collider wireframe, COM, velocity arrow, suspension rays
const debugDraw = createPhysicsDebug(scene)
debugDraw.update(physicsWorld, vehicle.readDebugFrame())
debugDraw.setVisible(false)  // off by default, toggle with O key
```

---

## @trace/softbody (stub)

**Path:** `packages/trace-softbody/`
**Status:** Phase 0 stub. Implemented in Phase 1 W5.

**Planned:** Mass-spring solver running in a Web Worker behind a `SharedArrayBuffer` seam. Takes contact-force impulses from physics and outputs deformed vertex positions for the renderer. Never imported directly — communicates only via postMessage/SAB to stay off the main thread.

---

## @trace/editor (stub)

**Path:** `packages/trace-editor/`
**Status:** Phase 0 stub. Implemented in Phase 1 W8.

**Planned:** Click-tool engine for authoring `SemanticSidecar` JSON — centerline spline fitting, barrier placement, checkpoint definition, undo stack (command pattern). Runs in-browser overlaid on a zone GLB.
