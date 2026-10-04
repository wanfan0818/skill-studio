import type { FastifyInstance } from 'fastify'
import os from 'os'
import fs from 'fs/promises'
import path from 'path'
import { fullScan } from '../scanner/discovery.js'
import { AGENTS } from '../scanner/agents.js'
import type { ScanResult, Skill } from '../types.js'

let cachedResult: ScanResult | null = null

export function getCachedResult(): ScanResult | null {
  return cachedResult
}

export async function skillRoutes(app: FastifyInstance) {
  // Trigger full scan
  app.get('/api/scan', async () => {
    cachedResult = await fullScan()
    return cachedResult
  })

  // Get all skills (with optional filters)
  app.get<{
    Querystring: { scope?: string; source?: string; agent?: string; category?: string; search?: string }
  }>('/api/skills', async (req) => {
    if (!cachedResult) {
      cachedResult = await fullScan()
    }

    let skills = [...cachedResult.skills]
    const { scope, source, agent, category, search } = req.query

    if (scope && scope !== 'all') {
      skills = skills.filter((s) => s.scope === scope)
    }
    if (source && source !== 'all') {
      skills = skills.filter((s) => s.source === source)
    }
    if (agent && agent !== 'all') {
      skills = skills.filter((s) => s.agent === agent)
    }
    if (category && category !== 'all') {
      skills = skills.filter((s) => s.category === category)
    }
    if (search) {
      const q = search.toLowerCase()
      skills = skills.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      )
    }

    return { skills, stats: cachedResult.stats }
  })

  // Get single skill detail
  app.get<{ Params: { id: string } }>('/api/skills/:id', async (req, reply) => {
    if (!cachedResult) {
      cachedResult = await fullScan()
    }
    const skill = cachedResult.skills.find((s) => s.id === req.params.id)
    if (!skill) {
      return reply.status(404).send({ error: 'Skill not found' })
    }
    return skill
  })

  // Get the agent registry (id/name/icon) — used by the frontend filter UI
  app.get('/api/agents', async () => {
    return AGENTS.map((a) => ({ id: a.id, name: a.name, icon: a.icon }))
  })


  // Get conflicts
  app.get('/api/conflicts', async () => {
    if (!cachedResult) {
      cachedResult = await fullScan()
    }
    return cachedResult.conflicts
  })

  // Get stats
  app.get('/api/stats', async () => {
    if (!cachedResult) {
      cachedResult = await fullScan()
    }
    return cachedResult.stats
  })

  // Diagnostic endpoint — useful for debugging "only found 1 skill" reports
  app.get('/api/debug', async () => {
    if (!cachedResult) {
      cachedResult = await fullScan()
    }
    return {
      version: '0.3.0',
      node: process.version,
      platform: process.platform,
      cwd: process.cwd(),
      homedir: os.homedir(),
      env: {
        SKILL_HUB_EXTRA_PATHS: process.env.SKILL_HUB_EXTRA_PATHS || null,
        PORT: process.env.PORT || null,
      },
      scan: {
        durationMs: cachedResult.durationMs,
        totalSkills: cachedResult.stats.total,
        scannedPaths: cachedResult.scannedPaths,
      },
      stats: cachedResult.stats,
      health: cachedResult.health,
      categories: cachedResult.categories,
    }
  })

  // Fix missing Frontmatter by prepending yaml header
  app.post<{ Params: { id: string } }>('/api/skills/:id/fix-frontmatter', async (req, reply) => {
    if (!cachedResult) {
      cachedResult = await fullScan()
    }
    const skill = cachedResult.skills.find((s) => s.id === req.params.id)
    if (!skill) {
      return reply.status(404).send({ error: 'Skill not found' })
    }

    const skillMdPath = path.join(skill.realPath, 'SKILL.md')
    try {
      let currentContent = ''
      try {
        currentContent = await fs.readFile(skillMdPath, 'utf-8')
      } catch {}

      // 如果有 # Role 或者是其他标题，我们在它前面灌入 Frontmatter
      const yamlHeader = `---\nname: ${skill.name}\ndescription: ${skill.description || 'Auto-generated skill'}\n---\n\n`
      const newContent = yamlHeader + currentContent

      // 写入文件
      await fs.writeFile(skillMdPath, newContent, 'utf-8')
      invalidateCache()
      
      // 触发一次扫描
      cachedResult = await fullScan()
      return { ok: true }
    } catch (err: any) {
      return reply.status(500).send({ error: `无法写入标头: ${err.message}` })
    }
  })
}

async function samePath(a: string, b: string): Promise<boolean> {
  if (path.resolve(a) === path.resolve(b)) return true
  try {
    return (await fs.realpath(a)) === (await fs.realpath(b))
  } catch {
    return false
  }
}

/**
 * Resolve a skill the scanner actually discovered, by id or by its path /
 * realPath. Mutating endpoints use this instead of trusting a client-supplied
 * path, so they can only ever touch real skill directories.
 * Retries once with a fresh scan in case the cache is stale.
 */
export async function findKnownSkill(match: { id?: string; path?: string }): Promise<Skill | undefined> {
  const lookup = async (skills: Skill[]) => {
    if (match.id) return skills.find((s) => s.id === match.id)
    if (match.path && typeof match.path === 'string') {
      for (const s of skills) {
        if ((await samePath(s.path, match.path)) || (await samePath(s.realPath, match.path))) return s
      }
    }
    return undefined
  }
  if (cachedResult) {
    const hit = await lookup(cachedResult.skills)
    if (hit) return hit
  }
  cachedResult = await fullScan()
  return lookup(cachedResult.skills)
}

export function invalidateCache() {
  cachedResult = null
}
