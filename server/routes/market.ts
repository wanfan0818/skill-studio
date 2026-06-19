import type { FastifyInstance } from 'fastify'
import { exec } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import { invalidateCache } from './skills.js'
import { readIdeSettingsFull, copyDir } from './manage.js'

const execAsync = promisify(exec)

function stripAnsi(str: string): string {
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
}

export async function marketRoutes(app: FastifyInstance) {
  // Search skills using CLI
  app.get<{
    Querystring: { q: string }
  }>('/api/skills/market/search', async (req) => {
    const q = req.query.q
    if (!q) {
      return { ok: true, items: [] }
    }

    try {
      // Run skills find in temp dir to prevent workspace pollution
      const { stdout } = await execAsync(`npx -y skills find "${q}"`, {
        cwd: os.tmpdir(),
        timeout: 20000, // 20s
        stdio: ['ignore', 'pipe', 'pipe']
      })

      const lines = stdout.split('\n').map((l) => stripAnsi(l.trim())).filter(Boolean)
      const items = []

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]

        // Regex to match e.g. "xixu-me/skills@github-actions-docs 221.3K installs"
        const match = line.match(/^([^\s@]+)@([^\s@]+)\s+(.+)$/)
        if (match) {
          const repoPath = match[1]
          const name = match[2]
          const installs = match[3]
          const fullId = `${repoPath}@${name}`

          let url = ''
          if (i + 1 < lines.length && lines[i + 1].includes('https://')) {
            url = lines[i + 1].replace(/^[└\s\-]+/, '').trim()
            i++ // Skip url line
          }

          items.push({
            fullId,
            repoPath,
            name,
            installs,
            url,
          })
        }
      }

      return { ok: true, items }
    } catch (err: any) {
      // The CLI may return error exit code if no results found. Return empty items in this case.
      return { ok: true, items: [], error: err.message }
    }
  })

  // Install skill using CLI
  app.post<{
    Body: { target: string; scope: 'global' | 'project'; projectPath?: string }
  }>('/api/skills/market/install', async (req, reply) => {
    const { target, scope, projectPath } = req.body
    if (!target) {
      reply.status(400)
      return { ok: false, error: 'Target is required' }
    }

    let installCwd = os.homedir()
    if (scope === 'project') {
      if (!projectPath) {
        reply.status(400)
        return { ok: false, error: 'Project path is required for project scope' }
      }
      installCwd = projectPath
    }

    try {
      const { stdout, stderr } = await execAsync(`npx -y skills add "${target}"`, {
        cwd: installCwd,
        timeout: 60000, // 60s for clone
        stdio: ['ignore', 'pipe', 'pipe']
      })

      const settings = await readIdeSettingsFull()
      if (scope === 'global' && settings.customGlobalSkillsDir) {
        let skillFolderName = ''
        const atIdx = target.lastIndexOf('@')
        if (atIdx !== -1) {
          skillFolderName = target.slice(atIdx + 1)
        } else {
          const slashIdx = target.lastIndexOf('/')
          skillFolderName = slashIdx !== -1 ? target.slice(slashIdx + 1) : target
        }

        if (skillFolderName) {
          const srcPath = path.join(os.homedir(), '.claude', 'skills', skillFolderName)
          const destPath = path.join(settings.customGlobalSkillsDir, skillFolderName)
          try {
            await fs.mkdir(settings.customGlobalSkillsDir, { recursive: true })
            try {
              await fs.rename(srcPath, destPath)
            } catch {
              await copyDir(srcPath, destPath)
              await fs.rm(srcPath, { recursive: true })
            }
          } catch (err: any) {
            console.error(`[market-install] Failed to move installed skill ${skillFolderName} to custom global path:`, err)
          }
        }
      }

      // Re-scan and synchronize symlinks
      const { fullScan } = await import('../scanner/discovery.js')
      const { ensureEnabledIdesSymlinks } = await import('./manage.js')
      const scanRes = await fullScan()
      await ensureEnabledIdesSymlinks(scanRes.skills)

      invalidateCache()
      return { ok: true, log: stdout + '\n' + stderr }
    } catch (err: any) {
      reply.status(500)
      return { ok: false, error: err.message || 'Installation failed' }
    }
  })

  // Get README/SKILL.md content for preview
  app.get<{
    Querystring: { repo?: string; name?: string; tempPath?: string; skillPath?: string }
  }>('/api/skills/market/readme', async (req, reply) => {
    const { repo, name, skillPath } = req.query

    // Case 1: Local temporary path (cloned from GitHub)
    if (skillPath) {
      let resolved = path.resolve(skillPath)
      let tmpDirResolved = path.resolve(os.tmpdir())
      try {
        resolved = await fs.realpath(resolved)
        tmpDirResolved = await fs.realpath(tmpDirResolved)
      } catch {}
      const isUnderTemp = 
        resolved.startsWith(tmpDirResolved) ||
        resolved.startsWith('/var/folders') ||
        resolved.startsWith('/private/var/folders') ||
        resolved.startsWith('/tmp') ||
        resolved.startsWith('/private/tmp')

      if (!isUnderTemp) {
        reply.status(403)
        return { error: 'Access denied' }
      }

      const skillMd = path.join(resolved, 'SKILL.md')
      const skillMdLower = path.join(resolved, 'skill.md')
      try {
        try {
          const content = await fs.readFile(skillMd, 'utf-8')
          return { content }
        } catch {
          const content = await fs.readFile(skillMdLower, 'utf-8')
          return { content }
        }
      } catch (err: any) {
        reply.status(404)
        return { error: `无法读取本地 SKILL.md: ${err.message}` }
      }
    }

    // Case 2: Online GitHub repository
    if (repo && name) {
      const urls = [
        `https://raw.githubusercontent.com/${repo}/main/${name}/SKILL.md`,
        `https://raw.githubusercontent.com/${repo}/master/${name}/SKILL.md`,
        `https://raw.githubusercontent.com/${repo}/main/${name}/skill.md`,
        `https://raw.githubusercontent.com/${repo}/master/${name}/skill.md`,
        `https://raw.githubusercontent.com/${repo}/main/SKILL.md`,
        `https://raw.githubusercontent.com/${repo}/master/SKILL.md`,
      ]

      for (const url of urls) {
        try {
          const res = await fetch(url)
          if (res.ok) {
            const content = await res.text()
            return { content }
          }
        } catch {}
      }

      reply.status(404)
      return { error: '未能在 GitHub 上找到该 Skill 的 SKILL.md' }
    }

    reply.status(400)
    return { error: 'Missing parameters' }
  })
}
