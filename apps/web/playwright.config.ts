import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the zone-runtime smoke tests. Boots the Vite dev server
 * and drives the live WebGL + Rapier session in a real (headless) browser —
 * runtime verification, not just unit gates. Headless Chromium runs WebGL2 via
 * SwiftShader (`--enable-unsafe-swiftshader`), so it needs no GPU.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
