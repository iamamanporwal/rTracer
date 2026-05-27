/**
 * Surface tags per blueprint §6.3.
 *
 * A surface tag is the link between a triangle in the world and the friction /
 * audio / particle / damage behavior applied when a wheel or body touches it.
 * Tags are coarse on purpose — the per-zone physics profile maps the tag to
 * actual coefficients.
 */
export const SURFACE_TAGS = [
  'tarmac',
  'kerb',
  'grass',
  'dirt',
  'gravel',
  'snow',
  'sand',
  'barrier',
  'unknown',
] as const;

export type SurfaceTag = (typeof SURFACE_TAGS)[number];

/** Default friction coefficient used when a profile doesn't override a tag. */
export const DEFAULT_SURFACE_FRICTION: Record<SurfaceTag, number> = {
  tarmac: 1.0,
  kerb: 0.85,
  grass: 0.55,
  dirt: 0.7,
  gravel: 0.6,
  snow: 0.3,
  sand: 0.5,
  barrier: 0.4,
  unknown: 0.9,
};

/** Visual debug color per tag (sRGB hex). Used by the click-tool and dev HUD. */
export const SURFACE_DEBUG_COLOR: Record<SurfaceTag, `#${string}`> = {
  tarmac: '#3a3f47',
  kerb: '#e84a4a',
  grass: '#4d7a3a',
  dirt: '#8a6a3f',
  gravel: '#6a6055',
  snow: '#dfe7ec',
  sand: '#d9c089',
  barrier: '#c63a3a',
  unknown: '#7a3aa6',
};
