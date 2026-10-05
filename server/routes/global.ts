import type { FastifyInstance } from 'fastify'
import { isPlainSegment } from '../utils/safe.js'
import { readDistribution, updateDistribution } from '../distribution/state.js'
import { applyScoped } from './distribution.js'
import { getCachedResult } from './skills.js'

/**
 * "Global skills" are the distribution state's `globalSet`: every agent whose
 * rule is mode 'global' receives exactly this set (plus its own include /
 * exclude). Which agents those are is configured per agent in the
 * distribution panel — not hard-coded by this endpoint any more.
 *
 * The old implementation also deleted every other symlink in the target
 * directories, fighting the per-agent "link everything" sync. Both now go
 * through the same reconciler.
 */
export async function globalRoutes(app: FastifyInstance) {
  app.get('/api/global-skills', async () => {
    const state = await readDistribution()
    const targetIdes = Object.entries(state.agents)
      .filter(([, r]) => r.mode === 'global')
      .map(([id]) => id)
    const names = new Set(state.globalSet)
    const activeSkills = (getCachedResult()?.skills ?? []).filter((s) => names.has(s.name))
    return {
      ok: true,
      config: { globalSkills: state.globalSet, targetIdes, updatedAt: state.updatedAt },
      globalSkills: state.globalSet,
      activeSkills,
    }
  })

  app.post<{
    Body: { skillName: string; isGlobal: boolean }
  }>('/api/global-skills/toggle', async (req, reply) => {
    const { skillName, isGlobal } = req.body ?? ({} as any)
    if (!isPlainSegment(skillName)) {
      reply.status(400)
      return { ok: false, error: '未提供合法的 skillName' }
    }
    const state = await updateDistribution((s) => {
      const set = new Set(s.globalSet)
      if (isGlobal) set.add(skillName)
      else set.delete(skillName)
      s.globalSet = [...set]
    })
    const applied = await applyScoped({ skills: [skillName] })
    return {
      ok: true,
      config: { globalSkills: state.globalSet },
      applied,
      message: isGlobal
        ? `已将 /${skillName} 加入全局集，并分发到「仅全局集」模式的 IDE（${applied.applied} 项变更）`
        : `已将 /${skillName} 移出全局集（${applied.applied} 项变更）`,
    }
  })

  // `targetIdes` from the client is ignored: receivers are per-agent rules.
  app.post<{
    Body: { globalSkills: string[]; targetIdes?: string[] }
  }>('/api/global-skills/set', async (req, reply) => {
    const { globalSkills } = req.body ?? ({} as any)
    if (!Array.isArray(globalSkills) || !globalSkills.every(isPlainSegment)) {
      reply.status(400)
      return { ok: false, error: 'globalSkills 必须为 Skill 名称数组' }
    }
    const before = new Set((await readDistribution()).globalSet)
    const state = await updateDistribution((s) => {
      s.globalSet = Array.from(new Set(globalSkills))
    })
    const after = new Set(state.globalSet)
    const changed = [...new Set([...before, ...after])].filter((n) => before.has(n) !== after.has(n))
    const applied = changed.length ? await applyScoped({ skills: changed }) : null
    return {
      ok: true,
      config: { globalSkills: state.globalSet },
      applied,
      message: `已更新全局集（共 ${state.globalSet.length} 个），${applied ? `应用 ${applied.applied} 项变更` : '无需变更'}`,
    }
  })

  app.post('/api/global-skills/sync', async () => {
    const state = await readDistribution()
    const applied = state.globalSet.length ? await applyScoped({ skills: state.globalSet }) : null
    return { ok: true, applied, message: '已按分发规则同步全局集' }
  })
}
