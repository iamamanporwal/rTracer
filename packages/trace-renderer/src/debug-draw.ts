import * as THREE from 'three';

/**
 * Physics debug overlay — the visualizer the refactor needed to *see* the rig.
 *
 * Draws, on demand (toggled off by default, ~zero cost when hidden):
 *   - the Rapier collider/contact wireframe (`world.debugRender()` output),
 *   - each wheel's suspension ray (hard point → wheel center) and ground contact,
 *   - the **strut hard-point** marker (the node where the suspension attaches
 *     to the chassis — the body-side end of the tire ↔ body connection),
 *   - the **wheel-hub** marker (the node where the tire mounts to the strut —
 *     the tire-side end of that same connection),
 *   - the chassis center of mass, and
 *   - the velocity vector.
 *
 * Kept fully decoupled from `@trace/physics`: it consumes plain
 * `{vertices,colors}` buffers and a structural {@link PhysicsDebugFrame}, never
 * Rapier types, so the renderer package has no physics dependency.
 */

/** Flat line buffers, matching Rapier's `DebugRenderBuffers` shape. */
export type DebugWireframe = {
  /** Flat `[x,y,z, x,y,z, …]`, two consecutive points per line segment. */
  vertices: Float32Array;
  /** Flat RGBA `[r,g,b,a, …]`, one color per vertex. */
  colors: Float32Array;
};

export type DebugContact = {
  hardPoint: { x: number; y: number; z: number };
  center: { x: number; y: number; z: number };
  contact: { x: number; y: number; z: number };
  inContact: boolean;
  suspensionForce: number;
};

/** Structural match for `@trace/physics` `MovementDebugFrame`. */
export type PhysicsDebugFrame = {
  comWorld: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  contacts: DebugContact[];
};

export type PhysicsDebug = {
  /** Root group (added to the scene by this factory). */
  group: THREE.Group;
  enabled: boolean;
  setEnabled(on: boolean): void;
  /** Flip enabled; returns the new state (for HUD labels). */
  toggle(): boolean;
  /** Refresh the overlay from the latest physics buffers. No-op when disabled. */
  update(wireframe: DebugWireframe, frame: PhysicsDebugFrame): void;
  dispose(): void;
};

const STRUT_COLOR = 0x46e0a0; // suspension ray
const CONTACT_COLOR = 0x36a6ff; // contact stub
const COM_COLOR = 0xff3b6b;
const VEL_COLOR = 0xffd23b;
// Connection-node markers — the two ends of the chassis ↔ tire link.
const HARDPOINT_COLOR = 0xc864ff; // body-side strut mount (purple)
const HUB_COLOR = 0xff9a3c; // wheel-side spin axle (orange)
const MAX_CONTACTS = 8;

export function createPhysicsDebug(scene: THREE.Scene): PhysicsDebug {
  const group = new THREE.Group();
  group.name = 'physics-debug';
  group.visible = false;
  scene.add(group);

  // ── Collider/contact wireframe ─────────────────────────────────────────────
  const wireGeom = new THREE.BufferGeometry();
  wireGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
  wireGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
  const wireMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 });
  const wire = new THREE.LineSegments(wireGeom, wireMat);
  wire.frustumCulled = false;
  group.add(wire);

  // ── Suspension rays + contact stubs (2 segments per contact = 4 verts) ──────
  const strutGeom = new THREE.BufferGeometry();
  const strutPos = new Float32Array(MAX_CONTACTS * 4 * 3);
  strutGeom.setAttribute('position', new THREE.BufferAttribute(strutPos, 3));
  strutGeom.setDrawRange(0, 0);
  const strutMat = new THREE.LineBasicMaterial({ color: STRUT_COLOR });
  const struts = new THREE.LineSegments(strutGeom, strutMat);
  struts.frustumCulled = false;
  group.add(struts);

  // Contact dots — blue spheres at the ground contact point of each wheel.
  const dotGeom = new THREE.SphereGeometry(0.08, 8, 6);
  const dotMat = new THREE.MeshBasicMaterial({ color: CONTACT_COLOR });
  const dots: THREE.Mesh[] = [];
  for (let i = 0; i < MAX_CONTACTS; i++) {
    const dot = new THREE.Mesh(dotGeom, dotMat);
    dot.visible = false;
    group.add(dot);
    dots.push(dot);
  }

  // ── Connection nodes (the chassis ↔ tire link) ──────────────────────────────
  // Hard-point markers: purple boxes at the body-side strut mount — these ride
  // with the chassis. Slightly cubic to read as a rigid "bracket on the body".
  const hardGeom = new THREE.BoxGeometry(0.14, 0.14, 0.14);
  const hardMat = new THREE.MeshBasicMaterial({ color: HARDPOINT_COLOR });
  const hardNodes: THREE.Mesh[] = [];
  for (let i = 0; i < MAX_CONTACTS; i++) {
    const m = new THREE.Mesh(hardGeom, hardMat);
    m.visible = false;
    group.add(m);
    hardNodes.push(m);
  }
  // Wheel-hub markers: orange spheres at the wheel axle — the tire-side end of
  // the same connection. Slide along the strut as the suspension travels.
  const hubGeom = new THREE.SphereGeometry(0.11, 12, 8);
  const hubMat = new THREE.MeshBasicMaterial({ color: HUB_COLOR });
  const hubNodes: THREE.Mesh[] = [];
  for (let i = 0; i < MAX_CONTACTS; i++) {
    const m = new THREE.Mesh(hubGeom, hubMat);
    m.visible = false;
    group.add(m);
    hubNodes.push(m);
  }

  // ── Center of mass ──────────────────────────────────────────────────────────
  const comMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 12, 8),
    new THREE.MeshBasicMaterial({ color: COM_COLOR }),
  );
  group.add(comMesh);

  // ── Velocity arrow ──────────────────────────────────────────────────────────
  const velArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(),
    1,
    VEL_COLOR,
  );
  group.add(velArrow);

  const tmpDir = new THREE.Vector3();
  const tmpPos = new THREE.Vector3();
  let enabled = false;

  function update(wireframe: DebugWireframe, frame: PhysicsDebugFrame): void {
    if (!enabled) return;

    // Wireframe — reallocate attributes only when the vertex count changes.
    const vCount = (wireframe.vertices.length / 3) | 0;
    const posAttr = wireGeom.getAttribute('position') as THREE.BufferAttribute;
    if (posAttr.count !== vCount) {
      wireGeom.setAttribute('position', new THREE.BufferAttribute(wireframe.vertices.slice(), 3));
      wireGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vCount * 3), 3));
    } else {
      (posAttr.array as Float32Array).set(wireframe.vertices);
      posAttr.needsUpdate = true;
    }
    // RGBA → RGB.
    const colAttr = wireGeom.getAttribute('color') as THREE.BufferAttribute;
    const col = colAttr.array as Float32Array;
    for (let i = 0; i < vCount; i++) {
      col[i * 3] = wireframe.colors[i * 4] ?? 1;
      col[i * 3 + 1] = wireframe.colors[i * 4 + 1] ?? 1;
      col[i * 3 + 2] = wireframe.colors[i * 4 + 2] ?? 1;
    }
    colAttr.needsUpdate = true;

    // Suspension rays + contact dots.
    const n = Math.min(frame.contacts.length, MAX_CONTACTS);
    let v = 0;
    for (let i = 0; i < n; i++) {
      const c = frame.contacts[i];
      if (!c) continue;
      // Segment A: hard point → wheel center.
      strutPos[v++] = c.hardPoint.x;
      strutPos[v++] = c.hardPoint.y;
      strutPos[v++] = c.hardPoint.z;
      strutPos[v++] = c.center.x;
      strutPos[v++] = c.center.y;
      strutPos[v++] = c.center.z;
      // Segment B: wheel center → contact (collapses to a point when airborne).
      strutPos[v++] = c.center.x;
      strutPos[v++] = c.center.y;
      strutPos[v++] = c.center.z;
      strutPos[v++] = c.contact.x;
      strutPos[v++] = c.contact.y;
      strutPos[v++] = c.contact.z;

      const dot = dots[i];
      if (dot) {
        dot.visible = c.inContact;
        if (c.inContact) dot.position.set(c.contact.x, c.contact.y, c.contact.z);
      }

      // Connection nodes — chassis-side mount and wheel-side hub. Always
      // visible when the overlay is on (not gated on ground contact like the
      // blue contact dot), since the link itself exists airborne too.
      const hard = hardNodes[i];
      if (hard) {
        hard.visible = true;
        hard.position.set(c.hardPoint.x, c.hardPoint.y, c.hardPoint.z);
      }
      const hub = hubNodes[i];
      if (hub) {
        hub.visible = true;
        hub.position.set(c.center.x, c.center.y, c.center.z);
      }
    }
    for (let i = n; i < MAX_CONTACTS; i++) {
      const dot = dots[i];
      if (dot) dot.visible = false;
      const hard = hardNodes[i];
      if (hard) hard.visible = false;
      const hub = hubNodes[i];
      if (hub) hub.visible = false;
    }
    strutGeom.setDrawRange(0, n * 4);
    (strutGeom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

    // COM marker.
    comMesh.position.set(frame.comWorld.x, frame.comWorld.y, frame.comWorld.z);

    // Velocity arrow (hidden below a deadband to avoid jitter at rest).
    tmpDir.set(frame.velocity.x, frame.velocity.y, frame.velocity.z);
    const speed = tmpDir.length();
    if (speed > 0.2) {
      tmpPos.set(frame.comWorld.x, frame.comWorld.y, frame.comWorld.z);
      velArrow.position.copy(tmpPos);
      velArrow.setDirection(tmpDir.multiplyScalar(1 / speed));
      velArrow.setLength(Math.min(speed * 0.25, 6), 0.4, 0.25);
      velArrow.visible = true;
    } else {
      velArrow.visible = false;
    }
  }

  function setEnabled(on: boolean): void {
    enabled = on;
    group.visible = on;
  }

  return {
    group,
    get enabled(): boolean {
      return enabled;
    },
    setEnabled,
    toggle(): boolean {
      setEnabled(!enabled);
      return enabled;
    },
    update,
    dispose(): void {
      wireGeom.dispose();
      wireMat.dispose();
      strutGeom.dispose();
      strutMat.dispose();
      dotGeom.dispose();
      dotMat.dispose();
      hardGeom.dispose();
      hardMat.dispose();
      hubGeom.dispose();
      hubMat.dispose();
      (comMesh.geometry as THREE.BufferGeometry).dispose();
      (comMesh.material as THREE.Material).dispose();
      velArrow.dispose();
      group.removeFromParent();
    },
  };
}
