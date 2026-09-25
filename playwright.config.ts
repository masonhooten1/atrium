import { defineConfig, devices } from '@playwright/test'

// Chromium launches with fake media devices so camera/mic flows are testable
// headlessly (spec: Parity tiles). The flags apply to every test browser.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:3000',
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        // Host candidates surface as mDNS .local names by default, which makes
        // same-machine ICE resolution slow and flaky under headless load —
        // reveal the real host IPs so mesh e2e connects deterministically.
        '--disable-features=WebRtcHideLocalIpsForMdns',
      ],
    },
  },
  webServer: {
    // Production build: Next dev's first-compile blocks the event loop on slow
    // CI runners, which starves the socket handshake and makes presence e2e
    // flaky. Building once gives deterministic startup.
    command: 'npm run build && npm run start',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
