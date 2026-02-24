import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { svelteTesting } from '@testing-library/svelte/vite'

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  server: {
    // Proxy API calls to the Go backend during development
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    // Output to a directory the Go binary will embed
    outDir: '../cmd/lightjj/frontend-dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest-setup.ts'],
  },
})
