# Asset Pipeline & Manifests

Everything about zone and vehicle assets: folder structure, manifest schemas, the asset CLI, and conventions for adding new content.

---

## Asset Folder Structure

All static assets are served from `apps/web/public/assets/`. The path convention is:

```
assets/
├── zones/
│   ├── index.json                          # Zone registry
│   └── {zone_id}/
│       └── v{version}/
│           ├── manifest.json               # ZoneManifest (Zod-validated)
│           ├── world.glb                   # Visual + collision mesh
│           ├── collider.glb                # Physics-only mesh (future — lighter)
│           ├── semantic-sidecar.json       # SemanticSidecar (authored in editor)
│           ├── skybox.glb                  # Environment map (future)
│           └── textures/                   # KTX2-compressed textures (future)
└── vehicles/
    ├── index.json                          # Vehicle registry
    └── {vehicle_id}/
        └── v{version}/
            ├── manifest.json               # VehicleManifest (Zod-validated)
            └── model/
                └── scene.gltf              # Rigged GLB model + embedded textures
```

### Index files

The index files are simple arrays of manifest refs:

```json
// assets/zones/index.json
[
  { "id": "zone_highway",   "version": "0.1.0", "name": "Highway Battle" },
  { "id": "zone_racetrack", "version": "0.1.0", "name": "Race Track" }
]

// assets/vehicles/index.json
[
  { "id": "vehicle_hummer_ev",    "version": "0.1.0", "name": "Hummer EV" },
  { "id": "vehicle_corvette_c2",  "version": "0.1.0", "name": "Corvette C2" }
]
```

---

## ZoneManifest

Full schema is in `packages/trace-core/src/manifests/zone.ts`.

```json
{
  "id": "zone_highway",
  "version": "0.1.0",
  "name": "Highway Battle",
  "physicsProfile": "tarmac_circuit",
  "controlScheme": "circuit",
  "modesSupported": ["free_roam", "timed_run"],
  "world": {
    "glbPath": "world.glb",
    "scale": 1.0,
    "yaw": 0,
    "offset": [0, 0, 0],
    "surfaceTag": "tarmac",
    "materialExclusions": ["Foliage_leaf", "Grass_patch"]
  },
  "spawnPoints": [
    { "position": [0, 0.5, 0], "yaw": 0 }
  ],
  "thumbnailPath": "thumbnail.webp"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `physicsProfile` | `'tarmac_circuit' \| 'dirt' \| 'snow' \| 'drift'` | Base physics preset for this zone |
| `controlScheme` | `'circuit' \| 'rally' \| 'drift' \| 'casual'` | Input feel hint for UI |
| `world.glbPath` | string | Path relative to the manifest's folder |
| `world.scale` | number | Uniform scale applied to the GLB on load |
| `world.yaw` | number | Rotation in degrees — align track to face +Z |
| `world.offset` | Vec3 | Translation offset after scale and yaw |
| `world.surfaceTag` | SurfaceTag | Tag applied to all collision geometry |
| `world.materialExclusions` | string[] | Named GLB materials to skip for collision (visual-only geometry like foliage) |
| `spawnPoints` | Array | Player spawn positions. First entry is the default. |

---

## VehicleManifest

Full schema is in `packages/trace-core/src/manifests/vehicle.ts`.

```json
{
  "id": "vehicle_hummer_ev",
  "version": "0.1.0",
  "name": "Hummer EV",
  "mass": 4110,
  "rig": {
    "wheels": [
      { "position": [ 0.93, -0.10,  1.52], "radius": 0.46, "isDriven": true,  "isSteered": true  },
      { "position": [-0.93, -0.10,  1.52], "radius": 0.46, "isDriven": true,  "isSteered": true  },
      { "position": [ 0.93, -0.10, -1.52], "radius": 0.46, "isDriven": true,  "isSteered": false },
      { "position": [-0.93, -0.10, -1.52], "radius": 0.46, "isDriven": true,  "isSteered": false }
    ]
  },
  "engine": {
    "powerCurve": [
      { "rpm": 1000, "hp": 400 },
      { "rpm": 5000, "hp": 1000 },
      { "rpm": 7000, "hp": 800 }
    ],
    "redlineRpm": 7500
  },
  "gearbox": {
    "ratios": [3.5, 2.1, 1.4, 1.0, 0.8],
    "finalDrive": 3.7,
    "reverseRatio": 3.2
  },
  "visual": {
    "glbPath": "model/scene.gltf"
  },
  "tuning": {
    "rideHeight": 0.45,
    "suspensionStiffness": 0.7
  },
  "audio": {
    "engineType": "electric",
    "idleHz": 60,
    "revHz": 200
  }
}
```

### Wheel rig convention

Wheels are always ordered: **FL, FR, RL, RR** (front-left, front-right, rear-left, rear-right). Positions are in local vehicle space with +X right, +Y up, +Z forward.

### Tuning overrides

The `tuning` field overrides the per-profile defaults from `trace-physics/src/movement/car/config.ts`. Start without tuning and add values only when the car feels noticeably wrong.

| Tuning key | Unit | Effect |
|------------|------|--------|
| `rideHeight` | m | Raise/lower body — Hummer uses 0.45 |
| `suspensionStiffness` | 0..1 multiplier | Softer suspension for heavy/off-road vehicles |
| `driveAccel` | m/s² | Peak longitudinal acceleration |
| `brakeDecel` | m/s² | Peak braking deceleration |
| `steerLock` | radians | Maximum steering angle |
| `steerSpeedScale` | m/s | Speed at which steer lock halves |

---

## GLB Requirements

### Zone meshes

- The mesh must have its geometry centered reasonably (the `world.offset` corrects small offsets).
- Set `world.yaw` so the track's main straight points in the +Z direction.
- All geometry in the GLB becomes collision by default. Use `materialExclusions` for geometry that should render but not collide (foliage, spectator stands, signage).
- Material names must be deterministic (consistent between Blender exports).
- No skinned meshes — zone GLBs are static.

### Vehicle meshes

- Wheels should be separate objects named consistently (e.g., `Wheel_FL`, `Wheel_FR`, `Wheel_RL`, `Wheel_RR`).
- The renderer reparents wheels onto spin pivots using bounding-box centers, so origin placement within each wheel mesh is unimportant.
- The body mesh can have multiple sub-objects (it's all merged by the visual loader).
- `KHR_materials_transmission` glass is automatically downgraded to a cheap glossy-opaque material for mobile performance. This is intentional.
- Embedded textures (base color, roughness/metalness, normal) at ≤2K resolution are fine for Phase 1. KTX2 compression is a Phase 1 W4 task.

---

## Asset CLI

**Path:** `tools/asset-cli/`

```bash
# Ingest a GLB into the zone asset directory
pnpm trace asset ingest path/to/world.glb --kind zone --id zone_my_track --version 0.1.0

# Ingest a vehicle GLB
pnpm trace asset ingest path/to/model.gltf --kind vehicle --id vehicle_my_car --version 0.1.0

# Inspect a telemetry blob (Phase 1 W12)
pnpm trace telemetry-inspect path/to/session.trc1
```

**Phase 0 status:** The CLI prints the planned pipeline stages but does not execute them. Phase 1 W4 implements:
1. Mesh decimation (polygon reduction for LOD)
2. KTX2 texture compression (GPU-native format)
3. Draco geometry compression (smaller transfer size)
4. Collision mesh extraction and simplification
5. Proxy/LOD generation

---

## Physics Profiles Reference

Profiles live in `packages/trace-physics/src/profiles.ts`.

| Profile | Grip | Suspension | Use for |
|---------|------|-----------|---------|
| `tarmac_circuit` | High | Stiff | Road racing circuits |
| `dirt` | Medium-low | Soft, long travel | Off-road, rally |
| `snow` | Very low | Soft | Winter/ice zones |
| `drift` | Medium | Soft side-friction | Dedicated drift tracks |

The profile is set per-zone in `manifest.physicsProfile`. Weather modifies grip on top of the profile at runtime via `vehicle.setGripMultiplier()` — the profile itself is never mutated.

---

## Surface Tags Reference

Surface tags come from `packages/trace-core/src/surface.ts`. They are assigned to collision geometry to drive friction and visual feedback.

| Tag | Friction | Visual color | Notes |
|-----|----------|-------------|-------|
| `tarmac` | 0.9 | Dark gray | Road surface |
| `kerb` | 0.7 | Red/white stripe | Rumble strips |
| `grass` | 0.5 | Green | Off-track grass |
| `dirt` | 0.6 | Brown | Dirt roads |
| `gravel` | 0.55 | Tan | Gravel traps |
| `snow` | 0.25 | White | Winter |
| `sand` | 0.4 | Beige | Desert |
| `barrier` | 0.3 | Gray | Walls, tires |
| `unknown` | 0.5 | Magenta | Fallback |

Zone GLBs use a single surface tag for all their collision geometry (set in `world.surfaceTag`). Per-polygon surface tags are a future feature for the editor.
