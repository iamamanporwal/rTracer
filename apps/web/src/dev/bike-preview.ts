/**
 * Dev-only bike preview harness (loaded by `/bike-preview.html`). It builds a
 * minimal Three.js scene around `createBikeVisual` so the bike + rider can be
 * inspected from any angle, with programmable steer/spin — used to verify the
 * surgered GLB, the steering rig, and the rider posture without driving the full
 * game. Not shipped (no route references it); safe to delete.
 *
 * Window API (called by the Playwright screenshot script):
 *   __setView([px,py,pz],[tx,ty,tz])  position camera + look-at, render once
 *   __setSteer(rad)                    front-wheel steer angle
 *   __setSpin(rad)                     wheel spin angle
 *   __setSpeed(mps)                    speed (feeds cosmetic lean)
 *   __bikeReady                        true once the GLB + rider have loaded
 */
import * as THREE from 'three';
import { createBikeVisual, type VehicleVisualSnapshot } from '@trace/renderer';
import { loadVehicleManifest } from '~/manifests';

declare global {
  interface Window {
    __setView: (pos: [number, number, number], target: [number, number, number]) => void;
    __setSteer: (rad: number) => void;
    __setSpin: (rad: number) => void;
    __setSpeed: (mps: number) => void;
    __bikeReady: boolean;
  }
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#2a2d33');

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(3, 1.4, 3);
camera.lookAt(0, 0.7, 0);

// Lighting — a key sun + soft fill so the matte rider reads clearly.
const hemi = new THREE.HemisphereLight(0xffffff, 0x404048, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(4, 6, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xbfd0ff, 0.6);
fill.position.set(-4, 3, -2);
scene.add(fill);

// Ground.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ color: '#3a3d44', roughness: 0.95 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(40, 40, 0x556070, 0x404652);
scene.add(grid);

const snapshot: VehicleVisualSnapshot = {
  // y is auto-set after load so the model's lowest point (wheel contact) rests on
  // the preview ground plane (y=0) — matches the game's on-ground stance.
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  speed: 0,
  wheels: [
    { position: { x: 0, y: 0, z: 0 }, steering: 0, rotation: 0, inContact: true },
    { position: { x: 0, y: 0, z: 0 }, steering: 0, rotation: 0, inContact: true },
    { position: { x: 0, y: 0, z: 0 }, steering: 0, rotation: 0, inContact: true },
    { position: { x: 0, y: 0, z: 0 }, steering: 0, rotation: 0, inContact: true },
  ],
};

function render(): void {
  renderer.render(scene, camera);
}

window.__setView = (pos, target) => {
  camera.position.set(pos[0], pos[1], pos[2]);
  camera.lookAt(target[0], target[1], target[2]);
  camera.updateProjectionMatrix();
  render();
};

async function main(): Promise<void> {
  // ?v=vehicle_jawa&hub=-0.27 — pick which bike + its physics restHubLocalY.
  const params = new URLSearchParams(location.search);
  const id = params.get('v') ?? 'vehicle_bike';
  const restHub = Number(params.get('hub') ?? '-0.2708');
  const manifest = await loadVehicleManifest(id, '0.1.0');
  const bundle = `/assets/vehicles/${id}/v0.1.0`;
  const visual = await createBikeVisual({
    url: `${bundle}/${manifest.visual?.glb}`,
    manifest,
    restHubLocalY: restHub, // real physics-derived value (matches the game)
    environment: null,
    riderUrl: manifest.rider ? `${bundle}/${manifest.rider.fbx}` : null,
    fallClipUrl: null,
  });
  scene.add(visual.group);

  // Auto-lift so the lowest point (wheel contact) sits on the ground plane.
  visual.applySnapshot(snapshot);
  const box = new THREE.Box3().setFromObject(visual.group);
  snapshot.position.y = -box.min.y;

  const apply = (): void => {
    snapshot.wheels[0]!.steering = snapshot.wheels[1]!.steering;
    visual.applySnapshot(snapshot);
    render();
  };

  window.__setSteer = (rad) => {
    for (const w of snapshot.wheels) w.steering = 0;
    snapshot.wheels[0]!.steering = rad;
    snapshot.wheels[1]!.steering = rad;
    apply();
  };
  window.__setSpin = (rad) => {
    for (const w of snapshot.wheels) w.rotation = rad;
    apply();
  };
  window.__setSpeed = (mps) => {
    snapshot.speed = mps;
    apply();
  };

  apply();
  window.__bikeReady = true;
}

void main();
