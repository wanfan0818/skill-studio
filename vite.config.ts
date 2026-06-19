import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'

// Read dynamic port from .port.tmp if it exists
let backendPort = '3456'
try {
  const tmpPath = path.resolve(__dirname, '.port.tmp')
  if (fs.existsSync(tmpPath)) {
    backendPort = fs.readFileSync(tmpPath, 'utf-8').trim()
  }
} catch {}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'web',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'web/src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${backendPort}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://127.0.0.1:${backendPort}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
})
