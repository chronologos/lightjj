import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  server: {
    // Proxy API calls to the Go backend during development
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    // Output to a directory the Go binary will embed
    outDir: '../cmd/jj-web/frontend-dist',
    emptyOutDir: true,
  },
})
