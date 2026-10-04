import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'
import os from 'os'

// Read dynamic port from .port.tmp if it exists
let backendPort = '3456'
try {
  const tmpPath = path.resolve(__dirname, '.port.tmp')
  if (fs.existsSync(tmpPath)) {
    backendPort = fs.readFileSync(tmpPath, 'utf-8').trim()
  }
} catch {}

// Session token written by the backend at startup (dev mode only: in
// production the page served by the backend sets it as a cookie). Read per
// request because `tsx watch` restarts the backend — and mints a new token —
// on every edit.
const tokenFile = path.join(os.homedir(), '.config', 'skill-studio', 'session-token')
function readSessionToken(): string {
  try {
    return fs.readFileSync(tokenFile, 'utf-8').trim()
  } catch {
    return ''
  }
}
function attachToken(proxy: any) {
  const set = (proxyReq: any) => {
    const token = readSessionToken()
    if (token) proxyReq.setHeader('x-skill-studio-token', token)
  }
  proxy.on('proxyReq', set)
  proxy.on('proxyReqWs', set)
}

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
        configure: attachToken,
      },
      '/ws': {
        target: `ws://127.0.0.1:${backendPort}`,
        ws: true,
        configure: attachToken,
      },
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
})
