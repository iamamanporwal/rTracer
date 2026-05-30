import { expect, Page, test } from '@playwright/test';

/**
 * Zone-runtime smoke tests — prove the refactored movement system actually
 * drives in a real browser (WebGL + Rapier), not just in headless unit math.
 *
 * Keyboard input is delivered to `window`, so we focus the canvas first, then
 * poll the HUD speed while a key is held (robust against frame-timing jitter in
 * software-rendered headless WebGL).
 */

const speedOf = (page: Page) => page.getByTestId('hud-speed-kmh');
const readKmh = async (page: Page): Promise<number> =>
  Number((await speedOf(page).innerText()).trim());

/** Hold a key and poll until the speed clears `min` km/h (then release). */
async function holdUntilFaster(page: Page, key: string, min: number): Promise<void> {
  await page.keyboard.down(key);
  try {
    await expect
      .poll(() => readKmh(page), { timeout: 12_000, intervals: [200] })
      .toBeGreaterThan(min);
  } finally {
    await page.keyboard.up(key);
  }
}

test('the demo car accelerates under throttle and brakes to a stop', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/play/zone_alpha');

  // Canvas mounts; the "Loading vehicle…" overlay clears once the session
  // (Rapier WASM + scene) is ready.
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText('Loading vehicle…')).toBeHidden({ timeout: 30_000 });
  await page.locator('canvas').focus();

  await page.waitForTimeout(500);
  expect(await readKmh(page)).toBeLessThan(3);

  // Throttle pulls the car away from rest.
  await holdUntilFaster(page, 'w', 8);
  const movingKmh = await readKmh(page);

  // Debug overlay toggle (O) must not crash the loop.
  await page.keyboard.press('o');
  await page.waitForTimeout(300);

  // Brake (S, while rolling forward) brings it back to a near stop.
  await page.keyboard.down('s');
  await expect.poll(() => readKmh(page), { timeout: 12_000, intervals: [200] }).toBeLessThan(5);
  await page.keyboard.up('s');
  expect(await readKmh(page)).toBeLessThan(movingKmh);

  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});

/**
 * GLB path — drive a downloaded glTF car (the garage's default hero, the
 * Corvette) end-to-end. Exercises the rigged-wheel visual that consumes the
 * refactored `restHubLocalY` + rotation-corrected wheel poses, and the
 * transmission-glass perf downgrade that keeps it renderable.
 */
/**
 * Tire ground-contact FX smoke test — proves the new burnout (W+S at rest)
 * and handbrake (Space at speed) gestures don't blow up the render loop,
 * and that the car responds correctly. We only assert lack of console
 * errors + that the burnout actually holds the chassis still: visual
 * fidelity of the smoke/skid ribbon is checked manually.
 */
test('burnout (W+S) holds chassis, handbrake (Space) doesn’t crash', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/play/zone_alpha');
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText('Loading vehicle…')).toBeHidden({ timeout: 30_000 });
  await page.locator('canvas').focus();
  await page.waitForTimeout(500);

  // Burnout: from rest, hold W and S together for ~1.5 s. Speed should stay
  // low (chassis pinned by front brakes) — confirms the two-pedal gesture
  // didn't accidentally let the car launch.
  await page.keyboard.down('w');
  await page.keyboard.down('s');
  await page.waitForTimeout(1500);
  const burnoutKmh = await readKmh(page);
  await page.keyboard.up('s');
  await page.keyboard.up('w');
  expect(burnoutKmh).toBeLessThan(10);

  await page.waitForTimeout(800); // let the car coast to rest

  // Handbrake at speed: build a roll, then yank Space. Just needs to not crash.
  await holdUntilFaster(page, 'w', 6);
  await page.keyboard.down('Space');
  await page.waitForTimeout(800);
  await page.keyboard.up('Space');

  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('a GLB car loads from the garage and drives', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await page.getByRole('button', { name: 'Drive' }).click();

  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText('Loading vehicle…')).toBeHidden({ timeout: 45_000 });
  await page.locator('canvas').focus();
  await page.waitForTimeout(500);

  await holdUntilFaster(page, 'w', 8);

  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});
