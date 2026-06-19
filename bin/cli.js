#!/usr/bin/env node
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const pkgRoot = path.resolve(__dirname, '..')
const serverEntry = path.join(pkgRoot, 'dist', 'server', 'index.js')

function sanitizeFileDescriptors() {
  for (const fd of [0, 1, 2]) {
    try {
      fs.fstatSync(fd)
    } catch (err) {
      if (err.code === 'EBADF') {
        try {
          const mode = fd === 0 ? 'r' : 'w'
          const newFd = fs.openSync('/dev/null', mode)
          if (newFd !== fd) {
            // If the opened fd is not the one we want, duplicate it to target fd
            // However, in standard environments, opening sequentially should yield 0, 1, 2.
          }
        } catch {}
      }
    }
  }
}
sanitizeFileDescriptors()

if (!fs.existsSync(serverEntry)) {
  console.error('\x1b[31m[claude-skill-studio] Build output missing.\x1b[0m')
  console.error('Expected:', serverEntry)
  console.error('Run `npm run build` in the package directory, or reinstall.')
  process.exit(1)
}

const child = spawn(process.execPath, [serverEntry], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
  cwd: process.cwd(),
})

if (child.stdout) {
  child.stdout.on('data', (data) => {
    try {
      process.stdout.write(data)
    } catch {}
  })
}

if (child.stderr) {
  child.stderr.on('data', (data) => {
    try {
      process.stderr.write(data)
    } catch {}
  })
}

child.on('exit', (code) => process.exit(code ?? 0))

const forward = (sig) => () => child.kill(sig)
process.on('SIGINT', forward('SIGINT'))
process.on('SIGTERM', forward('SIGTERM'))
