import type { FastifyInstance } from 'fastify'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import { parseSkillMd } from '../scanner/parser.js'
import { invalidateCache } from './skills.js'
import { readIdeSettingsFull } from '../settings.js'
import { execFileSafe } from '../utils/exec.js'
import { isInside, isPlainSegment } from '../utils/safe.js'

/**
 * Temp clone directories created by THIS server process. Install / preview
 * requests may only reference these — a client-supplied `tempPath` used to be
 * passed straight to `fs.rm(..., { recursive: true, force: true })`.
 */
const cloneDirs = new Map<string, number>()
const CLONE_TTL_MS = 60 * 60 * 1000

function pruneStaleClones() {
  const now = Date.now()
  for (const [dir, createdAt] of cloneDirs) {
    if (now - createdAt > CLONE_TTL_MS) {
      cloneDirs.delete(dir)
      void fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** Resolve `p` to the registered clone dir that contains it, or null. */
export async function findOwningCloneDir(p: string): Promise<string | null> {
  if (typeof p !== 'string' || !p) return null
  for (const dir of cloneDirs.keys()) {
    if (await isInside(p, dir)) return dir
  }
  return null
}

/** Accept `owner/repo`, an https:// git URL, or an scp-style `git@host:owner/repo`. */
function normalizeCloneUrl(input: string): string | null {
  const s = input.trim()
  if (!s || s.startsWith('-') || /[\s\0]/.test(s)) return null
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return `https://github.com/${s}.git`
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_.\/-]+$/.test(s)) return s
  try {
    const u = new URL(s)
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.toString()
  } catch {}
  return null
}

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

    const cloneUrl = typeof repoUrl === 'string' ? normalizeCloneUrl(repoUrl) : null
    if (!cloneUrl) {
      reply.status(400)
      return { ok: false, error: '仓库地址格式不正确（支持 owner/repo、https:// 或 git@host:owner/repo）' }
    }

    pruneStaleClones()
    try {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-hub-git-'))
      cloneDirs.set(tempDir, Date.now())

      await execFileSafe('git', ['clone', '--depth', '1', '--', cloneUrl, tempDir], {
        timeoutMs: 30000,
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

    // Both paths must belong to a clone this server created.
    const ownedTemp = cloneDirs.has(tempPath) ? tempPath : null
    if (!ownedTemp || !(await isInside(skillPath, ownedTemp))) {
      reply.status(403)
      return { ok: false, error: '未知的临时克隆目录，请重新克隆仓库' }
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
      if (!path.isAbsolute(projectPath)) {
        reply.status(400)
        return { ok: false, error: 'projectPath 必须是绝对路径' }
      }
      destParentDir = path.join(projectPath, '.claude', 'skills')
    }

    const skillFolderName = path.basename(skillPath)
    if (!isPlainSegment(skillFolderName) || skillFolderName.startsWith('skill-hub-git-')) {
      reply.status(400)
      return { ok: false, error: '无法确定 Skill 目录名' }
    }
    const destPath = path.join(destParentDir, skillFolderName)

    try {
      await fs.access(destPath)
      reply.status(409)
      return { ok: false, error: `目标位置已存在同名 Skill: ${destPath}` }
    } catch {}

    try {
      await fs.mkdir(destParentDir, { recursive: true })
      await fs.cp(skillPath, destPath, { recursive: true })

      invalidateCache()
      return { ok: true }
    } catch (err: any) {
      reply.status(500)
      return { ok: false, error: `拷贝技能目录失败: ${err.message}` }
    } finally {
      cloneDirs.delete(ownedTemp)
      await fs.rm(ownedTemp, { recursive: true, force: true }).catch(() => {})
    }
  })
}
