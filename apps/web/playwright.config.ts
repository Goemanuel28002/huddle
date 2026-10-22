import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8081',
    browserName: 'chromium',
    channel: 'msedge',
    permissions: ['microphone', 'camera'],
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${resolve(process.cwd(), 'e2e/fixtures/fake-camera.y4m')}`, '--auto-select-desktop-capture-source=Entire screen', '--allow-http-screen-capture', '--autoplay-policy=no-user-gesture-required'],
    },
  },
});
