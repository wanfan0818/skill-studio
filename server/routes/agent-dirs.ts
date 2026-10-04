import type { FastifyInstance } from 'fastify'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { invalidateCache, findKnownSkill } from './skills.js'
import { isPlainSegment } from '../utils/safe.js'
import { moveToTrash } from '../trash/store.js'
import { copyDir } from '../utils/fs.js'
import { AGENTS, agentGlobalPaths } from '../scanner/agents.js'
import { getWarehouseDirs } from '../settings.js'
import { readDistribution, updateDistribution, setSkillForAgent, desiredNames } from '../distribution/state.js'
import { inspect, plan } from '../distribution/reconcile.js'
import { withWriteLock } from '../distribution/lock.js'
import { applyScoped, distributableAgents } from './distribution.js'

/**
 * Agent global skill directories: health stats / anomalies (real dirs that
 * should live in the warehouse), adopting them, and the legacy IDE toggle and
 * batch-symlink endpoints — all expressed through the distribution model.
 */

const homedir = os.homedir()

/**
 * Move a real skill directory that sits inside an agent's global dir into the
 * warehouse and leave a symlink in its place, so the agent keeps working and
 * the skill becomes distributable. If the agent has a distribution rule that
 * would not include the skill, it is added to that agent's `include` so the
 * next apply doesn't unlink it.
 */
async function adoptIntoWarehouse(entryPath: string, warehouse: string): Promise<string> {
  const name = path.basename(entryPath)
  let dest = path.join(warehouse, name)
  try {
    await fs.access(dest)
    dest = path.join(warehouse, `${name}_adopted_${Date.now()}`)
  } catch {}
  await fs.mkdir(warehouse, { recursive: true })
  try {
    await fs.rename(entryPath, dest)
  } catch {
    await copyDir(entryPath, dest)
    await moveToTrash(entryPath, name)
  }
  await fs.symlink(dest, entryPath, 'dir')
  return dest
}

export async function agentDirRoutes(app: FastifyInstance) {
  // GET /api/symlinks/anomalies - Detect anomalous skill directories and symlink stats
  app.get('/api/symlinks/anomalies', async () => {
    const anomalies = []
    const stats = []
    const dist = await readDistribution()
    const warehouseReals = await Promise.all((await getWarehouseDirs()).map((w) => fs.realpath(w).catch(() => path.resolve(w))))

    for (const agent of AGENTS) {
      if (!agent.globalPaths || agent.globalPaths.length === 0) continue
      if (agent.id === 'universal') continue

      const globalPaths = agentGlobalPaths(agent, homedir)
      let symlinkCount = 0
      let realCount = 0
      let exists = false

      // User-scoped agents own one directory per account: aggregate their
      // counts into a single stat row and show the first dir as representative.
      for (const globalPath of globalPaths) {
        // An agent dir that IS a warehouse holds the source skills themselves.
        const realGlobal = await fs.realpath(globalPath).catch(() => path.resolve(globalPath))
        if (warehouseReals.some((w) => realGlobal === w || realGlobal.startsWith(w + path.sep))) continue
        try {
          await fs.access(globalPath)
          exists = true
          const entries = await fs.readdir(globalPath, { withFileTypes: true })
          for (const entry of entries) {
            const entryPath = path.join(globalPath, entry.name)
            const stat = await fs.lstat(entryPath)

            if (stat.isSymbolicLink()) {
              symlinkCount++
            } else if (stat.isDirectory()) {
              realCount++
              if (!entry.name.startsWith('.')) {
                anomalies.push({
                  id: crypto.createHash('md5').update(entryPath).digest('hex').slice(0, 12),
                  name: entry.name,
                  path: entryPath,
                  agentId: agent.id,
                  agentName: agent.name,
                })
              }
            }
          }
        } catch {}
      }

      stats.push({
        agentId: agent.id,
        agentName: agent.name,
        icon: agent.icon,
        symlinkCount,
        realCount,
        globalPath: globalPaths[0] || '',
        exists,
        enabled: dist.agents[agent.id]?.mode === 'all',
        mode: dist.agents[agent.id]?.mode ?? null,
      })
    }

    return { ok: true, anomalies, stats }
  })

  // POST /api/ide/toggle — legacy switch kept for compatibility:
  // on → mode 'all', off → mode 'off'. Only the desired state changes; the
  // response carries the preview and nothing touches disk until apply.
  app.post<{
    Body: { agentId: string; enabled: boolean }
  }>('/api/ide/toggle', async (req, reply) => {
    const { agentId, enabled } = req.body ?? ({} as any)
    if (!distributableAgents().some((a) => a.id === agentId) || agentId === 'universal') {
      reply.status(400)
      return { ok: false, error: '无效或不支持的 Agent ID' }
    }
    const state = await updateDistribution((s) => {
      s.agents[agentId] = { ...s.agents[agentId], mode: enabled ? 'all' : 'off' }
    })
    return { ok: true, state, plan: await plan({ agentIds: [agentId] }) }
  })

  // POST /api/symlinks/anomalies/fix — adopt real skill dirs found in agent
  // global dirs into the primary warehouse, leaving symlinks behind.
  app.post<{
    Body: { targets?: { name: string; path: string; agentId: string }[] }
  }>('/api/symlinks/anomalies/fix', async (req) => {
    const targets = Array.isArray(req.body?.targets) ? req.body.targets : []
    const warehouses = await getWarehouseDirs()
    const warehouse = warehouses[0]
    const warehouseReals = await Promise.all(warehouses.map((w) => fs.realpath(w).catch(() => path.resolve(w))))
    const isWarehouseDir = async (d: string) => {
      const r = await fs.realpath(d).catch(() => path.resolve(d))
      return warehouseReals.some((w) => r === w || r.startsWith(w + path.sep))
    }

    const agentDirs: { agentId: string; dir: string }[] = []
    for (const agent of AGENTS) {
      if (agent.id === 'universal') continue
      for (const dir of agentGlobalPaths(agent, homedir)) {
        if (!(await isWarehouseDir(dir))) agentDirs.push({ agentId: agent.id, dir })
      }
    }

    const items: { name: string; path: string; agentId: string }[] = []
    if (targets.length > 0) {
      for (const t of targets) {
        if (!t || !isPlainSegment(t.name) || typeof t.path !== 'string' || path.basename(t.path) !== t.name) continue
        const owner = agentDirs.find((d) => path.resolve(d.dir) === path.resolve(path.dirname(t.path)))
        if (owner) items.push({ name: t.name, path: t.path, agentId: owner.agentId })
      }
      if (items.length === 0) return { ok: false, fixedCount: 0, results: [], error: '没有合法的修复目标' }
    } else {
      for (const { agentId, dir } of agentDirs) {
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
        for (const e of entries) {
          if (e.isDirectory() && !e.name.startsWith('.')) items.push({ name: e.name, path: path.join(dir, e.name), agentId })
        }
      }
    }

    const results: { name: string; success: boolean; error?: string }[] = []
    const adopted: { agentId: string; dest: string }[] = []
    await withWriteLock(async () => {
      for (const item of items) {
        try {
          const st = await fs.lstat(item.path)
          if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('不是真实目录')
          adopted.push({ agentId: item.agentId, dest: await adoptIntoWarehouse(item.path, warehouse) })
          results.push({ name: item.name, success: true })
        } catch (err: any) {
          results.push({ name: item.name, success: false, error: err.message })
        }
      }
    })

    // Keep adopted skills in agents that have a rule which would not include them.
    if (adopted.length) {
      const ins = await inspect()
      const allNames = [...ins.sources.keys()]
      const byReal = new Map([...ins.sources.values()].map((src) => [src.realPath, src.name]))
      const wanted: { agentId: string; name: string }[] = []
      for (const a of adopted) {
        const name = byReal.get(await fs.realpath(a.dest).catch(() => a.dest))
        if (name) wanted.push({ agentId: a.agentId, name })
      }
      await updateDistribution((s) => {
        for (const { agentId, name } of wanted) {
          if (s.agents[agentId] && !desiredNames(s.agents[agentId], s, allNames).has(name)) {
            setSkillForAgent(s, agentId, name, true, allNames)
          }
        }
      })
    }

    invalidateCache()
    return { ok: true, fixedCount: adopted.length, results, warehouse }
  })

  // POST /api/skills/batch/symlink — legacy batch actions mapped onto rules:
  //   add        → include the chosen warehouse skills for that agent, apply them
  //   remove_all → set the agent to 'off', apply (removes only managed links)
  app.post<{
    Body: {
      action: 'add' | 'remove_all'
      agentId: string
      skillIds?: string[]
    }
  }>('/api/skills/batch/symlink', async (req, reply) => {
    const { action, agentId, skillIds = [] } = req.body ?? ({} as any)
    if (!distributableAgents().some((a) => a.id === agentId) || agentId === 'universal') {
      reply.status(400)
      return { ok: false, error: '无效或不支持的 Agent ID' }
    }

    if (action === 'add') {
      if (!Array.isArray(skillIds) || skillIds.length === 0) return { ok: true, message: '未勾选技能', results: [] }
      const ins = await inspect()
      const allNames = [...ins.sources.keys()]
      const results: { name: string; success: boolean; error?: string }[] = []
      const names: string[] = []
      for (const id of skillIds) {
        const skill = await findKnownSkill({ id })
        if (!skill) results.push({ name: String(id), success: false, error: '未找到该 Skill' })
        else if (!ins.sources.has(skill.name)) results.push({ name: skill.name, success: false, error: '不在 Skill 仓库中，无法分发（请先收归到仓库）' })
        else names.push(skill.name)
      }
      if (names.length) {
        await updateDistribution((s) => {
          for (const n of names) setSkillForAgent(s, agentId, n, true, allNames)
        })
        const applied = await applyScoped({ agentIds: [agentId], skills: names })
        const failedIds = new Set(applied.results.filter((r) => !r.ok).map((r) => r.id))
        for (const n of names) {
          const failed = [...failedIds].find((id) => id.endsWith(path.sep + n))
          results.push(failed ? { name: n, success: false, error: applied.results.find((r) => r.id === failed)?.error } : { name: n, success: true })
        }
      }
      return { ok: true, results }
    }

    if (action === 'remove_all') {
      await updateDistribution((s) => {
        s.agents[agentId] = { mode: 'off' }
      })
      const applied = await applyScoped({ agentIds: [agentId] })
      return { ok: applied.failed === 0, removedCount: applied.applied, applied }
    }

    reply.status(400)
    return { ok: false, error: '无效的操作 action' }
  })
}
