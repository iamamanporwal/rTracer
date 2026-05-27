import * as THREE from 'three';

/**
 * Camera rig per blueprint §21.2 (P1-16) — a GTA-style follow camera with
 * switchable modes. Three modes cycle on the C key:
 *
 *   - **default** (Chase): spline-damped chase behind and above the car, kept
 *     centered in frame, with a GTA orbit (mouse yaw/pitch swings around the car
 *     and gently drifts back behind the heading when idle).
 *   - **wide**: same chase, pulled back with a wide field of view — cinematic.
 *   - **fpv**: first-person from the driver's seat, looking down the car's
 *     heading, with mouse free-look. Stays upright (no roll) for comfort.
 *
 * Damping is a critically-damped spring approximation: a single lerp factor per
 * frame with a time-step-independent decay constant. Stable across variable
 * frame rates and never overshoots.
 */
export type CameraMode = 'default' | 'wide' | 'fpv';

/** Ordered cycle for the C key, with HUD labels. */
export const CAMERA_MODES: readonly { id: CameraMode; label: string }[] = [
  { id: 'default', label: 'Chase' },
  { id: 'wide', label: 'Wide' },
  { id: 'fpv', label: 'First-person' },
];

/**
 * Per-frame orbit/zoom request, normally produced by the mouse input layer.
 * `yaw`/`pitch` are *additive* to the heading; `distance` scales the chase
 * follow distance (ignored in FPV).
 */
export type CameraControl = {
  /** Extra yaw orbit around the car (radians). 0 = directly behind / straight ahead. */
  yaw: number;
  /** Pitch orbit (radians). Positive raises the chase camera / tilts FPV down. */
  pitch: number;
  /** Follow-distance multiplier (zoom). 1 = default. */
  distance: number;
};

export const NEUTRAL_CAMERA_CONTROL: CameraControl = Object.freeze({
  yaw: 0,
  pitch: 0,
  distance: 1,
});

export type CameraRigOptions = {
  /** Driver eye point in chassis-local space, used by FPV. */
  seat?: [number, number, number];
};

export type CameraRig = {
  camera: THREE.PerspectiveCamera;
  /** Active camera mode. */
  readonly mode: CameraMode;
  /** Switch mode (Default ⇄ Wide ⇄ FPV). The follow transition is damped. */
  setMode(mode: CameraMode): void;
  /** Update from the latest vehicle pose. `dt` in seconds. `control` orbits/zooms. */
  follow(
    targetPosition: THREE.Vector3,
    targetQuaternion: THREE.Quaternion,
    dt: number,
    control?: CameraControl,
  ): void;
  /** Snap to the target pose without damping — call once after spawn. */
  snap(targetPosition: THREE.Vector3, targetQuaternion: THREE.Quaternion, control?: CameraControl): void;
  /** Resize the projection matrix when the canvas changes. */
  resize(aspect: number): void;
};

type ChaseParams = {
  /** Position offset behind/above the car, in the heading frame. */
  offset: THREE.Vector3;
  /** Look-target offset from the car center (small look-ahead keeps it centered). */
  lookOffset: THREE.Vector3;
  fov: number;
  posDamp: number;
  lookDamp: number;
};

// Tuned so the whole (lifted, tall) car sits centered with a little ground below.
const CHASE: Record<'default' | 'wide', ChaseParams> = {
  default: {
    offset: new THREE.Vector3(0, 2.2, -6.8),
    lookOffset: new THREE.Vector3(0, 0.55, 0.5),
    fov: 60,
    posDamp: 9,
    lookDamp: 9,
  },
  wide: {
    offset: new THREE.Vector3(0, 3.1, -9.6),
    lookOffset: new THREE.Vector3(0, 0.7, 0.5),
    fov: 82,
    posDamp: 7,
    lookDamp: 7.5,
  },
};

const FPV = {
  fov: 74,
  posDamp: 22, // tracks the chassis tightly (suspension bob comes through)
  lookDamp: 16,
};

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

export function createCameraRig(options: CameraRigOptions = {}): CameraRig {
  // Driver eye, chassis-local. Pulled slightly inboard and up from the seat so
  // the view clears the dashboard and sits at head height.
  const seat = options.seat ?? [0.35, 0.95, 0.15];
  const eyeLocal = new THREE.Vector3(seat[0] * 0.5, seat[1] + 0.18, seat[2] + 0.1);

  let mode: CameraMode = 'default';

  const camera = new THREE.PerspectiveCamera(CHASE.default.fov, 1, 0.1, 2000);
  camera.position.set(0, 4, -10);
  camera.lookAt(0, 0, 0);

  const desiredPos = new THREE.Vector3();
  const desiredLook = new THREE.Vector3();
  const currentLook = new THREE.Vector3();
  const yawQuat = new THREE.Quaternion();
  const pitchQuat = new THREE.Quaternion();
  const tmpDir = new THREE.Vector3();

  function computeChase(
    targetPos: THREE.Vector3,
    targetQuat: THREE.Quaternion,
    control: CameraControl,
    p: ChaseParams,
  ): void {
    const carYaw = yawFromQuaternion(targetQuat);
    // Position: pitch the offset about X, yaw about Y (heading + orbit), zoom.
    pitchQuat.setFromAxisAngle(RIGHT, control.pitch);
    yawQuat.setFromAxisAngle(UP, carYaw + control.yaw);
    desiredPos
      .copy(p.offset)
      .multiplyScalar(control.distance)
      .applyQuaternion(pitchQuat)
      .applyQuaternion(yawQuat)
      .add(targetPos);
    // Look target tracks the heading only (not the manual orbit) so the car
    // stays framed/centered as the camera swings around it.
    yawQuat.setFromAxisAngle(UP, carYaw);
    desiredLook.copy(p.lookOffset).applyQuaternion(yawQuat).add(targetPos);
  }

  function computeFpv(
    targetPos: THREE.Vector3,
    targetQuat: THREE.Quaternion,
    control: CameraControl,
  ): void {
    // Eye rides the full chassis pose (so suspension bob and lean carry through).
    desiredPos.copy(eyeLocal).applyQuaternion(targetQuat).add(targetPos);
    // Look down the heading plus free-look; level horizon (world up) for comfort.
    const yaw = yawFromQuaternion(targetQuat) + control.yaw;
    const pitch = 0.02 - control.pitch; // neutral tips down slightly to show the road
    const cp = Math.cos(pitch);
    tmpDir.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
    desiredLook.copy(desiredPos).add(tmpDir);
  }

  function compute(
    targetPos: THREE.Vector3,
    targetQuat: THREE.Quaternion,
    control: CameraControl,
  ): { posDamp: number; lookDamp: number } {
    if (mode === 'fpv') {
      computeFpv(targetPos, targetQuat, control);
      return FPV;
    }
    const p = CHASE[mode];
    computeChase(targetPos, targetQuat, control, p);
    return p;
  }

  return {
    camera,
    get mode(): CameraMode {
      return mode;
    },
    setMode(next: CameraMode): void {
      mode = next;
      const fov = next === 'fpv' ? FPV.fov : CHASE[next].fov;
      if (camera.fov !== fov) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
    },
    follow(targetPos, targetQuat, dt, control = NEUTRAL_CAMERA_CONTROL) {
      const { posDamp, lookDamp } = compute(targetPos, targetQuat, control);
      const posAlpha = 1 - Math.exp(-posDamp * dt);
      const lookAlpha = 1 - Math.exp(-lookDamp * dt);
      camera.position.lerp(desiredPos, posAlpha);
      currentLook.lerp(desiredLook, lookAlpha);
      camera.lookAt(currentLook);
    },
    snap(targetPos, targetQuat, control = NEUTRAL_CAMERA_CONTROL) {
      compute(targetPos, targetQuat, control);
      camera.position.copy(desiredPos);
      currentLook.copy(desiredLook);
      camera.lookAt(currentLook);
    },
    resize(aspect) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    },
  };
}

/** Heading angle (radians) about the world Y axis, ignoring pitch and roll. */
function yawFromQuaternion(q: THREE.Quaternion): number {
  // Yaw from a quaternion: atan2 of the forward vector's x/z components.
  const siny = 2 * (q.w * q.y + q.z * q.x);
  const cosy = 1 - 2 * (q.y * q.y + q.x * q.x);
  return Math.atan2(siny, cosy);
}
