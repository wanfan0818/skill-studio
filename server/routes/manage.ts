import type { FastifyInstance } from 'fastify'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { invalidateCache, findKnownSkill } from './skills.js'
import { isInside, isPlainSegment, readJsonFile, writeFileAtomic } from '../utils/safe.js'
import { createSnapshot } from '../versioning/store.js'
import { moveToTrash } from '../trash/store.js'
import { AGENTS, agentGlobalPaths } from '../scanner/agents.js'
import { discoverProjects, fullScan } from '../scanner/discovery.js'
import { readIdeSettingsFull, writeIdeSettingsFull, getWarehouseDirs, type AppSettings } from '../settings.js'
import { readDistribution, updateDistribution, setSkillForAgent, desiredNames } from '../distribution/state.js'
import { inspect, plan } from '../distribution/reconcile.js'
import { withWriteLock } from '../distribution/lock.js'
import { applyScoped, distributableAgents, setSkillAgents, skillDistributionStatus } from './distribution.js'

const homedir = os.homedir()
const settingsPath = path.join(homedir, '.claude', 'settings.json')

// App settings moved to ../settings.ts; re-exported for existing importers.
export { readIdeSettingsFull, writeIdeSettingsFull }
export type { AppSettings }

/**
 * Move a real skill directory that sits inside an agent's global dir into the
 * warehouse and leave a symlink in its place, so the agent keeps working and
 * the skill becomes distributable. If the agent has a distribution rule that
 * would not include the skill, it is added to that agent's `include` so the
 * next apply doesn't unlink it.
 */
async function adoptIntoWarehouse(entryPath: string, warehouse: string): Promise<string> {
  const name = path.basename(entryPath)
  let dest = path.join(warehouse, name)
  try {
    await fs.access(dest)
    dest = path.join(warehouse, `${name}_adopted_${Date.now()}`)
  } catch {}
  await fs.mkdir(warehouse, { recursive: true })
  try {
    await fs.rename(entryPath, dest)
  } catch {
    await copyDir(entryPath, dest)
    await moveToTrash(entryPath, name)
  }
  await fs.symlink(dest, entryPath, 'dir')
  return dest
}

/**
 * Claude Code's own ~/.claude/settings.json. Missing → {}. Anything else that
 * fails (bad JSON, permissions) throws: writing `{ permissions }` back over a
 * file we could not parse would wipe the user's hooks, env, model, etc.
 */
async function readSettings(): Promise<any> {
  return (await readJsonFile<any>(settingsPath)) ?? {}
}

async function writeSettings(settings: any): Promise<void> {
  await writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2))
}


async function copyDirRecursive(src: string, dest: string) {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath)
    } else {
      await fs.copyFile(srcPath, destPath)
    }
  }
}

/** A physical copy Skill Studio materialized (Antigravity mode) carries this marker. */
async function isManagedCopy(dir: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(dir, '.skill-source'), 'utf-8'))
    return typeof marker?.originPath === 'string' && marker.originPath.length > 0
  } catch {
    return false
  }
}

export interface ProjectSyncResult {
  /** Entries left untouched because a real, user-owned directory is in the way. */
  conflicts: string[]
}

/**
 * Bring a project's agent skill directories in line with its .skills-profile.json.
 *
 * Safety rules (each one was a real data-loss bug before):
 *   - A real directory is NEVER deleted or overwritten. Only symlinks and
 *     physical copies carrying our `.skill-source` marker are "managed".
 *   - A skill that physically lives inside the target directory is left alone
 *     (it used to be rm'd and then "copied from itself" → gone).
 *   - Managed entries that are removed go to the recycle bin, not `rm -rf`.
 */
export async function syncProjectSkills(
  projectPath: string,
  skillsMap: Map<string, any>,
): Promise<ProjectSyncResult> {
  const result: ProjectSyncResult = { conflicts: [] }
  const profilePath = path.join(projectPath, '.skills-profile.json')
  let profile: any
  try {
    profile = JSON.parse(await fs.readFile(profilePath, 'utf-8'))
  } catch {
    return result
  }

  const skillsList: string[] = Array.isArray(profile.skills) ? profile.skills.filter(isPlainSegment) : []
  const targetIde = profile.targetIde || 'claude-code'
  const agent = AGENTS.find((a) => a.id === targetIde)
  const relPaths = agent && agent.projectPaths.length > 0 ? agent.projectPaths : ['.agents/skills']
  const isAntigravity = targetIde === 'antigravity'

  for (const relPath of relPaths) {
    const targetDir = path.join(projectPath, relPath)

    // A dangling symlink in place of the skills dir would make mkdir throw.
    try {
      const lstat = await fs.lstat(targetDir)
      if (lstat.isSymbolicLink()) {
        try {
          await fs.stat(targetDir)
        } catch {
          await fs.unlink(targetDir).catch(() => {})
        }
      }
    } catch {}

    await fs.mkdir(targetDir, { recursive: true })

    // Only managed entries are candidates for removal.
    const existingEntries = await fs.readdir(targetDir, { withFileTypes: true }).catch(() => [])
    const toDelete = new Set<string>()
    for (const entry of existingEntries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isSymbolicLink()) {
        toDelete.add(entry.name)
      } else if (isAntigravity && entry.isDirectory() && (await isManagedCopy(path.join(targetDir, entry.name)))) {
        toDelete.add(entry.name)
      }
    }

    for (const skillName of skillsList) {
      const skill = skillsMap.get(skillName)
      if (!skill || !isPlainSegment(skill.name)) continue

      const targetLinkPath = path.join(targetDir, skill.name)
      let resolvedRealPath: string
      try {
        resolvedRealPath = await fs.realpath(skill.realPath)
      } catch {
        resolvedRealPath = path.resolve(skill.realPath)
      }

      // The skill's only home is this very directory — nothing to do.
      if (await isInside(resolvedRealPath, targetDir)) {
        toDelete.delete(skill.name)
        continue
      }

      let lstat: import('fs').Stats | null = null
      try {
        lstat = await fs.lstat(targetLinkPath)
      } catch {}

      if (lstat && !lstat.isSymbolicLink() && lstat.isDirectory()) {
        const managed = isAntigravity && (await isManagedCopy(targetLinkPath))
        if (!managed) {
          // User-owned directory with the same name: keep it, report it.
          toDelete.delete(skill.name)
          result.conflicts.push(targetLinkPath)
          continue
        }
      } else if (lstat && !lstat.isSymbolicLink()) {
        toDelete.delete(skill.name)
        result.conflicts.push(targetLinkPath)
        continue
      }

      if (isAntigravity) {
        // Antigravity mode: materialized physical copy + .skill-source marker.
        try {
          if (lstat?.isSymbolicLink()) {
            await fs.unlink(targetLinkPath)
          } else if (lstat) {
            await fs.rm(targetLinkPath, { recursive: true, force: true }) // managed copy only
          }
          await copyDirRecursive(resolvedRealPath, targetLinkPath)

          const sourceMarkerFile = path.join(targetLinkPath, '.skill-source')
          let markerData: any = {}
          try {
            markerData = JSON.parse(await fs.readFile(sourceMarkerFile, 'utf-8'))
          } catch {}
          markerData.name = skill.name
          markerData.originPath = resolvedRealPath
          markerData.copiedAt = new Date().toISOString()
          await fs.writeFile(sourceMarkerFile, JSON.stringify(markerData, null, 2), 'utf-8')
          toDelete.delete(skill.name)
        } catch (err: any) {
          console.error(`[syncProjectSkills] Failed physical copy for ${skill.name}:`, err.message)
        }
        continue
      }

      // Symlink mode for Claude Code & other IDEs.
      if (lstat?.isSymbolicLink()) {
        let resolvedTarget: string
        try {
          resolvedTarget = await fs.realpath(targetLinkPath)
        } catch {
          resolvedTarget = path.resolve(targetDir, await fs.readlink(targetLinkPath))
        }
        if (resolvedTarget === resolvedRealPath) {
          toDelete.delete(skill.name)
          continue
        }
        await fs.unlink(targetLinkPath).catch(() => {})
      }

      try {
        await fs.symlink(resolvedRealPath, targetLinkPath, 'dir')
        toDelete.delete(skill.name)
      } catch (err: any) {
        console.error(`[syncProjectSkills] Failed to symlink ${skill.name} to ${targetLinkPath}:`, err.message)
      }
    }

    for (const nameToDelete of toDelete) {
      const entryPath = path.join(targetDir, nameToDelete)
      try {
        const st = await fs.lstat(entryPath)
        if (st.isSymbolicLink()) {
          await fs.unlink(entryPath)
        } else {
          await moveToTrash(entryPath, nameToDelete)
        }
      } catch (err: any) {
        console.error(`[syncProjectSkills] Failed to remove ${entryPath}:`, err.message)
      }
    }
  }

  // Claude Code entry link: .claude/skills -> .agents/skills, but ONLY when
  // .claude/skills does not exist yet. A real .claude/skills directory holds
  // the user's own project skills and used to be `rm -rf`'d here.
  const agentsSkillsDir = path.join(projectPath, '.agents', 'skills')
  try {
    const s = await fs.stat(agentsSkillsDir)
    if (s.isDirectory() && (targetIde === 'claude-code' || relPaths.includes('.claude/skills'))) {
      const claudeSkillsDir = path.join(projectPath, '.claude', 'skills')
      let exists = true
      try {
        await fs.lstat(claudeSkillsDir)
      } catch {
        exists = false
      }
      if (!exists) {
        await fs.mkdir(path.join(projectPath, '.claude'), { recursive: true })
        await fs.symlink(agentsSkillsDir, claudeSkillsDir, 'dir').catch(() => {})
      }
    }
  } catch {}

  return result
}

export async function manageRoutes(app: FastifyInstance) {
  // Skill × IDE (global distribution) and Skill × project associations
  app.get<{
    Params: { name: string }
  }>('/api/skills/:name/association', async (req, reply) => {
    const { name } = req.params
    if (!isPlainSegment(name)) {
      reply.status(400)
      return { ok: false, error: '参数不合法' }
    }
    const { distributable, ides } = await skillDistributionStatus(name)

    const projectsList = []
    for (const proj of await discoverProjects()) {
      let hasSkill = false
      try {
        const profile = JSON.parse(await fs.readFile(path.join(proj.path, '.skills-profile.json'), 'utf-8'))
        hasSkill = Array.isArray(profile?.skills) && profile.skills.includes(name)
      } catch {}
      projectsList.push({ name: proj.name, path: proj.path, enabled: hasSkill, linked: hasSkill })
    }

    return { name, distributable, ides, projects: projectsList }
  })

  // Save associations. IDE part edits the distribution state and applies
  // only this skill's changes; project part edits project profiles.
  app.post<{
    Params: { name: string }
    Body: { ides?: Record<string, boolean>; disabledIdes?: string[]; enabledProjectPaths: string[] }
  }>('/api/skills/:name/association', async (req, reply) => {
    const { name } = req.params
    const { ides, disabledIdes, enabledProjectPaths } = req.body ?? ({} as any)
    if (
      !isPlainSegment(name) ||
      !Array.isArray(enabledProjectPaths) ||
      !enabledProjectPaths.every((p: unknown) => typeof p === 'string' && path.isAbsolute(p))
    ) {
      reply.status(400)
      return { ok: false, error: '参数不合法' }
    }

    // 1. IDE distribution
    const status = await skillDistributionStatus(name)
    let wanted: Record<string, boolean> | undefined
    if (ides && typeof ides === 'object') {
      wanted = ides
    } else if (Array.isArray(disabledIdes)) {
      // Legacy body shape: everything listed as enabled unless disabled.
      wanted = Object.fromEntries(status.ides.filter((i) => i.managed).map((i) => [i.id, !disabledIdes.includes(i.id)]))
    }
    let distribution = null
    if (wanted) {
      const changes: Record<string, boolean> = {}
      for (const ide of status.ides) {
        if (ide.id in wanted && !!wanted[ide.id] !== ide.enabled) changes[ide.id] = !!wanted[ide.id]
      }
      if (Object.keys(changes).length) {
        const r = await setSkillAgents(name, changes)
        if (!r.ok) {
          reply.status(400)
          return r
        }
        distribution = await applyScoped({ skills: [name] })
      }
    }

    // 2. Fetch skillsMap. We ONLY scan once.
    const scanRes = await fullScan()
    const skillsMap = new Map(scanRes.skills.map(s => [s.name, s]))
    const targetSkill = skillsMap.get(name)

    // 3. Update project config profiles without running discoverProjects recursively.
    // We derive originally linked projects directly from the scan output
    const originallyLinkedProjectPaths = targetSkill?.linkedProjects?.map(p => p.path) || []
    const allAffectedPaths = new Set([...enabledProjectPaths, ...originallyLinkedProjectPaths])

    for (const projectPath of allAffectedPaths) {
      const profilePath = path.join(projectPath, '.skills-profile.json')
      const shouldHaveSkill = enabledProjectPaths.includes(projectPath)

      let profile: any
      try {
        const raw = await fs.readFile(profilePath, 'utf-8')
        profile = JSON.parse(raw)
      } catch {}

      if (profile && Array.isArray(profile.skills)) {
        const hasSkill = profile.skills.includes(name)
        let changed = false

        if (shouldHaveSkill && !hasSkill) {
          profile.skills.push(name)
          changed = true
        } else if (!shouldHaveSkill && hasSkill) {
          profile.skills = profile.skills.filter((s: string) => s !== name)
          changed = true
        }

        if (changed) {
          profile.updatedAt = new Date().toISOString()
          await fs.writeFile(profilePath, JSON.stringify(profile, null, 2), 'utf-8')
          await syncProjectSkills(projectPath, skillsMap)
        }
      } else if (shouldHaveSkill) {
        // Automatically initialize profile if user opts to associate this project
        profile = {
          version: 1,
          name: path.basename(projectPath),
          description: '',
          skills: [name],
          targetIde: 'claude-code',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
        await fs.writeFile(profilePath, JSON.stringify(profile, null, 2), 'utf-8')
        await syncProjectSkills(projectPath, skillsMap)
      }
    }

    invalidateCache()
    return { ok: true, distribution }
  })

  // Toggle skill enabled/disabled
  app.put<{
    Params: { id: string }
    Body: { enabled: boolean; skillName: string }
  }>('/api/skills/:id/toggle', async (req, reply) => {
    const { enabled, skillName } = req.body ?? ({} as any)
    if (!isPlainSegment(skillName) || /[()\s]/.test(skillName) || typeof enabled !== 'boolean') {
      reply.status(400)
      return { ok: false, error: '参数不合法' }
    }
    let settings: any
    try {
      settings = await readSettings()
    } catch (err: any) {
      reply.status(500)
      return { ok: false, error: err.message }
    }

    if (!settings.permissions) settings.permissions = {}
    if (!settings.permissions.deny) settings.permissions.deny = []

    const rule = `Skill(${skillName})`
    const idx = settings.permissions.deny.indexOf(rule)

    if (enabled && idx >= 0) {
      // Remove from deny list to enable
      settings.permissions.deny.splice(idx, 1)
    } else if (!enabled && idx < 0) {
      // Add to deny list to disable
      settings.permissions.deny.push(rule)
    }

    await writeSettings(settings)
    invalidateCache()
    return { ok: true, enabled }
  })

  // Update SKILL.md content
  app.put<{
    Params: { id: string }
    Body: { realPath: string; content: string }
  }>('/api/skills/:id/content', async (req, reply) => {
    const { content } = req.body ?? ({} as any)
    if (typeof content !== 'string') {
      reply.status(400)
      return { ok: false, error: 'content 必须是字符串' }
    }
    // The target comes from the scan, never from the request body: a
    // client-supplied realPath allowed writing SKILL.md anywhere on disk.
    const skill = await findKnownSkill({ id: req.params.id })
    if (!skill) {
      reply.status(404)
      return { ok: false, error: 'Skill not found' }
    }
    const realPath = skill.realPath
    const skillMdPath = path.join(realPath, 'SKILL.md')

    // Verify the file exists
    try {
      await fs.access(skillMdPath)
    } catch {
      return { ok: false, error: 'SKILL.md not found' }
    }

    // Auto-snapshot before overwriting (save the old version)
    const skillName = path.basename(realPath)
    try {
      await createSnapshot(realPath, skillName, '编辑前自动备份', 'auto')
    } catch {}

    await fs.writeFile(skillMdPath, content, 'utf-8')

    // Snapshot the new version
    try {
      await createSnapshot(realPath, skillName, '通过编辑器保存', 'auto')
    } catch {}

    invalidateCache()
    return { ok: true }
  })

  // Copy skill to another location
  app.post<{
    Body: {
      sourcePath: string
      targetScope: 'global' | 'project'
      projectPath?: string
      skillName: string
    }
  }>('/api/skills/copy', async (req, reply) => {
    const { sourcePath, targetScope, projectPath, skillName } = req.body ?? ({} as any)
    if (!isPlainSegment(skillName) || (projectPath !== undefined && (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)))) {
      reply.status(400)
      return { ok: false, error: '参数不合法' }
    }
    if (!(await findKnownSkill({ path: sourcePath }))) {
      reply.status(404)
      return { ok: false, error: '源路径不是已发现的 Skill' }
    }

    let targetDir: string
    if (targetScope === 'global') {
      const settings = await readIdeSettingsFull()
      if (settings.customGlobalSkillsDir) {
        targetDir = path.join(settings.customGlobalSkillsDir, skillName)
      } else {
        targetDir = path.join(homedir, '.claude', 'skills', skillName)
      }
    } else if (projectPath) {
      targetDir = path.join(projectPath, '.claude', 'skills', skillName)
    } else {
      return { ok: false, error: 'Project path required for project scope' }
    }

    // Resolve source if symlink
    let realSource: string
    try {
      realSource = await fs.realpath(sourcePath)
    } catch {
      realSource = sourcePath
    }

    // Check if target already exists
    try {
      await fs.access(targetDir)
      return { ok: false, error: '目标位置已存在同名 Skill' }
    } catch {
      // Good — doesn't exist
    }

    // Copy directory recursively
    await copyDir(realSource, targetDir)
    invalidateCache()
    return { ok: true, targetDir }
  })

  // Move skill (copy + delete source)
  app.post<{
    Body: {
      sourcePath: string
      targetScope: 'global' | 'project'
      projectPath?: string
      skillName: string
    }
  }>('/api/skills/move', async (req, reply) => {
    const { sourcePath, targetScope, projectPath, skillName } = req.body ?? ({} as any)
    if (!isPlainSegment(skillName) || (projectPath !== undefined && (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)))) {
      reply.status(400)
      return { ok: false, error: '参数不合法' }
    }
    if (!(await findKnownSkill({ path: sourcePath }))) {
      reply.status(404)
      return { ok: false, error: '源路径不是已发现的 Skill' }
    }

    let targetDir: string
    if (targetScope === 'global') {
      const settings = await readIdeSettingsFull()
      if (settings.customGlobalSkillsDir) {
        targetDir = path.join(settings.customGlobalSkillsDir, skillName)
      } else {
        targetDir = path.join(homedir, '.claude', 'skills', skillName)
      }
    } else if (projectPath) {
      targetDir = path.join(projectPath, '.claude', 'skills', skillName)
    } else {
      return { ok: false, error: 'Project path required for project scope' }
    }

    let realSource: string
    try {
      realSource = await fs.realpath(sourcePath)
    } catch {
      realSource = sourcePath
    }

    try {
      await fs.access(targetDir)
      return { ok: false, error: '目标位置已存在同名 Skill' }
    } catch {}

    await copyDir(realSource, targetDir)

    // Remove the source via the recycle bin (symlinks are recorded and unlinked).
    await moveToTrash(sourcePath, skillName)

    invalidateCache()
    return { ok: true, targetDir }
  })

  // Delete skill (soft delete → recycle bin; 7-day TTL)
  app.delete<{
    Params: { id: string }
    Body: { path: string; skillName?: string }
  }>('/api/skills/:id', async (req, reply) => {
    const skillPath = req.body?.path
    const skillName = req.body?.skillName
    if (typeof skillPath !== 'string' || !(await findKnownSkill({ path: skillPath }))) {
      reply.status(404)
      return { ok: false, error: '该路径不是已发现的 Skill' }
    }

    try {
      const meta = await moveToTrash(skillPath, skillName)
      invalidateCache()
      return { ok: true, trashId: meta.id, expiresAt: meta.expiresAt }
    } catch (err: any) {
      reply.status(500)
      return { ok: false, error: err?.message || '删除失败' }
    }
  })

  // Batch delete — move many skills to trash in one call
  app.post<{
    Body: { items: { id: string; path: string; skillName?: string }[] }
  }>('/api/skills/batch/delete', async (req, reply) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : []
    if (items.length === 0) {
      reply.status(400)
      return { ok: false, error: '未提供要删除的 skill' }
    }

    const results: {
      id: string
      skillName?: string
      ok: boolean
      trashId?: string
      error?: string
    }[] = []

    for (const item of items) {
      if (!item || typeof item.path !== 'string') {
        results.push({ id: item?.id || '(unknown)', ok: false, error: '参数不完整' })
        continue
      }
      if (!(await findKnownSkill({ path: item.path }))) {
        results.push({ id: item.id, skillName: item.skillName, ok: false, error: '该路径不是已发现的 Skill' })
        continue
      }
      try {
        const meta = await moveToTrash(item.path, item.skillName)
        results.push({
          id: item.id,
          skillName: item.skillName,
          ok: true,
          trashId: meta.id,
        })
      } catch (err: any) {
        results.push({
          id: item.id,
          skillName: item.skillName,
          ok: false,
          error: err?.message || '删除失败',
        })
      }
    }

    invalidateCache()

    const okCount = results.filter((r) => r.ok).length
    const failCount = results.length - okCount
    return { ok: failCount === 0, okCount, failCount, results }
  })

  // GET /api/symlinks/anomalies - Detect anomalous skill directories and symlink stats
  app.get('/api/symlinks/anomalies', async () => {
    const anomalies = []
    const stats = []
    const dist = await readDistribution()
    const warehouseReals = await Promise.all((await getWarehouseDirs()).map((w) => fs.realpath(w).catch(() => path.resolve(w))))

    for (const agent of AGENTS) {
      if (!agent.globalPaths || agent.globalPaths.length === 0) continue
      if (agent.id === 'universal') continue

      const globalPaths = agentGlobalPaths(agent, homedir)
      let symlinkCount = 0
      let realCount = 0
      let exists = false

      // User-scoped agents own one directory per account: aggregate their
      // counts into a single stat row and show the first dir as representative.
      for (const globalPath of globalPaths) {
        // An agent dir that IS a warehouse holds the source skills themselves.
        const realGlobal = await fs.realpath(globalPath).catch(() => path.resolve(globalPath))
        if (warehouseReals.some((w) => realGlobal === w || realGlobal.startsWith(w + path.sep))) continue
        try {
          await fs.access(globalPath)
          exists = true
          const entries = await fs.readdir(globalPath, { withFileTypes: true })
          for (const entry of entries) {
            const entryPath = path.join(globalPath, entry.name)
            const stat = await fs.lstat(entryPath)

            if (stat.isSymbolicLink()) {
              symlinkCount++
            } else if (stat.isDirectory()) {
              realCount++
              if (!entry.name.startsWith('.')) {
                anomalies.push({
                  id: crypto.createHash('md5').update(entryPath).digest('hex').slice(0, 12),
                  name: entry.name,
                  path: entryPath,
                  agentId: agent.id,
                  agentName: agent.name,
                })
              }
            }
          }
        } catch {}
      }

      stats.push({
        agentId: agent.id,
        agentName: agent.name,
        icon: agent.icon,
        symlinkCount,
        realCount,
        globalPath: globalPaths[0] || '',
        exists,
        enabled: dist.agents[agent.id]?.mode === 'all',
        mode: dist.agents[agent.id]?.mode ?? null,
      })
    }

    return { ok: true, anomalies, stats }
  })

  // POST /api/ide/toggle — legacy switch kept for compatibility:
  // on → mode 'all', off → mode 'off'. Only the desired state changes; the
  // response carries the preview and nothing touches disk until apply.
  app.post<{
    Body: { agentId: string; enabled: boolean }
  }>('/api/ide/toggle', async (req, reply) => {
    const { agentId, enabled } = req.body ?? ({} as any)
    if (!distributableAgents().some((a) => a.id === agentId) || agentId === 'universal') {
      reply.status(400)
      return { ok: false, error: '无效或不支持的 Agent ID' }
    }
    const state = await updateDistribution((s) => {
      s.agents[agentId] = { ...s.agents[agentId], mode: enabled ? 'all' : 'off' }
    })
    return { ok: true, state, plan: await plan({ agentIds: [agentId] }) }
  })

  // POST /api/symlinks/anomalies/fix — adopt real skill dirs found in agent
  // global dirs into the primary warehouse, leaving symlinks behind.
  app.post<{
    Body: { targets?: { name: string; path: string; agentId: string }[] }
  }>('/api/symlinks/anomalies/fix', async (req) => {
    const targets = Array.isArray(req.body?.targets) ? req.body.targets : []
    const warehouses = await getWarehouseDirs()
    const warehouse = warehouses[0]
    const warehouseReals = await Promise.all(warehouses.map((w) => fs.realpath(w).catch(() => path.resolve(w))))
    const isWarehouseDir = async (d: string) => {
      const r = await fs.realpath(d).catch(() => path.resolve(d))
      return warehouseReals.some((w) => r === w || r.startsWith(w + path.sep))
    }

    const agentDirs: { agentId: string; dir: string }[] = []
    for (const agent of AGENTS) {
      if (agent.id === 'universal') continue
      for (const dir of agentGlobalPaths(agent, homedir)) {
        if (!(await isWarehouseDir(dir))) agentDirs.push({ agentId: agent.id, dir })
      }
    }

    const items: { name: string; path: string; agentId: string }[] = []
    if (targets.length > 0) {
      for (const t of targets) {
        if (!t || !isPlainSegment(t.name) || typeof t.path !== 'string' || path.basename(t.path) !== t.name) continue
        const owner = agentDirs.find((d) => path.resolve(d.dir) === path.resolve(path.dirname(t.path)))
        if (owner) items.push({ name: t.name, path: t.path, agentId: owner.agentId })
      }
      if (items.length === 0) return { ok: false, fixedCount: 0, results: [], error: '没有合法的修复目标' }
    } else {
      for (const { agentId, dir } of agentDirs) {
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
        for (const e of entries) {
          if (e.isDirectory() && !e.name.startsWith('.')) items.push({ name: e.name, path: path.join(dir, e.name), agentId })
        }
      }
    }

    const results: { name: string; success: boolean; error?: string }[] = []
    const adopted: { agentId: string; dest: string }[] = []
    await withWriteLock(async () => {
      for (const item of items) {
        try {
          const st = await fs.lstat(item.path)
          if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('不是真实目录')
          adopted.push({ agentId: item.agentId, dest: await adoptIntoWarehouse(item.path, warehouse) })
          results.push({ name: item.name, success: true })
        } catch (err: any) {
          results.push({ name: item.name, success: false, error: err.message })
        }
      }
    })

    // Keep adopted skills in agents that have a rule which would not include them.
    if (adopted.length) {
      const ins = await inspect()
      const allNames = [...ins.sources.keys()]
      const byReal = new Map([...ins.sources.values()].map((src) => [src.realPath, src.name]))
      const wanted: { agentId: string; name: string }[] = []
      for (const a of adopted) {
        const name = byReal.get(await fs.realpath(a.dest).catch(() => a.dest))
        if (name) wanted.push({ agentId: a.agentId, name })
      }
      await updateDistribution((s) => {
        for (const { agentId, name } of wanted) {
          if (s.agents[agentId] && !desiredNames(s.agents[agentId], s, allNames).has(name)) {
            setSkillForAgent(s, agentId, name, true, allNames)
          }
        }
      })
    }

    invalidateCache()
    return { ok: true, fixedCount: adopted.length, results, warehouse }
  })

  // POST /api/skills/batch/symlink — legacy batch actions mapped onto rules:
  //   add        → include the chosen warehouse skills for that agent, apply them
  //   remove_all → set the agent to 'off', apply (removes only managed links)
  app.post<{
    Body: {
      action: 'add' | 'remove_all'
      agentId: string
      skillIds?: string[]
    }
  }>('/api/skills/batch/symlink', async (req, reply) => {
    const { action, agentId, skillIds = [] } = req.body ?? ({} as any)
    if (!distributableAgents().some((a) => a.id === agentId) || agentId === 'universal') {
      reply.status(400)
      return { ok: false, error: '无效或不支持的 Agent ID' }
    }

    if (action === 'add') {
      if (!Array.isArray(skillIds) || skillIds.length === 0) return { ok: true, message: '未勾选技能', results: [] }
      const ins = await inspect()
      const allNames = [...ins.sources.keys()]
      const results: { name: string; success: boolean; error?: string }[] = []
      const names: string[] = []
      for (const id of skillIds) {
        const skill = await findKnownSkill({ id })
        if (!skill) results.push({ name: String(id), success: false, error: '未找到该 Skill' })
        else if (!ins.sources.has(skill.name)) results.push({ name: skill.name, success: false, error: '不在 Skill 仓库中，无法分发（请先收归到仓库）' })
        else names.push(skill.name)
      }
      if (names.length) {
        await updateDistribution((s) => {
          for (const n of names) setSkillForAgent(s, agentId, n, true, allNames)
        })
        const applied = await applyScoped({ agentIds: [agentId], skills: names })
        const failedIds = new Set(applied.results.filter((r) => !r.ok).map((r) => r.id))
        for (const n of names) {
          const failed = [...failedIds].find((id) => id.endsWith(path.sep + n))
          results.push(failed ? { name: n, success: false, error: applied.results.find((r) => r.id === failed)?.error } : { name: n, success: true })
        }
      }
      return { ok: true, results }
    }

    if (action === 'remove_all') {
      await updateDistribution((s) => {
        s.agents[agentId] = { mode: 'off' }
      })
      const applied = await applyScoped({ agentIds: [agentId] })
      return { ok: applied.failed === 0, removedCount: applied.applied, applied }
    }

    reply.status(400)
    return { ok: false, error: '无效的操作 action' }
  })

  // GET /api/settings
  app.get('/api/settings', async () => {
    const { githubToken, ...rest } = await readIdeSettingsFull()
    // The token never leaves the server; the UI only needs to know it exists.
    return { ok: true, settings: { ...rest, hasGithubToken: !!githubToken } }
  })

  // POST /api/settings
  app.post<{
    Body: {
      customGlobalSkillsDir?: string
      skillWarehouses?: string[]
      githubToken?: string
      clearGithubToken?: boolean
      httpProxy?: string
    }
  }>('/api/settings', async (req, reply) => {
    const { customGlobalSkillsDir, skillWarehouses, githubToken, clearGithubToken, httpProxy } = req.body ?? ({} as any)
    
    let normalizedPath: string | undefined = undefined
    if (customGlobalSkillsDir && customGlobalSkillsDir.trim() !== '') {
      const p = customGlobalSkillsDir.trim()
      if (!path.isAbsolute(p)) {
        reply.status(400)
        return { ok: false, error: '存储路径必须是绝对路径' }
      }
      normalizedPath = path.resolve(p)
    }

    let normalizedWarehouses: string[] | undefined = undefined
    if (Array.isArray(skillWarehouses)) {
      normalizedWarehouses = skillWarehouses
        .filter((w) => typeof w === 'string' && w.trim() !== '')
        .map((w) => (w.startsWith('~') ? path.join(homedir, w.slice(1)) : path.resolve(w.trim())))
    }

    const oldSettings = await readIdeSettingsFull()
    const newSettings: AppSettings = {
      customGlobalSkillsDir: normalizedPath,
      skillWarehouses: normalizedWarehouses !== undefined ? normalizedWarehouses : oldSettings.skillWarehouses,
      // Empty / omitted token means "keep the stored one" (the UI never
      // receives it, so it cannot echo it back). Clearing is explicit.
      githubToken: clearGithubToken
        ? undefined
        : typeof githubToken === 'string' && githubToken.trim() !== ''
          ? githubToken.trim()
          : oldSettings.githubToken,
      httpProxy: httpProxy !== undefined ? httpProxy : oldSettings.httpProxy,
      // Legacy distribution fields: migrated into distribution.json, kept
      // untouched here (they used to be dropped on every save).
      enabledAgentIds: oldSettings.enabledAgentIds,
      skillOverrides: oldSettings.skillOverrides,
    }

    // Changing the warehouse path no longer moves every agent's real skill
    // directories as a side effect. Adopting them is an explicit action
    // ("一键收归"), and the new warehouse only takes effect on the next apply.
    if (newSettings.customGlobalSkillsDir) await fs.mkdir(newSettings.customGlobalSkillsDir, { recursive: true })

    await writeIdeSettingsFull(newSettings)

    // Dynamic apply proxy settings
    const { setupProxy } = await import('../sync/proxy.js')
    await setupProxy()

    invalidateCache()
    const { githubToken: _token, ...publicSettings } = newSettings
    return { ok: true, settings: { ...publicSettings, hasGithubToken: !!newSettings.githubToken } }
  })
}

export async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else {
      await fs.copyFile(srcPath, destPath)
    }
  }
}
