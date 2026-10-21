import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    includeAssets: ['favicon.svg', 'connect-mark.svg'],
    manifest: {
      id: '/',
      name: 'Connect Together',
      short_name: 'Connect',
      description: 'Ein Ort, der euch verbindet.',
      lang: 'de',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#18181d',
      theme_color: '#18181d',
      categories: ['social', 'communication'],
      icons: [
        { src: '/connect-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/connect-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    },
    workbox: { navigateFallback: '/index.html', cleanupOutdatedCaches: true, globPatterns: ['**/*.{js,css,html,svg,png,ico}'] },
  })],
  server: { proxy: { '/api': { target: 'http://localhost:3000', ws: true } } },
})
