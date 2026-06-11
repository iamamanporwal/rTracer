// Dev smoke test for the rider pose editor: loads /pose-editor.html, drives a
// couple of the editor's actions, captures console errors, and screenshots.
// Run from apps/web so it resolves @playwright/test:
//   BASE=http://localhost:5173 node pose-editor-smoke.mjs [vehicle_id] [hub]
import { chromium } from '@playwright/test';

const id = process.argv[2] ?? 'vehicle_bike';
const hub = process.argv[3] ?? '-0.2708';
const base = process.env.BASE ?? 'http://localhost:5173';
const url = `${base}/pose-editor.html?v=${id}&hub=${hub}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(url, { waitUntil: 'networkidle' });
// Give the GLB + FBX + IK solve time to settle.
await page.waitForTimeout(3500);
await page.screenshot({ path: `/tmp/pose-editor-${id}.png` });

// Exercise the React export action (writes JSON into the textarea) and read it back.
let exported = null;
try {
  await page.getByRole('button', { name: /Export JSON/i }).click();
  await page.waitForSelector('textarea[data-testid="pose-json"]', { timeout: 4000 });
  exported = await page.locator('textarea[data-testid="pose-json"]').inputValue();
} catch (e) {
  errors.push(`export action failed: ${e.message}`);
}

let parsedOk = false;
try {
  const obj = JSON.parse(exported ?? 'null');
  // New per-side knee fields confirm the rig change is live end-to-end.
  parsedOk =
    obj &&
    typeof obj === 'object' &&
    'idle' in obj &&
    'wheelie' in obj &&
    Array.isArray(obj.idle?.legPoleL) &&
    Array.isArray(obj.idle?.legPoleR);
} catch {
  parsedOk = false;
}

console.log(`screenshot: /tmp/pose-editor-${id}.png`);
console.log(`export parsed OK: ${parsedOk}`);
console.log(`console errors (${errors.length}):`);
for (const e of errors) console.log('  - ' + e);

await browser.close();
process.exit(errors.length === 0 && parsedOk ? 0 : 1);
