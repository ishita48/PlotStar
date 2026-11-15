import { defineConfig } from '@playwright/test';
import { randomBytes } from 'node:crypto';
process.env.TELEMETRY_API_KEY ||= randomBytes(24).toString('hex');
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90000,
  expect: { timeout: 20000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3100',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: {
    command: 'node scripts/test-server.mjs',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      ...(process.env as Record<string, string>),
      // Postgres: a throwaway Neon branch is best (TEST_DATABASE_URL); falls back to DATABASE_URL.
      DATABASE_URL: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '',
      DATABASE_URL_UNPOOLED: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED || '',
      TELEMETRY_API_KEY: process.env.TELEMETRY_API_KEY,
      OPENAI_API_KEY: '',
    },
  },
});
