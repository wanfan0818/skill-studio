import type { FastifyInstance } from 'fastify'
import fs from 'fs/promises'
import path from 'path'
import { invalidateCache } from './skills.js'
import { isPlainSegment } from '../utils/safe.js'
import { discoverProjects, fullScan } from '../scanner/discovery.js'
import { syncProjectSkills } from '../projects/sync.js'
import { applyScoped, setSkillAgents, skillDistributionStatus } from './distribution.js'

/** One skill's associations: which IDEs it is distributed to, which projects use it. */
export async function associationRoutes(app: FastifyInstance) {
  // Skill × IDE (global distribution) and Skill × project associations
  app.get<{
    Params: { name: string }
  }>('/api/skills/:name/association', async (req, reply) => {
    const { name } = req.params
    if (!isPlainSegment(name)) {
      reply.status(400)
      return { ok: false, error: '参数不合法' }
    }
    const { distributable, ides } = await skillDistributionStatus(name)

    const projectsList = []
    for (const proj of await discoverProjects()) {
      let hasSkill = false
      try {
        const profile = JSON.parse(await fs.readFile(path.join(proj.path, '.skills-profile.json'), 'utf-8'))
        hasSkill = Array.isArray(profile?.skills) && profile.skills.includes(name)
      } catch {}
      projectsList.push({ name: proj.name, path: proj.path, enabled: hasSkill, linked: hasSkill })
    }

    return { name, distributable, ides, projects: projectsList }
  })

  // Save associations. IDE part edits the distribution state and applies
  // only this skill's changes; project part edits project profiles.
  app.post<{
    Params: { name: string }
    Body: { ides?: Record<string, boolean>; disabledIdes?: string[]; enabledProjectPaths: string[] }
  }>('/api/skills/:name/association', async (req, reply) => {
    const { name } = req.params
    const { ides, disabledIdes, enabledProjectPaths } = req.body ?? ({} as any)
    if (
      !isPlainSegment(name) ||
      !Array.isArray(enabledProjectPaths) ||
      !enabledProjectPaths.every((p: unknown) => typeof p === 'string' && path.isAbsolute(p))
    ) {
      reply.status(400)
      return { ok: false, error: '参数不合法' }
    }

    // 1. IDE distribution
    const status = await skillDistributionStatus(name)
    let wanted: Record<string, boolean> | undefined
    if (ides && typeof ides === 'object') {
      wanted = ides
    } else if (Array.isArray(disabledIdes)) {
      // Legacy body shape: everything listed as enabled unless disabled.
      wanted = Object.fromEntries(status.ides.filter((i) => i.managed).map((i) => [i.id, !disabledIdes.includes(i.id)]))
    }
    let distribution = null
    if (wanted) {
      const changes: Record<string, boolean> = {}
      for (const ide of status.ides) {
        if (ide.id in wanted && !!wanted[ide.id] !== ide.enabled) changes[ide.id] = !!wanted[ide.id]
      }
      if (Object.keys(changes).length) {
        const r = await setSkillAgents(name, changes)
        if (!r.ok) {
          reply.status(400)
          return r
        }
        distribution = await applyScoped({ skills: [name] })
      }
    }

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

    invalidateCache()
    return { ok: true, distribution }
  })
}
