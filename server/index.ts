import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { skillRoutes } from './routes/skills.js'
import { manageRoutes } from './routes/manage.js'
import { distributionRoutes } from './routes/distribution.js'
import { isApplying } from './distribution/lock.js'
import { versionRoutes } from './routes/versions.js'
import { similarityRoutes } from './routes/similarity.js'
import { trashRoutes } from './routes/trash.js'
import { syncRoutes } from './routes/sync.js'
import { marketRoutes } from './routes/market.js'
import { githubRoutes } from './routes/github.js'
import { projectRoutes } from './routes/projects.js'
import { updaterRoutes } from './routes/updater.js'
import { globalRoutes } from './routes/global.js'
import { startWatcher, stopWatcher, type WatchCallback } from './scanner/watcher.js'
import { invalidateCache } from './routes/skills.js'
import { purgeExpired as purgeExpiredTrash } from './trash/store.js'
import type { WebSocket } from '@fastify/websocket'
import os from 'os'
import fsPromises from 'fs/promises'
import { setupProxy } from './sync/proxy.js'
import { registerGuard, generateSessionToken, persistSessionToken } from './security/guard.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function migrateLegacyDirectories() {
  const homedir = os.homedir()
  const migrations = [
    {
      old: path.join(homedir, '.config', 'skill-hub'),
      new: path.join(homedir, '.config', 'skill-studio')
    },
    {
      old: path.join(homedir, '.skill-hub'),
      new: path.join(homedir, '.skill-studio')
    },
    {
      old: path.join(homedir, '.local', 'share', 'skill-hub'),
      new: path.join(homedir, '.local', 'share', 'skill-studio')
    },
    {
      old: path.join(homedir, '.claude', 'skill-hub'),
      new: path.join(homedir, '.claude', 'skill-studio')
    }
  ]
  for (const m of migrations) {
    if (!fs.existsSync(m.new) && fs.existsSync(m.old)) {
      try {
        await fsPromises.rename(m.old, m.new)
        console.log(`[skill-studio] Migrated legacy folder from ${m.old} to ${m.new}`)
      } catch (err: any) {
        console.error(`[skill-studio] Failed to migrate ${m.old} to ${m.new}:`, err.message)
      }
    }
  }
}

await setupProxy()
await migrateLegacyDirectories()

process.on('uncaughtException', (err) => {
  console.error('[skill-studio] Uncaught Exception caught (process guarded):', err)
})

process.on('unhandledRejection', (reason) => {
  console.error('[skill-studio] Unhandled Rejection caught (process guarded):', reason)
})

const app = Fastify({ logger: false })

// No CORS: the UI is same-origin. The guard rejects foreign Host/Origin
// headers and requests without this launch's session token.
const sessionToken = generateSessionToken()
await persistSessionToken(sessionToken).catch((err) => {
  console.warn('[skill-studio] Could not persist session token (dev proxy will not authenticate):', err?.message || err)
})
registerGuard(app, sessionToken)

await app.register(websocket)
await app.register(skillRoutes)
await app.register(manageRoutes)
await app.register(versionRoutes)
await app.register(similarityRoutes)
await app.register(trashRoutes)
await app.register(syncRoutes)
await app.register(marketRoutes)
await app.register(githubRoutes)
await app.register(projectRoutes)
await app.register(updaterRoutes)
await app.register(globalRoutes)
await app.register(distributionRoutes)

// Health check
app.get('/api/health', async () => ({ status: 'ok' }))

// WebSocket for real-time updates
const wsClients = new Set<WebSocket>()

function broadcast(data: any) {
  const msg = JSON.stringify(data)
  for (const ws of wsClients) {
    if (ws.readyState === 1) {
      ws.send(msg)
    }
  }
}

// File watcher only runs while at least one Web UI client is connected.
let debounceTimer: ReturnType<typeof setTimeout> | null = null

const watchCallback: WatchCallback = (event) => {
  if (isApplying()) return
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    // Only invalidate and notify. Drifted physical copies are NOT
    // auto-overwritten here: the old block never actually ran (it referenced
    // an unimported function), and silently re-copying on every file event
    // would discard edits made inside a project's copy. Drift is surfaced in
    // the UI and resynced on explicit user action.
    invalidateCache()
    broadcast({ type: 'change', event })
  }, 500)
}

app.register(async function (fastify) {
  fastify.get('/ws', { websocket: true }, (socket) => {
    const shouldStartWatcher = wsClients.size === 0
    wsClients.add(socket)

    if (shouldStartWatcher) {
      invalidateCache()
      void startWatcher(watchCallback)
    }

    socket.on('close', () => {
      wsClients.delete(socket)
      if (wsClients.size === 0) {
        stopWatcher()
      }
    })
  })
})

// Serve built frontend static files (production mode)
// Try several possible locations for the dist/web directory. Must check both
// index.html AND assets/ so we don't accidentally pick the source web/ dir in
// dev mode — the source index.html references /src/main.tsx which only works
// under vite, and serving it from fastify leaves the page blank.
const candidates = [
  path.resolve(__dirname, '../web'),          // dist/server/ → dist/web/ (production layout)
  path.resolve(__dirname, '../../dist/web'),   // server/ (dev) → project/dist/web/
  path.resolve(process.cwd(), 'dist/web'),     // cwd/dist/web/
]

const staticRoot = candidates.find((p) => {
  try {
    return (
      fs.existsSync(path.join(p, 'index.html')) &&
      fs.existsSync(path.join(p, 'assets'))
    )
  } catch {
    return false
  }
})

if (staticRoot) {
  await app.register(fastifyStatic, {
    root: staticRoot,
    prefix: '/',
    wildcard: false,
  })

  // SPA fallback: any non-/api, non-/ws route → serve index.html
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      reply.status(404).send({ error: 'Not found' })
      return
    }
    reply.sendFile('index.html')
  })
}

// Startup self-check: warn loudly if frontend is missing
if (!staticRoot) {
  console.warn(
    '\n\x1b[33m⚠️  Frontend build not found. Running in API-only mode.\x1b[0m',
  )
  console.warn(
    '   Looked in:\n   - ' + candidates.join('\n   - '),
  )
  console.warn('   Run `npm run build` in the package directory.\n')
}

// Try a range of ports on EADDRINUSE so a stale process doesn't brick startup.
async function listenWithRetry(startPort: number): Promise<number> {
  const maxAttempts = 5
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i
    try {
      await app.listen({ port, host: '127.0.0.1' })
      return port
    } catch (err: any) {
      if (err?.code === 'EADDRINUSE' && i < maxAttempts - 1) {
        console.warn(`\x1b[33m⚠️  Port ${port} in use, trying ${port + 1}...\x1b[0m`)
        continue
      }
      throw err
    }
  }
  throw new Error(`All ports ${startPort}-${startPort + maxAttempts - 1} in use`)
}

const basePort = parseInt(process.env.PORT || '3456')

function openInBrowser(url: string) {
  if (process.env.SKILL_STUDIO_NO_OPEN === '1' || process.env.SKILL_HUB_NO_OPEN === '1') return
  import('child_process')
    .then(({ execFile }) => {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
      execFile(cmd, [url], () => {})
    })
    .catch(() => {})
}

// Single instance (production build only; `npm run dev` is never affected).
const isProductionBuild = __filename.endsWith(path.join('dist', 'server', 'index.js'))
const singleInstance = isProductionBuild && process.env.SKILL_STUDIO_ALLOW_MULTIPLE !== '1'
let build = ''
let startPort = basePort
if (singleInstance) {
  const { currentBuild, resolveStartup } = await import('./instance.js')
  let version = '0.0.0'
  try {
    version = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')).version
  } catch {}
  build = currentBuild(__filename, version)
  const decision = await resolveStartup(basePort, build)
  if (decision.action === 'reuse') {
    const url = `http://localhost:${decision.existing.port}`
    console.log(`\n✅ Skill Studio（同一版本）已在运行：\x1b[36m${url}\x1b[0m（pid ${decision.existing.pid}），不再重复启动。`)
    console.log(`\x1b[90m   如需重启，先在原终端按 Ctrl+C，或设置 SKILL_STUDIO_ALLOW_MULTIPLE=1。\x1b[0m\n`)
    if (staticRoot) openInBrowser(url)
    process.exit(0)
  }
  for (const s of decision.stopped) {
    console.log(`\x1b[33m♻️  已停止旧版本 Skill Studio（pid ${s.pid}，端口 ${s.port}），由新版本接管\x1b[0m`)
  }
  startPort = decision.port
}

try {
  const actualPort = await listenWithRetry(startPort)
  const url = `http://localhost:${actualPort}`
  if (singleInstance) {
    const { recordInstance } = await import('./instance.js')
    await recordInstance({ pid: process.pid, port: actualPort, build, startedAt: new Date().toISOString() }).catch(() => {})
  }

  // Record the port for the Vite dev proxy — in the config dir, not the
  // user's current working directory.
  try {
    fs.mkdirSync(path.join(os.homedir(), '.config', 'skill-studio'), { recursive: true })
    fs.writeFileSync(path.join(os.homedir(), '.config', 'skill-studio', 'port'), actualPort.toString(), 'utf-8')
  } catch {}

  // Purge expired trash entries on startup (best-effort, non-blocking failures)
  try {
    const removed = await purgeExpiredTrash()
    if (removed > 0) {
      console.log(`\x1b[90m🗑  Purged ${removed} expired trash entr${removed === 1 ? 'y' : 'ies'}\x1b[0m`)
    }
  } catch {}

  // Run an initial scan so the banner shows real numbers
  let scanSummary = ''
  try {
    const { fullScan } = await import('./scanner/discovery.js')
    const result = await fullScan()
    const paths = result.scannedPaths
    const foundPaths = paths.filter((p) => p.count > 0)
    scanSummary =
      `\x1b[32m✅ Found ${result.stats.total} skills\x1b[0m ` +
      `(${foundPaths.length}/${paths.length} locations, ${result.durationMs}ms)`
    if (result.stats.total === 0) {
      scanSummary += '\n\x1b[33m⚠️  No skills found. Run `curl ' + url + '/api/debug` to see scanned paths.\x1b[0m'
    }
  } catch (e: any) {
    scanSummary = `\x1b[31m❌ Initial scan failed: ${e?.message || e}\x1b[0m`
  }

  console.log(`\n🚀 Claude Skill Studio running at \x1b[36m${url}\x1b[0m`)
  if (staticRoot) {
    console.log(`🌐 Web UI:   \x1b[36m${url}\x1b[0m`)
  }
  console.log(`🔍 Debug:    \x1b[36m${url}/api/debug\x1b[0m`)
  console.log(scanSummary)
  console.log(`👀 File watcher starts when Web UI connects`)
  console.log(`\x1b[90m💡 下次启动直接敲: \x1b[0m\x1b[36mskill-studio\x1b[0m\x1b[90m  (或访问 ${url})\x1b[0m\n`)

  if (staticRoot) openInBrowser(url)

} catch (err) {
  console.error('\x1b[31m❌ Failed to start server:\x1b[0m', err)
  process.exit(1)
}
