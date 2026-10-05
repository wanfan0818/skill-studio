import fs from 'fs'
import path from 'path'
import os from 'os'
import { allAgentGlobalAbsPaths } from './agents.js'
import { getWarehouseDirs } from '../settings.js'

const homedir = os.homedir()

export type WatchCallback = (event: { type: string; path: string }) => void

/**
 * File watching for the skill roots (warehouses + every agent's global dir).
 *
 * Uses Node's recursive fs.watch — FSEvents on macOS, ReadDirectoryChangesW
 * on Windows — so each root costs one handle regardless of how many files it
 * contains. The previous chokidar setup watched every file individually
 * (following symlinks two levels deep), which on the real dataset held
 * ~10 000 open descriptors. On macOS posix_spawn rejects descriptors at or
 * above OPEN_MAX (10240) with EBADF, so once the watcher had eaten the low
 * slots, spawning git / npx / tar failed intermittently with `spawn EBADF`.
 */

let watchers: fs.FSWatcher[] = []
let starting = false

/** Only events that can change what a scan reports: an entry appearing or
 *  disappearing in a skills root, or a SKILL.md being edited. */
export function isRelevant(relPath: string): boolean {
  const parts = relPath.split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0) return true
  if (parts.some((p) => p === 'node_modules' || p === '.git')) return false
  if (parts.length === 1) return !parts[0].startsWith('.') || parts[0] === '.skills-profile.json'
  return parts.length === 2 && parts[1] === 'SKILL.md'
}

/** Real, existing directories; drop any that live inside another watched root. */
function dedupeRoots(dirs: string[]): string[] {
  const reals: string[] = []
  for (const d of dirs) {
    try {
      const real = fs.realpathSync(d)
      if (fs.statSync(real).isDirectory() && !reals.includes(real)) reals.push(real)
    } catch {}
  }
  reals.sort((a, b) => a.length - b.length)
  return reals.filter((r, i) => !reals.slice(0, i).some((p) => r.startsWith(p + path.sep)))
}

export async function startWatcher(callback: WatchCallback): Promise<void> {
  if (watchers.length || starting) return
  starting = true

  let warehouseDirs: string[] = []
  try {
    warehouseDirs = await getWarehouseDirs()
  } catch (err: any) {
    console.warn('[watcher] Could not read warehouse settings:', err?.message || err)
  }
  starting = false
  if (watchers.length) return

  const roots = dedupeRoots([...warehouseDirs, ...allAgentGlobalAbsPaths(homedir).map((x) => x.path)])

  for (const root of roots) {
    try {
      const w = fs.watch(root, { recursive: true, persistent: true }, (eventType, filename) => {
        const rel = filename ? filename.toString() : ''
        if (!isRelevant(rel)) return
        callback({ type: eventType, path: path.join(root, rel) })
      })
      w.on('error', (err) => console.warn(`[watcher] ${root}:`, err?.message || err))
      watchers.push(w)
    } catch (err: any) {
      console.warn(`[watcher] Cannot watch ${root}:`, err?.message || err)
    }
  }
}

export function stopWatcher(): void {
  for (const w of watchers) {
    try {
      w.close()
    } catch {}
  }
  watchers = []
}

export function watchedRootCount(): number {
  return watchers.length
}
