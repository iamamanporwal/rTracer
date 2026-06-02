/**
 * @trace/renderer — Three.js scene factory, materials, decals, LOD.
 *
 * Phase 1 W2 surface: scene + renderer + ground visual + vehicle visual +
 * chase camera. HDR skybox, decals, occlusion, and LOD chains land alongside
 * real zone art (W4) and the soft-body pass (W6).
 */
export const TRACE_RENDERER_VERSION = '0.0.0';

export * from './materials';
export * from './ground';
export * from './obstacles';
export * from './vehicle-visual';
export * from './glb-vehicle-visual';
export * from './glb-zone-visual';
export * from './deformation';
export * from './engine-audio';
export * from './camera-rig';
export * from './scene';
export * from './sky';
export * from './rain';
export * from './weather';
export * from './debug-draw';
export * from './tire-fx';
