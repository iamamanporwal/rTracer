import RAPIER from '@dimforge/rapier3d-compat';

/**
 * A small obstacle field placed near the spawn — a single speed bump straight
 * ahead and a handful of dynamic crates further out. Pure physics here; the
 * renderer reads {@link ObstacleField.readSnapshot} each frame to position its
 * meshes.
 *
 * Forward from spawn is -Z (matches `FORWARD_SIGN = -1`), so all obstacles sit
 * at negative Z relative to the spawn point.
 */

export type ObstacleKind = 'speedBump' | 'crate';

export type ObstacleSnapshot = {
  /** Stable id; the renderer keys its mesh map off this. */
  id: string;
  kind: ObstacleKind;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  /** Half-extents of the cuboid collider (= visual size / 2). Immutable. */
  halfExtents: { x: number; y: number; z: number };
};

export type ObstacleFieldSnapshot = ObstacleSnapshot[];

export type ObstacleField = {
  /** Reused buffer — mutated in place each call. Stable order. */
  readSnapshot(): ObstacleFieldSnapshot;
  dispose(): void;
};

type Entry = {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  snapshot: ObstacleSnapshot;
};

export function createObstacleField(world: RAPIER.World): ObstacleField {
  const entries: Entry[] = [];

  // Speed bump — static, low-and-wide cuboid spanning the path ahead.
  entries.push(
    spawnStaticBox(world, {
      id: 'bump_main',
      kind: 'speedBump',
      position: { x: 0, y: 0.09, z: -10 },
      halfExtents: { x: 4, y: 0.09, z: 0.35 },
      friction: 0.9,
    }),
  );

  // Crates — dynamic 1 m cubes. A row of three, a stack of two behind, and a
  // lone one off to the side close enough to clip on the way out of the spawn.
  const cratePositions: Array<{ x: number; y: number; z: number }> = [
    { x: -1.5, y: 0.5, z: -18 },
    { x: 0, y: 0.5, z: -18 },
    { x: 1.5, y: 0.5, z: -18 },
    { x: 0, y: 0.5, z: -22 },
    { x: 0, y: 1.5, z: -22 },
    { x: -5, y: 0.5, z: -14 },
  ];
  for (let i = 0; i < cratePositions.length; i++) {
    const p = cratePositions[i];
    if (!p) continue;
    entries.push(
      spawnDynamicBox(world, {
        id: `crate_${i}`,
        kind: 'crate',
        position: p,
        halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
        mass: 12,
        friction: 0.6,
      }),
    );
  }

  const buffer: ObstacleFieldSnapshot = entries.map((e) => e.snapshot);

  return {
    readSnapshot() {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!e) continue;
        const t = e.body.translation();
        const r = e.body.rotation();
        e.snapshot.position.x = t.x;
        e.snapshot.position.y = t.y;
        e.snapshot.position.z = t.z;
        e.snapshot.rotation.x = r.x;
        e.snapshot.rotation.y = r.y;
        e.snapshot.rotation.z = r.z;
        e.snapshot.rotation.w = r.w;
      }
      return buffer;
    },
    dispose() {
      for (const e of entries) {
        world.removeRigidBody(e.body);
      }
      entries.length = 0;
    },
  };
}

type StaticBoxArgs = {
  id: string;
  kind: ObstacleKind;
  position: { x: number; y: number; z: number };
  halfExtents: { x: number; y: number; z: number };
  friction: number;
};

function spawnStaticBox(world: RAPIER.World, args: StaticBoxArgs): Entry {
  const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(
    args.position.x,
    args.position.y,
    args.position.z,
  );
  const body = world.createRigidBody(bodyDesc);
  const colliderDesc = RAPIER.ColliderDesc.cuboid(
    args.halfExtents.x,
    args.halfExtents.y,
    args.halfExtents.z,
  )
    .setFriction(args.friction)
    .setRestitution(0.0);
  const collider = world.createCollider(colliderDesc, body);

  return {
    body,
    collider,
    snapshot: {
      id: args.id,
      kind: args.kind,
      position: { x: args.position.x, y: args.position.y, z: args.position.z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      halfExtents: { x: args.halfExtents.x, y: args.halfExtents.y, z: args.halfExtents.z },
    },
  };
}

type DynamicBoxArgs = StaticBoxArgs & {
  mass: number;
};

function spawnDynamicBox(world: RAPIER.World, args: DynamicBoxArgs): Entry {
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(args.position.x, args.position.y, args.position.z)
    .setLinearDamping(0.2)
    .setAngularDamping(0.4);
  const body = world.createRigidBody(bodyDesc);
  const colliderDesc = RAPIER.ColliderDesc.cuboid(
    args.halfExtents.x,
    args.halfExtents.y,
    args.halfExtents.z,
  )
    .setFriction(args.friction)
    .setRestitution(0.1)
    .setDensity(args.mass / (8 * args.halfExtents.x * args.halfExtents.y * args.halfExtents.z));
  const collider = world.createCollider(colliderDesc, body);

  return {
    body,
    collider,
    snapshot: {
      id: args.id,
      kind: args.kind,
      position: { x: args.position.x, y: args.position.y, z: args.position.z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      halfExtents: { x: args.halfExtents.x, y: args.halfExtents.y, z: args.halfExtents.z },
    },
  };
}
