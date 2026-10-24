import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { writeFileAtomic } from '../utils/safe.js'

/**
 * Baseline content fingerprint of every warehouse skill: what the skill
 * looked like when it was installed, last updated from upstream, or when the
 * user last accepted its local changes. "Locally edited" = current content
 * differs from the baseline.
 *
 * Kept outside the skill directories (in ~/.config) so the skills stay clean
 * and a baseline can't be edited along with the content it guards.
 */

export interface Baseline {
  fingerprint: string | null
  /** Stat signature of the content the fingerprint was taken from (see getSkillFolderSignature). */
  signature?: string | null
  recordedAt: string
  /** Why this baseline was set: install, upstream update, accepted local edits, first sight. */
  reason: 'install' | 'update' | 'accept' | 'adopt'
}

interface BaselineFile {
  version: 1
  /** keyed by the skill directory's real path */
  skills: Record<string, Baseline>
}

export function baselineFile(): string {
  return path.join(os.homedir(), '.config', 'skill-studio', 'update-baselines.json')
}

let queue: Promise<unknown> = Promise.resolve()

export async function readBaselines(): Promise<Record<string, Baseline>> {
  try {
    const parsed = JSON.parse(await fs.readFile(baselineFile(), 'utf-8')) as BaselineFile
    return parsed && typeof parsed.skills === 'object' && parsed.skills ? parsed.skills : {}
  } catch {
    return {}
  }
}

/** Serialized read-modify-write of the baseline file. */
export function updateBaselines(mutate: (skills: Record<string, Baseline>) => void): Promise<void> {
  const run = queue.then(async () => {
    const skills = await readBaselines()
    mutate(skills)
    await fs.mkdir(path.dirname(baselineFile()), { recursive: true })
    await writeFileAtomic(baselineFile(), JSON.stringify({ version: 1, skills } satisfies BaselineFile, null, 2))
  })
  queue = run.catch(() => {})
  return run
}

export function setBaseline(realPath: string, fingerprint: string | null, reason: Baseline['reason'], signature?: string | null): Promise<void> {
  return updateBaselines((skills) => {
    skills[realPath] = { fingerprint, signature, recordedAt: new Date().toISOString(), reason }
  })
}
