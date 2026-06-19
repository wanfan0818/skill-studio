import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { parseSkillMd, listSkillFiles, getSkillMdPath } from './parser.js'
import { resolveSymlink, identifySource } from './symlink.js'
import { readSkillSource, writeSkillSource, parseGithubUrl, findSourceInManifests } from '../updater/source.js'
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
import {
  isSyncingSymlinks,
  setSyncingSymlinks,
  ensureEnabledIdesSymlinks,
  readIdeSettingsFull,
} from '../routes/manage.js'
import { analyzeSecurity } from './security.js'

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

async function scanSkillDir(
  skillDir: string,
  scope: 'global' | 'project' | 'plugin',
  agent: AgentId,
  projectName?: string,
  projectPath?: string,
  disabledSkills?: Set<string>,
): Promise<Skill[]> {
  const skills: Skill[] = []

  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(skillDir, { withFileTypes: true })
  } catch {
    return skills
  }

  for (const entry of entries) {
    const entryPath = path.join(skillDir, entry.name)

    const symlinkInfo = await resolveSymlink(entryPath)
    const realPath = symlinkInfo.realPath

    let isDir = false
    try {
      const stat = await fs.stat(realPath)
      isDir = stat.isDirectory()
    } catch {
      continue
    }

    if (!isDir) continue

    const skillMdPath = getSkillMdPath(realPath)
    let skillMdExists = false
    try {
      await fs.access(skillMdPath)
      skillMdExists = true
    } catch {}

    if (!skillMdExists) {
      const files = await listSkillFiles(realPath)
      if (files.length === 0) continue
    }

    let frontmatter = {}
    let content = ''
    let rawContent = ''

    if (skillMdExists) {
      try {
        const parsed = await parseSkillMd(skillMdPath)
        frontmatter = parsed.frontmatter
        content = parsed.content
        rawContent = parsed.rawContent
      } catch {}
    }

    const files = await listSkillFiles(realPath)
    const source = symlinkInfo.isSymlink
      ? identifySource(realPath, homedir)
      : 'local'

    let lastModified = new Date().toISOString()
    try {
      const stat = await fs.stat(skillMdExists ? skillMdPath : realPath)
      lastModified = stat.mtime.toISOString()
    } catch {}

    const safeFrontmatter = sanitizeFrontmatter(frontmatter as Record<string, unknown>)
    const skillName = toSafeString((safeFrontmatter as any).name) || entry.name
    const description = toSafeString((safeFrontmatter as any).description)

    // Frontmatter `agent:` overrides the path-based guess when it's a known id.
    const fmAgent = toSafeString((safeFrontmatter as any).agent).toLowerCase().trim()
    const resolvedAgent: AgentId = fmAgent && isValidAgentId(fmAgent) ? fmAgent : agent

    // Read githubSource
    let githubSource: any = await readSkillSource(realPath)
    if (!githubSource) {
      if ((safeFrontmatter as any).source) {
        const parsed = parseGithubUrl(toSafeString((safeFrontmatter as any).source))
        if (parsed) {
          githubSource = {
            owner: parsed.owner,
            repo: parsed.repo,
            branch: parsed.branch,
            subPath: parsed.subPath,
            installedAt: new Date().toISOString()
          }
          try {
            await writeSkillSource(realPath, githubSource)
          } catch (err) {
            console.error(`Failed to automatically write .skill-source for ${skillName}:`, err)
          }
        }
      } else {
        // Fallback to checking skills.json or skills-lock.json (for skills installed via skills.sh)
        const found = await findSourceInManifests(skillName, realPath, projectPath)
        if (found) {
          githubSource = {
            owner: found.owner,
            repo: found.repo,
            branch: found.branch,
            subPath: found.subPath,
            installedCommit: found.installedCommit,
            installedAt: new Date().toISOString()
          }
          try {
            await writeSkillSource(realPath, githubSource)
          } catch (err) {
            console.error(`Failed to automatically write .skill-source from manifest for ${skillName}:`, err)
          }
        }
      }
    }

    skills.push({
      id: makeId(entryPath),
      name: skillName,
      description,
      scope,
      agent: resolvedAgent,
      source,
      category: '', // populated later by classifyAll()
      path: entryPath,
      realPath,
      symlinkTarget: symlinkInfo.isSymlink ? symlinkInfo.target : undefined,
      projectName,
      projectPath,
      frontmatter: safeFrontmatter as any,
      content: toSafeString(rawContent || content),
      files,
      enabled: disabledSkills ? !disabledSkills.has(skillName) : true,
      hasConflict: false,
      lastModified,
      security: analyzeSecurity(toSafeString(rawContent || content)),
      githubSource: githubSource || undefined,
    })
  }

  return skills
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

async function hasAnyAgentSkills(projectRoot: string): Promise<boolean> {
  for (const rel of allAgentProjectRelPaths()) {
    if (await dirExists(path.join(projectRoot, rel))) return true
  }
  return false
}

async function discoverProjectsRecursively(
  dir: string,
  maxDepth: number,
  currentDepth = 0
): Promise<{ name: string; path: string }[]> {
  const projects: { name: string; path: string }[] = []
  if (currentDepth > maxDepth) return projects

  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return projects
  }

  if (dir !== homedir && await hasAnyAgentSkills(dir)) {
    projects.push({
      name: path.basename(dir),
      path: dir,
    })
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    if (
      name === 'node_modules' ||
      name === '.git' ||
      name === 'dist' ||
      name === 'build' ||
      (currentDepth > 0 && name === 'Library')
    ) {
      continue
    }
    const subPath = path.join(dir, name)
    const subProjects = await discoverProjectsRecursively(subPath, maxDepth, currentDepth + 1)
    projects.push(...subProjects)
  }

  return projects
}

export async function discoverProjects(): Promise<{ name: string; path: string }[]> {
  const projects: { name: string; path: string }[] = []

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
          projects.push({
            name: path.basename(projectPath),
            path: projectPath,
          })
        }
      }
    }
  } catch {}

  // 2. Common project root dirs — expanded list with CloudStorage & deep recursive scan
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
    path.join(homedir, 'Library', 'CloudStorage'),
  ]

  for (const dir of commonDirs) {
    if (await dirExists(dir)) {
      try {
        const found = await discoverProjectsRecursively(dir, 7)
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

  return projects
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
    let entries: Awaited<ReturnType<typeof fs.readdir>>
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

export async function fullScan(): Promise<ScanResult> {
  const start = Date.now()
  const disabledSkills = await getDisabledSkills()
  const allSkills: Skill[] = []
  const scannedPaths: ScanPathReport[] = []

  async function scanAndReport(
    label: string,
    dir: string,
    scope: 'global' | 'project' | 'plugin',
    agent: AgentId,
    projectName?: string,
    projectPath?: string,
  ) {
    const exists = await dirExists(dir)
    if (!exists) {
      scannedPaths.push({ label, path: dir, exists: false, count: 0 })
      return []
    }
    try {
      const skills = await scanSkillDir(dir, scope, agent, projectName, projectPath, disabledSkills)
      scannedPaths.push({ label, path: dir, exists: true, count: skills.length })
      return skills
    } catch (e: any) {
      scannedPaths.push({
        label,
        path: dir,
        exists: true,
        count: 0,
        error: e?.message || String(e),
      })
      return []
    }
  }

  const settings = await readIdeSettingsFull()
  if (settings.customGlobalSkillsDir) {
    allSkills.push(
      ...(await scanAndReport('global:custom', settings.customGlobalSkillsDir, 'global', 'universal')),
    )
  }

  // 1. Global skills — loop over every agent's global paths
  for (const { agent, path: globalDir } of allAgentGlobalAbsPaths(homedir)) {
    allSkills.push(
      ...(await scanAndReport(`global:${agent.id}`, globalDir, 'global', agent.id)),
    )
  }

  // 2. Plugin skills — Claude Code only for now
  const pluginSkillDirs = await discoverPluginSkillDirs()
  for (const pluginDir of pluginSkillDirs) {
    const pluginName = path.relative(path.join(homedir, '.claude', 'plugins'), pluginDir)
    allSkills.push(
      ...(await scanAndReport(`plugin:${pluginName}`, pluginDir, 'plugin', 'claude-code')),
    )
  }

  // 3. Project skills — for each project, scan every agent's project paths
  const discoveredProjects = await discoverProjects()
  const projects: Project[] = []

  for (const proj of discoveredProjects) {
    let projectTotal = 0
    for (const agent of AGENTS) {
      for (const rel of agent.projectPaths) {
        const skillsDir = path.join(proj.path, rel)
        const projectSkills = await scanAndReport(
          `project:${proj.name}:${agent.id}`,
          skillsDir,
          'project',
          agent.id,
          proj.name,
          proj.path,
        )
        allSkills.push(...projectSkills)
        projectTotal += projectSkills.length
      }
    }
    projects.push({
      name: proj.name,
      path: proj.path,
      skillCount: projectTotal,
    })
  }

  // 4. Extra paths from SKILL_HUB_EXTRA_PATHS — agent unknown
  for (const extra of parseExtraPaths()) {
    allSkills.push(
      ...(await scanAndReport(`extra:${path.basename(extra)}`, extra, 'project', 'unknown')),
    )
  }

  // Deduplicate by realPath (symlinks can point to the same skill from multiple roots)
  const seen = new Set<string>()
  const dedupedSkills: Skill[] = []
  for (const s of allSkills) {
    if (seen.has(s.realPath)) continue
    seen.add(s.realPath)
    dedupedSkills.push(s)
  }

  const conflicts = detectConflicts(dedupedSkills)

  // Classify skills into categories + generate merge suggestions
  const { skills: classifiedSkills, categories, mergeSuggestions, byCategory } =
    classifyAll(dedupedSkills)

  // Similarity detection (used by health check)
  const similarGroups = detectSimilarSkills(classifiedSkills)

  // Health diagnostics
  const health = computeHealth(
    classifiedSkills,
    conflicts,
    similarGroups,
    categories,
    mergeSuggestions,
  )

  const bySource: Record<string, number> = {}
  const byAgent: Record<string, number> = {}
  for (const s of classifiedSkills) {
    bySource[s.source] = (bySource[s.source] || 0) + 1
    byAgent[s.agent] = (byAgent[s.agent] || 0) + 1
  }

  // Auto-sync enabled IDEs symlinks to keep them in sync on scanning
  if (!isSyncingSymlinks) {
    try {
      await ensureEnabledIdesSymlinks(classifiedSkills)
    } catch (err) {
      console.error('Failed to auto-sync enabled IDE symlinks during scan:', err)
    }
  }

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
  }
}
