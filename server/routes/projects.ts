import type { FastifyInstance } from 'fastify'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import {
  discoverProjects,
  fullScan,
  saveProjectToRegistry,
  addExcludedProject,
  getExcludedProjects,
  removeExcludedProject,
  purgeProjectSkillsAndProfile
} from '../scanner/discovery.js'
import { AGENTS, allAgentProjectRelPaths } from '../scanner/agents.js'
import { recommendSkills } from '../recommender/engine.js'
import { invalidateCache } from './skills.js'
import { syncProjectSkills } from './manage.js'
import type { SkillProfile, ProjectWithProfile } from '../types.js'
import { isPlainSegment, writeFileAtomic } from '../utils/safe.js'

const homedir = os.homedir()

/**
 * 辅助函数：读取项目根目录下的 .skills-profile.json
 */
async function readProjectProfile(projectPath: string): Promise<SkillProfile | undefined> {
  const profilePath = path.join(projectPath, '.skills-profile.json')
  try {
    const raw = await fs.readFile(profilePath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.skills)) {
      return {
        version: parsed.version || 1,
        name: parsed.name || path.basename(projectPath),
        description: parsed.description || '',
        skills: parsed.skills,
        targetIde: parsed.targetIde || 'claude-code',
        createdAt: parsed.createdAt || new Date().toISOString(),
        updatedAt: parsed.updatedAt || new Date().toISOString()
      }
    }
  } catch {}
  return undefined
}

/**
 * 辅助函数：将 profile 写入项目根目录下的 .skills-profile.json
 */
async function writeProjectProfile(projectPath: string, profile: SkillProfile): Promise<void> {
  const profilePath = path.join(projectPath, '.skills-profile.json')
  await writeFileAtomic(profilePath, JSON.stringify(profile, null, 2))
}

/** Project paths from the client must be absolute paths to existing directories. */
async function isValidProjectDir(p: unknown): Promise<boolean> {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false
  if (path.resolve(p) === path.resolve(homedir) || path.resolve(p) === '/') return false
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}


/**
 * 辅助函数：查找某项目实际链接的 Skill 数量与状态
 */
async function getProjectSkillsStatus(
  projectPath: string,
  profile?: SkillProfile
): Promise<{ linkedCount: number; status: 'synced' | 'drift' | 'no-profile'; actualSkills: string[] }> {
  const actualLinkedSkills = new Set<string>()
  const uniqueRelPaths = allAgentProjectRelPaths()

  for (const rel of uniqueRelPaths) {
    const targetDir = path.join(projectPath, rel)
    try {
      const entries = await fs.readdir(targetDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (entry.isSymbolicLink() || entry.isDirectory()) {
          actualLinkedSkills.add(entry.name)
        }
      }
    } catch {}
  }

  const linkedCount = actualLinkedSkills.size
  const actualSkills = Array.from(actualLinkedSkills)

  if (!profile) {
    return { linkedCount, status: 'no-profile', actualSkills }
  }

  const declaredSkills = new Set(profile.skills)
  let isSynced = true

  for (const s of declaredSkills) {
    if (!actualLinkedSkills.has(s)) {
      isSynced = false
      break
    }
  }

  return {
    linkedCount,
    status: isSynced ? 'synced' : 'drift',
    actualSkills,
  }
}

export async function projectRoutes(app: FastifyInstance) {
  // 1. GET /api/projects - 获取所有项目及配置信息
  app.get('/api/projects', async () => {
    const found = await discoverProjects()
    const projectsWithProfile: ProjectWithProfile[] = []

    for (const p of found) {
      // Read-only: a GET must never write into the user's projects. This used
      // to auto-create a profile with targetIde 'antigravity', which armed the
      // physical-copy sync mode on projects the user never configured.
      const profile = await readProjectProfile(p.path)
      const { linkedCount, status } = await getProjectSkillsStatus(p.path, profile)

      projectsWithProfile.push({
        name: profile?.name || p.name,
        path: p.path,
        skillCount: linkedCount,
        profile,
        linkedSkillCount: linkedCount,
        profileSkillCount: profile ? profile.skills.length : 0,
        syncStatus: profile ? status : 'no-profile',
      })
    }

    return { ok: true, projects: projectsWithProfile }
  })

  // 2. GET /api/projects/profile - 获取单个项目的 profile
  app.get<{
    Querystring: { projectPath: string }
  }>('/api/projects/profile', async (req, reply) => {
    const { projectPath } = req.query
    if (!projectPath) {
      reply.status(400)
      return { ok: false, error: '未提供项目路径 projectPath' }
    }

    const profile = await readProjectProfile(projectPath)
    if (!profile) {
      return { ok: true, exists: false }
    }

    return { ok: true, exists: true, profile }
  })

  // 3. POST /api/projects/profile - 新增或修改项目的 profile
  app.post<{
    Body: {
      projectPath: string
      profile: Omit<SkillProfile, 'createdAt' | 'updatedAt'>
    }
  }>('/api/projects/profile', async (req, reply) => {
    const { projectPath, profile } = req.body
    if (!projectPath || !profile) {
      reply.status(400)
      return { ok: false, error: '缺少必填参数 projectPath 或 profile' }
    }
    if (!(await isValidProjectDir(projectPath))) {
      reply.status(400)
      return { ok: false, error: '项目路径必须是已存在目录的绝对路径' }
    }

    const existing = await readProjectProfile(projectPath)
    const now = new Date().toISOString()
    const fullProfile: SkillProfile = {
      version: profile.version || 1,
      name: profile.name,
      description: profile.description || '',
      skills: profile.skills || [],
      targetIde: profile.targetIde || 'claude-code',
      createdAt: existing?.createdAt || now,
      updatedAt: now
    }

    try {
      await writeProjectProfile(projectPath, fullProfile)
      await saveProjectToRegistry(projectPath, fullProfile.name)
      return { ok: true, profile: fullProfile }
    } catch (err: any) {
      reply.status(500)
      return { ok: false, error: `写入配置文件失败: ${err.message}` }
    }
  })

  // 4. POST /api/projects/recommend-skills - 根据描述推荐 Skill
  app.post<{
    Body: { description: string }
  }>('/api/projects/recommend-skills', async (req, reply) => {
    const { description } = req.body
    try {
      const scanRes = await fullScan()
      const recommended = recommendSkills(description, scanRes.skills)
      return { ok: true, recommended }
    } catch (err: any) {
      reply.status(500)
      return { ok: false, error: `推荐失败: ${err.message}` }
    }
  })

  // 5. POST /api/projects/sync - 同步 Skill 软链接到项目目录
  app.post<{
    Body: { projectPath: string }
  }>('/api/projects/sync', async (req, reply) => {
    const { projectPath } = req.body
    if (!projectPath) {
      reply.status(400)
      return { ok: false, error: '未提供项目路径 projectPath' }
    }
    if (!(await isValidProjectDir(projectPath))) {
      reply.status(400)
      return { ok: false, error: '项目路径必须是已存在目录的绝对路径' }
    }

    let profile = await readProjectProfile(projectPath)
    if (!profile) {
      const status = await getProjectSkillsStatus(projectPath)
      profile = {
        version: 1,
        name: path.basename(projectPath),
        description: '自动配置的项目 Profile',
        skills: status.actualSkills,
        targetIde: 'claude-code',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      await writeProjectProfile(projectPath, profile)
    }

    try {
      const scanRes = await fullScan()
      const globalSkillsMap = new Map(scanRes.skills.map(s => [s.name, s]))
      const { conflicts } = await syncProjectSkills(projectPath, globalSkillsMap)
      invalidateCache()
      return {
        ok: true,
        message: conflicts.length
          ? `已同步，但有 ${conflicts.length} 个同名真实目录未被覆盖`
          : '项目 Skill 同步成功',
        conflicts,
      }
    } catch (err: any) {
      reply.status(500)
      return { ok: false, error: `同步失败: ${err.message}` }
    }
  })

  // 6. DELETE /api/projects/clean - 一键清理项目下的所有 Skill 软链接，并删除 profile
  app.delete<{
    Body: { projectPath: string }
  }>('/api/projects/clean', async (req, reply) => {
    const { projectPath } = req.body
    if (!projectPath) {
      reply.status(400)
      return { ok: false, error: '未提供项目路径 projectPath' }
    }
    if (!(await isValidProjectDir(projectPath))) {
      reply.status(400)
      return { ok: false, error: '项目路径必须是已存在目录的绝对路径' }
    }

    const profile = await readProjectProfile(projectPath)
    if (!profile) {
      // 就算没有 profile，我们也尽力清理各大 IDE 下的软链接
      const cleanedDirs = []
      for (const agent of AGENTS) {
        for (const rel of agent.projectPaths) {
          const targetDir = path.join(projectPath, rel)
          try {
            const entries = await fs.readdir(targetDir, { withFileTypes: true })
            for (const entry of entries) {
              const entryPath = path.join(targetDir, entry.name)
              const stat = await fs.lstat(entryPath)
              if (stat.isSymbolicLink()) {
                await fs.unlink(entryPath)
              }
            }
            cleanedDirs.push(rel)
          } catch {}
        }
      }
      return { ok: true, message: '未找到配置文件，已尽力清理 IDE 项目软链接。', cleanedDirs }
    }

    const agent = AGENTS.find(a => a.id === profile.targetIde)
    const relPaths = agent && agent.projectPaths.length > 0 ? agent.projectPaths : ['.agents/skills']
    const targetDir = path.join(projectPath, relPaths[0])

    try {
      // 删除软链接
      const entries = await fs.readdir(targetDir, { withFileTypes: true }).catch(() => [] as any)
      for (const entry of entries) {
        const entryPath = path.join(targetDir, entry.name)
        try {
          const stat = await fs.lstat(entryPath)
          if (stat.isSymbolicLink()) {
            await fs.unlink(entryPath)
          }
        } catch {}
      }

      // 删除 profile 文件
      const profilePath = path.join(projectPath, '.skills-profile.json')
      await fs.unlink(profilePath).catch(() => {})

      invalidateCache()
      return { ok: true }
    } catch (err: any) {
      reply.status(500)
      return { ok: false, error: `清理失败: ${err.message}` }
    }
  })

  // 以项目为中心的单一 Skill 安装绑定接口
  app.post<{
    Body: { projectPath: string; skillName: string; targetIde?: string }
  }>('/api/projects/install-skill', async (req, reply) => {
    const { projectPath, skillName, targetIde } = req.body
    if (!projectPath || !skillName) {
      reply.status(400)
      return { ok: false, error: '未提供 projectPath 或 skillName' }
    }
    if (!isPlainSegment(skillName)) {
      reply.status(400)
      return { ok: false, error: 'skillName 不合法' }
    }
    if (!(await isValidProjectDir(projectPath))) {
      reply.status(400)
      return { ok: false, error: '项目路径必须是已存在目录的绝对路径' }
    }

    let profile = await readProjectProfile(projectPath)
    if (!profile) {
      const status = await getProjectSkillsStatus(projectPath)
      profile = {
        version: 1,
        name: path.basename(projectPath),
        description: '自动配置的项目 Profile',
        skills: status.actualSkills,
        targetIde: targetIde || 'claude-code',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    }

    if (targetIde) {
      profile.targetIde = targetIde
    }

    if (!profile.skills.includes(skillName)) {
      profile.skills.push(skillName)
    }

    await writeProjectProfile(projectPath, profile)
    const scanRes = await fullScan()
    const globalSkillsMap = new Map(scanRes.skills.map((s) => [s.name, s]))
    const { conflicts } = await syncProjectSkills(projectPath, globalSkillsMap)
    invalidateCache()

    return { ok: true, profile, conflicts }
  })

  // 以项目为中心的单一 Skill 卸载解绑接口
  app.post<{
    Body: { projectPath: string; skillName: string }
  }>('/api/projects/uninstall-skill', async (req, reply) => {
    const { projectPath, skillName } = req.body
    if (!projectPath || !skillName) {
      reply.status(400)
      return { ok: false, error: '未提供 projectPath 或 skillName' }
    }
    if (!isPlainSegment(skillName)) {
      reply.status(400)
      return { ok: false, error: 'skillName 不合法' }
    }
    if (!(await isValidProjectDir(projectPath))) {
      reply.status(400)
      return { ok: false, error: '项目路径必须是已存在目录的绝对路径' }
    }

    let profile = await readProjectProfile(projectPath)
    if (!profile) {
      const status = await getProjectSkillsStatus(projectPath)
      profile = {
        version: 1,
        name: path.basename(projectPath),
        description: '',
        skills: status.actualSkills,
        targetIde: 'claude-code',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    }

    profile.skills = profile.skills.filter((s) => s !== skillName)
    await writeProjectProfile(projectPath, profile)

    const scanRes = await fullScan()
    const globalSkillsMap = new Map(scanRes.skills.map((s) => [s.name, s]))
    const { conflicts } = await syncProjectSkills(projectPath, globalSkillsMap)
    invalidateCache()

    return { ok: true, profile, conflicts }
  })

  // 删除 / 隐藏项目接口
  app.post<{
    Body: { projectPath: string; purgeFiles?: boolean }
  }>('/api/projects/delete', async (req, reply) => {
    const { projectPath, purgeFiles } = req.body
    if (!projectPath) {
      reply.status(400)
      return { ok: false, error: '未提供 projectPath' }
    }
    if (!(await isValidProjectDir(projectPath))) {
      reply.status(400)
      return { ok: false, error: '项目路径必须是已存在目录的绝对路径' }
    }

    if (purgeFiles) {
      await purgeProjectSkillsAndProfile(projectPath)
    }

    await addExcludedProject(projectPath)
    invalidateCache()
    return { ok: true }
  })

  // 获取已隐藏/排除的项目列表
  app.get('/api/projects/excluded', async () => {
    const list = await getExcludedProjects()
    return { ok: true, excludedProjects: list }
  })

  // 恢复显示被隐藏的项目
  app.post<{
    Body: { projectPath: string }
  }>('/api/projects/restore', async (req, reply) => {
    const { projectPath } = req.body
    if (!projectPath) {
      reply.status(400)
      return { ok: false, error: '未提供 projectPath' }
    }

    await removeExcludedProject(projectPath)
    invalidateCache()
    return { ok: true }
  })
}
