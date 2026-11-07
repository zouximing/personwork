import { defineConfig, devices } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const port = process.env.WORKBENCH_E2E_PORT ?? '4310';
const origin = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: 'tests/e2e', fullyParallel: false, workers: 1, timeout: 45000,
  use: { baseURL: origin, trace: 'retain-on-failure', screenshot: 'only-on-failure', ...devices['Desktop Chrome'], channel: 'chrome' },
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-results.json' }]],
  webServer: { command: 'npm run build && npm start', url: `${origin}/api/session`, reuseExistingServer: false, timeout: 120000, env: { WORKBENCH_DATA_DIR: join('.runtime', 'e2e', randomUUID()), WORKBENCH_PORT: port, WORKBENCH_ORIGIN: origin, WORKBENCH_HOST: '127.0.0.1' } }
});
