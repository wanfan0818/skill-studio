import type { FastifyInstance } from 'fastify'
import fs from 'fs/promises'
import os from 'os'
import { AGENTS, agentGlobalPaths, isValidAgentId } from '../scanner/agents.js'
import { isPlainSegment } from '../utils/safe.js'
import { invalidateCache } from './skills.js'
import {
  readDistribution,
  updateDistribution,
  setSkillForAgent,
  desiredNames,
  type AgentMode,
} from '../distribution/state.js'
import { inspect, plan, apply, PlanChangedError, type PlanFilter } from '../distribution/reconcile.js'

const MODES: (AgentMode | null)[] = ['all', 'global', 'off', null]

function parseList(v: unknown): string[] | undefined {
  if (typeof v !== 'string' || !v) return undefined
  return v.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Agents that have a global skill directory and can be distribution targets. */
export function distributableAgents() {
  return AGENTS.filter((a) => a.globalPaths.length > 0 && a.id !== 'unknown')
}

/** Apply only the changes concerning `filter`, for edits the user just confirmed. */
export async function applyScoped(filter: PlanFilter) {
  const res = await apply(filter)
  invalidateCache()
  return res
}

/** Per-skill × per-agent view used by the skill detail panel. */
export async function skillDistributionStatus(name: string) {
  const ins = await inspect({ skills: [name] })
  const allNames = [...ins.sources.keys()]
  const distributable = ins.sources.has(name)
  return {
    distributable,
    ides: distributableAgents()
      .filter((a) => a.id !== 'universal')
      .map((agent) => {
        const rule = ins.state.agents[agent.id]
        const group = ins.groups.find((g) => g.agentIds.includes(agent.id))
        return {
          id: agent.id,
          name: agent.name,
          managed: !!rule,
          mode: rule?.mode ?? null,
          enabled: distributable && desiredNames(rule, ins.state, allNames).has(name),
          linked: !!group && !!ins.satisfied.get(group.realDir)?.has(name),
        }
      }),
  }
}

export async function distributionRoutes(app: FastifyInstance) {
  // Desired state + per-agent overview.
  app.get('/api/distribution', async () => {
    const ins = await inspect()
    const home = os.homedir()
    const agents = await Promise.all(
      distributableAgents().map(async (agent) => {
        const dirs = agentGlobalPaths(agent, home)
        let exists = false
        let symlinkCount = 0
        let realCount = 0
        for (const d of dirs) {
          const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => null)
          if (!entries) continue
          exists = true
          for (const e of entries) {
            if (e.name.startsWith('.')) continue
            if (e.isSymbolicLink()) symlinkCount++
            else if (e.isDirectory()) realCount++
          }
        }
        const target = ins.plan.targets.find((t) => t.agentIds.includes(agent.id))
        return {
          id: agent.id,
          name: agent.name,
          icon: agent.icon,
          dirs,
          exists,
          symlinkCount,
          realCount,
          rule: ins.state.agents[agent.id] ?? null,
          desired: target?.desired ?? 0,
          satisfied: target?.satisfied ?? 0,
          sharedDirWith: target ? [...target.agentIds, ...target.sharedWith].filter((id) => id !== agent.id) : [],
        }
      }),
    )
    return {
      ok: true,
      state: ins.state,
      agents,
      warehouses: ins.plan.warehouses,
      sourceCount: ins.plan.sourceCount,
      counts: ins.plan.counts,
      fingerprint: ins.plan.fingerprint,
    }
  })

  // Set (or clear) one agent's rule. `mode: null` makes the agent unmanaged.
  app.put<{
    Params: { id: string }
    Body: { mode: AgentMode | null; include?: string[]; exclude?: string[] }
  }>('/api/distribution/agents/:id', async (req, reply) => {
    const { id } = req.params
    const { mode, include, exclude } = req.body ?? ({} as any)
    if (!isValidAgentId(id) || !distributableAgents().some((a) => a.id === id) || !MODES.includes(mode)) {
      reply.status(400)
      return { ok: false, error: '参数不合法' }
    }
    const state = await updateDistribution((s) => {
      if (mode === null) {
        delete s.agents[id]
        return
      }
      const prev = s.agents[id]
      s.agents[id] = {
        mode,
        include: Array.isArray(include) ? include : prev?.include,
        exclude: Array.isArray(exclude) ? exclude : prev?.exclude,
      }
    })
    return { ok: true, state, plan: await plan({ agentIds: [id] }) }
  })

  app.put<{ Body: { skills: string[] } }>('/api/distribution/global-set', async (req, reply) => {
    const skills = req.body?.skills
    if (!Array.isArray(skills) || !skills.every(isPlainSegment)) {
      reply.status(400)
      return { ok: false, error: 'skills 必须是 Skill 名称数组' }
    }
    const state = await updateDistribution((s) => {
      s.globalSet = skills
    })
    return { ok: true, state }
  })

  // Preview. Nothing on disk changes.
  app.get<{ Querystring: { skills?: string; agents?: string } }>('/api/distribution/plan', async (req) => {
    return { ok: true, plan: await plan({ skills: parseList(req.query.skills), agentIds: parseList(req.query.agents) }) }
  })

  // Execute the previewed plan. With `fingerprint`, refuses if the plan changed.
  app.post<{
    Body: { fingerprint?: string; includeLegacy?: boolean; skills?: string[]; agentIds?: string[] }
  }>('/api/distribution/apply', async (req, reply) => {
    const { fingerprint, includeLegacy, skills, agentIds } = req.body ?? {}
    try {
      const result = await apply({
        fingerprint: typeof fingerprint === 'string' ? fingerprint : undefined,
        includeLegacy: includeLegacy === true,
        skills: Array.isArray(skills) ? skills : undefined,
        agentIds: Array.isArray(agentIds) ? agentIds : undefined,
      })
      invalidateCache()
      return { ok: result.failed === 0, ...result }
    } catch (err: any) {
      if (err instanceof PlanChangedError) {
        reply.status(409)
        return { ok: false, error: err.message, code: 'PLAN_CHANGED' }
      }
      throw err
    }
  })

  // Per-skill toggles: { agents: { [agentId]: boolean } }, then apply just that skill.
  app.put<{
    Params: { name: string }
    Body: { agents: Record<string, boolean>; apply?: boolean }
  }>('/api/distribution/skills/:name', async (req, reply) => {
    const { name } = req.params
    const agents = req.body?.agents
    if (!isPlainSegment(name) || !agents || typeof agents !== 'object') {
      reply.status(400)
      return { ok: false, error: '参数不合法' }
    }
    const result = await setSkillAgents(name, agents)
    if (!result.ok) {
      reply.status(400)
      return result
    }
    const applied = req.body.apply === false ? null : await applyScoped({ skills: [name] })
    return { ok: true, applied, status: await skillDistributionStatus(name) }
  })
}

/** Shared by the distribution route and the legacy association endpoint. */
export async function setSkillAgents(name: string, agents: Record<string, boolean>) {
  const ins = await inspect({ skills: [name] })
  const enabling = Object.values(agents).some(Boolean)
  if (enabling && !ins.sources.has(name)) {
    return { ok: false as const, error: `「${name}」不在 Skill 仓库中，无法分发到 IDE 全局目录。请先把它收归到仓库。` }
  }
  const allNames = [...ins.sources.keys()]
  await updateDistribution((s) => {
    for (const [id, on] of Object.entries(agents)) {
      if (!isValidAgentId(id) || id === 'universal' || !distributableAgents().some((a) => a.id === id)) continue
      setSkillForAgent(s, id, name, !!on, allNames)
    }
  })
  return { ok: true as const }
}

export async function readGlobalSetNames(): Promise<Set<string>> {
  try {
    return new Set((await readDistribution()).globalSet)
  } catch {
    return new Set()
  }
}
