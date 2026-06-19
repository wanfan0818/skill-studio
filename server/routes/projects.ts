import type { FastifyInstance } from 'fastify'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { discoverProjects, fullScan } from '../scanner/discovery.js'
import { AGENTS } from '../scanner/agents.js'
import { recommendSkills } from '../recommender/engine.js'
import { invalidateCache } from './skills.js'
import type { SkillProfile, ProjectWithProfile } from '../types.js'

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
  await fs.writeFile(profilePath, JSON.stringify(profile, null, 2), 'utf-8')
}

/**
 * 辅助函数：查找某项目实际链接的 Skill 数量与状态
 */
async function getProjectSkillsStatus(
  projectPath: string,
  profile?: SkillProfile
): Promise<{ linkedCount: number; status: 'synced' | 'drift' | 'no-profile' }> {
  if (!profile) {
    return { linkedCount: 0, status: 'no-profile' }
  }

  const agent = AGENTS.find(a => a.id === profile.targetIde)
  const relPaths = agent && agent.projectPaths.length > 0 ? agent.projectPaths : ['.agents/skills']
  const targetDir = path.join(projectPath, relPaths[0])

  let linkedCount = 0
  const actualLinkedSkills = new Set<string>()

  try {
    const entries = await fs.readdir(targetDir, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(targetDir, entry.name)
      try {
        const stat = await fs.lstat(entryPath)
        if (stat.isSymbolicLink()) {
          linkedCount++
          actualLinkedSkills.add(entry.name)
        }
      } catch {}
    }
  } catch {}

  // 检查是否漂移：声明的技能和实际软链接的技能是否一致
  const declaredSkills = new Set(profile.skills)
  let isSynced = true

  for (const s of declaredSkills) {
    if (!actualLinkedSkills.has(s)) {
      isSynced = false
      break
    }
  }

  if (isSynced) {
    for (const s of actualLinkedSkills) {
      if (!declaredSkills.has(s)) {
        isSynced = false
        break
      }
    }
  }

  return {
    linkedCount,
    status: isSynced ? 'synced' : 'drift'
  }
}

export async function projectRoutes(app: FastifyInstance) {
  // 1. GET /api/projects - 获取所有项目及配置信息
  app.get('/api/projects', async () => {
    const found = await discoverProjects()
    const projectsWithProfile: ProjectWithProfile[] = []

    for (const p of found) {
      const profile = await readProjectProfile(p.path)
      const { linkedCount, status } = await getProjectSkillsStatus(p.path, profile)

      projectsWithProfile.push({
        name: profile?.name || p.name,
        path: p.path,
        skillCount: linkedCount, // 作为向后兼容，这个值表示实际链接数
        profile,
        linkedSkillCount: linkedCount,
        profileSkillCount: profile?.skills.length || 0,
        syncStatus: status
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

    const profile = await readProjectProfile(projectPath)
    if (!profile) {
      reply.status(404)
      return { ok: false, error: '该项目未创建 Skill 配置' }
    }

    // 1. 获取全局所有的 Skill 映射（用于解析真实路径）
    const scanRes = await fullScan()
    const globalSkillsMap = new Map(scanRes.skills.map(s => [s.name, s]))

    // 2. 找到目标 IDE 的项目级路径
    const agent = AGENTS.find(a => a.id === profile.targetIde)
    const relPaths = agent && agent.projectPaths.length > 0 ? agent.projectPaths : ['.agents/skills']
    const targetDir = path.join(projectPath, relPaths[0])

    try {
      // 创建目标目录
      await fs.mkdir(targetDir, { recursive: true })

      // 收集当前目录中所有的软链接，准备进行清理
      const existingEntries = await fs.readdir(targetDir, { withFileTypes: true })
      const toDelete = new Set<string>()

      for (const entry of existingEntries) {
        const entryPath = path.join(targetDir, entry.name)
        try {
          const lstat = await fs.lstat(entryPath)
          if (lstat.isSymbolicLink()) {
            toDelete.add(entry.name)
          }
        } catch {}
      }

      const results = []

      // 3. 开始创建或更新软链接
      for (const skillName of profile.skills) {
        const skill = globalSkillsMap.get(skillName)
        if (!skill) {
          results.push({ name: skillName, success: false, error: '全局技能库中未找到此 Skill' })
          continue
        }

        const targetLinkPath = path.join(targetDir, skill.name)
        let resolvedRealPath: string
        try {
          resolvedRealPath = await fs.realpath(skill.realPath)
        } catch {
          resolvedRealPath = path.resolve(skill.realPath)
        }

        // 如果已经是一个软链接并且指向了正确的真实路径，就保留
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
              resolvedTarget = await fs.realpath(path.resolve(targetDir, currentTarget))
            } catch {
              resolvedTarget = path.resolve(targetDir, currentTarget)
            }

            if (resolvedTarget === resolvedRealPath) {
              // 已经在目标位置且指向正确，从删除列表中移出
              toDelete.delete(skill.name)
              results.push({ name: skill.name, success: true, message: '无需更新' })
              continue
            }
          }
          // 如果是一个真实文件夹或错误的软链接，先删除它
          await fs.unlink(targetLinkPath).catch(async () => {
            // 如果是文件夹，说明有同名非软链接，为了安全我们不直接删除真实文件夹
            throw new Error('存在同名的物理文件/文件夹，未进行覆盖')
          })
        }

        // 创建新的软链接
        try {
          await fs.symlink(resolvedRealPath, targetLinkPath, 'dir')
          toDelete.delete(skill.name)
          results.push({ name: skill.name, success: true })
        } catch (err: any) {
          results.push({ name: skill.name, success: false, error: err.message })
        }
      }

      // 4. 清理多余的旧软链接
      for (const name of toDelete) {
        const linkPath = path.join(targetDir, name)
        await fs.unlink(linkPath).catch(() => {})
      }

      invalidateCache()
      return { ok: true, results }
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
}
