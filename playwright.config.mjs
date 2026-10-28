import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.DEMO_URL || 'http://localhost:4173',
    viewport: { width: 1440, height: 900 },
    channel: 'chromium',
    headless: true,
    launchOptions: { args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm start',
    url: `${process.env.DEMO_URL || 'http://localhost:4173'}/api/health`,
    reuseExistingServer: true,
    timeout: 30000,
  },
});
