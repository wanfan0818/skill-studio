import os from 'os'
import path from 'path'
import { readJsonFile, writeFileAtomic } from './utils/safe.js'

/**
 * ~/.config/skill-studio/ide-settings.json — app-level settings.
 *
 * Distribution (which skills go to which agent) no longer lives here: see
 * server/distribution/state.ts. `enabledAgentIds` / `skillOverrides` are kept
 * on the type only so the one-time migration can read them.
 */
export interface AppSettings {
  customGlobalSkillsDir?: string
  skillWarehouses?: string[]
  githubToken?: string
  httpProxy?: string
  /**
   * IDEs the user actually uses; only these appear in IDE pickers. Unset →
   * derived from distribution rules and project configs (see preferredIdes()).
   */
  preferredIdes?: string[]
  /** @deprecated migrated into distribution.json */
  enabledAgentIds?: string[]
  /** @deprecated migrated into distribution.json */
  skillOverrides?: Record<string, { enabledIdes?: string[]; disabledIdes?: string[] }>
}

export function configDir(): string {
  return path.join(os.homedir(), '.config', 'skill-studio')
}

export function ideSettingsPath(): string {
  return path.join(configDir(), 'ide-settings.json')
}

/**
 * Missing file → defaults (nothing is written: reads have no side effects).
 * Malformed / unreadable file → throws, so callers never overwrite it.
 */
export async function readIdeSettingsFull(): Promise<AppSettings> {
  const parsed = await readJsonFile<any>(ideSettingsPath())
  if (parsed === undefined) return {}

  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
  return {
    customGlobalSkillsDir: str(parsed.customGlobalSkillsDir),
    skillWarehouses: Array.isArray(parsed.skillWarehouses)
      ? parsed.skillWarehouses.filter((w: unknown) => typeof w === 'string' && w.trim() !== '').map((w: string) => w.trim())
      : undefined,
    githubToken: typeof parsed.githubToken === 'string' ? parsed.githubToken : undefined,
    httpProxy: typeof parsed.httpProxy === 'string' ? parsed.httpProxy : undefined,
    preferredIdes: Array.isArray(parsed.preferredIdes) ? parsed.preferredIdes.filter((x: unknown) => typeof x === 'string') : undefined,
    enabledAgentIds: Array.isArray(parsed.enabledAgentIds) ? parsed.enabledAgentIds : undefined,
    skillOverrides: parsed.skillOverrides && typeof parsed.skillOverrides === 'object' ? parsed.skillOverrides : undefined,
  }
}

export async function writeIdeSettingsFull(settings: AppSettings): Promise<void> {
  // 0600: this file holds the GitHub token.
  await writeFileAtomic(ideSettingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 })
}

/**
 * The skill warehouses: the user's managed skill library and the ONLY source
 * that gets distributed into agent directories. Falls back to the shared
 * universal directory when nothing is configured.
 */
export function warehouseDirsFrom(settings: AppSettings): string[] {
  const dirs: string[] = []
  const add = (p?: string) => {
    if (!p) return
    const abs = path.resolve(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)
    if (!dirs.includes(abs)) dirs.push(abs)
  }
  add(settings.customGlobalSkillsDir)
  for (const w of settings.skillWarehouses ?? []) add(w)
  if (dirs.length === 0) add(path.join(os.homedir(), '.agents', 'skills'))
  return dirs
}

export async function getWarehouseDirs(): Promise<string[]> {
  return warehouseDirsFrom(await readIdeSettingsFull())
}
