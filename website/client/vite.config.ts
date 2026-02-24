import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  base: './',
  server: {
    port: 5173,
    proxy: {
      // Proxy WebSocket connections to the Express server during dev
      '/ws': {
        target: 'ws://localhost:3579',
        ws: true,
      },
    },
  },
})
