import { describe, expect, it } from 'vitest';
import { applyCloudKey, featherStamp } from './clouds';

/**
 * `applyCloudKey` is the one piece of the cloud pipeline that's pure pixel math
 * (no DOM/WebGL), so we pin it directly. The rest of the field — stamp baking,
 * sprite scatter, drift — needs a canvas + GL and is exercised in the browser.
 *
 * The contract that matters for the look:
 *   - background keys to alpha 0 (a cloud must not carry a visible box), and
 *   - the cloud body keys to (near-)opaque, regardless of which way round the
 *     source image stores it (bright-on-dark vs dark-on-white).
 */

/** Build a 1px RGBA buffer for a single colour. */
function px(r: number, g: number, b: number): Uint8ClampedArray {
  return new Uint8ClampedArray([r, g, b, 255]);
}

describe('applyCloudKey — bright (cloud is white on a dark background)', () => {
  it('keys a black background fully transparent', () => {
    const data = px(0, 0, 0);
    applyCloudKey(data, 'bright');
    expect(data[3]).toBe(0);
  });

  it('keys a white cloud fully opaque and forces colour to white (tintable)', () => {
    const data = px(255, 255, 255);
    applyCloudKey(data, 'bright');
    expect(data[3]).toBe(255);
    expect([data[0], data[1], data[2]]).toEqual([255, 255, 255]);
  });

  it('gives a soft mid-grey edge partial alpha', () => {
    const data = px(128, 128, 128);
    applyCloudKey(data, 'bright');
    expect(data[3]).toBeGreaterThan(0);
    expect(data[3]).toBeLessThan(255);
  });
});

describe('applyCloudKey — dark (cloud is grey on a white background)', () => {
  it('keys a pure-white background fully transparent', () => {
    const data = px(255, 255, 255);
    applyCloudKey(data, 'dark');
    expect(data[3]).toBe(0);
  });

  it('keys a near-white background transparent (small dead-zone)', () => {
    const data = px(252, 252, 252);
    applyCloudKey(data, 'dark');
    expect(data[3]).toBe(0);
  });

  it('keys a grey cloud body to opaque', () => {
    const data = px(150, 150, 150);
    applyCloudKey(data, 'dark');
    expect(data[3]).toBe(255);
  });

  it('keeps (and brightens) the cloud shading rather than forcing white', () => {
    const data = px(150, 155, 165);
    applyCloudKey(data, 'dark');
    // Original ordering preserved, each channel nudged up by 30, clamped to 255.
    expect(data[0]).toBe(180);
    expect(data[1]).toBe(185);
    expect(data[2]).toBe(195);
  });
});

describe('featherStamp — kills the hard crop edge', () => {
  /** Build a W×H fully-opaque white RGBA buffer. */
  function solid(w: number, h: number): Uint8ClampedArray {
    const d = new Uint8ClampedArray(w * h * 4);
    d.fill(255);
    return d;
  }

  it('drives rim alpha to (near) zero while keeping the centre opaque', () => {
    const w = 64;
    const h = 64;
    const d = solid(w, h);
    featherStamp(d, w, h, 'bright');
    const at = (x: number, y: number, c: number): number => d[(y * w + x) * 4 + c]!;
    // Corners and edges feather out — no hard rectangular edge survives.
    expect(at(0, 0, 3)).toBe(0);
    expect(at(w - 1, h - 1, 3)).toBe(0);
    expect(at(Math.floor(w / 2), 0, 3)).toBe(0);
    // Centre stays fully opaque.
    expect(at(Math.floor(w / 2), Math.floor(h / 2), 3)).toBe(255);
  });

  it('darkens the underside of bright clouds but not dark ones', () => {
    const w = 8;
    const h = 8;
    const bright = solid(w, h);
    const dark = solid(w, h);
    featherStamp(bright, w, h, 'bright');
    featherStamp(dark, w, h, 'dark');
    // Sample a centre-column pixel near the bottom (inside the rim window) so the
    // feather doesn't dominate: bottom row is fully feathered, so use row h-3.
    const cx = Math.floor(w / 2);
    const topRGB = bright[(2 * w + cx) * 4]!;
    const botRGB = bright[((h - 3) * w + cx) * 4]!;
    expect(botRGB).toBeLessThan(topRGB); // underside shaded darker
    // Dark clouds keep their own shading — no extra darken applied to RGB.
    expect(dark[((h - 3) * w + cx) * 4]!).toBe(255);
  });
});
