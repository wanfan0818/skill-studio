import type { FastifyInstance } from 'fastify'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import { parseSkillMd } from '../scanner/parser.js'
import { invalidateCache } from './skills.js'
import { getWarehouseDirs } from '../settings.js'
import { execFileSafe } from '../utils/exec.js'
import { copyDir } from '../utils/fs.js'
import { isInside, isPlainSegment } from '../utils/safe.js'

/**
 * Temp clone directories created by THIS server process. Install / preview
 * requests may only reference these — a client-supplied `tempPath` used to be
 * passed straight to `fs.rm(..., { recursive: true, force: true })`.
 */
const cloneDirs = new Map<string, { createdAt: number; repoName: string }>()
const CLONE_TTL_MS = 60 * 60 * 1000

function pruneStaleClones() {
  const now = Date.now()
  for (const [dir, { createdAt }] of cloneDirs) {
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

/** Last path segment of a clone URL without `.git`, e.g. `owner/handdraw-skill.git` → `handdraw-skill`. */
export function repoNameFromUrl(url: string): string {
  return url.replace(/[#?].*$/, '').replace(/\/+$/, '').split(/[/:]/).pop()!.replace(/\.git$/, '')
}

const usableName = (n: unknown): n is string => isPlainSegment(n) && !n.startsWith('.') && !n.startsWith('skill-hub-git-')

/**
 * Directory name to install a cloned skill under. A skill in a subdirectory
 * keeps that directory's name. A repository whose ROOT is the skill would
 * otherwise get the random temp-dir name (`skill-hub-git-XXXX`), so use the
 * SKILL.md frontmatter `name`, then the repository name.
 */
export async function resolveInstallFolderName(skillPath: string, cloneDir: string, repoName: string): Promise<string | null> {
  const isRoot = path.resolve(skillPath) === path.resolve(cloneDir)
  if (!isRoot) {
    const base = path.basename(skillPath)
    return usableName(base) ? base : null
  }
  for (const file of ['SKILL.md', 'skill.md']) {
    try {
      const fmName = (await parseSkillMd(path.join(skillPath, file))).frontmatter?.name
      if (typeof fmName === 'string' && usableName(fmName.trim())) return fmName.trim()
      break
    } catch {}
  }
  return usableName(repoName) ? repoName : null
}

export interface RepoInput {
  cloneUrl: string
  /** `owner/repo` for GitHub inputs. */
  repo?: string
  /** Directory inside the repo the user pointed at (from a /tree/ or /blob/ URL). */
  subPath?: string
  /** A single skill the user pointed at (`owner/repo@skill`, skills.sh, `--skill x`). */
  skill?: string
}

const SEG = /^[A-Za-z0-9_.-]+$/

function github(owner: string, repo: string, extra: Partial<RepoInput> = {}): RepoInput | null {
  repo = repo.replace(/\.git$/, '')
  if (!SEG.test(owner) || !SEG.test(repo) || owner.startsWith('.') || repo.startsWith('.')) return null
  return { cloneUrl: `https://github.com/${owner}/${repo}.git`, repo: `${owner}/${repo}`, ...extra }
}

/**
 * Parse whatever people paste into the market box:
 *   owner/repo · owner/repo@skill · owner/repo.git
 *   github.com/owner/repo (with or without https://, www.)
 *   https://github.com/owner/repo/tree/<ref>/<dir> · …/blob/<ref>/<dir>/SKILL.md
 *   https://skills.sh/owner/repo/skill (the links shown in market results)
 *   npx skills add owner/repo [--skill name]
 *   git@host:owner/repo.git · any other https:// git URL
 */
export function parseRepoInput(input: string): RepoInput | null {
  if (typeof input !== 'string') return null
  let s = input.trim().replace(/^["'<]+|["'>]+$/g, '')
  if (!s || s.startsWith('-') || s.includes('\0')) return null

  // `npx skills add <src> [--skill <name>]` (also `npx -y skills add …`, `skills add …`)
  const cli = s.match(/^(?:npx\s+(?:-y\s+)?)?skills\s+(?:add|install|i)\s+(.+)$/i)
  if (cli) {
    const parts = cli[1].split(/\s+/)
    let skill: string | undefined
    let src: string | undefined
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '--skill' || parts[i] === '-s') skill = parts[++i]
      else if (!parts[i].startsWith('-') && !src) src = parts[i]
    }
    const r = src ? parseRepoInput(src) : null
    return r && skill && SEG.test(skill) ? { ...r, skill } : r
  }
  if (/\s/.test(s)) return null

  // owner/repo or owner/repo@skill
  const short = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)\/?(?:@([A-Za-z0-9_.-]+))?$/)
  if (short) return github(short[1], short[2], short[3] ? { skill: short[3] } : {})

  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_.\/-]+$/.test(s)) return { cloneUrl: s }

  if (/^(www\.)?(github\.com|skills\.sh)\//i.test(s)) s = 'https://' + s
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)

  if (host === 'skills.sh') {
    const [owner, repo, skill] = segs
    if (!owner || !repo) return null
    return github(owner, repo, skill && SEG.test(skill) ? { skill } : {})
  }
  if (host === 'github.com') {
    // Browser URLs: …/owner/repo/tree/main/sub, /blob/main/sub/SKILL.md.
    // git can only clone the root, so remember the directory to narrow results.
    const [owner, repo, kind, , ...rest] = segs
    if (!owner || !repo) return null
    let sub = kind === 'tree' || kind === 'blob' ? rest : []
    if (kind === 'blob' && sub.length && /\.md$/i.test(sub[sub.length - 1])) sub = sub.slice(0, -1)
    const subPath = sub.filter((p) => p !== '..' && p !== '.').join('/')
    return github(owner, repo, subPath ? { subPath } : {})
  }
  if (host === 'raw.githubusercontent.com') {
    const [owner, repo, , ...rest] = segs
    if (!owner || !repo) return null
    const sub = (/\.md$/i.test(rest[rest.length - 1] || '') ? rest.slice(0, -1) : rest).filter((p) => p !== '..' && p !== '.')
    return github(owner, repo, sub.length ? { subPath: sub.join('/') } : {})
  }
  return { cloneUrl: u.toString() }
}

/** Clone URL for a pasted repository reference (see parseRepoInput). */
export function normalizeCloneUrl(input: string): string | null {
  return parseRepoInput(input)?.cloneUrl ?? null
}

/** Turn git's stderr into something a user can act on. */
function cloneErrorMessage(err: any, input: RepoInput): string {
  const msg = String(err?.message || err)
  if (/not found|does not exist|Repository not found|could not read Username|Authentication failed|403/i.test(msg)) {
    return `找不到仓库 ${input.repo ?? input.cloneUrl}（地址写错了，或者是私有仓库）`
  }
  if (/timed out|timeout/i.test(msg)) return `克隆 ${input.repo ?? input.cloneUrl} 超时，请检查网络或代理后重试`
  if (/Could not resolve host|unable to access|Connection (refused|reset)|Failed to connect/i.test(msg)) {
    return `无法连接 GitHub：${msg.split('\n').find((l) => /fatal|unable|Could not/i.test(l))?.trim() ?? msg}`
  }
  return `Git 克隆或解析失败: ${msg}`
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

    const input = parseRepoInput(repoUrl)
    if (!input) {
      reply.status(400)
      return { ok: false, error: '仓库地址格式不正确（支持 owner/repo、owner/repo@skill、GitHub 网址、skills.sh 网址或 git@host:owner/repo）' }
    }
    const { cloneUrl } = input

    pruneStaleClones()
    let tempDir: string | null = null
    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-hub-git-'))
      cloneDirs.set(tempDir, { createdAt: Date.now(), repoName: repoNameFromUrl(cloneUrl) })

      await execFileSafe('git', ['clone', '--depth', '1', '--single-branch', '--', cloneUrl, tempDir], {
        timeoutMs: 120_000,
        // Never hang on a credential prompt for a private / mistyped repo.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })

      let skillDirs = await findSkillsInDir(tempDir)
      let notice: string | undefined
      // A /tree/<ref>/<dir> URL: keep only skills under that directory. The ref
      // may itself contain slashes, so also try dropping leading segments.
      if (input.subPath) {
        const segs = input.subPath.split('/')
        let narrowed: string[] = []
        for (let i = 0; i < segs.length && !narrowed.length; i++) {
          const base = path.join(tempDir, ...segs.slice(i))
          narrowed = skillDirs.filter((d) => d === base || d.startsWith(base + path.sep))
        }
        if (narrowed.length) skillDirs = narrowed
        else notice = `仓库里没有找到目录 ${input.subPath}，已列出全部 Skill`
      }
      
      const skills = []
      for (const skillDir of skillDirs) {
        const skillName = (await resolveInstallFolderName(skillDir, tempDir, repoNameFromUrl(cloneUrl))) ?? path.basename(skillDir)
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

      let result = skills
      if (input.skill) {
        const want = input.skill.toLowerCase()
        const hit = skills.filter((k) => k.dirName.toLowerCase() === want || String(k.name).toLowerCase() === want)
        if (hit.length) result = hit
        else notice = `仓库里没有找到 Skill「${input.skill}」，已列出全部 Skill`
      }
      if (!result.length) notice = notice ?? '这个仓库里没有找到包含 SKILL.md 的目录'

      return {
        ok: true,
        tempPath: tempDir,
        repo: input.repo ?? null,
        notice,
        skills: result
      }
    } catch (err: any) {
      // Don't leave a half-cloned temp dir behind.
      if (tempDir) {
        cloneDirs.delete(tempDir)
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
      reply.status(500)
      return { ok: false, error: cloneErrorMessage(err, input) }
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
      // "Global" = the skill warehouse, the single source that distribution
      // links into every IDE (see server/distribution).
      destParentDir = (await getWarehouseDirs())[0]
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

    const skillFolderName = await resolveInstallFolderName(skillPath, ownedTemp, cloneDirs.get(ownedTemp)!.repoName)
    if (!skillFolderName) {
      reply.status(400)
      return { ok: false, error: '无法确定 Skill 目录名：SKILL.md 的 name 与仓库名都不能用作目录名' }
    }
    const destPath = path.join(destParentDir, skillFolderName)

    try {
      await fs.access(destPath)
      reply.status(409)
      return { ok: false, error: `目标位置已存在同名 Skill: ${destPath}` }
    } catch {}

    try {
      await fs.mkdir(destParentDir, { recursive: true })
      // Never carry the clone's .git along (a repo-root skill would otherwise
      // become a nested git repository inside the warehouse).
      await copyDir(skillPath, destPath, { skip: (name) => name === '.git' })

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
