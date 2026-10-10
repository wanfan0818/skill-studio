import fs from 'fs/promises'
import path from 'path'
import { AGENTS, projectCapableAgents, allAgentProjectRelPaths } from '../scanner/agents.js'
import { isPlainSegment, writeFileAtomic } from '../utils/safe.js'

/**
 * A project = one folder with a `.skills-profile.json`:
 *   one skill list, distributed to every IDE in `ides`.
 *
 * v1 profiles had a single `targetIde`; they are read as `ides: [targetIde]`
 * and written back as v2 (keeping `targetIde = ides[0]` for older versions).
 */
export interface ProjectProfile {
  version: 2
  name: string
  description: string
  skills: string[]
  ides: string[]
  createdAt: string
  updatedAt: string
}

/** Description written by the old auto-profile bug (GET /api/projects). */
export const AUTO_PROFILE_DESCRIPTION = '自动配置的项目 Profile'

const PROFILE_FILE = '.skills-profile.json'

export function validProjectIdes(ids: unknown): string[] {
  const capable = new Set(projectCapableAgents().map((a) => a.id as string))
  return Array.isArray(ids) ? Array.from(new Set(ids.filter((x): x is string => typeof x === 'string' && capable.has(x)))) : []
}

interface RawProfile {
  raw: any
  profile: ProjectProfile
}

async function readRaw(projectPath: string): Promise<RawProfile | undefined> {
  let raw: any
  try {
    raw = JSON.parse(await fs.readFile(path.join(projectPath, PROFILE_FILE), 'utf-8'))
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.skills)) return undefined
  const ides = validProjectIdes(Array.isArray(raw.ides) ? raw.ides : raw.targetIde ? [raw.targetIde] : [])
  return {
    raw,
    profile: {
      version: 2,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : path.basename(projectPath),
      description: typeof raw.description === 'string' ? raw.description : '',
      skills: Array.from(new Set(raw.skills.filter(isPlainSegment))),
      ides,
      createdAt: raw.createdAt || new Date().toISOString(),
      updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString(),
    },
  }
}

export async function readProfile(projectPath: string): Promise<ProjectProfile | undefined> {
  return (await readRaw(projectPath))?.profile
}

/**
 * Profiles the old bug wrote automatically and nobody has touched since are
 * not "configured by the user" — they are offered as candidates instead.
 */
function isUnconfirmedAuto(raw: any): boolean {
  return raw?.description === AUTO_PROFILE_DESCRIPTION && (!raw.updatedAt || raw.updatedAt === raw.createdAt)
}

export async function writeProfile(projectPath: string, profile: Omit<ProjectProfile, 'version' | 'createdAt' | 'updatedAt'> & { createdAt?: string }): Promise<ProjectProfile> {
  const now = new Date().toISOString()
  const existing = await readProfile(projectPath)
  const full: ProjectProfile = {
    version: 2,
    name: profile.name || path.basename(projectPath),
    description: profile.description || '',
    skills: Array.from(new Set(profile.skills.filter(isPlainSegment))),
    ides: validProjectIdes(profile.ides),
    createdAt: existing?.createdAt || profile.createdAt || now,
    updatedAt: now,
  }
  // `targetIde` keeps older Skill Studio versions able to read the file.
  await writeFileAtomic(path.join(projectPath, PROFILE_FILE), JSON.stringify({ ...full, targetIde: full.ides[0] ?? 'claude-code' }, null, 2))
  return full
}

export interface ConfiguredProject {
  name: string
  path: string
  profile: ProjectProfile
}

export interface CandidateProject {
  name: string
  path: string
  /** Agent skill dirs found in the folder, with entry counts. */
  dirs: { rel: string; entries: number; readBy: string[] }[]
  /** IDEs that would be selected on import (those whose dirs hold skills). */
  suggestedIdes: string[]
  /** Skill names found in those dirs. */
  skills: string[]
  /** Folder has a profile written automatically by an old version. */
  autoProfile: boolean
}

async function dedupeByRealPath<T extends { path: string }>(items: T[]): Promise<T[]> {
  const seen = new Set<string>()
  const out: T[] = []
  for (const it of items) {
    const real = await fs.realpath(it.path).catch(() => path.resolve(it.path))
    if (seen.has(real)) continue
    seen.add(real)
    out.push(it)
  }
  return out
}

/** Projects the user configured (has a confirmed profile), deduped by folder. */
export async function listConfiguredProjects(): Promise<ConfiguredProject[]> {
  const { discoverProjects } = await import('../scanner/discovery.js')
  const out: ConfiguredProject[] = []
  for (const p of await dedupeByRealPath(await discoverProjects())) {
    const r = await readRaw(p.path)
    if (!r || isUnconfirmedAuto(r.raw)) continue
    out.push({ name: r.profile.name, path: p.path, profile: r.profile })
  }
  return out
}

async function listSkillEntries(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink())).map((e) => e.name)
}

/** Discovered folders that look like projects but aren't configured yet. */
export async function listCandidateProjects(): Promise<CandidateProject[]> {
  const { discoverProjects } = await import('../scanner/discovery.js')
  const rels = allAgentProjectRelPaths()
  const out: CandidateProject[] = []
  for (const p of await dedupeByRealPath(await discoverProjects())) {
    const r = await readRaw(p.path)
    if (r && !isUnconfirmedAuto(r.raw)) continue
    const dirs: CandidateProject['dirs'] = []
    const skills = new Set<string>()
    for (const rel of rels) {
      const names = await listSkillEntries(path.join(p.path, rel))
      if (!names.length) continue
      names.forEach((n) => skills.add(n))
      dirs.push({ rel, entries: names.length, readBy: AGENTS.filter((a) => a.projectPaths.includes(rel)).map((a) => a.id) })
    }
    if (!dirs.length && !r) continue // nothing to manage here
    out.push({
      name: r?.profile.name ?? path.basename(p.path),
      path: p.path,
      dirs,
      suggestedIdes: suggestIdes(dirs.map((d) => d.rel), r?.profile.ides ?? []),
      skills: [...(r?.profile.skills ?? []), ...skills].filter((v, i, a) => a.indexOf(v) === i),
      autoProfile: !!r,
    })
  }
  return out
}

/**
 * Which IDEs to pre-select when importing: a dir that only one IDE reads
 * names that IDE; a shared dir (.agents/skills) alone doesn't (it would
 * select six IDEs) unless the old profile already named one.
 */
export function suggestIdes(rels: string[], fromProfile: string[]): string[] {
  const capable = projectCapableAgents()
  const picked = new Set(validProjectIdes(fromProfile))
  for (const rel of rels) {
    const readers = capable.filter((a) => a.projectPaths.includes(rel) || (a.projectLegacyPaths ?? []).includes(rel))
    if (readers.length === 1) picked.add(readers[0].id)
  }
  return [...picked]
}
