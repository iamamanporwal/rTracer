import * as THREE from 'three';

/**
 * Tire-ground contact effects: per-wheel skid trails + a shared smoke
 * particle system. Both feed off the same `WheelSlipFrame` so the visual layer
 * doesn't need to know whether the slip came from a burnout, a handbrake yank,
 * or an ABS lock — it just renders the result.
 *
 * Design:
 *  - **One mesh per skid press**, organized into a small per-wheel pool. Each
 *    time the wheel's slip rises above threshold a fresh mesh is grabbed,
 *    zeroed, and written into until slip drops below threshold or the mesh
 *    fills. This makes every skid a *closed surface* with its own buffer and
 *    its own index list — there is no shared index that can connect
 *    consecutive trails, so the "streak from old skid to new skid" the player
 *    sees with a single ring buffer is impossible by construction.
 *  - Pool wraps round-robin: once `trailsPerWheel` skids have been laid, the
 *    next press overwrites the oldest. Players see the most recent N skids.
 *  - Each trail mesh's positions are zero-initialized; segments past the
 *    actual stamps render as fully-degenerate quads (all 4 verts at the
 *    origin) so a half-filled mesh stops cleanly with no trailing artifact.
 *  - GPU drives smoke (a `uTime` uniform animates age, fade, drift, and size
 *    in the vertex shader) so the CPU only touches a slot when spawning.
 */

export type WheelSlipFrame = {
  /** World-space contact point at the tire footprint. */
  contact: { x: number; y: number; z: number };
  /** Slip magnitude this tick, 0..1. <= threshold ⇒ no FX emission. */
  slip: number;
  /** Whether the wheel is in ground contact this frame. */
  inContact: boolean;
};

export type TireFx = {
  /** Add to the scene once at session start. */
  group: THREE.Group;
  /**
   * Feed the latest per-wheel slip frame and advance internal animation.
   * `dt` is the wall-clock delta this render frame (NOT the fixed step) so the
   * smoke particles keep moving smoothly on high-refresh monitors.
   *
   * `cameraPos` is needed to cull smoke spawns when the player is far away.
   *
   * `chassisRotation` is the body quaternion this frame — used to derive each
   * wheel's lateral axis (band-width direction) for skid stamps. Pulling the
   * lateral from the chassis rather than the per-tick motion vector keeps the
   * band orientation stable through drifts and sharp direction changes, where
   * consecutive contact-point deltas otherwise produce a zig-zag.
   */
  update(
    wheels: readonly WheelSlipFrame[],
    dt: number,
    cameraPos: THREE.Vector3,
    chassisRotation: { x: number; y: number; z: number; w: number },
  ): void;
  /** Free every owned GPU resource. */
  dispose(): void;
};

export type CreateTireFxOptions = {
  /** Number of physics wheels — each gets its own trail-mesh pool. */
  wheelCount: number;
  /**
   * Vertex-pair capacity of a single skid trail. Once the active trail's
   * pool mesh hits this many stamps the trail terminates (and the next time
   * slip rises a fresh mesh is grabbed). Default 96 ≈ 11.5 m of trail at the
   * 0.12 m default stamp spacing — long enough for an aggressive drift, short
   * enough that several trails per wheel fit in the pool.
   */
  maxStampsPerTrail?: number;
  /**
   * How many separate skid trails to keep alive per wheel. Round-robin pool —
   * once full the oldest mesh is reset for the next press. Default 6: the
   * last six skids (per wheel) remain on the ground. Increase for a longer
   * history, at linear memory + draw-call cost.
   */
  trailsPerWheel?: number;
  /** Sprite particles in the shared smoke pool. Default 384. */
  maxSmokeParticles?: number;
  /** Width (m) of each skid stamp across the tire. Default 0.28. */
  skidWidth?: number;
  /**
   * Minimum world distance (m) between two consecutive skid stamps before a
   * new one is dropped. Smaller = denser trail; larger = better perf and
   * stamps spaced enough that overlap doesn't read as a wider stripe. Default
   * 0.12.
   */
  minStampSpacing?: number;
  /**
   * Slip value below which the wheel is treated as rolling — no skid stamp,
   * no smoke. Should match the controller's `SLIP_FX_THRESHOLD`.
   */
  slipThreshold?: number;
};

/**
 * Build the tire-fx renderer. One call per session; the returned handle holds
 * its own group/meshes and exposes `update` + `dispose`.
 */
export function createTireFx(options: CreateTireFxOptions): TireFx {
  const wheelCount = options.wheelCount;
  const maxStampsPerTrail = options.maxStampsPerTrail ?? 96;
  const trailsPerWheel = options.trailsPerWheel ?? 6;
  const maxSmoke = options.maxSmokeParticles ?? 384;
  const skidWidth = options.skidWidth ?? 0.28;
  const minSpacing = options.minStampSpacing ?? 0.12;
  const slipThreshold = options.slipThreshold ?? 0.18;
  const halfW = skidWidth * 0.5;
  const minSpacingSq = minSpacing * minSpacing;

  const group = new THREE.Group();
  group.name = 'tire-fx';
  // The ribbons sit just above the ground (Y = 0). PolygonOffset on the
  // material handles z-fighting with the road; group lift is a belt-and-braces
  // tiny nudge so weather/IBL doesn't darken straight through.
  const SKID_LIFT = 0.012;

  // ── Skid trail pools (one pool per wheel) ──────────────────────────────────
  // Every press-of-the-skid is one independent `Trail`: its own positions
  // buffer, its own index list, its own draw call. Boundaries between trails
  // are physically impossible to bridge because no shared index references
  // both — a fix-by-construction for the previous architecture's leak where
  // a single ring buffer drew a quad from the last stale slot of an old skid
  // to the first slot of a new one.
  //
  // The trails are pre-allocated up front (constant memory) and reused in
  // round-robin. When the (trailsPerWheel + 1)-th press begins, the oldest
  // trail's buffer is reset to zero and the new skid writes into it.
  type Trail = {
    mesh: THREE.Mesh;
    positions: Float32Array;
    posAttr: THREE.BufferAttribute;
    /** Pairs written so far. 0 = empty trail. */
    head: number;
    /** Pair capacity = maxStampsPerTrail. */
    capacity: number;
  };
  type WheelSkid = {
    trails: Trail[];
    /** Index in `trails` of the trail being written; -1 before the first press. */
    current: number;
    /** True while this wheel is actively extending its current trail. */
    active: boolean;
    /** World position of the most recent real-pair drop on the current trail. */
    lastContactX: number;
    lastContactY: number;
    lastContactZ: number;
  };
  const wheelSkids: WheelSkid[] = [];

  // Single shared material across every trail mesh — three.js still issues
  // one draw call per geometry, but state changes between draws are minimal.
  const skidMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0x0c0c0e),
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    side: THREE.DoubleSide,
  });

  // Index list shared across every trail mesh (same layout regardless of
  // wheel/trail). One quad per consecutive vertex-pair, 2 triangles per quad.
  //   pair k:   vertex 2k     (left),  vertex 2k+1   (right)
  //   pair k+1: vertex 2(k+1) (left),  vertex 2(k+1)+1 (right)
  const sharedIndexCount = (maxStampsPerTrail - 1) * 6;
  const sharedIndices = new Uint16Array(sharedIndexCount);
  for (let k = 0; k < maxStampsPerTrail - 1; k++) {
    const a = 2 * k;
    const b = 2 * k + 1;
    const c = 2 * (k + 1);
    const d = 2 * (k + 1) + 1;
    const off = k * 6;
    sharedIndices[off + 0] = a;
    sharedIndices[off + 1] = b;
    sharedIndices[off + 2] = d;
    sharedIndices[off + 3] = a;
    sharedIndices[off + 4] = d;
    sharedIndices[off + 5] = c;
  }

  for (let i = 0; i < wheelCount; i++) {
    const trails: Trail[] = [];
    for (let t = 0; t < trailsPerWheel; t++) {
      const positions = new Float32Array(maxStampsPerTrail * 2 * 3);
      // Each trail gets its OWN index buffer (a copy of the shared layout) so
      // disposing a single trail's geometry doesn't free indices another
      // trail is still referencing.
      const indices = new Uint16Array(sharedIndices);

      const geom = new THREE.BufferGeometry();
      const posAttr = new THREE.BufferAttribute(positions, 3);
      posAttr.setUsage(THREE.DynamicDrawUsage);
      geom.setAttribute('position', posAttr);
      geom.setIndex(new THREE.BufferAttribute(indices, 1));
      // Buffer is large and frequently re-anchored anywhere on the ground,
      // so set an effectively-infinite bounding sphere to bypass culling.
      geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);

      const mesh = new THREE.Mesh(geom, skidMaterial);
      mesh.frustumCulled = false;
      mesh.renderOrder = 1; // draw before smoke so smoke overlays cleanly
      mesh.position.y = SKID_LIFT;
      group.add(mesh);

      trails.push({ mesh, positions, posAttr, head: 0, capacity: maxStampsPerTrail });
    }
    wheelSkids.push({
      trails,
      current: -1,
      active: false,
      lastContactX: 0,
      lastContactY: 0,
      lastContactZ: 0,
    });
  }

  // ── Smoke (shared Points pool) ──────────────────────────────────────────────
  // Custom ShaderMaterial because three's built-in `PointsMaterial` doesn't
  // expose per-particle alpha — and an aging tire-smoke puff is mostly alpha.
  // Particles are simulated entirely in the vertex shader (drift + age + fade)
  // so the CPU only touches a slot when spawning. uTime ticks each frame in
  // wall-clock seconds.
  const smokePositions = new Float32Array(maxSmoke * 3); // spawn position
  const smokeVelocities = new Float32Array(maxSmoke * 3);
  const smokeSpawns = new Float32Array(maxSmoke); // spawn time
  const smokeLives = new Float32Array(maxSmoke); // lifetime seconds
  const smokeSizes = new Float32Array(maxSmoke); // base point size

  // Pre-mark every particle as "expired" so nothing renders before the first
  // spawn (spawn=0, life=0 ⇒ vAge > 1 ⇒ discard in fragment shader).
  for (let i = 0; i < maxSmoke; i++) smokeLives[i] = 0;

  const smokeGeom = new THREE.BufferGeometry();
  const smokePosAttr = new THREE.BufferAttribute(smokePositions, 3);
  smokePosAttr.setUsage(THREE.DynamicDrawUsage);
  smokeGeom.setAttribute('position', smokePosAttr);
  const smokeVelAttr = new THREE.BufferAttribute(smokeVelocities, 3);
  smokeVelAttr.setUsage(THREE.DynamicDrawUsage);
  smokeGeom.setAttribute('aVel', smokeVelAttr);
  const smokeSpawnAttr = new THREE.BufferAttribute(smokeSpawns, 1);
  smokeSpawnAttr.setUsage(THREE.DynamicDrawUsage);
  smokeGeom.setAttribute('aSpawn', smokeSpawnAttr);
  const smokeLifeAttr = new THREE.BufferAttribute(smokeLives, 1);
  smokeLifeAttr.setUsage(THREE.DynamicDrawUsage);
  smokeGeom.setAttribute('aLife', smokeLifeAttr);
  const smokeSizeAttr = new THREE.BufferAttribute(smokeSizes, 1);
  smokeSizeAttr.setUsage(THREE.DynamicDrawUsage);
  smokeGeom.setAttribute('aSize', smokeSizeAttr);
  smokeGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);

  const smokeTex = makeSmokeTexture();
  const smokeMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uTex: { value: smokeTex },
      uTint: { value: new THREE.Color(0.92, 0.92, 0.94) },
    },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute vec3 aVel;
      attribute float aSpawn;
      attribute float aLife;
      attribute float aSize;
      uniform float uTime;
      varying float vAge;
      void main() {
        float t = uTime - aSpawn;
        vAge = (aLife > 0.0) ? (t / aLife) : 2.0;
        // Drift: integrate velocity, add gentle upward bias as the puff lifts.
        vec3 drift = aVel * t + vec3(0.0, 0.6 * t, 0.0);
        vec4 mv = modelViewMatrix * vec4(position + drift, 1.0);
        // Puff grows with age (smoke expands as it dissipates).
        float grow = 1.0 + vAge * 2.6;
        gl_PointSize = aSize * grow * (320.0 / max(-mv.z, 0.1));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex;
      uniform vec3 uTint;
      varying float vAge;
      void main() {
        if (vAge >= 1.0 || vAge < 0.0) discard;
        vec4 tex = texture2D(uTex, gl_PointCoord);
        // Bell-curve alpha: ramps up briefly, then fades out.
        float a = tex.a * (1.0 - vAge) * smoothstep(0.0, 0.12, vAge) * 0.85;
        if (a <= 0.005) discard;
        gl_FragColor = vec4(uTint, a);
      }
    `,
  });
  const smokePoints = new THREE.Points(smokeGeom, smokeMaterial);
  smokePoints.frustumCulled = false;
  smokePoints.renderOrder = 2;
  group.add(smokePoints);

  // ── Per-frame scratch (alloc-free hot path) ─────────────────────────────────
  let elapsed = 0; // accumulates dt for the smoke uTime uniform
  // Carry-over for fractional smoke emissions (target rate is ~80 puffs/s per
  // slipping wheel, but we never emit fractional particles).
  const emitCarry = new Float32Array(wheelCount);
  let smokeHead = 0;
  // Cap the total emission this frame so a high refresh rate can't burst the
  // pool: at most maxSmoke / lifetime particles can be live at once anyway.
  const SMOKE_LIFETIME = 1.05; // seconds — also referenced by emit rate
  const EMIT_PER_SEC = 72;

  function update(
    wheels: readonly WheelSlipFrame[],
    dt: number,
    cameraPos: THREE.Vector3,
    chassisRotation: { x: number; y: number; z: number; w: number },
  ): void {
    elapsed += Math.max(dt, 0);
    smokeMaterial.uniforms.uTime!.value = elapsed;

    // Chassis +X projected onto the ground plane = the lateral band direction
    // for every wheel on this car. Rotating the canonical (1,0,0) by the
    // chassis quaternion gives column 1 of the rotation matrix:
    //     (1 - 2y² - 2z²,  2xy + 2wz,  2xz - 2wy)
    // We keep only (x, z), since the band lies on the ground (y = 0). The
    // result is normalized so band width is independent of body roll/pitch.
    // Reading the chassis once per frame is enough — all wheels share it (we
    // ignore steering for skid orientation; the deflection is small at the
    // speeds where skids form, and using the chassis axis keeps the band
    // perfectly straight through sharp steering swaps).
    const qx = chassisRotation.x;
    const qy = chassisRotation.y;
    const qz = chassisRotation.z;
    const qw = chassisRotation.w;
    let latX = 1 - 2 * (qy * qy + qz * qz);
    let latZ = 2 * (qx * qz - qw * qy);
    const latLen = Math.hypot(latX, latZ);
    if (latLen > 1e-4) {
      latX /= latLen;
      latZ /= latLen;
    } else {
      // Pure upside-down would zero the ground projection; the car can't skid
      // there so the value doesn't matter, but pick a sane default.
      latX = 1;
      latZ = 0;
    }
    const halfLatX = latX * halfW;
    const halfLatZ = latZ * halfW;

    for (let i = 0; i < wheelCount; i++) {
      const wheel = wheels[i];
      const skid = wheelSkids[i];
      if (!wheel || !skid) continue;

      const shouldDraw = wheel.inContact && wheel.slip > slipThreshold;

      if (shouldDraw) {
        if (!skid.active) {
          // ── Begin a new skid in its own mesh ─────────────────────────────
          // Round-robin to the next trail slot in this wheel's pool and zero
          // its buffer so any data left behind by a previous press in this
          // slot is wiped. The skid then writes from slot 0 of the trail.
          skid.current = (skid.current + 1) % trailsPerWheel;
          const trail = skid.trails[skid.current]!;
          trail.positions.fill(0);
          trail.head = 0;
          trail.posAttr.needsUpdate = true;
          // Start anchor: a collapsed pair (left = right) at the contact —
          // gives the first proper stamp a natural taper from a single point.
          writeStamp(trail, wheel.contact.x, wheel.contact.y, wheel.contact.z, 0, 0);
          skid.active = true;
          skid.lastContactX = wheel.contact.x;
          skid.lastContactY = wheel.contact.y;
          skid.lastContactZ = wheel.contact.z;
        } else {
          // ── Continue the current skid ────────────────────────────────────
          // Drop a new vertex pair only if the wheel has moved past the min
          // spacing from the last drop. During a stationary burnout this
          // loop is a no-op — the existing tail guard stays under the wheel
          // and the trail "freezes" until the chassis starts rolling.
          const dx = wheel.contact.x - skid.lastContactX;
          const dz = wheel.contact.z - skid.lastContactZ;
          if (dx * dx + dz * dz >= minSpacingSq) {
            const trail = skid.trails[skid.current]!;
            const ok = writeStamp(
              trail,
              wheel.contact.x,
              wheel.contact.y,
              wheel.contact.z,
              halfLatX,
              halfLatZ,
            );
            if (ok) {
              skid.lastContactX = wheel.contact.x;
              skid.lastContactY = wheel.contact.y;
              skid.lastContactZ = wheel.contact.z;
            } else {
              // Trail full — terminate. Slip is still high so the very next
              // frame will begin a new trail in the next pool slot.
              skid.active = false;
            }
          }
        }

        // Smoke: emit while the trail is being drawn. Cull past ~80 m from
        // the camera — invisible at that range and not worth the pool slot.
        const dxCam = wheel.contact.x - cameraPos.x;
        const dzCam = wheel.contact.z - cameraPos.z;
        if (dxCam * dxCam + dzCam * dzCam < 80 * 80) {
          emitCarry[i] = (emitCarry[i] ?? 0) + EMIT_PER_SEC * wheel.slip * dt;
          let toEmit = emitCarry[i]!;
          while (toEmit >= 1) {
            spawnSmoke(wheel.contact.x, wheel.contact.y, wheel.contact.z);
            toEmit -= 1;
          }
          emitCarry[i] = toEmit;
        }
      } else if (skid.active) {
        // ── End the current skid ─────────────────────────────────────────
        // The guard pair written alongside the most recent stamp already
        // taper-caps the trail's tail. Slots past the head still hold zeros
        // from the reset at trail start, so segments past the cap render
        // fully degenerate. No buffer mutation needed; just flip the flag.
        skid.active = false;
        emitCarry[i] = 0;
      } else {
        // Idle: ensure the carry doesn't accumulate during long idle periods
        // and produce a puff burst the moment slip rises again.
        emitCarry[i] = 0;
      }
    }
  }

  /**
   * Append a vertex pair to a trail and write a collapsed guard pair one slot
   * ahead. The guard:
   *   - Caps the tail with a natural taper if the trail ends on the next
   *     frame (the segment from the real pair to the guard renders as a
   *     thin tip triangle — visually a tire mark fading to a point),
   *   - Is overwritten by the next real pair if the trail continues.
   *
   * Pass `lx = lz = 0` for an "anchor" pair (collapsed at the contact point)
   * to mark the start of a fresh trail; pass the wheel's lateral half-width
   * for a normal stamp.
   *
   * Returns `false` if the trail is already at capacity — the caller should
   * terminate this trail and start a new one in the next pool slot.
   */
  function writeStamp(
    trail: Trail,
    cx: number,
    cy: number,
    cz: number,
    lx: number,
    lz: number,
  ): boolean {
    const idx = trail.head;
    // Need room for both this real pair and the trailing guard pair. The
    // guard sits at idx+1, so the real pair must land at idx <= capacity-2.
    if (idx >= trail.capacity - 1) return false;

    const off = idx * 2 * 3;
    trail.positions[off + 0] = cx + lx;
    trail.positions[off + 1] = cy;
    trail.positions[off + 2] = cz + lz;
    trail.positions[off + 3] = cx - lx;
    trail.positions[off + 4] = cy;
    trail.positions[off + 5] = cz - lz;

    // Guard: both vertices collapsed at the same world point. If this is the
    // last stamp, the segment idx → idx+1 renders as a thin tip wedge.
    const gapOff = (idx + 1) * 2 * 3;
    trail.positions[gapOff + 0] = cx;
    trail.positions[gapOff + 1] = cy;
    trail.positions[gapOff + 2] = cz;
    trail.positions[gapOff + 3] = cx;
    trail.positions[gapOff + 4] = cy;
    trail.positions[gapOff + 5] = cz;

    trail.head = idx + 1;
    trail.posAttr.needsUpdate = true;
    return true;
  }

  function spawnSmoke(cx: number, cy: number, cz: number): void {
    const slot = smokeHead;
    smokeHead = (smokeHead + 1) % maxSmoke;

    smokePositions[slot * 3 + 0] = cx + (Math.random() - 0.5) * 0.18;
    smokePositions[slot * 3 + 1] = cy + 0.08;
    smokePositions[slot * 3 + 2] = cz + (Math.random() - 0.5) * 0.18;

    // Velocity: gentle backward+lateral drift; gravity is omitted so smoke
    // just rises a bit and dissipates. Smoke clouds don't have momentum, the
    // chassis already does.
    smokeVelocities[slot * 3 + 0] = (Math.random() - 0.5) * 0.6;
    smokeVelocities[slot * 3 + 1] = 0.2 + Math.random() * 0.4;
    smokeVelocities[slot * 3 + 2] = (Math.random() - 0.5) * 0.6;

    smokeSpawns[slot] = elapsed;
    smokeLives[slot] = SMOKE_LIFETIME * (0.85 + Math.random() * 0.3);
    smokeSizes[slot] = 0.22 + Math.random() * 0.18;

    smokePosAttr.needsUpdate = true;
    smokeVelAttr.needsUpdate = true;
    smokeSpawnAttr.needsUpdate = true;
    smokeLifeAttr.needsUpdate = true;
    smokeSizeAttr.needsUpdate = true;
  }

  function dispose(): void {
    for (const skid of wheelSkids) {
      for (const trail of skid.trails) {
        trail.mesh.geometry.dispose();
      }
    }
    skidMaterial.dispose();
    smokeGeom.dispose();
    smokeMaterial.dispose();
    smokeTex.dispose();
    group.removeFromParent();
  }

  return { group, update, dispose };
}

/**
 * Build a 64×64 radial-gradient texture for the smoke sprite. Drawn in-canvas
 * so we don't ship a PNG; the texture lives for the session and is freed in
 * `dispose`.
 */
function makeSmokeTexture(): THREE.Texture {
  if (typeof document === 'undefined') {
    // Headless build (tests) — return a 1×1 data texture so the material
    // still compiles. Visual unused.
    const data = new Uint8Array([255, 255, 255, 255]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    return tex;
  }
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.8, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
