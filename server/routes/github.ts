import type { FastifyInstance } from 'fastify'
import { exec } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import { parseSkillMd } from '../scanner/parser.js'
import { invalidateCache } from './skills.js'
import { readIdeSettingsFull } from './manage.js'

const execAsync = promisify(exec)

async function findSkillsInDir(dir: string, depth: number = 0, maxDepth: number = 5): Promise<string[]> {
  if (depth > maxDepth) return []
  const skills: string[] = []

  const skillMdNames = ['SKILL.md', 'skill.md']
  let hasSkillMd = false
  try {
    const entries = await fs.readdir(dir)
    hasSkillMd = entries.some(e => skillMdNames.includes(e))
  } catch {
    return []
  }

  if (hasSkillMd) {
    skills.push(dir)
    return skills
  }

  let subdirs: string[] = []
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') {
        subdirs.push(path.join(dir, entry.name))
      }
    }
  } catch {}

  for (const subdir of subdirs) {
    const subSkills = await findSkillsInDir(subdir, depth + 1, maxDepth)
    skills.push(...subSkills)
  }

  return skills
}

export async function githubRoutes(app: FastifyInstance) {
  // POST /api/skills/market/github-clone
  app.post<{
    Body: { repoUrl: string }
  }>('/api/skills/market/github-clone', async (req, reply) => {
    const { repoUrl } = req.body
    if (!repoUrl) {
      reply.status(400)
      return { ok: false, error: 'repoUrl is required' }
    }

    let cloneUrl = repoUrl.trim()
    if (!cloneUrl.startsWith('http://') && !cloneUrl.startsWith('https://') && !cloneUrl.startsWith('git@')) {
      cloneUrl = `https://github.com/${cloneUrl}.git`
    }

    try {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-hub-git-'))
      
      await execAsync(`git clone --depth 1 "${cloneUrl}" "${tempDir}"`, {
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      const skillDirs = await findSkillsInDir(tempDir)
      
      const skills = []
      for (const skillDir of skillDirs) {
        const skillName = path.basename(skillDir)
        let name = skillName
        let description = '无描述'
        let hasFrontmatter = false

        const skillMdPath = path.join(skillDir, 'SKILL.md')
        const skillMdPathLower = path.join(skillDir, 'skill.md')
        let targetSkillMd = ''
        try {
          await fs.access(skillMdPath)
          targetSkillMd = skillMdPath
        } catch {
          try {
            await fs.access(skillMdPathLower)
            targetSkillMd = skillMdPathLower
          } catch {}
        }

        if (targetSkillMd) {
          try {
            const parsed = await parseSkillMd(targetSkillMd)
            if (parsed.frontmatter) {
              if (parsed.frontmatter.name) {
                name = parsed.frontmatter.name
                hasFrontmatter = true
              }
              if (parsed.frontmatter.description) {
                description = parsed.frontmatter.description
              }
            }
          } catch {}
        }

        skills.push({
          name,
          description,
          dirName: skillName,
          absPath: skillDir,
          hasFrontmatter
        })
      }

      return {
        ok: true,
        tempPath: tempDir,
        skills
      }
    } catch (err: any) {
      reply.status(500)
      return { ok: false, error: `Git 克隆或解析失败: ${err.message}` }
    }
  })

  // POST /api/skills/market/github-install
  app.post<{
    Body: { tempPath: string; skillPath: string; scope: 'global' | 'project'; projectPath?: string }
  }>('/api/skills/market/github-install', async (req, reply) => {
    const { tempPath, skillPath, scope, projectPath } = req.body
    if (!tempPath || !skillPath) {
      reply.status(400)
      return { ok: false, error: 'tempPath and skillPath are required' }
    }

    let destParentDir = ''
    if (scope === 'global') {
      const settings = await readIdeSettingsFull()
      destParentDir = settings.customGlobalSkillsDir || path.join(os.homedir(), '.claude', 'skills')
    } else {
      if (!projectPath) {
        reply.status(400)
        return { ok: false, error: 'projectPath is required for project scope' }
      }
      destParentDir = path.join(projectPath, '.claude', 'skills')
    }

    try {
      const skillFolderName = path.basename(skillPath)
      const destPath = path.join(destParentDir, skillFolderName)

      await fs.mkdir(destParentDir, { recursive: true })
      await fs.cp(skillPath, destPath, { recursive: true })

      invalidateCache()
      return { ok: true }
    } catch (err: any) {
      reply.status(500)
      return { ok: false, error: `拷贝技能目录失败: ${err.message}` }
    } finally {
      try {
        await fs.rm(tempPath, { recursive: true, force: true })
      } catch {}
    }
  })
}
