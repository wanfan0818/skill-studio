#!/usr/bin/env node
// Build frontend + server on first install. Skips if already built.
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')
const built = path.join(root, 'dist', 'server', 'index.js')

if (fs.existsSync(built)) {
  process.exit(0)
}

// Skip in CI/publish contexts where devDeps may be unavailable
if (process.env.SKILL_STUDIO_SKIP_BUILD === '1') {
  process.exit(0)
}

console.log('[claude-skill-studio] Building frontend and server (first run)...')
try {
  execSync('npm run build', { cwd: root, stdio: 'inherit' })
} catch (err) {
  console.error('[claude-skill-studio] Build failed:', err.message)
  process.exit(1)
}

