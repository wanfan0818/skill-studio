import type { FastifyInstance } from 'fastify'
import path from 'path'
import { invalidateCache } from './skills.js'
import { isPlainSegment } from '../utils/safe.js'
import { listConfiguredProjects, writeProfile } from '../projects/model.js'
import { applyProject } from '../projects/reconcile.js'
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

    // Configured projects only; a project "has" the skill when it is in its list.
    const projectsList = (await listConfiguredProjects()).map((p) => {
      const has = p.profile.skills.includes(name)
      return { name: p.name, path: p.path, enabled: has, linked: has, ides: p.profile.ides }
    })

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

    // 2. Projects: add/remove the skill from each configured project's list,
    //    then apply just that skill there (all of the project's IDEs).
    const projectResults: { path: string; ok: boolean; error?: string }[] = []
    for (const p of await listConfiguredProjects()) {
      const should = enabledProjectPaths.includes(p.path)
      const has = p.profile.skills.includes(name)
      if (should === has) continue
      const skills = should ? [...p.profile.skills, name] : p.profile.skills.filter((s) => s !== name)
      const profile = await writeProfile(p.path, { ...p.profile, skills })
      const r = await applyProject(p.path, { profile, skills: [name] })
      projectResults.push({ path: p.path, ok: r.failed === 0, error: r.results.find((x) => !x.ok)?.error })
    }

    invalidateCache()
    return { ok: projectResults.every((r) => r.ok), distribution, projects: projectResults }
  })
}
