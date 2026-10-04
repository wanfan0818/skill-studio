import type { FastifyInstance } from 'fastify'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { fullScan } from '../scanner/discovery.js'
import { AGENTS, agentGlobalPaths } from '../scanner/agents.js'
import { invalidateCache } from './skills.js'
import type { GlobalSkillsConfig } from '../types.js'

const homedir = os.homedir()
const configDir = path.join(homedir, '.config', 'skill-studio')
const globalConfigFile = path.join(configDir, 'global-skills.json')

const DEFAULT_GLOBAL_TARGET_IDES = ['claude-code', 'codex', 'antigravity', 'workbuddy', 'zcode']

export async function readGlobalSkillsConfig(): Promise<GlobalSkillsConfig> {
  try {
    const raw = await fs.readFile(globalConfigFile, 'utf-8')
    const parsed = JSON.parse(raw)
    const currentIdes: string[] = Array.isArray(parsed.targetIdes) ? parsed.targetIdes : DEFAULT_GLOBAL_TARGET_IDES
    // Smooth upgrade: ensure zcode is present if user has other popular IDEs enabled
    const mergedIdes = Array.from(new Set([...currentIdes, 'zcode']))

    return {
      globalSkills: Array.isArray(parsed.globalSkills) ? parsed.globalSkills : [],
      targetIdes: mergedIdes,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
    }
  } catch {
    return {
      globalSkills: [],
      targetIdes: DEFAULT_GLOBAL_TARGET_IDES,
      updatedAt: new Date().toISOString(),
    }
  }
}

export async function writeGlobalSkillsConfig(config: GlobalSkillsConfig): Promise<void> {
  await fs.mkdir(configDir, { recursive: true })
  config.updatedAt = new Date().toISOString()
  await fs.writeFile(globalConfigFile, JSON.stringify(config, null, 2), 'utf-8')
}

/**
 * Deploys/syncs all configured global skills to standard IDE global skill directories.
 */
export async function syncGlobalSkillsToIdes(skillsMap: Map<string, any>): Promise<{ synced: string[]; errors: string[] }> {
  const config = await readGlobalSkillsConfig()
  const globalSkillNames = new Set(config.globalSkills)
  const targetIdes = config.targetIdes || ['claude-code', 'codex', 'antigravity', 'workbuddy', 'zcode']

  const synced: string[] = []
  const errors: string[] = []

  // Resolve all IDE global directories that should receive global skills
  const globalDirsToDeploy = new Set<string>()

  for (const ideId of targetIdes) {
    const agent = AGENTS.find((a) => a.id === ideId)
    if (agent && agent.globalPaths.length > 0) {
      // agentGlobalPaths resolves user-scoped templates (e.g. TeleAgent's
      // `users/<userId>/skills`) to real directories, so we never mkdir a
      // literal `*` segment here.
      for (const p of agentGlobalPaths(agent, homedir)) {
        globalDirsToDeploy.add(path.resolve(p))
      }
    }
  }

  // Always include shared universal global path ~/.agents/skills
  globalDirsToDeploy.add(path.join(homedir, '.agents', 'skills'))

  for (const targetDir of globalDirsToDeploy) {
    try {
      await fs.mkdir(targetDir, { recursive: true })

      const existingEntries = await fs.readdir(targetDir, { withFileTypes: true }).catch(() => [])
      const toClean = new Set<string>()

      for (const entry of existingEntries) {
        if (entry.isSymbolicLink()) {
          toClean.add(entry.name)
        }
      }

      // Process each configured global skill
      for (const skillName of globalSkillNames) {
        const skill = skillsMap.get(skillName)
        if (!skill) continue

        let resolvedRealPath: string
        try {
          resolvedRealPath = await fs.realpath(skill.realPath)
        } catch {
          resolvedRealPath = path.resolve(skill.realPath)
        }

        const targetLinkPath = path.join(targetDir, skill.name)

        // Clean broken/dangling symlink or existing directory/symlink
        try {
          const lstat = await fs.lstat(targetLinkPath)
          let isSymlink = lstat.isSymbolicLink()
          if (isSymlink) {
            let currentTarget = ''
            try {
              currentTarget = await fs.readlink(targetLinkPath)
              const resolvedTarget = path.resolve(targetDir, currentTarget)
              if (resolvedTarget === resolvedRealPath) {
                toClean.delete(skill.name)
                synced.push(`${skill.name} -> ${targetDir}`)
                continue
              }
            } catch {}
          }
          await fs.rm(targetLinkPath, { recursive: true, force: true }).catch(() => {})
        } catch {}

        try {
          await fs.symlink(resolvedRealPath, targetLinkPath, 'dir')
          toClean.delete(skill.name)
          synced.push(`${skill.name} -> ${targetDir}`)
        } catch (err: any) {
          errors.push(`Failed to symlink global skill ${skillName} in ${targetDir}: ${err.message}`)
        }
      }

      // Clean unselected former global symlinks
      for (const name of toClean) {
        if (!globalSkillNames.has(name)) {
          const linkPath = path.join(targetDir, name)
          await fs.rm(linkPath, { recursive: true, force: true }).catch(() => {})
        }
      }
    } catch (err: any) {
      errors.push(`Failed accessing global dir ${targetDir}: ${err.message}`)
    }
  }

  return { synced, errors }
}

export async function globalRoutes(app: FastifyInstance) {
  // GET /api/global-skills - Read current global skills configuration
  app.get('/api/global-skills', async () => {
    const config = await readGlobalSkillsConfig()
    const scanRes = await fullScan()
    const globalSkillNames = new Set(config.globalSkills)

    const activeSkills = scanRes.skills.filter((s) => globalSkillNames.has(s.name) || s.isGlobalActive)
    return {
      ok: true,
      config,
      globalSkills: config.globalSkills,
      activeSkills,
    }
  })

  // POST /api/global-skills/toggle - Toggle single skill as global
  app.post<{
    Body: { skillName: string; isGlobal: boolean }
  }>('/api/global-skills/toggle', async (req, reply) => {
    const { skillName, isGlobal } = req.body
    if (!skillName) {
      reply.status(400)
      return { ok: false, error: '未提供 skillName' }
    }

    const config = await readGlobalSkillsConfig()
    const set = new Set(config.globalSkills)

    if (isGlobal) {
      set.add(skillName)
    } else {
      set.delete(skillName)
    }

    config.globalSkills = Array.from(set)
    await writeGlobalSkillsConfig(config)

    const scanRes = await fullScan()
    const globalSkillsMap = new Map(scanRes.skills.map((s) => [s.name, s]))
    const syncRes = await syncGlobalSkillsToIdes(globalSkillsMap)
    invalidateCache()

    return {
      ok: true,
      config,
      message: isGlobal ? `已将 /${skillName} 提升为全局 Skill 并完成 IDE 全域部署` : `已取消 /${skillName} 的全局 Skill 部署`,
      syncRes,
    }
  })

  // POST /api/global-skills/set - Batch set global skills
  app.post<{
    Body: { globalSkills: string[]; targetIdes?: string[] }
  }>('/api/global-skills/set', async (req, reply) => {
    const { globalSkills, targetIdes } = req.body
    if (!Array.isArray(globalSkills)) {
      reply.status(400)
      return { ok: false, error: 'globalSkills 必须为数组' }
    }

    const config = await readGlobalSkillsConfig()
    config.globalSkills = Array.from(new Set(globalSkills))
    if (Array.isArray(targetIdes)) {
      config.targetIdes = targetIdes
    }

    await writeGlobalSkillsConfig(config)

    const scanRes = await fullScan()
    const globalSkillsMap = new Map(scanRes.skills.map((s) => [s.name, s]))
    const syncRes = await syncGlobalSkillsToIdes(globalSkillsMap)
    invalidateCache()

    return {
      ok: true,
      config,
      message: `已更新全局 Skill 列表 (共 ${config.globalSkills.length} 个)，并完成 IDE 全域部署`,
      syncRes,
    }
  })

  // POST /api/global-skills/sync - Force full sync of global skills
  app.post('/api/global-skills/sync', async () => {
    const scanRes = await fullScan()
    const globalSkillsMap = new Map(scanRes.skills.map((s) => [s.name, s]))
    const syncRes = await syncGlobalSkillsToIdes(globalSkillsMap)
    invalidateCache()

    return {
      ok: true,
      message: '全局 Skill 已全量同步应用至所有启用 IDE 的全局目录',
      syncRes,
    }
  })
}
