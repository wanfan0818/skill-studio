import chokidar, { type FSWatcher } from 'chokidar'
import fs from 'fs'
import os from 'os'
import { allAgentGlobalAbsPaths } from './agents.js'
import { getWarehouseDirs } from '../settings.js'

const homedir = os.homedir()

export type WatchCallback = (event: { type: string; path: string }) => void

let watcher: FSWatcher | null = null
const ignoredPathNames = new Set(['node_modules', '.git'])

function isIgnoredPath(filePath: string): boolean {
  return filePath.split(/[\\/]+/).some((part) => ignoredPathNames.has(part))
}

let starting = false

export async function startWatcher(callback: WatchCallback): Promise<void> {
  if (watcher || starting) return
  starting = true

  // Configured warehouses (not hard-coded personal paths) + every agent's
  // global skills directory.
  let warehouseDirs: string[] = []
  try {
    warehouseDirs = await getWarehouseDirs()
  } catch (err: any) {
    console.warn('[watcher] Could not read warehouse settings:', err?.message || err)
  }
  starting = false
  if (watcher) return

  const watchPaths = Array.from(new Set([
    ...allAgentGlobalAbsPaths(homedir).map((x) => x.path),
    ...warehouseDirs,
  ]))

  // Only watch paths that exist
  const validPaths = watchPaths.filter((p) => {
    try {
      fs.statSync(p)
      return true
    } catch {
      return false
    }
  })

  if (validPaths.length === 0) return

  watcher = chokidar.watch(validPaths, {
    depth: 2,
    ignoreInitial: true,
    persistent: true,
    followSymlinks: true,
    ignored: isIgnoredPath,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  })

  watcher
    .on('add', (p) => callback({ type: 'add', path: p }))
    .on('change', (p) => callback({ type: 'change', path: p }))
    .on('unlink', (p) => callback({ type: 'unlink', path: p }))
    .on('addDir', (p) => callback({ type: 'addDir', path: p }))
    .on('unlinkDir', (p) => callback({ type: 'unlinkDir', path: p }))
    .on('error', (err) => {
      console.warn('[watcher] File watcher error encountered:', (err as any)?.message || err)
    })
}

export function stopWatcher(): void {

  if (watcher) {
    void watcher.close().catch((err) => {
      console.warn('Failed to close file watcher:', err)
    })
    watcher = null
  }
}
