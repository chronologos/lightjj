import { readFileSync } from 'fs'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { svelteTesting } from '@testing-library/svelte/vite'

const appVersion = readFileSync('../version.txt', 'utf-8').trim()

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    // Proxy API calls to the Go backend during development
    proxy: {
      '/api': 'http://localhost:3000',
      '/tab': 'http://localhost:3000',
      '/tabs': 'http://localhost:3000',
    },
  },
  build: {
    // Output to a directory the Go binary will embed
    outDir: '../cmd/lightjj/frontend-dist',
    emptyOutDir: true,
    // Single-bundle app (no dynamic imports), shipped embedded in a Go binary —
    // code-splitting buys nothing. Silence the 500kB warning.
    chunkSizeWarningLimit: 1000,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest-setup.ts'],
  },
})
