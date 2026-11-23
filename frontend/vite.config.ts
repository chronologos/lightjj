import { readFileSync } from 'fs'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { svelteTesting } from '@testing-library/svelte/vite'

const appVersion = readFileSync('../version.txt', 'utf-8').trim()

// Host must stay the browser's: the backend accepts config writes only when Origin
// matches it. (The string shorthand implies changeOrigin: true.)
const backend = { target: 'http://localhost:3000', changeOrigin: false }

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    // Proxy API calls to the Go backend during development
    proxy: {
      '/api': backend,
      '/tab': backend,
      '/tabs': backend,
    },
  },
  build: {
    // Output to a directory the Go binary will embed
    outDir: '../cmd/lightjj/frontend-dist',
    emptyOutDir: true,
    // Main chunk ~600K after lazy-loading CodeMirror editor + markdown stack.
    // Shipped embedded in a Go binary so chunk count doesn't matter for
    // deployment; the split is purely for initial-parse latency. See
    // bundle.test.ts for the regression assertion.
    chunkSizeWarningLimit: 1000,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest-setup.ts'],
  },
})
