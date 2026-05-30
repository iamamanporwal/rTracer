# Movement System Refactor — Plan

**Mindset:** GTA gameplay/physics engineer, not a sim engineer. The goal is
_believable, responsive, cinematic_ driving that stays stable, lightweight, and
mobile-friendly. We use Rapier's official `DynamicRayCastVehicleController` (we
already do) but clean up its wiring, fix the rig/suspension/COM/collider issues,
and wrap it in a **modular movement framework** that can grow to bikes, planes,
and animals without rewrites.

We do **not** chase real-world physical accuracy. Arcade feel beats simulation.
Avoid overengineering: implement the **car** fully now; scaffold the other
movement kinds as typed extension points, not full implementations.

---

## 1. Diagnosis (what's wrong today)

Source read: `packages/trace-physics/src/vehicle.ts`, `world.ts`, `profiles.ts`,
`apps/web/src/zone/{session,loop,input,camera-input}.ts`,
`packages/trace-renderer/src/{glb-vehicle-visual,vehicle-visual,camera-rig}.ts`.

1. **Center of mass is a hardcoded hack.** `setAdditionalMassProperties(mass,
   {y: -halfExtents.y*0.7*comHeightScale}, …)` with a massless collider. Not
   derived from geometry; couples to the fixed `halfExtents.y = 0.5`.
2. **Suspension connection points ignore the rig.** All struts are pinned at
   `connectionLocalY = -halfExtents.y*0.5` (a constant), and the manifest wheel
   `position.y` is dropped entirely. Ride height is then patched up with a
   `RIDE_HEIGHT` constant + `Math.max(spawn.y, idealBodyY)` fudge. The strut
   stroke is tiny and not physically legible.
3. **Airborne / contact wheel pose is wrong (admitted in code).** The fallback
   adds the chassis-local connection point to the body translation **without
   body rotation**, so wheels detach visually when the car pitches/rolls or
   jumps. Rapier exposes `wheelHardPoint` + `wheelSuspensionLength` +
   `wheelDirectionCs` — we should reconstruct the wheel center correctly in all
   cases.
4. **No modular movement framework.** `createVehicle` is car-only and monolithic
   (chassis math + drivetrain + Rapier wiring + snapshot in one 380-line file).
   Bikes/planes/animals have nowhere to live.
5. **No debug visualizers.** Nothing renders colliders, suspension rays, contact
   points, COM, or velocity — making the above bugs invisible to verify.
6. **Stability knobs are ad-hoc.** `angularDamping = 0.6` is a band-aid; friction
   slip is unbounded (Rapier warns high slip flips cars on hard braking); no
   suspension force cap; solver iterations left default.
7. **Handbrake is just a brake.** No GTA-style rear-grip break for drifting.

What is already good (keep): Rapier raycast vehicle controller; fixed-timestep
accumulator loop (`loop.ts`); per-car `tuning` overrides; surface/terrain
`PHYSICS_PROFILES`; the `VehicleVisual.applySnapshot` render seam; the
drive-direction contract test.

---

## 2. Target architecture

Clean separation: **physics** owns bodies/forces/controllers; **renderer** owns
meshes/camera/debug-draw; **gameplay/session** orchestrates; **deformation**
stays a future worker behind a narrow seam (untouched here). The movement
framework is the new spine inside `@trace/physics`.

```
packages/trace-physics/src/
  world.ts                 # + numSolverIterations, debug passthrough (unchanged API)
  ground.ts profiles.ts input.ts   # unchanged contracts
  movement/
    types.ts               # MovementKind, MovementController, MovementSnapshot,
                           #   WheelSnapshot, MovementSpawn, MovementDebugFrame
    index.ts               # createMovement(world, opts) registry/dispatch by kind
    car/
      config.ts            # axis indices + FORWARD/STEER signs + default CarFeel
      chassis.ts           # deriveCarChassis() — pure: extents, COM, strut Y,
                           #   restLength, rideHeight, restHubLocalY (testable)
      drivetrain.ts        # computeDriveCommand() — pure-ish: engine/brake/steer,
                           #   reverse, handbrake-drift (testable)
      controller.ts        # createCarController(): wires Rapier + chassis + drivetrain
    bike|plane|animal/     # NOT built now; registry returns a clear NotImplemented
  vehicle.ts               # back-compat shim: createVehicle = createCarController
```

- **Public API stays stable:** `createVehicle`, `VehicleHandle`,
  `VehicleSnapshot`, `WheelSnapshot` keep their names/shapes so `session.ts`,
  the renderer, and `vehicle.drive.test.ts` are unaffected. `VehicleHandle`
  becomes a `MovementController` (car kind) plus its existing extra fields.
- **Reusable physics profiles:** terrain profiles (`PHYSICS_PROFILES`) stay;
  per-kind feel defaults live in `car/config.ts` (`bike/config.ts` later).
- **Deterministic fixed timestep:** unchanged — `controller.updateVehicle(dt)`
  then `world.step()` inside the fixed step. `world.timestep === FIXED_DT`.

`renderer`: add `debug-draw.ts` → `createPhysicsDebug(scene)` consuming
`world.debugRender()` (collider wireframe) + a plain `MovementDebugFrame` (COM,
velocity arrow, per-wheel suspension ray + contact dot). No Rapier types cross
into the renderer. Off by default, toggled with the **O** key in the session.

---

## 3. Work breakdown

### P-A — Movement framework skeleton
- `movement/types.ts`: shared types + `MovementController` interface +
  `MovementDebugFrame`.
- `movement/index.ts`: `createMovement(world, {kind, manifest, profile, spawn})`;
  `kind: 'car'` → car controller; others → `throw` with a clear "not implemented,
  framework-ready" message (extension point).
- Stubs: tiny `bike/README`-style note in code comments; no dead files.

### P-B — Car chassis (pure)
- `deriveCarChassis(manifest, profile, tuning)` returns geometry derived from the
  rig: half-extents (x/z from track/wheelbase + margins, y from wheel radius),
  COM offset (configurable fraction of half-height below center, default ≈ old
  feel), per-wheel strut connection Y = `hubLocalY + restLength` (strut sits
  above the hub), `restLength`/`maxTravel` from profile × tuning, computed
  `rideHeight`/spawn Y so wheels rest flush (no `Math.max` fudge), and
  `restHubLocalY` for the visual seam.

### P-C — Car drivetrain (pure-ish)
- `computeDriveCommand(input, signedSpeed, params)` → `{enginePerWheel,
  frontBrake, rearBrake, steerAngle, rearGripMul}`.
- Keep the arcade power/speed force model + accel/decel/reverse caps (preserve
  drive-test magnitudes), speed-sensitive steering.
- **GTA handbrake:** strong rear brake **and** `rearGripMul < 1` so the back
  steps out → drift. Surface/profile still scales grip.

### P-D — Car controller (Rapier wiring)
- `createCarController(world, opts): VehicleHandle` using P-B/P-C.
- Fix wheel pose: reconstruct world wheel center from `wheelHardPoint +
  (R·directionCs)·suspensionLength`; contact via `wheelContactPoint` /
  `wheelIsInContact`. Rotation-correct in air and on slopes.
- Stability: bounded `frictionSlip`, `setWheelMaxSuspensionForce`, tuned
  compression/relaxation, `world.numSolverIterations` bump, principled COM,
  modest angular damping.
- `readDebugFrame()` (alloc-free) → `MovementDebugFrame`.

### P-E — Renderer debug visualizers
- `debug-draw.ts`: collider wireframe (`LineSegments`, vertex colors), COM
  sphere, velocity `ArrowHelper`, per-wheel suspension line + contact dot.
- Export from renderer index. Zero cost when disabled.

### P-F — Session wiring
- Create debug overlay; toggle on **O**; feed `physics.world` +
  `vehicle.readDebugFrame()`; surface label via existing HUD line. No API change
  to `startZoneSession`.

### P-G — Tests
- `chassis.test.ts`: derivation invariants (wheels rest flush, COM below center,
  extents enclose track/wheelbase).
- `drivetrain.test.ts`: throttle→forward force sign, brake vs reverse split,
  handbrake drops rear grip, steering shrinks with speed.
- `stability.test.ts`: 600-step throttle+steer run stays upright (local up·world
  up > 0.7), bounded height (no explosion), comes to rest under brake.
- Keep `vehicle.drive.test.ts` green (forward +Z, reverse −Z, A→+X, D→−X).

---

## 4. Constraints / risk control
- Preserve exported names + snapshot shapes; verify by typecheck + existing test.
- Keep `FORWARD_SIGN = -1` / `STEER_SIGN = -1` (locked by test) but centralize +
  document them in `car/config.ts` — don't "fix" the sign and risk regressions.
- Reproduce current accel/brake feel by default; only the listed bugs change
  behavior. GLB cars (Hummer/Charger/Corvette) must still drive.
- Lightweight: alloc-free hot paths; debug draw off by default; no new deps.

## 5. Self-evaluation checklist (run after execute)
- [x] `pnpm typecheck` clean (all 7 packages)
- [x] `pnpm lint` clean (0 errors)
- [x] `pnpm test` green — 29 tests (21 physics incl. new chassis/drivetrain/stability
      + the drive-direction lock; 8 web)
- [x] `pnpm --filter @trace/web build` compiles the web bundle
- [x] In-browser drive (Playwright + headless WebGL/Rapier): procedural car
      accelerates >8 km/h, **O** toggles the debug overlay, brakes to a stop, 0
      console errors
- [x] In-browser drive: GLB car (Corvette) loads from the garage and drives
- [x] Defects found during self-eval — fixed (see §6)

## 6. Defects found in self-eval (and fixes)
1. **GLB cars never finished loading in-browser.** Bisected with timing logs to
   the *first WebGL render*: the downloaded models carry `KHR_materials_transmission`
   glass, which forces a per-frame full-screen transmission pass that stalls
   software/headless WebGL (and is a mobile-perf landmine — counter to the
   lightweight goal). **Fix:** the GLB material pass now downgrades transmissive
   glass to a cheap glossy-opaque material (`glb-vehicle-visual.ts`). GLB cars
   load and drive in-browser, and are far cheaper on mobile. (Glass is no longer
   see-through; revert per-material if a high-end tier wants it back.)
2. Lint warnings (non-null assertions) in a new test — rewritten with guards.

## 7. Follow-up fixes (post-feedback)
1. **Wheels slid behind the body at speed (all cars).** Root cause: the loop
   raycasts wheels in `updateVehicle()` (pre-step pose) then `world.step()` moves
   the body; rendering read the body post-step but the wheels from Rapier's
   cached pre-step hard point → wheels lagged `speed × dt` (~18 cm at 40 km/h),
   scaling with speed. **Fix:** `controller.ts` reconstructs each wheel from the
   live body transform (`bodyT + R·connection + R·(0,-1,0)·suspensionLength`).
   Locked by a new `stability.test.ts` case (body-local x/z pinned to the rig
   within 6 cm at speed); confirmed with 53–56 km/h side-view screenshots.
2. **Hummer ground clearance.** New optional `tuning.rideHeight` (m) raises the
   settled body ~1:1 (Hummer → 0.45). The controller now pre-settles the car on
   its springs at construction and **measures** `restHubLocalY`, so the body mesh
   seats exactly over the wheels (incl. spring sag) at any ride height.

## 8. Weather system — anime sky, rain, slippery roads

Goal: an anime-stylized bright-blue sky with soft stylized clouds; clouds tint
with weather (gray under storm, golden at sunset); a rain particle system; rain
reduces tire grip live. Built mobile-first.

### Architectural calls
- **Don't mutate the zone physics profile** (Blueprint §6.3 — profile is static
  per zone). Instead, the car controller gains a runtime
  `setGripMultiplier(m)` overlay. Profile = surface baseline; weather = dynamic
  modifier on top.
- **One weather system, not three** — `createWeatherSystem({scene,sun,ambient})`
  owns sky + rain + lighting, applies presets atomically, exposes `wetness`.
- **Mobile-first**: GPU-side animation everywhere; pool sizes scaled by device.

### Sky — `@trace/renderer/sky.ts`
- Large inverted icosahedron (radius 3000, detail 3 → ~640 verts). One draw call.
- `ShaderMaterial`: vertical gradient (uHorizon → uZenith), two scrolling samples
  of a 256×128 procedurally-baked cloud `CanvasTexture` for parallax, masked by
  `uCloudColor` × `uCloudCoverage`. Horizon-fade so clouds taper out near ground
  (anime distance look).
- `toneMapped: false` + `fog: false` to keep the saturated anime palette.
- Render order `-1`, depthWrite/depthTest off, frustum culled off.

### Rain — `@trace/renderer/rain.ts`
- `THREE.Points` with custom shader. Particles' base positions are random inside
  a fixed field (60×40×60 m) around origin. The vertex shader translates by the
  uniformed camera-XZ each frame (field follows camera) and wraps Y with
  `uTime × uFallSpeed`. **Zero per-particle CPU work** — only uniforms update.
- Fragment shader carves a thin vertical streak inside each point sprite (no
  texture): `discard` outside the strip, soft alpha taper at tips.
- AdditiveBlending, depthWrite off, frustumCulled off.
- Pool size: `isMobile ? 600 : (cores >= 8 ? 2000 : 1200)`. `setIntensity(0..1)`
  drives alpha + point size; `group.visible = false` when fully dry → 0 cost.

### Weather system — `@trace/renderer/weather.ts`
- Extends `WeatherPreset` with `skyZenith`, `skyHorizon`, `cloudColor`,
  `cloudCoverage` (0..1), `rainIntensity` (0..1; also = wetness).
- Five existing presets updated with anime palettes (clear / overcast / golden /
  night / storm) — storm = `rainIntensity 1.0`, golden = warm cloud tint.
- `applyPreset(p)` updates lighting (old `applyWeather` behavior), sky uniforms,
  rain intensity — atomic.
- `update(dt, camPos)` advances sky/rain time and anchors rain to camera.
- `wetness` getter for the session to pipe to physics.

### Wet grip — car controller
- `setGripMultiplier(m ∈ [0.1, 1])` stored as closure state.
- Update tick: multiplies `chassis.sideFrictionStiffness` (combines with the
  handbrake rear-cut) and re-applies `wheelFrictionSlip` when the multiplier
  changes.
- Session: `vehicle.setGripMultiplier(1 - weather.wetness * 0.4)` per render
  frame. Full rain → 60% grip (slippery but driveable arcade feel).

### Frame budget (target: mobile 60 Hz)
- Sky: 1 draw call, 2 tex lookups/frag, ~640 verts → <0.5 ms.
- Rain: 1 draw call, ≤2000 points, GPU-only animation → <0.5 ms.
- Wet grip: ≤8 `setWheel*` calls per tick → negligible.

### Tests
- `wet.test.ts`: under `setGripMultiplier(0.6)`, equal brake input leaves a
  higher residual speed than dry (slipperier).
- All existing tests stay green.
- In-browser: cycle to storm with **Y**, drive, no console errors, car still
  accelerates but slides more.

### Defects found during self-eval (and fixed)
1. **Sky dome was being clipped by the camera's far plane.** Original dome
   radius 3000m, camera far 2000m → vertices behind far → frustum-clipped to
   nothing (only corner triangles survived through float jitter, which read as
   solid scene-background blue everywhere else). **Fix:** shrunk the dome to
   radius 1200 (well inside far) and added `sky.setCameraAnchor(x,y,z)` so the
   dome re-centers on the camera each frame — "infinite sky" preserved no
   matter where the car drives. (Standard skybox-follows-camera pattern.)
2. **Clouds invisible at chase-cam angles.** Horizon fade was
   `smoothstep(0.02, 0.22, up)` — clouds killed below `up=0.22`, but the chase
   cam mostly sees `up<0.3` of sky. Re-tuned to `smoothstep(-0.02, 0.06, up)`
   and remapped coverage→threshold so coverage controls visible cloud mass
   instead of just the texture's brightest peaks. Tightened the cloud-edge
   smoothstep band to 0.08 for crisp anime puffs (not foggy mist).
3. **Rain streaks read as chunky white bars + tanked frame rate.** Sprites too
   large + strip width 10% + alpha 0.65 → massive overdraw under additive
   blending (7 fps in SwiftShader). **Fix:** sprite size halved, strip width
   6%, alpha 0.4, field height 25 m, pool max 1500 (was 2000). Reads as thin
   anime streaks and 28 fps after the fix (real GPUs / mobile run faster).
4. **Wet grip too punishing at full rain.** Original `1 - wetness*0.4` (60%
   grip) made the car nearly immovable on launch (1 km/h after 2 s of W). Tuned
   to `1 - wetness*0.3` (70% grip) — slippery-but-driveable, ~8 km/h after 2 s.
