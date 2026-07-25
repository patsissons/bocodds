import { defineConfig, devices } from '@playwright/test';

const FIXTURE_PORT = 9788;
const APP_PORT = 8789;
const fixtureBase = `http://127.0.0.1:${FIXTURE_PORT}`;

// The app runs through the real Pages Function (wrangler pages dev) with all
// upstream base URLs pointed at the local fixture server. KV state is
// persisted to a throwaway directory wiped on startup so no snapshot leaks
// between runs (or in from `npm run dev`).
const wranglerCommand = [
  'rm -rf tests/e2e/.wrangler-state &&',
  'npx wrangler pages dev public --port',
  String(APP_PORT),
  '--kv SNAPSHOTS --persist-to tests/e2e/.wrangler-state',
  '--binding ENABLE_BOCODDS=true',
  '--binding CONTACT_EMAIL=e2e@example.com',
  `--binding KALSHI_BASE_URL=${fixtureBase}`,
  `--binding POLYMARKET_BASE_URL=${fixtureBase}`,
  `--binding BOCODDS_BASE_URL=${fixtureBase}`,
  `--binding BOC_VALET_BASE_URL=${fixtureBase}`,
].join(' ');

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, grepInvert: /@mobile/ },
    {
      name: 'mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 700 } },
      grep: /@mobile/,
    },
  ],
  webServer: [
    {
      command: 'node tests/e2e/fixture-server.mjs',
      url: `${fixtureBase}/valet/observations/V39079/json?recent=1`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: wranglerCommand,
      url: `http://localhost:${APP_PORT}/`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
