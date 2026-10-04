import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { parseSkillMd, listSkillFiles, getSkillMdPath } from './parser.js'
import { resolveSymlink, identifySource } from './symlink.js'
import { readSkillSource, parseGithubUrl, findSourceInManifests, type ManifestCache } from '../updater/source.js'
import { mapLimit } from '../utils/concurrency.js'
import {
  AGENTS,
  allAgentGlobalAbsPaths,
  allAgentProjectRelPaths,
  isValidAgentId,
  type AgentId,
} from './agents.js'
import { classifyAll } from './taxonomy.js'
import { detectSimilarSkills } from './similarity.js'
import { computeHealth } from './health.js'
import type { Skill, Project, ConflictGroup, ScanResult, ScanPathReport } from '../types.js'
import { readIdeSettingsFull } from '../settings.js'
import { analyzeSecurity } from './security.js'
import { checkSkillDrift } from './drift.js'
import { moveToTrash } from '../trash/store.js'

const homedir = os.homedir()

function makeId(p: string): string {
  return crypto.createHash('md5').update(p).digest('hex').slice(0, 12)
}

/**
 * YAML frontmatter can legitimately parse `name` / `description` / `model`
 * fields as non-string values (numbers, booleans, objects, arrays). If we let
 * those through, React renders them and throws error #31. Force-coerce every
 * value that the UI is going to render.
 */
function toSafeString(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(toSafeString).join(', ')
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v)
    } catch {
      return '[object]'
    }
  }
  return String(v)
}

function sanitizeFrontmatter(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fm)) {
    // Keep arrays/objects as-is for fields the UI treats as data (e.g. `paths`),
    // but coerce the ones we know get rendered as plain text.
    if (k === 'name' || k === 'description' || k === 'model' || k === 'effort' || k === 'agent' || k === 'context') {
      out[k] = toSafeString(v)
    } else {
      out[k] = v
    }
  }
  return out
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

/**
 * Per-scan shared state. Many agent directories link to the same physical
 * skills (a warehouse skill is typically seen 3–5 times per scan), so the
 * expensive per-skill work — reading and parsing SKILL.md, listing files,
 * the security scan, manifest lookups — is done once per real path.
 */
interface ScanContext {
  disabledSkills: Set<string>
  manifestCache: ManifestCache
  skillData: Map<string, Promise<SkillData | null>>
}

interface SkillData {
  frontmatter: Record<string, unknown>
  text: string
  files: string[]
  lastModified: string
  security: ReturnType<typeof analyzeSecurity>
  ownSource: any
}

function newScanContext(disabledSkills: Set<string>): ScanContext {
  return { disabledSkills, manifestCache: new Map(), skillData: new Map() }
}

async function loadSkillData(realPath: string): Promise<SkillData | null> {
  try {
    if (!(await fs.stat(realPath)).isDirectory()) return null
  } catch {
    return null
  }
  const skillMdPath = getSkillMdPath(realPath)
  const files = await listSkillFiles(realPath)
  // A SKILL.md that is itself a symlink isn't reported as a plain file.
  const skillMdExists = files.includes('SKILL.md') || (await fs.stat(skillMdPath).then((st) => st.isFile(), () => false))
  if (!skillMdExists && files.length === 0) return null

  let frontmatter: Record<string, unknown> = {}
  let text = ''
  let mtimePath = realPath
  if (skillMdExists) {
    mtimePath = skillMdPath
    try {
      const parsed = await parseSkillMd(skillMdPath)
      frontmatter = sanitizeFrontmatter(parsed.frontmatter as Record<string, unknown>)
      text = toSafeString(parsed.rawContent || parsed.content)
    } catch {}
  }
  let lastModified = new Date().toISOString()
  try {
    lastModified = (await fs.stat(mtimePath)).mtime.toISOString()
  } catch {}

  return {
    frontmatter,
    text,
    files,
    lastModified,
    security: analyzeSecurity(text),
    ownSource: await readSkillSource(realPath),
  }
}

async function scanSkillDir(
  skillDir: string,
  scope: 'global' | 'project' | 'plugin',
  agent: AgentId,
  ctx: ScanContext,
  projectName?: string,
  projectPath?: string,
): Promise<Skill[]> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(skillDir, { withFileTypes: true })
  } catch {
    return []
  }

  // Entries are independent: process a few at a time, keep the original order.
  const scanned = await mapLimit(entries, 8, async (entry): Promise<Skill | null> => {
    // Dot-entries directly inside a skills root are app bookkeeping, never
    // user skills. Examples found in the wild: Codex keeps its bundled
    // `.system/` skills there, TeleAgent keeps `.cache/`, WorkBuddy keeps
    // migration markers, and every agent picks up a stray `.DS_Store`.
    // Surfacing these as manageable skills is actively harmful — a user could
    // delete `.system/` and break the agent — so they are skipped entirely.
    if (entry.name.startsWith('.')) return null

    const entryPath = path.join(skillDir, entry.name)
    const symlinkInfo = await resolveSymlink(entryPath)
    const realPath = symlinkInfo.realPath

    let pending = ctx.skillData.get(realPath)
    if (!pending) ctx.skillData.set(realPath, (pending = loadSkillData(realPath)))
    const data = await pending
    if (!data) return null

    const fm = data.frontmatter as any
    const skillName = toSafeString(fm.name) || entry.name
    const description = toSafeString(fm.description)

    // Frontmatter `agent:` overrides the path-based guess when it's a known id.
    const fmAgent = toSafeString(fm.agent).toLowerCase().trim()
    const resolvedAgent: AgentId = fmAgent && isValidAgentId(fmAgent) ? fmAgent : agent

    // GitHub source: .skill-source on disk, else frontmatter `source:`, else
    // a skills.sh manifest. Derived in memory only — scanning never writes
    // into skill directories; explicit updater actions persist it.
    let githubSource: any = data.ownSource
    if (!githubSource && fm.source) {
      const parsed = parseGithubUrl(toSafeString(fm.source))
      if (parsed) githubSource = { owner: parsed.owner, repo: parsed.repo, branch: parsed.branch, subPath: parsed.subPath }
    } else if (!githubSource) {
      const found = await findSourceInManifests(skillName, realPath, projectPath, ctx.manifestCache)
      if (found) {
        githubSource = {
          owner: found.owner,
          repo: found.repo,
          branch: found.branch,
          subPath: found.subPath,
          installedCommit: found.installedCommit,
        }
      }
    }

    return {
      id: makeId(entryPath),
      name: skillName,
      description,
      scope,
      agent: resolvedAgent,
      source: symlinkInfo.isSymlink ? identifySource(realPath, homedir) : 'local',
      category: '', // populated later by classifyAll()
      path: entryPath,
      realPath,
      symlinkTarget: symlinkInfo.isSymlink ? symlinkInfo.target : undefined,
      projectName,
      projectPath,
      frontmatter: data.frontmatter as any,
      content: data.text,
      files: data.files,
      enabled: !ctx.disabledSkills.has(skillName),
      hasConflict: false,
      lastModified: data.lastModified,
      security: data.security,
      githubSource: githubSource ? { ...githubSource } : undefined,
    }
  })

  return scanned.filter((s): s is Skill => s !== null)
}

async function getDisabledSkills(): Promise<Set<string>> {
  const disabled = new Set<string>()
  const settingsPath = path.join(homedir, '.claude', 'settings.json')
  try {
    const raw = await fs.readFile(settingsPath, 'utf-8')
    const settings = JSON.parse(raw)
    const deny = settings?.permissions?.deny || []
    for (const rule of deny) {
      const match = rule.match(/^Skill\((.+)\)$/)
      if (match) disabled.add(match[1])
    }
  } catch {}
  return disabled
}

/**
 * Does `projectRoot` hold a skills profile or any agent's project skill dir?
 * When the caller already listed the directory, `entries` lets us answer
 * without touching disk for the (common) case of no agent marker at all.
 */
async function hasAnyAgentSkills(projectRoot: string, entries?: import('fs').Dirent[]): Promise<boolean> {
  const rels = allAgentProjectRelPaths()
  if (entries) {
    const names = new Set(entries.map((e) => e.name))
    if (names.has('.skills-profile.json')) return true
    const candidates = rels.filter((rel) => names.has(rel.split('/')[0]))
    if (candidates.length === 0) return false
    const hits = await Promise.all(candidates.map((rel) => dirExists(path.join(projectRoot, rel))))
    return hits.some(Boolean)
  }

  const profilePath = path.join(projectRoot, '.skills-profile.json')
  try {
    const s = await fs.stat(profilePath)
    if (s.isFile()) return true
  } catch {}
  const hits = await Promise.all(rels.map((rel) => dirExists(path.join(projectRoot, rel))))
  return hits.some(Boolean)
}

export async function getSavedProjects(): Promise<{ name: string; path: string }[]> {
  const storePath = path.join(homedir, '.config', 'skill-studio', 'projects.json')
  try {
    const raw = await fs.readFile(storePath, 'utf-8')
    const list = JSON.parse(raw)
    if (Array.isArray(list)) {
      return list.filter(p => p && typeof p.path === 'string')
    }
  } catch {}
  return []
}

export async function removeSavedProjectFromRegistry(projectPath: string): Promise<void> {
  const storePath = path.join(homedir, '.config', 'skill-studio', 'projects.json')
  try {
    const current = await getSavedProjects()
    const filtered = current.filter(p => path.resolve(p.path) !== path.resolve(projectPath))
    await fs.writeFile(storePath, JSON.stringify(filtered, null, 2), 'utf-8')
  } catch {}
}

export async function getExcludedProjects(): Promise<string[]> {
  const storePath = path.join(homedir, '.config', 'skill-studio', 'excluded-projects.json')
  try {
    const raw = await fs.readFile(storePath, 'utf-8')
    const list = JSON.parse(raw)
    if (Array.isArray(list)) {
      return list.filter(p => typeof p === 'string').map(p => path.resolve(p))
    }
  } catch {}
  return []
}

export async function addExcludedProject(projectPath: string): Promise<void> {
  const storeDir = path.join(homedir, '.config', 'skill-studio')
  const storePath = path.join(storeDir, 'excluded-projects.json')
  await fs.mkdir(storeDir, { recursive: true })
  
  const target = path.resolve(projectPath)
  const current = await getExcludedProjects()
  if (!current.includes(target)) {
    current.push(target)
    await fs.writeFile(storePath, JSON.stringify(current, null, 2), 'utf-8')
  }

  await removeSavedProjectFromRegistry(projectPath)
}

export async function removeExcludedProject(projectPath: string): Promise<void> {
  const storePath = path.join(homedir, '.config', 'skill-studio', 'excluded-projects.json')
  try {
    const target = path.resolve(projectPath)
    const current = await getExcludedProjects()
    const filtered = current.filter(p => p !== target)
    await fs.writeFile(storePath, JSON.stringify(filtered, null, 2), 'utf-8')
  } catch {}
}

export async function purgeProjectSkillsAndProfile(projectPath: string): Promise<void> {
  const targetPath = path.resolve(projectPath)
  
  // 1. Delete .skills-profile.json
  const profilePath = path.join(targetPath, '.skills-profile.json')
  try {
    await fs.unlink(profilePath)
  } catch {}

  // 2. Clear agent skill directories in the project. Symlinks are unlinked;
  //    real skill directories (the user's own work) go to the recycle bin
  //    instead of the old `rm -rf` of every agent skills dir.
  for (const rel of allAgentProjectRelPaths()) {
    const skillDir = path.join(targetPath, rel)
    let st
    try {
      st = await fs.lstat(skillDir)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) {
      await fs.unlink(skillDir).catch(() => {})
      continue
    }
    if (!st.isDirectory()) continue
    const entries = await fs.readdir(skillDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const entryPath = path.join(skillDir, entry.name)
      try {
        if (entry.isSymbolicLink()) await fs.unlink(entryPath)
        else if (entry.isDirectory() && !entry.name.startsWith('.')) await moveToTrash(entryPath, entry.name)
      } catch (err: any) {
        console.error(`[purgeProject] Failed to clear ${entryPath}:`, err?.message || err)
      }
    }
  }
}

async function discoverProjectsRecursively(
  dir: string,
  maxDepth: number,
  currentDepth = 0
): Promise<{ name: string; path: string }[]> {
  const projects: { name: string; path: string }[] = []
  if (currentDepth > maxDepth) return projects

  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return projects
  }

  if (dir !== homedir && (await hasAnyAgentSkills(dir, entries))) {
    projects.push({
      name: path.basename(dir),
      path: dir,
    })
  }

  // Hidden directories are never project roots worth descending into: agent
  // markers (.claude, .agents, …) are checked directly on each candidate by
  // hasAnyAgentSkills(). Skipping them avoids walking .git internals, caches,
  // Obsidian vaults' .obsidian, etc.
  const subdirs = entries.filter((entry) => {
    if (!entry.isDirectory()) return false
    const name = entry.name
    return !(
      name.startsWith('.') ||
      name === 'node_modules' ||
      name === 'dist' ||
      name === 'build' ||
      (currentDepth > 0 && name === 'Library')
    )
  })
  const nested = await mapLimit(subdirs, 8, (entry) =>
    discoverProjectsRecursively(path.join(dir, entry.name), maxDepth, currentDepth + 1),
  )
  for (const sub of nested) projects.push(...sub)

  return projects
}

export async function discoverProjects(): Promise<{ name: string; path: string }[]> {
  const projects: { name: string; path: string }[] = []

  // 0. Saved custom projects in ~/.config/skill-studio/projects.json
  const savedProjs = await getSavedProjects()
  for (const p of savedProjs) {
    if (await dirExists(p.path)) {
      if (!projects.some((existing) => existing.path === p.path)) {
        projects.push(p)
      }
    }
  }

  // 1. ~/.claude/projects/ (mangled path dirs — Claude tracks projects it's been opened in)
  const projectsDir = path.join(homedir, '.claude', 'projects')
  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const projectPath = entry.name.replace(/^-/, '/').replace(/-/g, '/')
      if (await dirExists(projectPath)) {
        if (projectPath === homedir) continue
        if (await hasAnyAgentSkills(projectPath)) {
          if (!projects.some((p) => p.path === projectPath)) {
            projects.push({
              name: path.basename(projectPath),
              path: projectPath,
            })
          }
        }
      }
    }
  } catch {}

  // 1.5. ~/.gemini/projects.json (Antigravity tracks projects opened in it)
  const geminiProjectsFile = path.join(homedir, '.gemini', 'projects.json')
  try {
    const raw = await fs.readFile(geminiProjectsFile, 'utf-8')
    const parsed = JSON.parse(raw)
    const geminiProjects = parsed?.projects && typeof parsed.projects === 'object' ? Object.keys(parsed.projects) : []
    for (let projectPath of geminiProjects) {
      if (typeof projectPath !== 'string' || !projectPath.trim()) continue
      projectPath = path.resolve(projectPath.trim())
      if (projectPath === homedir || projectPath === path.dirname(homedir)) continue
      
      if (await dirExists(projectPath)) {
        if (!projects.some((p) => p.path === projectPath)) {
          projects.push({
            name: path.basename(projectPath),
            path: projectPath,
          })
        }
      }
    }
  } catch {}

  // 1.6. ~/.codex/config.toml (Codex tracks projects opened/trusted in it)
  const codexConfigFile = path.join(homedir, '.codex', 'config.toml')
  try {
    const raw = await fs.readFile(codexConfigFile, 'utf-8')
    const matches = raw.matchAll(/\[projects\."([^"]+)"\]/g)
    for (const match of matches) {
      let projectPath = match[1]
      if (typeof projectPath !== 'string' || !projectPath.trim()) continue
      projectPath = path.resolve(projectPath.trim())
      if (projectPath === homedir || projectPath === path.dirname(homedir)) continue

      if (await dirExists(projectPath)) {
        if (!projects.some((p) => p.path === projectPath)) {
          projects.push({
            name: path.basename(projectPath),
            path: projectPath,
          })
        }
      }
    }
  } catch {}

  // 1.7. ~/.zcode/v2/setting.json (ZCode tracks recent projects opened in it)
  const zcodeSettingFile = path.join(homedir, '.zcode', 'v2', 'setting.json')
  try {
    const raw = await fs.readFile(zcodeSettingFile, 'utf-8')
    const parsed = JSON.parse(raw)
    const recentProjects = Array.isArray(parsed?.recentProjects) ? parsed.recentProjects : []
    for (let projectPath of recentProjects) {
      if (typeof projectPath !== 'string' || !projectPath.trim()) continue
      projectPath = path.resolve(projectPath.trim())
      if (projectPath === homedir || projectPath === path.dirname(homedir)) continue

      if (await dirExists(projectPath)) {
        if (!projects.some((p) => p.path === projectPath)) {
          projects.push({
            name: path.basename(projectPath),
            path: projectPath,
          })
        }
      }
    }
  } catch {}

  // 2. Common project root dirs — light recursive scan (depth 3)
  const commonDirs = [
    path.join(homedir, 'Documents'),
    path.join(homedir, 'Projects'),
    path.join(homedir, 'Developer'),
    path.join(homedir, 'Code'),
    path.join(homedir, 'code'),
    path.join(homedir, 'workspace'),
    path.join(homedir, 'dev'),
    path.join(homedir, 'Dev'),
    path.join(homedir, 'work'),
    path.join(homedir, 'repos'),
    path.join(homedir, 'src'),
  ]

  for (const dir of commonDirs) {
    if (await dirExists(dir)) {
      try {
        const found = await discoverProjectsRecursively(dir, 3)
        for (const proj of found) {
          if (!projects.some((p) => p.path === proj.path)) {
            projects.push(proj)
          }
        }
      } catch {}
    }
  }

  // 3. CWD + walk up 3 levels — skip the user's home directory, whose
  //    `.claude/skills/` etc. are the *global* paths, not project paths.
  //    Running `skill-hub` from home otherwise causes every global skill to
  //    be double-counted as "lhc (cwd)/<agent>" in the scan report.
  let cwd = process.cwd()
  for (let i = 0; i < 4; i++) {
    if (cwd !== homedir && (await hasAnyAgentSkills(cwd))) {
      if (!projects.some((p) => p.path === cwd)) {
        projects.push({ name: path.basename(cwd) + ' (cwd)', path: cwd })
      }
    }
    const parent = path.dirname(cwd)
    if (parent === cwd) break
    cwd = parent
  }

  const excluded = await getExcludedProjects()
  return projects.filter(p => !excluded.includes(path.resolve(p.path)))
}

export async function saveProjectToRegistry(projectPath: string, name?: string): Promise<void> {
  const storeDir = path.join(homedir, '.config', 'skill-studio')
  const storePath = path.join(storeDir, 'projects.json')
  await fs.mkdir(storeDir, { recursive: true })
  
  const current = await getSavedProjects()
  const projName = name || path.basename(projectPath)
  if (!current.some(p => path.resolve(p.path) === path.resolve(projectPath))) {
    current.push({ name: projName, path: projectPath })
    await fs.writeFile(storePath, JSON.stringify(current, null, 2), 'utf-8')
  }

  // If it was excluded before, auto remove from excluded list
  await removeExcludedProject(projectPath)
}

/**
 * Find every `skills/` directory that belongs to a plugin the user has
 * actually enabled.
 *
 * Claude Code tracks enabled plugins in ~/.claude/plugins/config.json under
 * `repositories`. Anything living only under ~/.claude/plugins/marketplaces/
 * is a *candidate* from a marketplace — Claude Code does not load those, they
 * are just the source catalog. Earlier versions of this scanner walked the
 * entire plugins/ tree and reported those candidates as installed plugin
 * skills, which was very confusing for users who had never enabled a plugin.
 */
async function discoverPluginSkillDirs(): Promise<string[]> {
  const result: string[] = []
  const pluginsRoot = path.join(homedir, '.claude', 'plugins')
  const configPath = path.join(pluginsRoot, 'config.json')

  // Extract installLocation of every enabled plugin.
  const installLocations: string[] = []
  try {
    const raw = await fs.readFile(configPath, 'utf-8')
    const config = JSON.parse(raw) as { repositories?: Record<string, unknown> }
    const repos = config?.repositories || {}
    for (const meta of Object.values(repos)) {
      if (meta && typeof meta === 'object') {
        const loc = (meta as { installLocation?: unknown }).installLocation
        if (typeof loc === 'string' && loc.length > 0) {
          installLocations.push(loc)
        }
      }
    }
  } catch {}

  // No plugins enabled → nothing to scan. Skip the marketplace catalog entirely.
  if (installLocations.length === 0) return result

  async function walk(dir: string, depth: number) {
    if (depth > 4) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue
      const sub = path.join(dir, entry.name)
      if (entry.name === 'skills') {
        result.push(sub)
        continue
      }
      await walk(sub, depth + 1)
    }
  }

  // Only walk inside each enabled plugin's install location, not the whole
  // plugins/ tree.
  for (const loc of installLocations) {
    if (await dirExists(loc)) {
      await walk(loc, 0)
    }
  }

  return result
}

function detectConflicts(skills: Skill[]): ConflictGroup[] {
  const byName = new Map<string, Skill[]>()
  for (const skill of skills) {
    const existing = byName.get(skill.name) || []
    existing.push(skill)
    byName.set(skill.name, existing)
  }

  const conflicts: ConflictGroup[] = []
  for (const [name, group] of byName) {
    if (group.length > 1) {
      // Same-name entries that resolve to the same physical path are symlinks
      // pointing at one shared skill — not a real conflict.
      const realPaths = new Set(group.map((s) => s.realPath))
      if (realPaths.size <= 1) continue
      group.forEach((s) => (s.hasConflict = true))
      conflicts.push({ name, skills: group })
    }
  }
  return conflicts
}

function parseExtraPaths(): string[] {
  const raw = process.env.SKILL_HUB_EXTRA_PATHS
  if (!raw) return []
  return raw
    .split(/[:,]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.startsWith('~') ? path.join(homedir, p.slice(1)) : p))
}

/**
 * Coalesce concurrent scans: callers that arrive while a scan is running get
 * that scan's result — unless something changed on disk since it started
 * (markScanDirty), in which case a fresh scan runs.
 */
let scanGeneration = 0
let inflight: { gen: number; promise: Promise<ScanResult> } | null = null

export function markScanDirty(): void {
  scanGeneration++
}

export function fullScan(): Promise<ScanResult> {
  if (inflight && inflight.gen === scanGeneration) return inflight.promise
  const gen = scanGeneration
  const promise = runFullScan().finally(() => {
    if (inflight?.promise === promise) inflight = null
  })
  inflight = { gen, promise }
  return promise
}

async function runFullScan(): Promise<ScanResult> {
  const start = Date.now()
  const timings: Record<string, number> = {}
  let phaseStart = start
  const mark = (phase: string) => {
    const now = Date.now()
    timings[phase] = (timings[phase] ?? 0) + (now - phaseStart)
    phaseStart = now
  }
  const ctx = newScanContext(await getDisabledSkills())
  const allSkills: Skill[] = []
  const scannedPaths: ScanPathReport[] = []

  interface ScanTask {
    label: string
    dir: string
    scope: 'global' | 'project' | 'plugin'
    agent: AgentId
    projectName?: string
    projectPath?: string
    warehouse?: boolean
  }

  /**
   * Scan many skill directories concurrently, then merge results in task
   * order: dedupe below is first-wins, so ordering must stay deterministic.
   */
  async function runTasks(tasks: ScanTask[]): Promise<Skill[][]> {
    const results = await mapLimit(tasks, 6, async (t) => {
      if (!(await dirExists(t.dir))) return { skills: [] as Skill[], report: { label: t.label, path: t.dir, exists: false, count: 0 } }
      try {
        const skills = await scanSkillDir(t.dir, t.scope, t.agent, ctx, t.projectName, t.projectPath)
        if (t.warehouse) for (const ws of skills) ws.isWarehouseSource = true
        return { skills, report: { label: t.label, path: t.dir, exists: true, count: skills.length } }
      } catch (e: any) {
        return { skills: [] as Skill[], report: { label: t.label, path: t.dir, exists: true, count: 0, error: e?.message || String(e) } }
      }
    })
    for (const r of results) {
      scannedPaths.push(r.report)
      allSkills.push(...r.skills)
    }
    return results.map((r) => r.skills)
  }

  const settings = await readIdeSettingsFull()
  const warehouseDirs = new Set<string>()
  if (settings.customGlobalSkillsDir) warehouseDirs.add(path.resolve(settings.customGlobalSkillsDir))
  for (const w of settings.skillWarehouses ?? []) {
    if (w && typeof w === 'string') warehouseDirs.add(path.resolve(w))
  }

  // 0. Warehouses first: they are the canonical copies for dedupe.
  await runTasks(
    [...warehouseDirs].map((dir) => ({
      label: `warehouse:${path.basename(dir)}`,
      dir,
      scope: 'global' as const,
      agent: 'universal' as AgentId,
      warehouse: true,
    })),
  )
  mark('warehouses')

  // 1. Global skills — every agent's global paths
  await runTasks(
    allAgentGlobalAbsPaths(homedir).map(({ agent, path: dir }) => ({
      label: `global:${agent.id}`,
      dir,
      scope: 'global' as const,
      agent: agent.id,
    })),
  )
  mark('globals')

  // 2. Plugin skills — Claude Code only for now
  const pluginRoot = path.join(homedir, '.claude', 'plugins')
  await runTasks(
    (await discoverPluginSkillDirs()).map((dir) => ({
      label: `plugin:${path.relative(pluginRoot, dir)}`,
      dir,
      scope: 'plugin' as const,
      agent: 'claude-code' as AgentId,
    })),
  )
  mark('plugins')

  // 3. Project skills — for each project, scan every agent's project paths
  const discoveredProjects = await discoverProjects()
  mark('discoverProjects')
  const projectTasks: (ScanTask & { projIndex: number })[] = []
  discoveredProjects.forEach((proj, projIndex) => {
    for (const agent of AGENTS) {
      for (const rel of agent.projectPaths) {
        projectTasks.push({
          label: `project:${proj.name}:${agent.id}`,
          dir: path.join(proj.path, rel),
          scope: 'project',
          agent: agent.id,
          projectName: proj.name,
          projectPath: proj.path,
          projIndex,
        })
      }
    }
  })
  const projectResults = await runTasks(projectTasks)
  const projectTotals = new Array(discoveredProjects.length).fill(0)
  projectResults.forEach((skills, i) => (projectTotals[projectTasks[i].projIndex] += skills.length))
  const projects: Project[] = discoveredProjects.map((proj, i) => ({ name: proj.name, path: proj.path, skillCount: projectTotals[i] }))
  mark('projects')

  // 4. Extra paths from SKILL_HUB_EXTRA_PATHS — agent unknown
  await runTasks(
    parseExtraPaths().map((dir) => ({ label: `extra:${path.basename(dir)}`, dir, scope: 'project' as const, agent: 'unknown' as AgentId })),
  )

  // Deduplicate by realPath & originPath (supports symlinks and materialized copy markers)
  const seenByRealPath = new Map<string, Skill>()
  const seenByName = new Map<string, Skill>()

  // Pass 1: Index primary master skills (non-copies or global skills)
  for (const s of allSkills) {
    const originPath = s.githubSource?.originPath
    if (!originPath) {
      if (!seenByRealPath.has(s.realPath)) {
        seenByRealPath.set(s.realPath, s)
      }
      if (!seenByName.has(s.name)) {
        seenByName.set(s.name, s)
      }
    }
  }

  // Pass 2: Merge skills into main skills or add new master skills
  for (const s of allSkills) {
    s.linkedIdes = s.linkedIdes || []
    s.linkedProjects = s.linkedProjects || []

    const originPath = s.githubSource?.originPath
    let mainSkill: Skill | undefined

    if (originPath && seenByRealPath.has(originPath)) {
      mainSkill = seenByRealPath.get(originPath)
    } else if (seenByRealPath.has(s.realPath)) {
      mainSkill = seenByRealPath.get(s.realPath)
    } else if (originPath && seenByName.has(s.name)) {
      mainSkill = seenByName.get(s.name)
    }

    if (mainSkill && mainSkill !== s) {
      const isCopy = !!originPath
      let hasDrift = false
      if (isCopy) {
        hasDrift = await checkSkillDrift(mainSkill.realPath, s.realPath)
        if (hasDrift) {
          mainSkill.hasDrift = true
        }
      }

      if (s.scope === 'global' && s.agent !== 'universal') {
        if (!mainSkill.linkedIdes) mainSkill.linkedIdes = []
        if (!mainSkill.linkedIdes.includes(s.agent)) {
          mainSkill.linkedIdes.push(s.agent)
        }
      } else if (s.scope === 'project' && s.projectName && s.projectPath) {
        if (!mainSkill.linkedProjects) mainSkill.linkedProjects = []
        if (!mainSkill.linkedProjects.some((p) => p.path === s.projectPath)) {
          mainSkill.linkedProjects.push({
            name: s.projectName,
            path: s.projectPath,
            agentId: s.agent,
            isCopy,
            hasDrift,
          })
        }
      }
      continue
    }

    if (s.scope === 'global' && s.agent !== 'universal') {
      s.linkedIdes.push(s.agent)
    } else if (s.scope === 'project' && s.projectName && s.projectPath) {
      s.linkedProjects.push({
        name: s.projectName,
        path: s.projectPath,
        agentId: s.agent,
        isCopy: !!originPath,
      })
    }

    seenByRealPath.set(s.realPath, s)
    seenByName.set(s.name, s)
  }

  const dedupedSkills: Skill[] = Array.from(new Set(seenByRealPath.values()))
  mark('dedupe+drift')

  // isGlobalActive: the skill is in the distribution state's global set.
  try {
    const raw = await fs.readFile(path.join(homedir, '.config', 'skill-studio', 'distribution.json'), 'utf-8')
    const globalNames = new Set<string>(Array.isArray(JSON.parse(raw)?.globalSet) ? JSON.parse(raw).globalSet : [])
    for (const s of dedupedSkills) {
      if (globalNames.has(s.name)) s.isGlobalActive = true
    }
  } catch {}

  const conflicts = detectConflicts(dedupedSkills)
  mark('globalSet+conflicts')

  // Classify skills into categories + generate merge suggestions
  const { skills: classifiedSkills, categories, mergeSuggestions, byCategory } =
    classifyAll(dedupedSkills)

  mark('classify')
  // Similarity detection (used by health check)
  const similarGroups = detectSimilarSkills(classifiedSkills)
  mark('similarity')

  // Health diagnostics
  const health = computeHealth(
    classifiedSkills,
    conflicts,
    similarGroups,
    categories,
    mergeSuggestions,
  )

  mark('health')
  const bySource: Record<string, number> = {}
  const byAgent: Record<string, number> = {}
  for (const s of classifiedSkills) {
    bySource[s.source] = (bySource[s.source] || 0) + 1
    byAgent[s.agent] = (byAgent[s.agent] || 0) + 1
  }

  // Scanning is read-only. It used to link every discovered skill into every
  // enabled agent here; distribution is now an explicit plan → apply step
  // (server/distribution/reconcile.ts).

  return {
    skills: classifiedSkills,
    projects,
    conflicts,
    categories,
    mergeSuggestions,
    health,
    stats: {
      total: classifiedSkills.length,
      global: classifiedSkills.filter((s) => s.scope === 'global').length,
      project: classifiedSkills.filter((s) => s.scope === 'project').length,
      bySource,
      byAgent,
      byCategory,
    },
    scannedPaths,
    durationMs: Date.now() - start,
    timings,
  }
}
