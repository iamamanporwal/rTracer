import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createCameraRig } from './camera-rig';

/**
 * The camera rig is the anti-jitter seam: the spring is integrated at the fixed
 * simulation step in `advance`, and `present` interpolates the stored prev→curr
 * pose by the loop's `alpha`. These tests pin the contract that keeps the camera
 * in lockstep with the car visual (which uses the same `alpha`):
 *
 *   - `present(0)` reproduces the previous step's pose, `present(1)` the current
 *     one, and intermediate alphas land strictly between — no overshoot.
 *   - `alpha` outside [0,1] is clamped (defends against a saturated-substep
 *     frame pushing the camera past the latest pose, the classic snap-back).
 *   - `snap` collapses prev==curr so the first rendered frames don't glide in
 *     from a stale default pose.
 */

const Q_IDENTITY = new THREE.Quaternion();

function poseAt(rig: ReturnType<typeof createCameraRig>, alpha: number): THREE.Vector3 {
  rig.present(alpha);
  return rig.camera.position.clone();
}

describe('camera rig fixed-step + interpolation', () => {
  it('snap collapses prev==curr so present is stable across all alphas', () => {
    const rig = createCameraRig();
    rig.snap(new THREE.Vector3(10, 0, 10), Q_IDENTITY);

    const at0 = poseAt(rig, 0);
    const at05 = poseAt(rig, 0.5);
    const at1 = poseAt(rig, 1);

    // No advance() since snap ⇒ prev == curr ⇒ every alpha yields the same pose.
    expect(at0.distanceTo(at05)).toBeLessThan(1e-6);
    expect(at0.distanceTo(at1)).toBeLessThan(1e-6);
  });

  it('present interpolates the prev→curr camera pose by alpha', () => {
    const rig = createCameraRig();
    rig.snap(new THREE.Vector3(0, 0, 0), Q_IDENTITY);

    // One fixed step toward a moved target establishes a distinct prev (the
    // snapped pose) and curr (the sprung pose).
    rig.advance(new THREE.Vector3(0, 0, 40), Q_IDENTITY, 1 / 60);

    const prev = poseAt(rig, 0);
    const curr = poseAt(rig, 1);
    const mid = poseAt(rig, 0.5);

    // The step must actually move the camera (otherwise the test proves nothing).
    expect(prev.distanceTo(curr)).toBeGreaterThan(0.01);

    // Midpoint is the exact linear blend of the endpoints — the lockstep blend.
    const expectedMid = prev.clone().lerp(curr, 0.5);
    expect(mid.distanceTo(expectedMid)).toBeLessThan(1e-6);
  });

  it('clamps alpha outside [0,1] so the camera never extrapolates past curr', () => {
    const rig = createCameraRig();
    rig.snap(new THREE.Vector3(0, 0, 0), Q_IDENTITY);
    rig.advance(new THREE.Vector3(0, 0, 40), Q_IDENTITY, 1 / 60);

    const curr = poseAt(rig, 1);
    const over = poseAt(rig, 1.7); // a saturated-substep frame would ask for this
    const under = poseAt(rig, -0.4);
    const prev = poseAt(rig, 0);

    expect(over.distanceTo(curr)).toBeLessThan(1e-6);
    expect(under.distanceTo(prev)).toBeLessThan(1e-6);
  });
});
