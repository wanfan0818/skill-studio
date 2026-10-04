import type { FastifyInstance } from 'fastify'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { invalidateCache } from './skills.js'
import { createSnapshot } from '../versioning/store.js'
import { moveToTrash } from '../trash/store.js'
import { AGENTS, agentGlobalPaths } from '../scanner/agents.js'
import type { Skill } from '../types.js'
import { discoverProjects, fullScan } from '../scanner/discovery.js'

const homedir = os.homedir()
const settingsPath = path.join(homedir, '.claude', 'settings.json')
const ideConfigPath = path.join(homedir, '.config', 'skill-studio', 'ide-settings.json')

export let isSyncingSymlinks = false
export function setSyncingSymlinks(val: boolean) {
  isSyncingSymlinks = val
}

export interface AppSettings {
  enabledAgentIds: string[]
  customGlobalSkillsDir?: string
  skillWarehouses?: string[]
  githubToken?: string // Added for GitHub API authentication
  httpProxy?: string // Added for network proxy configuration
  skillOverrides?: Record<string, { disabledIdes?: string[] }>
}

export async function readIdeSettingsFull(): Promise<AppSettings> {
  try {
    const raw = await fs.readFile(ideConfigPath, 'utf-8')
    const parsed = JSON.parse(raw)
    const enabledAgentIds = Array.isArray(parsed.enabledAgentIds) ? parsed.enabledAgentIds : []
    const customGlobalSkillsDir = typeof parsed.customGlobalSkillsDir === 'string' && parsed.customGlobalSkillsDir.trim() !== ''
      ? parsed.customGlobalSkillsDir
      : undefined
    const skillWarehouses = Array.isArray(parsed.skillWarehouses)
      ? parsed.skillWarehouses.filter((w: unknown) => typeof w === 'string' && w.trim() !== '').map((w: string) => w.trim())
      : undefined
    const githubToken = typeof parsed.githubToken === 'string' ? parsed.githubToken : undefined
    const httpProxy = typeof parsed.httpProxy === 'string' ? parsed.httpProxy : undefined
    const skillOverrides = parsed.skillOverrides && typeof parsed.skillOverrides === 'object' ? parsed.skillOverrides : undefined
    return { enabledAgentIds, customGlobalSkillsDir, skillWarehouses, githubToken, httpProxy, skillOverrides }
  } catch {
    const initialEnabled: string[] = ['claude-code']
    try {
      for (const agent of AGENTS) {
        if (!agent.globalPaths || agent.globalPaths.length === 0 || agent.id === 'universal') continue
        let detected = false
        for (const globalPath of agentGlobalPaths(agent, homedir)) {
          try {
            await fs.access(globalPath)
            detected = true
            break
          } catch {}
        }
        if (detected && !initialEnabled.includes(agent.id)) {
          initialEnabled.push(agent.id)
        }
      }
      await writeIdeSettingsFull({ enabledAgentIds: initialEnabled })
      return { enabledAgentIds: initialEnabled }
    } catch {
      return { enabledAgentIds: [] }
    }
  }
}

export async function writeIdeSettingsFull(settings: AppSettings): Promise<void> {
  const configDir = path.dirname(ideConfigPath)
  await fs.mkdir(configDir, { recursive: true })
  await fs.writeFile(ideConfigPath, JSON.stringify(settings, null, 2), 'utf-8')
}

export async function readIdeSettings(): Promise<string[]> {
  const settings = await readIdeSettingsFull()
  return settings.enabledAgentIds
}

export async function writeIdeSettings(enabledAgentIds: string[]): Promise<void> {
  const settings = await readIdeSettingsFull()
  settings.enabledAgentIds = enabledAgentIds
  await writeIdeSettingsFull(settings)
}

export async function ensureEnabledIdesSymlinks(skills: Skill[]): Promise<void> {
  setSyncingSymlinks(true)

  try {
    const settings = await readIdeSettingsFull()
    const enabledAgentIds = settings.enabledAgentIds

    for (const agent of AGENTS) {
      if (!agent.globalPaths || agent.globalPaths.length === 0 || agent.id === 'universal') continue

      const shouldBeEnabled = enabledAgentIds.includes(agent.id)
      // User-scoped agents (e.g. TeleAgent) expand to one directory per
      // account; every static agent yields exactly one path.
      const globalPaths = agentGlobalPaths(agent, homedir)

      if (shouldBeEnabled) {
        for (const globalPath of globalPaths) {
          await fs.mkdir(globalPath, { recursive: true })

          for (const skill of skills) {
            const targetLinkPath = path.join(globalPath, skill.name)

            // 检查此技能的配置，如果在该 IDE 下被禁用，强制删除且不予建立软链接
            const overrides = settings.skillOverrides?.[skill.name]
            const isOverrideDisabled = overrides?.disabledIdes?.includes(agent.id)

            if (isOverrideDisabled) {
              try {
                const lstat = await fs.lstat(targetLinkPath)
                if (lstat.isSymbolicLink()) {
                  await fs.unlink(targetLinkPath)
                }
              } catch {}
              continue
            }

            let resolvedRealPath: string
            try {
              resolvedRealPath = await fs.realpath(skill.realPath)
            } catch {
              resolvedRealPath = path.resolve(skill.realPath)
            }

            if (path.resolve(targetLinkPath) === resolvedRealPath) {
              continue
            }

            let exists = false
            let isSymlink = false
            let currentTarget = ''

            try {
              const lstat = await fs.lstat(targetLinkPath)
              exists = true
              isSymlink = lstat.isSymbolicLink()
              if (isSymlink) {
                currentTarget = await fs.readlink(targetLinkPath)
              }
            } catch {
              exists = false
            }

            if (exists) {
              if (isSymlink) {
                let resolvedTarget: string
                try {
                  resolvedTarget = await fs.realpath(path.resolve(globalPath, currentTarget))
                } catch {
                  resolvedTarget = path.resolve(globalPath, currentTarget)
                }

                if (resolvedTarget === resolvedRealPath) {
                  continue
                }
              } else {
                continue
              }
            }

            try {
              await fs.unlink(targetLinkPath)
            } catch {}

            try {
              await fs.symlink(resolvedRealPath, targetLinkPath, 'dir')
            } catch (err: any) {
              console.error(`[ide-sync] Failed to create symlink for ${skill.name} in ${agent.name}:`, err)
            }
          }
        }
      } else {
        // Deliberately NO destructive cleanup in this branch.
        //
        // This used to unlink every symlink inside a non-enabled agent's global
        // directory. Since ensureEnabledIdesSymlinks() runs at the end of every
        // fullScan() — i.e. on page load, project save, skill toggle and settings
        // write — "this agent is not enabled" silently meant "delete whatever
        // lives in this agent's skill directory".
        //
        // That is exactly what happened to WorkBuddy AI. ~/.workbuddy-ai/skills
        // held 204 symlinks into the skill warehouse; the moment `workbuddy-ai`
        // joined AGENTS while still absent from enabledAgentIds, the next scan
        // wiped them and the user's WorkBuddy AI skill list collapsed to the
        // three real directories that remained.
        //
        // Cleanup is now an explicit, narrowly-scoped action: pruneAgentSymlinks()
        // below, called only when the user actually turns an agent off.
      }
    }
  } finally {
    // 延迟 1.5 秒复位锁，以确保操作系统异步 I/O 文件事件全部抛出并过去
    setTimeout(() => {
      setSyncingSymlinks(false)
    }, 1500)
  }
}

/**
 * Remove the symlinks Skill Studio manages inside ONE agent's global skill
 * directory. Called only when the user explicitly disables that agent.
 *
 * Scope is deliberately narrow: only this one agent's directories are touched,
 * so switching Cursor off can never disturb Codex, and an agent the user never
 * enabled is never touched at all.
 */
export async function pruneAgentSymlinks(agentId: string): Promise<void> {
  const agent = AGENTS.find((a) => a.id === agentId)
  if (!agent || agent.globalPaths.length === 0) return

  setSyncingSymlinks(true)
  try {
    for (const globalPath of agentGlobalPaths(agent, homedir)) {
      let entries: import('fs').Dirent[]
      try {
        entries = await fs.readdir(globalPath, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        const entryPath = path.join(globalPath, entry.name)
        try {
          const stat = await fs.lstat(entryPath)
          if (stat.isSymbolicLink()) {
            await fs.unlink(entryPath)
          }
        } catch {}
      }
    }
  } finally {
    setTimeout(() => {
      setSyncingSymlinks(false)
    }, 1500)
  }
}

async function readSettings(): Promise<any> {
  try {
    const raw = await fs.readFile(settingsPath, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function writeSettings(settings: any): Promise<void> {
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
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

export async function syncProjectSkills(projectPath: string, skillsMap: Map<string, any>) {
  const profilePath = path.join(projectPath, '.skills-profile.json')
  let profile: any
  try {
    const raw = await fs.readFile(profilePath, 'utf-8')
    profile = JSON.parse(raw)
  } catch {
    return
  }

  const skillsList = Array.isArray(profile.skills) ? profile.skills : []
  const targetIde = profile.targetIde || 'claude-code'
  const agent = AGENTS.find((a) => a.id === targetIde)
  const relPaths = agent && agent.projectPaths.length > 0 ? agent.projectPaths : ['.agents/skills']

  const isAntigravity = targetIde === 'antigravity'

  for (const relPath of relPaths) {
    const targetDir = path.join(projectPath, relPath)
    
    // 清理损坏/悬空的失效软链接（Dangling Symlink），防止 fs.mkdir 抛出 ENOENT
    try {
      const lstat = await fs.lstat(targetDir)
      if (lstat.isSymbolicLink()) {
        try {
          await fs.stat(targetDir)
        } catch {
          // 软链接目标已不可达，删掉此坏软链接以重建目录
          await fs.rm(targetDir, { force: true, recursive: true }).catch(() => {})
        }
      }
    } catch {}

    await fs.mkdir(targetDir, { recursive: true })

    const existingEntries = await fs.readdir(targetDir, { withFileTypes: true }).catch(() => [])
    const toDelete = new Set<string>()
    for (const entry of existingEntries) {
      if (entry.isSymbolicLink() || (isAntigravity && entry.isDirectory())) {
        toDelete.add(entry.name)
      }
    }

    for (const skillName of skillsList) {
      const skill = skillsMap.get(skillName)
      if (!skill) continue

      const targetLinkPath = path.join(targetDir, skill.name)
      let resolvedRealPath: string
      try {
        resolvedRealPath = await fs.realpath(skill.realPath)
      } catch (err: any) {
        console.warn(`[syncProjectSkills] fs.realpath failed for ${skill.realPath}:`, err.message)
        resolvedRealPath = path.resolve(skill.realPath)
      }

      if (isAntigravity) {
        // Antigravity Mode: Materialized Physical Copy + .skill-source Marker
        try {
          await fs.rm(targetLinkPath, { recursive: true, force: true }).catch(() => {})
          await copyDirRecursive(resolvedRealPath, targetLinkPath)
          
          const sourceMarkerFile = path.join(targetLinkPath, '.skill-source')
          let markerData: any = {}
          try {
            const rawMarker = await fs.readFile(sourceMarkerFile, 'utf-8')
            markerData = JSON.parse(rawMarker)
          } catch {}
          markerData.name = skill.name
          markerData.originPath = resolvedRealPath
          markerData.copiedAt = new Date().toISOString()
          await fs.writeFile(sourceMarkerFile, JSON.stringify(markerData, null, 2), 'utf-8')

          toDelete.delete(skill.name)
        } catch (err: any) {
          console.error(`[syncProjectSkills] Failed physical copy for ${skill.name}:`, err.message)
        }
      } else {
        // Symlink Mode for Claude Code & Other IDEs
        let exists = false
        let isSymlink = false
        let currentTarget = ''

        try {
          const lstat = await fs.lstat(targetLinkPath)
          exists = true
          isSymlink = lstat.isSymbolicLink()
          if (isSymlink) {
            currentTarget = await fs.readlink(targetLinkPath)
          }
        } catch {}

        if (exists) {
          if (isSymlink) {
            let resolvedTarget: string
            try {
              resolvedTarget = await fs.realpath(path.resolve(targetDir, currentTarget))
            } catch {
              resolvedTarget = path.resolve(targetDir, currentTarget)
            }
            if (resolvedTarget === resolvedRealPath) {
              toDelete.delete(skill.name)
              continue
            }
          }
          await fs.rm(targetLinkPath, { recursive: true, force: true }).catch(() => {})
        }

        try {
          await fs.symlink(resolvedRealPath, targetLinkPath, 'dir')
          toDelete.delete(skill.name)
        } catch (err: any) {
          console.error(`[syncProjectSkills] Failed to symlink ${skill.name} to ${targetLinkPath}:`, err.message)
        }
      }
    }

    for (const nameToDelete of toDelete) {
      const linkPath = path.join(targetDir, nameToDelete)
      await fs.rm(linkPath, { recursive: true, force: true }).catch((err: any) => {
        console.error(`[syncProjectSkills] Failed to delete link ${linkPath}:`, err.message)
      })
    }
  }

  // Automatic entry link maintenance for Claude Code (.claude/skills -> .agents/skills) & Codex (.codex/skills -> .agents/skills)
  const agentsSkillsDir = path.join(projectPath, '.agents', 'skills')
  try {
    const s = await fs.stat(agentsSkillsDir)
    if (s.isDirectory()) {
      // Build .claude/skills entry link for Claude Code
      if (targetIde === 'claude-code' || relPaths.includes('.claude/skills')) {
        const claudeSkillsDir = path.join(projectPath, '.claude', 'skills')
        await fs.mkdir(path.join(projectPath, '.claude'), { recursive: true })
        let exists = false
        try {
          const lstat = await fs.lstat(claudeSkillsDir)
          exists = true
          if (!lstat.isSymbolicLink()) {
            await fs.rm(claudeSkillsDir, { recursive: true, force: true })
            exists = false
          }
        } catch {}

        if (!exists) {
          await fs.symlink(agentsSkillsDir, claudeSkillsDir, 'dir').catch(() => {})
        }
      }
    }
  } catch {}
}

export async function manageRoutes(app: FastifyInstance) {
  // Get Skill associations across IDEs and local Projects
  app.get<{
    Params: { name: string }
  }>('/api/skills/:name/association', async (req) => {
    const { name } = req.params
    const settings = await readIdeSettingsFull()
    const skillOverrides = settings.skillOverrides?.[name] || {}
    const disabledIdes = skillOverrides.disabledIdes || []

    const idesList = AGENTS.filter(a => a.globalPaths && a.globalPaths.length > 0 && a.id !== 'universal').map(agent => {
      const isEnabledInSettings = settings.enabledAgentIds.includes(agent.id)
      const isDisabledByOverride = disabledIdes.includes(agent.id)
      return {
        id: agent.id,
        name: agent.name,
        enabled: isEnabledInSettings && !isDisabledByOverride,
        linked: isEnabledInSettings && !isDisabledByOverride
      }
    })

    const allProjects = await discoverProjects()
    const projectsList = []

    for (const proj of allProjects) {
      const profilePath = path.join(proj.path, '.skills-profile.json')
      let hasSkill = false
      try {
        const raw = await fs.readFile(profilePath, 'utf-8')
        const profile = JSON.parse(raw)
        if (profile && Array.isArray(profile.skills)) {
          hasSkill = profile.skills.includes(name)
        }
      } catch {}

      projectsList.push({
        name: proj.name,
        path: proj.path,
        enabled: hasSkill,
        linked: hasSkill
      })
    }

    return {
      name,
      ides: idesList,
      projects: projectsList
    }
  })

  // Save Skill association settings & apply changes to IDEs and Projects
  app.post<{
    Params: { name: string }
    Body: { disabledIdes: string[]; enabledProjectPaths: string[] }
  }>('/api/skills/:name/association', async (req) => {
    const { name } = req.params
    const { disabledIdes, enabledProjectPaths } = req.body

    // 1. Update global IDE overrides
    const settings = await readIdeSettingsFull()
    if (!settings.skillOverrides) settings.skillOverrides = {}
    settings.skillOverrides[name] = { disabledIdes }
    await writeIdeSettingsFull(settings)

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

    // 4. Force sync IDE globally for this single skill only, avoiding second fullScan
    if (targetSkill) {
      await ensureEnabledIdesSymlinks([targetSkill])
    }
    
    invalidateCache()

    return { ok: true }
  })

  // Toggle skill enabled/disabled
  app.put<{
    Params: { id: string }
    Body: { enabled: boolean; skillName: string }
  }>('/api/skills/:id/toggle', async (req) => {
    const { enabled, skillName } = req.body
    const settings = await readSettings()

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
  }>('/api/skills/:id/content', async (req) => {
    const { realPath, content } = req.body
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
  }>('/api/skills/copy', async (req) => {
    const { sourcePath, targetScope, projectPath, skillName } = req.body

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
  }>('/api/skills/move', async (req) => {
    const { sourcePath, targetScope, projectPath, skillName } = req.body

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

    // Remove the source (if symlink, just remove the link; if dir, remove recursively)
    const stat = await fs.lstat(sourcePath)
    if (stat.isSymbolicLink()) {
      await fs.unlink(sourcePath)
    } else {
      await fs.rm(sourcePath, { recursive: true })
    }

    invalidateCache()
    return { ok: true, targetDir }
  })

  // Delete skill (soft delete → recycle bin; 7-day TTL)
  app.delete<{
    Params: { id: string }
    Body: { path: string; skillName?: string }
  }>('/api/skills/:id', async (req, reply) => {
    const skillPath = req.body.path
    const skillName = req.body.skillName

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

  // Get sync status across IDEs for a skill
  app.get<{
    Params: { id: string }
    Querystring: { realPath: string; name: string }
  }>('/api/skills/:id/agents', async (req) => {
    const { realPath, name } = req.query

    let resolvedRealPath: string
    try {
      resolvedRealPath = await fs.realpath(realPath)
    } catch {
      resolvedRealPath = path.resolve(realPath)
    }

    const results = []
    const enabledAgentIds = await readIdeSettings()

    for (const agent of AGENTS) {
      if (!agent.globalPaths || agent.globalPaths.length === 0) continue

      // A user-scoped agent (e.g. TeleAgent) has one directory per account, so
      // probe each of them and report the strongest match: a directory that
      // already links this skill wins over an empty one.
      const candidates: {
        enabled: boolean
        isRealLocation: boolean
        targetLinkPath: string
      }[] = []

      for (const globalPath of agentGlobalPaths(agent, homedir)) {
        const targetLinkPath = path.join(globalPath, name)

        let resolvedLinkPath = ''
        let exists = false
        let isSymlink = false

        try {
          const lstat = await fs.lstat(targetLinkPath)
          exists = true
          isSymlink = lstat.isSymbolicLink()
          if (isSymlink) {
            const target = await fs.readlink(targetLinkPath)
            resolvedLinkPath = path.resolve(globalPath, target)
          } else {
            resolvedLinkPath = await fs.realpath(targetLinkPath)
          }
        } catch {
          exists = false
        }

        const isRealLocation = path.resolve(targetLinkPath) === resolvedRealPath
        const enabled =
          isRealLocation || (exists && isSymlink && resolvedLinkPath === resolvedRealPath)

        candidates.push({ enabled, isRealLocation, targetLinkPath })
      }

      if (candidates.length === 0) continue
      const chosen = candidates.find((c) => c.enabled) ?? candidates[0]

      results.push({
        id: agent.id,
        name: agent.name,
        icon: agent.icon,
        enabled: chosen.enabled,
        isRealLocation: chosen.isRealLocation,
        targetLinkPath: chosen.targetLinkPath,
        globallyEnabled: enabledAgentIds.includes(agent.id),
      })
    }

    return { ok: true, agents: results }
  })

  // Sync symlinks across IDEs for a skill
  app.post<{
    Params: { id: string }
    Body: { realPath: string; name: string; enabledAgentIds: string[] }
  }>('/api/skills/:id/agents/sync', async (req) => {
    const { realPath, name, enabledAgentIds } = req.body

    let resolvedRealPath: string
    try {
      resolvedRealPath = await fs.realpath(realPath)
    } catch {
      resolvedRealPath = path.resolve(realPath)
    }

    const results = []

    for (const agent of AGENTS) {
      if (!agent.globalPaths || agent.globalPaths.length === 0) continue

      const shouldBeEnabled = enabledAgentIds.includes(agent.id)
      const globalPaths = agentGlobalPaths(agent, homedir)

      // One aggregate result per agent, even when it owns several
      // directories (user-scoped agents), so the UI never shows the same
      // agent twice.
      let acted = false
      let failure: string | null = null

      for (const globalPath of globalPaths) {
        const targetLinkPath = path.join(globalPath, name)

        if (path.resolve(targetLinkPath) === resolvedRealPath) {
          continue
        }

        let exists = false
        let isSymlink = false
        let currentTarget = ''

        try {
          const lstat = await fs.lstat(targetLinkPath)
          exists = true
          isSymlink = lstat.isSymbolicLink()
          if (isSymlink) {
            currentTarget = await fs.readlink(targetLinkPath)
          }
        } catch {
          exists = false
        }

        if (shouldBeEnabled) {
          if (exists) {
            if (isSymlink) {
              const resolvedTarget = path.resolve(globalPath, currentTarget)
              if (resolvedTarget === resolvedRealPath) {
                continue
              }
              await fs.unlink(targetLinkPath)
            } else {
              failure = failure || '目标路径已存在真实文件夹，未覆盖。'
              continue
            }
          }

          try {
            await fs.mkdir(globalPath, { recursive: true })
            await fs.symlink(resolvedRealPath, targetLinkPath, 'dir')
            acted = true
          } catch (err: any) {
            failure = failure || err.message
          }
        } else {
          if (exists && isSymlink) {
            const resolvedTarget = path.resolve(globalPath, currentTarget)
            if (resolvedTarget === resolvedRealPath) {
              await fs.unlink(targetLinkPath)
              acted = true
            }
          }
        }
      }

      if (failure) {
        results.push({ agentId: agent.id, success: false, error: failure })
      } else if (acted) {
        results.push({ agentId: agent.id, success: true })
      }
    }

    invalidateCache()
    return { ok: true, results }
  })

  // GET /api/symlinks/anomalies - Detect anomalous skill directories and symlink stats
  app.get('/api/symlinks/anomalies', async () => {
    const anomalies = []
    const stats = []
    const enabledAgentIds = await readIdeSettings()

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
        enabled: enabledAgentIds.includes(agent.id),
      })
    }

    return { ok: true, anomalies, stats }
  })

  // POST /api/ide/toggle - Toggle global sharing for an IDE
  app.post<{
    Body: { agentId: string; enabled: boolean }
  }>('/api/ide/toggle', async (req, reply) => {
    const { agentId, enabled } = req.body
    if (!agentId) {
      reply.status(400)
      return { ok: false, error: '未提供 agentId' }
    }

    const agent = AGENTS.find((a) => a.id === agentId)
    if (!agent || !agent.globalPaths || agent.globalPaths.length === 0) {
      reply.status(400)
      return { ok: false, error: '无效或不支持的 Agent ID' }
    }

    const enabledAgentIds = await readIdeSettings()
    let newEnabledIds = [...enabledAgentIds]
    if (enabled) {
      if (!newEnabledIds.includes(agentId)) {
        newEnabledIds.push(agentId)
      }
    } else {
      newEnabledIds = newEnabledIds.filter((id) => id !== agentId)
    }
    await writeIdeSettings(newEnabledIds)

    // Turning an agent OFF is the one and only moment we are allowed to remove
    // symlinks — and only from that agent's own directories.
    if (!enabled) await pruneAgentSymlinks(agentId)

    const { fullScan } = await import('../scanner/discovery.js')
    const scanRes = await fullScan()
    
    await ensureEnabledIdesSymlinks(scanRes.skills)

    invalidateCache()
    return { ok: true, enabledAgentIds: newEnabledIds }
  })

  // POST /api/symlinks/anomalies/fix - One-click fix to move anomalies to shared location and symlink them back
  app.post<{
    Body: { targets?: { name: string; path: string; agentId: string }[] }
  }>('/api/symlinks/anomalies/fix', async (req) => {
    const targets = req.body?.targets || []
    const settings = await readIdeSettingsFull()
    const realGlobalBase = settings.customGlobalSkillsDir || path.join(homedir, '.agents', 'skills')

    await fs.mkdir(realGlobalBase, { recursive: true })
    const results = []
    let fixedCount = 0

    let itemsToFix = [...targets]
    if (itemsToFix.length === 0) {
      for (const agent of AGENTS) {
        if (!agent.globalPaths || agent.globalPaths.length === 0) continue
        if (agent.id === 'universal') continue
        for (const globalPath of agentGlobalPaths(agent, homedir)) {
          try {
            const entries = await fs.readdir(globalPath, { withFileTypes: true })
            for (const entry of entries) {
              const entryPath = path.join(globalPath, entry.name)
              const stat = await fs.lstat(entryPath)
              if (stat.isDirectory() && !stat.isSymbolicLink() && !entry.name.startsWith('.')) {
                itemsToFix.push({
                  name: entry.name,
                  path: entryPath,
                  agentId: agent.id,
                })
              }
            }
          } catch {}
        }
      }
    }

    for (const item of itemsToFix) {
      let targetRealPath = path.join(realGlobalBase, item.name)

      try {
        await fs.access(targetRealPath)
        targetRealPath = path.join(realGlobalBase, `${item.name}_fixed_${Date.now()}`)
      } catch {}

      try {
        try {
          await fs.rename(item.path, targetRealPath)
        } catch {
          await copyDir(item.path, targetRealPath)
          await fs.rm(item.path, { recursive: true })
        }

        await fs.symlink(targetRealPath, item.path, 'dir')
        fixedCount++
        results.push({ name: item.name, success: true })
      } catch (err: any) {
        results.push({ name: item.name, success: false, error: err.message })
      }
    }

    invalidateCache()
    return { ok: true, fixedCount, results }
  })

  // POST /api/skills/batch/symlink - Batch add symlinks or batch clear all symlinks in an IDE
  app.post<{
    Body: {
      action: 'add' | 'remove_all'
      agentId: string
      skillIds?: string[]
    }
  }>('/api/skills/batch/symlink', async (req, reply) => {
    const { action, agentId, skillIds = [] } = req.body

    const agent = AGENTS.find((a) => a.id === agentId)
    if (!agent || !agent.globalPaths || agent.globalPaths.length === 0) {
      reply.status(400)
      return { ok: false, error: '无效或不支持的 Agent ID' }
    }

    // User-scoped agents (e.g. TeleAgent) own one directory per account.
    const globalPaths = agentGlobalPaths(agent, homedir)

    if (action === 'add') {
      if (skillIds.length === 0) {
        return { ok: true, message: '未勾选技能' }
      }

      const { fullScan } = await import('../scanner/discovery.js')
      const scanRes = await fullScan()
      const matchedSkills = scanRes.skills.filter((s) => skillIds.includes(s.id))

      const results = []

      for (const globalPath of globalPaths) {
        await fs.mkdir(globalPath, { recursive: true })

        for (const skill of matchedSkills) {
          const targetLinkPath = path.join(globalPath, skill.name)
          let resolvedRealPath: string
          try {
            resolvedRealPath = await fs.realpath(skill.realPath)
          } catch {
            resolvedRealPath = path.resolve(skill.realPath)
          }

          if (path.resolve(targetLinkPath) === resolvedRealPath) {
            results.push({ name: skill.name, success: true, message: '本体无需创建软链' })
            continue
          }

          let exists = false
          let isSymlink = false
          let currentTarget = ''

          try {
            const lstat = await fs.lstat(targetLinkPath)
            exists = true
            isSymlink = lstat.isSymbolicLink()
            if (isSymlink) {
              currentTarget = await fs.readlink(targetLinkPath)
            }
          } catch {
            exists = false
          }

          if (exists) {
            if (isSymlink) {
              const resolvedTarget = path.resolve(globalPath, currentTarget)
              if (resolvedTarget === resolvedRealPath) {
                results.push({ name: skill.name, success: true, message: '软链已存在' })
                continue
              }
              await fs.unlink(targetLinkPath)
            } else {
              results.push({ name: skill.name, success: false, error: '目标路径已存在真实文件夹，未覆盖。' })
              continue
            }
          }

          try {
            await fs.symlink(resolvedRealPath, targetLinkPath, 'dir')
            results.push({ name: skill.name, success: true })
          } catch (err: any) {
            results.push({ name: skill.name, success: false, error: err.message })
          }
        }
      }

      invalidateCache()
      return { ok: true, results }
    } else if (action === 'remove_all') {
      let removedCount = 0
      for (const globalPath of globalPaths) {
        try {
          const entries = await fs.readdir(globalPath, { withFileTypes: true })
          for (const entry of entries) {
            const entryPath = path.join(globalPath, entry.name)
            const stat = await fs.lstat(entryPath)
            if (stat.isSymbolicLink()) {
              await fs.unlink(entryPath)
              removedCount++
            }
          }
        } catch {}
      }

      invalidateCache()
      return { ok: true, removedCount }
    }

    reply.status(400)
    return { ok: false, error: '无效的操作 action' }
  })

  // GET /api/settings
  app.get('/api/settings', async () => {
    const settings = await readIdeSettingsFull()
    return { ok: true, settings }
  })

  // POST /api/settings
  app.post<{
    Body: {
      enabledAgentIds?: string[]
      customGlobalSkillsDir?: string
      skillWarehouses?: string[]
      githubToken?: string
      httpProxy?: string
    }
  }>('/api/settings', async (req, reply) => {
    const { enabledAgentIds, customGlobalSkillsDir, skillWarehouses, githubToken, httpProxy } = req.body
    
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
      enabledAgentIds: Array.isArray(enabledAgentIds) ? enabledAgentIds : oldSettings.enabledAgentIds,
      customGlobalSkillsDir: normalizedPath,
      skillWarehouses: normalizedWarehouses !== undefined ? normalizedWarehouses : oldSettings.skillWarehouses,
      githubToken: githubToken !== undefined ? githubToken : oldSettings.githubToken,
      httpProxy: httpProxy !== undefined ? httpProxy : oldSettings.httpProxy
    }

    if (newSettings.customGlobalSkillsDir && newSettings.customGlobalSkillsDir !== oldSettings.customGlobalSkillsDir) {
      const targetDir = newSettings.customGlobalSkillsDir
      await fs.mkdir(targetDir, { recursive: true })
      
      for (const agent of AGENTS) {
        if (!agent.globalPaths || agent.globalPaths.length === 0 || agent.id === 'universal') continue
        for (const globalPath of agentGlobalPaths(agent, homedir)) {
          if (path.resolve(globalPath) === path.resolve(targetDir)) continue

          try {
            const entries = await fs.readdir(globalPath, { withFileTypes: true })
            for (const entry of entries) {
              const entryPath = path.join(globalPath, entry.name)
              const stat = await fs.lstat(entryPath)

              if (stat.isDirectory() && !stat.isSymbolicLink() && !entry.name.startsWith('.')) {
                const newDest = path.join(targetDir, entry.name)
                let destExists = false
                try {
                  await fs.access(newDest)
                  destExists = true
                } catch {}

                let finalDest = newDest
                if (destExists) {
                  finalDest = path.join(targetDir, `${entry.name}_migrated_${Date.now()}`)
                }

                try {
                  await fs.rename(entryPath, finalDest)
                } catch {
                  await copyDir(entryPath, finalDest)
                  await fs.rm(entryPath, { recursive: true })
                }
              }
            }
          } catch {}
        }
      }
    }

    await writeIdeSettingsFull(newSettings)

    // Agents the user just dropped from the enabled list get their symlinks
    // cleaned up explicitly — the scan itself no longer deletes anything.
    const removedAgentIds = oldSettings.enabledAgentIds.filter(
      (id) => !newSettings.enabledAgentIds.includes(id),
    )
    for (const removedId of removedAgentIds) {
      await pruneAgentSymlinks(removedId)
    }

    // Dynamic apply proxy settings
    const { setupProxy } = await import('../sync/proxy.js')
    await setupProxy()

    const { fullScan } = await import('../scanner/discovery.js')
    const scanRes = await fullScan()
    await ensureEnabledIdesSymlinks(scanRes.skills)

    invalidateCache()
    return { ok: true, settings: newSettings }
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
