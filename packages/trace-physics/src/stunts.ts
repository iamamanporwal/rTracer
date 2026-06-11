import RAPIER from '@dimforge/rapier3d-compat';

/**
 * Stunt park for the alpha (dev) plane — smooth curved kick ramps, a big stunt
 * jump (kicker → gap → landing), and a vertical 360° loop every vehicle can ride
 * (cars and bikes). Pure physics here: every piece is a static (fixed) collider
 * and the renderer mirrors {@link StuntPark.readSnapshot} into Three.js meshes
 * 1:1, so what you see is exactly what you launch off / loop around.
 *
 * Coordinate notes (shared with `obstacles.ts`):
 *   • Right-handed, Y-up, metres. Forward from spawn is -Z (`FORWARD_SIGN = -1`).
 *   • Ramps rise toward -Z, so a rider driving forward (-Z) climbs them.
 *   • Jumps sit dead ahead (x≈0); the loop gets its own clear parallel runway.
 *
 * Why curved ramps: a flat wedge has a hard edge at its base — hit it at speed
 * and the suspension slams and the launch is unpredictable. Instead every kick
 * ramp is a circular ARC: it starts flush/flat with the ground (tangent 0°) and
 * curves smoothly up to the launch angle, so the suspension loads progressively
 * and the launch is clean and repeatable. Built from short box segments; the loop
 * is just the same arc taken all the way around.
 *
 * Loop physics — why a minimum entry speed is required: a vehicle on the inside
 * of a vertical loop of radius R needs, at the top, centripetal accel ≥ g or it
 * falls off; energy conservation gives a bottom entry speed of v ≥ √(5·g·R).
 * Hit it fast enough and the loop assist (controller.ts) carries it over; too
 * slow and it stalls partway up and slides back. The ramp launch angles are kept
 * well below the loop assist's surface-bank threshold so jumps never get "stuck".
 */

const DEG = Math.PI / 180;

// ── Layout (metres). Tune freely; the renderer reads the snapshot. ───────────
const RAMP_LANE_X = 0; // jump progression sits dead ahead of spawn
const LOOP_X = 24; // the loop gets its own clear parallel runway to the right

const SEG_STEP = (2 * Math.PI) / 64; // arc segment pitch (~5.6°) — fine = smooth
const RAMP_FRICTION = 1.0; // grippy skatepark surface — clean, repeatable launches
const RAMP_RESTITUTION = 0.0; // no trampoline bounce; air comes from the slope

const LOOP_RADIUS = 5.5; // big enough that even a long car conforms to the ring
const LOOP_LIFT = 1.2; // raise the ring so the lead-in ramp has room to be gradual
const LOOP_WIDTH = 3.6; // wide enough for any car to stay between the kerbs
const LOOP_THICKNESS = 0.5; // radial track thickness
const LOOP_CENTER_Z = -78; // loop centre Z; long clean runway from spawn to here
const LOOP_RAIL_HEIGHT = 0.5; // kerbs along both edges keep the vehicle centred
const LOOP_PHI_IN = 30 * DEG; // ring entry angle; a flat lead-in ramp matches it
const LOOP_PHI_OUT = 305 * DEG; // open the bottom-back so the exit drops out forward

/**
 * Kick ramps, low → high. Each is a circular arc rising from the ground at `footZ`
 * to a `lipDeg` launch angle. Launch angle stays ≤ ~26° — comfortably under the
 * loop assist's surface-bank threshold (LOOP_ASSIST_MIN_SURF_TILT_RAD ≈ 35°) so a
 * jump ramp never trips the loop "stick". Lip height = radius·(1 − cos lipDeg).
 */
const RAMP_SPECS = [
  { id: 'ramp_kicker', x: RAMP_LANE_X, footZ: -42, radius: 11, lipDeg: 18, width: 6 },
  { id: 'ramp_launch', x: RAMP_LANE_X, footZ: -82, radius: 14, lipDeg: 23, width: 6.5 },
  { id: 'jump_takeoff', x: RAMP_LANE_X, footZ: -126, radius: 16, lipDeg: 24, width: 7 },
] as const;

const lipHeight = (r: number, lipDeg: number): number => r * (1 - Math.cos(lipDeg * DEG));
const lipZ = (footZ: number, r: number, lipDeg: number): number => footZ - r * Math.sin(lipDeg * DEG);

export type StuntShape = 'wedge' | 'box';
/** Drives the renderer's material choice, not physics. */
export type StuntSurface = 'ramp' | 'loop' | 'rail' | 'pad';

export type StuntPiece = {
  /** Stable id; the renderer keys its mesh map off this. */
  id: string;
  shape: StuntShape;
  surface: StuntSurface;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  /**
   * For `box`: cuboid half-extents.
   * For `wedge`: half-extents of the bounding box. The wedge is a right
   * triangular prism — width X∈[-x,x], depth Z∈[-z,z], height Y∈[0,2y] — base on
   * the local y=0 plane, low lip at +Z and tall lip at -Z. The renderer rebuilds
   * the same prism from these half-extents.
   */
  halfExtents: { x: number; y: number; z: number };
};

export type StuntPark = {
  /** Immutable — every piece is static, so this is computed once. */
  readSnapshot(): readonly StuntPiece[];
  dispose(): void;
};

/**
 * Loop + ramp geometry exposed so callers/tests can line up an approach and
 * reason about the speed each takes.
 */
export const STUNT_LOOP = {
  x: LOOP_X,
  centerZ: LOOP_CENTER_Z,
  radius: LOOP_RADIUS,
  /** World Y of the highest point of the ring (rider on the inside surface). */
  topY: 2 * LOOP_RADIUS + LOOP_LIFT,
  /** A clear point on the +Z runway to line up a straight, fast approach from. */
  approachZ: LOOP_CENTER_Z + LOOP_RADIUS + 22,
  /** Ideal frictionless minimum entry speed, √(5·g·R). Real threshold is higher. */
  idealMinEntrySpeedMs: Math.sqrt(5 * 9.81 * LOOP_RADIUS),
} as const;

export const STUNT_RAMPS = RAMP_SPECS.map((r) => ({
  id: r.id,
  x: r.x,
  footZ: r.footZ,
  lipDeg: r.lipDeg,
  lipY: lipHeight(r.radius, r.lipDeg),
  lipZ: lipZ(r.footZ, r.radius, r.lipDeg),
}));

type Entry = { body: RAPIER.RigidBody; piece: StuntPiece };

export function createStuntPark(world: RAPIER.World): StuntPark {
  const entries: Entry[] = [];

  // ── Jump lane (dead ahead): kicker → launch ramp → big stunt jump ──────────
  for (const r of RAMP_SPECS) {
    buildArc(world, entries, {
      idPrefix: r.id,
      surface: 'ramp',
      cx: r.x,
      cy: r.radius, // arc centre above the foot → φ=0 sits flush on the ground
      cz: r.footZ,
      radius: r.radius,
      thickness: 0.5,
      halfWidth: r.width / 2,
      phiStart: 0,
      phiEnd: r.lipDeg * DEG,
      rails: false,
      railHeight: 0,
    });
  }

  // Big stunt jump landing: a long, gentle down-ramp past the takeoff lip so the
  // rider lands on a descending slope (not a flat slam) across a range of speeds.
  const big = RAMP_SPECS[2];
  const landingTopZ = lipZ(big.footZ, big.radius, big.lipDeg) - 10; // 10 m gap
  const landingDepth = 26;
  const landingHeight = 3;
  entries.push(
    spawnWedge(world, {
      id: 'jump_landing',
      // yaw 180 puts the tall edge at +Z (facing the incoming jumper); base centre
      // sits depth/2 toward -Z of that edge.
      position: { x: RAMP_LANE_X, z: landingTopZ - landingDepth / 2 },
      width: 9,
      depth: landingDepth,
      height: landingHeight,
      yawDeg: 180,
    }),
  );

  // ── Loop lane: a vertical 360° every vehicle can ride ──────────────────────
  buildLoop(world, entries);

  const buffer: readonly StuntPiece[] = entries.map((e) => e.piece);

  return {
    readSnapshot() {
      return buffer;
    },
    dispose() {
      for (const e of entries) world.removeRigidBody(e.body);
      entries.length = 0;
    },
  };
}

// ── Arc of box segments (curved ramps + the loop) ────────────────────────────

type ArcArgs = {
  idPrefix: string;
  surface: StuntSurface;
  /** Arc centre. The driving (inside) surface sits at `radius` along -d(φ). */
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  thickness: number;
  halfWidth: number;
  /** φ measured from the bottom: 0 = flat/ground, increasing = forward (-Z) & up. */
  phiStart: number;
  phiEnd: number;
  rails: boolean;
  railHeight: number;
};

/**
 * Lay flat box segments along a circular arc in the Y-Z plane. For angle φ the
 * inward direction from the centre is d(φ)=(0,-cosφ,-sinφ); a segment box is
 * centred at radius R+t/2 along d and rotated about X by φ, so its local +Y (top
 * face) points back toward the centre — the driving surface lands exactly at
 * radius R. A ramp is a short arc (0 → lipDeg); the loop is the full sweep.
 */
function buildArc(world: RAPIER.World, entries: Entry[], a: ArcArgs): void {
  const R = a.radius;
  const t = a.thickness;
  const cr = R + t / 2;
  const segHalfLen = (R * SEG_STEP) / 2 + 0.12; // overlap → gapless surface
  let i = 0;
  for (let phi = a.phiStart; phi <= a.phiEnd + 1e-6; phi += SEG_STEP) {
    const half = phi / 2;
    const rot = { x: Math.sin(half), y: 0, z: 0, w: Math.cos(half) };
    const px = a.cx;
    const py = a.cy + cr * -Math.cos(phi);
    const pz = a.cz + cr * -Math.sin(phi);

    entries.push(
      spawnBox(world, {
        id: `${a.idPrefix}_${i}`,
        surface: a.surface,
        position: { x: px, y: py, z: pz },
        rotation: rot,
        halfExtents: { x: a.halfWidth, y: t / 2, z: segHalfLen },
      }),
    );

    if (a.rails) {
      // Kerbs just inboard of each edge, rising toward the centre (local +Y) so
      // they contain the vehicle without being a launch lip.
      const ry = (t / 2 + a.railHeight / 2) * Math.cos(phi);
      const rz = (t / 2 + a.railHeight / 2) * Math.sin(phi);
      for (const sx of [-1, 1] as const) {
        entries.push(
          spawnBox(world, {
            id: `${a.idPrefix}_rail_${i}_${sx > 0 ? 'r' : 'l'}`,
            surface: 'rail',
            position: { x: px + sx * a.halfWidth, y: py + ry, z: pz + rz },
            rotation: rot,
            halfExtents: { x: 0.06, y: a.railHeight / 2, z: segHalfLen },
          }),
        );
      }
    }
    i++;
  }
}

/**
 * Vertical 360° loop, rideable by every vehicle via the gated loop assist in
 * controller.ts. The ring runs from φ=LOOP_PHI_IN (≈30°) round to φ=LOOP_PHI_OUT
 * (≈305°); the open bottom-back lets the descending exit drop out forward instead
 * of being a wall in the approach lane, and the raised ring keeps the +Z exit arc
 * well overhead so the ground-level approach is clear.
 *
 * A FLAT lead-in ramp (slope = the entry tangent) feeds the ring. The assist
 * engages on that flat surface — where there is no centripetal demand — so it's
 * already carrying the vehicle before the curve begins; this avoids the high-speed
 * ricochet a curved un-assisted base would cause.
 */
function buildLoop(world: RAPIER.World, entries: Entry[]): void {
  const R = LOOP_RADIUS;
  const cy = R + LOOP_LIFT; // centre height

  buildArc(world, entries, {
    idPrefix: 'loop',
    surface: 'loop',
    cx: LOOP_X,
    cy,
    cz: LOOP_CENTER_Z,
    radius: R,
    thickness: LOOP_THICKNESS,
    halfWidth: LOOP_WIDTH / 2,
    phiStart: LOOP_PHI_IN,
    phiEnd: LOOP_PHI_OUT,
    rails: true,
    railHeight: LOOP_RAIL_HEIGHT,
  });

  // Flat lead-in ramp: rises from the ground to the φ=LOOP_PHI_IN entry point at
  // the ring's tangent slope there, so the vehicle pre-tilts onto the ring and the
  // assist engages on flat ground rather than mid-curve.
  const entryY = cy - R * Math.cos(LOOP_PHI_IN);
  const entryZ = LOOP_CENTER_Z - R * Math.sin(LOOP_PHI_IN);
  const depth = entryY / Math.tan(LOOP_PHI_IN);
  entries.push(
    spawnWedge(world, {
      id: 'loop_leadin',
      // Tall lip (-Z) lands on the ring entry point; base centre is depth/2 toward +Z.
      position: { x: LOOP_X, z: entryZ + depth / 2 },
      width: LOOP_WIDTH,
      depth,
      height: entryY,
      surface: 'loop',
    }),
  );
}

// ── Box + wedge primitives ───────────────────────────────────────────────────

type BoxArgs = {
  id: string;
  surface: StuntSurface;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  halfExtents: { x: number; y: number; z: number };
};

function spawnBox(world: RAPIER.World, args: BoxArgs): Entry {
  const bodyDesc = RAPIER.RigidBodyDesc.fixed()
    .setTranslation(args.position.x, args.position.y, args.position.z)
    .setRotation(args.rotation);
  const body = world.createRigidBody(bodyDesc);
  const desc = RAPIER.ColliderDesc.cuboid(
    args.halfExtents.x,
    args.halfExtents.y,
    args.halfExtents.z,
  )
    .setFriction(RAMP_FRICTION)
    .setRestitution(RAMP_RESTITUTION);
  world.createCollider(desc, body);
  return {
    body,
    piece: {
      id: args.id,
      shape: 'box',
      surface: args.surface,
      position: { ...args.position },
      rotation: { ...args.rotation },
      halfExtents: { ...args.halfExtents },
    },
  };
}

type WedgeArgs = {
  id: string;
  /** Base centre. The body sits at y=0 (base on the ground). */
  position: { x: number; z: number };
  width: number; // X span
  depth: number; // Z span
  height: number; // Y at the tall lip
  /** Optional yaw (deg about Y) — 180 flips a takeoff into a landing ramp. */
  yawDeg?: number;
  surface?: StuntSurface;
};

function spawnWedge(world: RAPIER.World, args: WedgeArgs): Entry {
  const hx = args.width / 2;
  const hz = args.depth / 2;
  const H = args.height;

  const yaw = ((args.yawDeg ?? 0) * Math.PI) / 180;
  const rot = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };

  const bodyDesc = RAPIER.RigidBodyDesc.fixed()
    .setTranslation(args.position.x, 0, args.position.z)
    .setRotation(rot);
  const body = world.createRigidBody(bodyDesc);

  // 6 hull points: front-bottom (low lip, +Z), back-bottom, back-top (tall lip).
  // prettier-ignore
  const pts = new Float32Array([
    -hx, 0, hz,  hx, 0, hz,   // front bottom — low lip
    -hx, 0, -hz, hx, 0, -hz,  // back bottom
    -hx, H, -hz, hx, H, -hz,  // back top — tall lip
  ]);
  const desc = RAPIER.ColliderDesc.convexHull(pts);
  if (!desc) throw new Error(`spawnWedge: convex hull failed for ${args.id}`);
  desc.setFriction(RAMP_FRICTION).setRestitution(RAMP_RESTITUTION);
  world.createCollider(desc, body);

  return {
    body,
    piece: {
      id: args.id,
      shape: 'wedge',
      surface: args.surface ?? 'ramp',
      position: { x: args.position.x, y: 0, z: args.position.z },
      rotation: rot,
      halfExtents: { x: hx, y: H / 2, z: hz },
    },
  };
}
