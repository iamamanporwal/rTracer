import { expect, Page, test } from '@playwright/test';

/**
 * GLB zone-world smoke tests — prove the new `drift_race_track_free.glb` map
 * loads end-to-end in a real browser: the 314k-tri visual renders, the derived
 * Rapier trimesh collider catches the car (it rests instead of falling through),
 * and the car drives on it. This is the runtime gate for the GLB-world path
 * (zone manifests with a `world` block), complementing the flat-ground
 * `zone_alpha` tests in `drive.spec.ts`.
 *
 * The track GLB is ~33 MB and the trimesh collider takes a moment to build, so
 * the loading overlay gets a generous timeout under software WebGL.
 */

const readKmh = async (page: Page): Promise<number> =>
  Number((await page.getByTestId('hud-speed-kmh').innerText()).trim());

const LOAD_TIMEOUT = 75_000;

test('the GLB drift track loads, holds the car, and drives (deep link)', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/play/zone_drift');

  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText('Loading vehicle…')).toBeHidden({ timeout: LOAD_TIMEOUT });
  await page.locator('canvas').focus();

  // Settle: the car should drop onto the trimesh and come to rest near zero —
  // if the collider were missing/broken it would free-fall forever (speed keeps
  // climbing). Poll for it to settle rather than reading one instant, since the
  // small spawn drop leaves a brief residual roll.
  await expect
    .poll(() => readKmh(page), { timeout: 8_000, intervals: [250] })
    .toBeLessThan(3);

  // Throttle: only possible if the wheels have a surface to grip — proves the
  // GLB-derived collider is really there under the car.
  await page.keyboard.down('w');
  try {
    await expect
      .poll(() => readKmh(page), { timeout: 12_000, intervals: [200] })
      .toBeGreaterThan(8);
  } finally {
    await page.keyboard.up('w');
  }

  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('the map changer selects the drift track and drives into it', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  // Garage → Tracks
  await page.goto('/');
  await page.getByRole('link', { name: 'Tracks' }).click();
  await expect(page).toHaveURL(/\/maps$/);

  // Pick the drift track from the thumbnail strip, then drop straight in.
  await page.getByRole('button', { name: /drift circuit/i }).click();
  await page.getByRole('button', { name: /drive now/i }).click();

  await expect(page).toHaveURL(/\/play\/zone_drift$/);
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText('Loading vehicle…')).toBeHidden({ timeout: LOAD_TIMEOUT });
  await page.locator('canvas').focus();
  await page.waitForTimeout(1000);

  await page.keyboard.down('w');
  try {
    await expect
      .poll(() => readKmh(page), { timeout: 12_000, intervals: [200] })
      .toBeGreaterThan(8);
  } finally {
    await page.keyboard.up('w');
  }

  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});
