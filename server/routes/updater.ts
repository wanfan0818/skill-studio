import type { FastifyInstance } from 'fastify'
import { fullScan } from '../scanner/discovery.js'
import { getCachedResult, invalidateCache } from './skills.js'
import { parseGithubUrl, readSkillSource, writeSkillSource, findSourceInManifests } from '../updater/source.js'
import { checkSkillUpdate, getGithubRateLimit } from '../updater/checker.js'
import { updateSkillFromGithub } from '../updater/installer.js'

async function getSkillsList() {
  let cached = getCachedResult()
  if (!cached) {
    cached = await fullScan()
  }
  return cached.skills
}

export async function updaterRoutes(app: FastifyInstance) {
  // GET /api/skills/updater/rate-limit
  app.get('/api/skills/updater/rate-limit', async () => {
    try {
      const rateLimit = await getGithubRateLimit()
      return { ok: true, rateLimit }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  // POST /api/skills/updater/bind
  app.post<{
    Body: { skillId: string; githubUrl: string }
  }>('/api/skills/updater/bind', async (req, reply) => {
    const { skillId, githubUrl } = req.body
    if (!skillId || !githubUrl) {
      return reply.status(400).send({ error: 'skillId and githubUrl are required' })
    }

    const skills = await getSkillsList()
    const skill = skills.find((s) => s.id === skillId)
    if (!skill) {
      return reply.status(404).send({ error: 'Skill not found' })
    }

    const parsed = parseGithubUrl(githubUrl)
    if (!parsed) {
      return reply.status(400).send({ error: '无效的 GitHub 链接格式。请提供类似于 owner/repo 或完整的 GitHub 网址。' })
    }

    const existingSource = await readSkillSource(skill.realPath)
    const newSource = {
      owner: parsed.owner,
      repo: parsed.repo,
      branch: parsed.branch,
      subPath: parsed.subPath,
      installedCommit: existingSource?.installedCommit || undefined,
      installedAt: existingSource?.installedAt || new Date().toISOString(),
      lastChecked: new Date().toISOString(),
      updateAvailable: false,
    }

    try {
      await writeSkillSource(skill.realPath, newSource)
      invalidateCache()
      return { ok: true, source: newSource }
    } catch (err: any) {
      return reply.status(500).send({ error: `无法保存绑定信息: ${err.message}` })
    }
  })

  // GET /api/skills/updater/check/:id
  app.get<{ Params: { id: string } }>('/api/skills/updater/check/:id', async (req, reply) => {
    const skills = await getSkillsList()
    const skill = skills.find((s) => s.id === req.params.id)
    if (!skill) {
      return reply.status(404).send({ error: 'Skill not found' })
    }

    const source = await readSkillSource(skill.realPath)
    if (!source) {
      return reply.status(400).send({ error: '该 Skill 尚未绑定 GitHub 来源' })
    }

    try {
      const result = await checkSkillUpdate(source)
      
      // Update .skill-source with check results
      source.updateAvailable = result.hasUpdate
      source.latestCommit = result.latestCommit
      source.lastChecked = new Date().toISOString()
      await writeSkillSource(skill.realPath, source)
      
      invalidateCache()

      return {
        ok: true,
        hasUpdate: result.hasUpdate,
        latestCommit: result.latestCommit,
        latestDate: result.latestDate,
        rateLimit: result.rateLimit,
      }
    } catch (err: any) {
      console.error(`Check update failed for ${skill.name}:`, err)
      return reply.status(500).send({ error: `检查更新失败: ${err.message}` })
    }
  })

  // GET /api/skills/updater/check
  // Checks all skills that have githubSource configured
  app.get('/api/skills/updater/check', async () => {
    const skills = await getSkillsList()
    const githubSkills = skills.filter((s) => s.githubSource)

    if (githubSkills.length === 0) {
      const rateLimit = await getGithubRateLimit()
      return { ok: true, checkedCount: 0, updatedCount: 0, results: [], rateLimit }
    }

    let checkedCount = 0
    let updatedCount = 0
    const results: any[] = []
    let finalRateLimit: any = null

    // Run checks in parallel with a small limit or just simple Promise.all
    // Simple Promise.all is fine since number of github skills is typically small/moderate,
    // but to avoid hitting rate limit or socket issues, let's do it sequentially or in chunks of 5.
    const chunkSize = 5
    for (let i = 0; i < githubSkills.length; i += chunkSize) {
      const chunk = githubSkills.slice(i, i + chunkSize)
      await Promise.all(
        chunk.map(async (skill) => {
          const source = skill.githubSource!
          try {
            const res = await checkSkillUpdate(source)
            checkedCount++
            if (res.hasUpdate) {
              updatedCount++
            }
            // Save state
            source.updateAvailable = res.hasUpdate
            source.latestCommit = res.latestCommit
            source.lastChecked = new Date().toISOString()
            await writeSkillSource(skill.realPath, source)

            results.push({
              skillId: skill.id,
              skillName: skill.name,
              hasUpdate: res.hasUpdate,
              latestCommit: res.latestCommit,
              success: true,
            })
            finalRateLimit = res.rateLimit
          } catch (err: any) {
            console.error(`Batch check update failed for ${skill.name}:`, err)
            results.push({
              skillId: skill.id,
              skillName: skill.name,
              success: false,
              error: err.message,
            })
          }
        })
      )
    }

    invalidateCache()

    if (!finalRateLimit) {
      finalRateLimit = await getGithubRateLimit()
    }

    return {
      ok: true,
      checkedCount,
      updatedCount,
      results,
      rateLimit: finalRateLimit,
    }
  })

  // POST /api/skills/updater/update/:id
  app.post<{
    Body: { latestCommit?: string }
    Params: { id: string }
  }>('/api/skills/updater/update/:id', async (req, reply) => {
    const { latestCommit } = req.body || {}
    const skills = await getSkillsList()
    const skill = skills.find((s) => s.id === req.params.id)
    if (!skill) {
      return reply.status(404).send({ error: 'Skill not found' })
    }

    const source = await readSkillSource(skill.realPath)
    if (!source) {
      return reply.status(400).send({ error: '该 Skill 尚未绑定 GitHub 来源' })
    }

    try {
      await updateSkillFromGithub(skill.realPath, source, latestCommit)
      invalidateCache()
      return { ok: true }
    } catch (err: any) {
      return reply.status(500).send({ error: `更新失败: ${err.message}` })
    }
  })

  // POST /api/skills/updater/update-all
  app.post('/api/skills/updater/update-all', async (req, reply) => {
    const skills = await getSkillsList()
    // Find all skills that have updates available
    const toUpdate = skills.filter((s) => s.githubSource?.updateAvailable)

    if (toUpdate.length === 0) {
      return { ok: true, updatedCount: 0 }
    }

    const results: any[] = []
    let updatedCount = 0

    // Update sequentially to avoid git locks
    for (const skill of toUpdate) {
      const source = skill.githubSource!
      try {
        await updateSkillFromGithub(skill.realPath, source, source.latestCommit)
        updatedCount++
        results.push({
          skillId: skill.id,
          skillName: skill.name,
          success: true,
        })
      } catch (err: any) {
        results.push({
          skillId: skill.id,
          skillName: skill.name,
          success: false,
          error: err.message,
        })
      }
    }

    invalidateCache()
    return {
      ok: true,
      updatedCount,
      results,
    }
  })

  // POST /api/skills/updater/auto-link
  app.post('/api/skills/updater/auto-link', async (req, reply) => {
    const { discoverProjects } = await import('../scanner/discovery.js')
    const projects = await discoverProjects()
    const skills = await getSkillsList()

    let boundCount = 0
    const boundSkills: string[] = []

    for (const skill of skills) {
      // If already has a source on disk, skip
      const existing = await readSkillSource(skill.realPath)
      if (existing) continue

      // Look in manifests
      const found = await findSourceInManifests(skill.name, skill.realPath, skill.projectPath)
      if (found) {
        const newSource = {
          owner: found.owner,
          repo: found.repo,
          branch: found.branch,
          subPath: found.subPath,
          installedCommit: found.installedCommit,
          installedAt: new Date().toISOString(),
          lastChecked: new Date().toISOString(),
          updateAvailable: false,
        }
        await writeSkillSource(skill.realPath, newSource)
        boundCount++
        boundSkills.push(skill.name)
      }
    }

    if (boundCount > 0) {
      invalidateCache()
    }

    // Recalculate total bound skills
    let totalBound = 0
    const updatedSkills = await getSkillsList()
    for (const skill of updatedSkills) {
      const source = await readSkillSource(skill.realPath)
      if (source) {
        totalBound++
      }
    }

    return {
      ok: true,
      boundCount,
      boundSkills,
      totalBound,
    }
  })
}
