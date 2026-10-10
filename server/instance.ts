import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { execFileSafe } from './utils/exec.js'
import { writeFileAtomic } from './utils/safe.js'

/**
 * Single-instance handling for the production server.
 *
 * Each start used to fall through to the next free port when an older
 * instance still held 3456, leaving several versions running side by side
 * (3456 / 3457 / 3458…) and the browser pointed at a stale one. Now a start:
 *   - finds running Skill Studio servers (instance file + who listens on the
 *     candidate ports, confirmed by the process command line),
 *   - same build already running → reuse it (print URL, don't start another),
 *   - older build → stop it and take over its port.
 * SKILL_STUDIO_ALLOW_MULTIPLE=1 disables this.
 */

export interface InstanceInfo {
  pid: number
  port: number
  build: string
  startedAt: string
}

export function instanceFile(): string {
  return path.join(os.homedir(), '.config', 'skill-studio', 'instance.json')
}

/** Identity of the code this process runs: version + mtime of the server entry. */
export function currentBuild(entryFile: string, version: string): string {
  try {
    return `${version}@${Math.round(fs.statSync(entryFile).mtimeMs)}`
  } catch {
    return `${version}@unknown`
  }
}

/** A production Skill Studio server process (never a dev `tsx` server). */
export function isSkillStudioServerCommand(cmd: string): boolean {
  return /skill-studio/i.test(cmd) && /dist[\\/]server[\\/]index\.js/.test(cmd) && !/\btsx\b|vite/.test(cmd)
}

async function commandOf(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileSafe('ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 5000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function listeningPid(port: number): Promise<number | null> {
  try {
    const { stdout } = await execFileSafe('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeoutMs: 5000 })
    const pid = parseInt(stdout.trim().split('\n')[0], 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null // lsof exits 1 when nothing listens
  }
}

async function readInstanceFile(): Promise<InstanceInfo | null> {
  try {
    return JSON.parse(await fsp.readFile(instanceFile(), 'utf-8'))
  } catch {
    return null
  }
}

export interface RunningInstance {
  pid: number
  port: number
  /** Known only for instances that wrote an instance file (newer versions). */
  build?: string
}

/** Other Skill Studio servers listening on any of `ports`. */
export async function findRunningInstances(ports: number[]): Promise<RunningInstance[]> {
  if (process.platform === 'win32') return []
  const self = new Set([process.pid, process.ppid])
  const recorded = await readInstanceFile()
  const found = new Map<number, RunningInstance>()
  for (const port of ports) {
    const pid = await listeningPid(port)
    if (!pid || self.has(pid) || found.has(pid)) continue
    const cmd = await commandOf(pid)
    if (!cmd || !isSkillStudioServerCommand(cmd)) continue
    found.set(pid, { pid, port, build: recorded?.pid === pid ? recorded.build : undefined })
  }
  return [...found.values()]
}

/** SIGTERM, wait, then SIGKILL. Resolves true once the process is gone. */
export async function stopInstance(pid: number, graceMs = 5000): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return !alive(pid)
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
  await new Promise((r) => setTimeout(r, 200))
  return !alive(pid)
}

export async function recordInstance(info: InstanceInfo): Promise<void> {
  await writeFileAtomic(instanceFile(), JSON.stringify(info, null, 2))
  const cleanup = () => {
    try {
      const cur = JSON.parse(fs.readFileSync(instanceFile(), 'utf-8'))
      if (cur.pid === process.pid) fs.unlinkSync(instanceFile())
    } catch {}
  }
  process.once('exit', cleanup)
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      cleanup()
      process.exit(0)
    })
  }
}

export type StartupDecision =
  | { action: 'start'; port: number; stopped: RunningInstance[] }
  | { action: 'reuse'; existing: RunningInstance }

/**
 * Decide what this start should do. Instances running the same build are
 * reused; older ones (or ones too old to report a build) are stopped and the
 * lowest freed port is taken over.
 */
export async function resolveStartup(basePort: number, build: string, tries = 5): Promise<StartupDecision> {
  const ports = Array.from({ length: tries }, (_, i) => basePort + i)
  const running = await findRunningInstances(ports)
  const same = running.find((r) => r.build === build)
  if (same) return { action: 'reuse', existing: same }
  const stopped: RunningInstance[] = []
  for (const r of running) {
    if (await stopInstance(r.pid)) stopped.push(r)
  }
  const port = stopped.length ? Math.min(basePort, ...stopped.map((s) => s.port)) : basePort
  return { action: 'start', port, stopped }
}
