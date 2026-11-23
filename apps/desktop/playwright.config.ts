import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  use: {
    baseURL: 'http://127.0.0.1:43187',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'bun run dev',
    url: 'http://127.0.0.1:43187',
    reuseExistingServer: !process.env.CI,
  },
})
