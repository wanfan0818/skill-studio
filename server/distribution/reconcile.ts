import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { AGENTS, agentGlobalPaths, allAgentProjectRelPaths } from '../scanner/agents.js'
import { parseSkillMd } from '../scanner/parser.js'
import { getWarehouseDirs } from '../settings.js'
import { isPlainSegment } from '../utils/safe.js'
import { readDistribution, desiredNames, type DistributionState } from './state.js'
import { withWriteLock } from './lock.js'
import { mapLimit } from '../utils/concurrency.js'
import { copyDir } from '../utils/fs.js'
import { getSkillFolderHash } from '../scanner/drift.js'
import { moveToTrash } from '../trash/store.js'

/**
 * plan → apply reconciler for global skill distribution.
 *
 * Ownership rule: a symlink is "managed" (ours to create / remove) only when
 * it points at a direct child of a warehouse. Real directories are never
 * touched; links pointing anywhere else belong to the user or another tool
 * and are left alone — except "legacy" links (into project skill dirs or
 * other agents' dirs, or dangling) that older Skill Studio versions created;
 * those are reported separately and only removed on explicit opt-in.
 *
 * Copy mode (agents with linkMode 'copy', e.g. TeleAgent, which ignores
 * symlinked skills): the agent gets real copies carrying a `.skill-source`
 * marker { originPath, fingerprint }. A copy is managed only if its marker
 * points into a warehouse. It is refreshed when the source changes — but
 * never if the copy itself was modified after we wrote it (the agent may
 * evolve skills in place); that is reported as a conflict instead.
 */

export interface SourceSkill {
  name: string
  path: string
  realPath: string
  warehouse: string
}

export type ActionType = 'link' | 'relink' | 'copy' | 'update' | 'unlink' | 'legacy' | 'conflict'

export interface PlanAction {
  id: string
  type: ActionType
  name: string
  dir: string
  linkPath: string
  /** Where the link should point (link / relink). */
  target?: string
  /** What currently occupies linkPath (relink / unlink / legacy / conflict). */
  current?: string
  agentIds: string[]
  reason: string
  /** unlink only: the link's target no longer exists. */
  dangling?: boolean
  /** How this target directory receives skills. */
  mode: 'symlink' | 'copy'
  /** The entry at linkPath is a managed physical copy (copy mode). */
  isCopy?: boolean
  /** Symlink text to write when it differs from `target` (relative links). */
  linkText?: string
  /** Set for project actions: the project root. */
  projectPath?: string
}

export interface TargetSummary {
  dir: string
  realDir: string
  agentIds: string[]
  /** Agents without a rule that read the same physical directory. */
  sharedWith: string[]
  mode: 'symlink' | 'copy'
  exists: boolean
  desired: number
  satisfied: number
}

export interface Plan {
  actions: PlanAction[]
  counts: Record<ActionType, number>
  targets: TargetSummary[]
  warnings: string[]
  warehouses: string[]
  sourceCount: number
  fingerprint: string
}

export interface PlanFilter {
  skills?: string[]
  agentIds?: string[]
}

interface Group {
  dir: string
  realDir: string
  agentIds: string[]
  unmanaged: string[]
  /** 'copy' when any agent reading this directory ignores symlinks. */
  mode: 'symlink' | 'copy'
}

interface CopyMarker {
  originPath?: string
  fingerprint?: string
  [k: string]: unknown
}

export async function readMarker(dir: string): Promise<CopyMarker | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, '.skill-source'), 'utf-8'))
  } catch {
    return null
  }
}

/** Full picture shared by plan() and status queries. */
export interface Inspection {
  state: DistributionState
  sources: Map<string, SourceSkill>
  groups: Group[]
  /** realDir → set of skill names whose link there already points at the source. */
  satisfied: Map<string, Set<string>>
  plan: Plan
}

export async function realOr(p: string, fallback: string | null = null): Promise<string | null> {
  try {
    return await fs.realpath(p)
  } catch {
    return fallback
  }
}


export async function listSources(warehouses: string[], warnings: string[]): Promise<Map<string, SourceSkill>> {
  const sources = new Map<string, SourceSkill>()
  for (const wh of warehouses) {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(wh, { withFileTypes: true })
    } catch {
      warnings.push(`仓库目录不存在或不可读: ${wh}`)
      continue
    }
    const found = await mapLimit(
      entries.filter((e) => !e.name.startsWith('.')),
      32,
      async (entry): Promise<SourceSkill | null> => {
        const entryPath = path.join(wh, entry.name)
        const real = await realOr(entryPath)
        if (!real) return null
        try {
          if (!(await fs.stat(real)).isDirectory()) return null
        } catch {
          return null
        }
        let name = entry.name
        try {
          const parsed = await parseSkillMd(path.join(real, 'SKILL.md'))
          const fmName = parsed.frontmatter?.name
          if (typeof fmName === 'string' && fmName.trim()) name = fmName.trim()
        } catch {
          // No SKILL.md: still a skill if the directory has any file (scanner parity).
          const files = await fs.readdir(real, { withFileTypes: true }).catch(() => [])
          if (!files.some((f) => f.isFile())) return null
        }
        if (!isPlainSegment(name)) {
          warnings.push(`Skill 名称无法用作目录名，已跳过: ${entryPath}`)
          return null
        }
        return { name, path: entryPath, realPath: real, warehouse: wh }
      },
    )
    for (const s of found) {
      if (!s) continue
      const existing = sources.get(s.name)
      if (existing) {
        if (existing.realPath !== s.realPath) warnings.push(`仓库中存在同名 Skill「${s.name}」，使用 ${existing.path}，忽略 ${s.path}`)
        continue
      }
      sources.set(s.name, s)
    }
  }
  return sources
}

async function listGroups(state: DistributionState, warehouseReals: string[], warnings: string[]): Promise<Group[]> {
  const home = os.homedir()
  const byReal = new Map<string, Group>()
  for (const agent of AGENTS) {
    for (const dir of agentGlobalPaths(agent, home)) {
      const realDir = (await realOr(dir)) ?? path.resolve(dir)
      let g = byReal.get(realDir)
      if (!g) byReal.set(realDir, (g = { dir, realDir, agentIds: [], unmanaged: [], mode: 'symlink' }))
      if (agent.linkMode === 'copy') g.mode = 'copy'
      if (state.agents[agent.id]) g.agentIds.push(agent.id)
      else g.unmanaged.push(agent.id)
    }
  }
  const groups: Group[] = []
  for (const g of byReal.values()) {
    if (g.agentIds.length === 0) continue
    const isWarehouse = warehouseReals.some((w) => g.realDir === w || g.realDir.startsWith(w + path.sep))
    if (isWarehouse) {
      warnings.push(`${g.agentIds.join(', ')} 的全局目录就是仓库本身（${g.dir}），无需分发`)
      continue
    }
    groups.push(g)
  }
  return groups
}

async function projectSkillDirReals(): Promise<Set<string>> {
  const out = new Set<string>()
  try {
    const { discoverProjects } = await import('../scanner/discovery.js')
    const rels = allAgentProjectRelPaths()
    for (const proj of await discoverProjects()) {
      for (const rel of rels) {
        const r = await realOr(path.join(proj.path, rel))
        if (r) out.add(r)
      }
    }
  } catch {}
  return out
}

export function fingerprintOf(actions: PlanAction[]): string {
  const h = crypto.createHash('sha1')
  for (const a of [...actions].sort((x, y) => x.id.localeCompare(y.id))) h.update(`${a.id}|${a.target ?? ''}\n`)
  return h.digest('hex').slice(0, 16)
}

export function emptyCounts(): Record<ActionType, number> {
  return { link: 0, relink: 0, copy: 0, update: 0, unlink: 0, legacy: 0, conflict: 0 }
}

/** `stateOverride` lets callers dry-run a hypothetical state without persisting it. */
export async function inspect(filter: PlanFilter = {}, stateOverride?: DistributionState): Promise<Inspection> {
  const state = stateOverride ?? (await readDistribution())
  const warnings: string[] = []
  const warehouses = await getWarehouseDirs()
  const warehouseReals = (await Promise.all(warehouses.map((w) => realOr(w)))).filter((x): x is string => !!x)
  const warehouseParents = new Set([...warehouses.map((w) => path.resolve(w)), ...warehouseReals])

  const sources = await listSources(warehouses, warnings)
  const sourceReals = new Set([...sources.values()].map((s) => s.realPath))
  const groups = await listGroups(state, warehouseReals, warnings)

  // For legacy detection: every agent global dir and every project skill dir.
  const agentDirReals = new Set<string>()
  for (const agent of AGENTS) for (const d of agentGlobalPaths(agent, os.homedir())) agentDirReals.add((await realOr(d)) ?? path.resolve(d))
  const projectDirs = await projectSkillDirReals()

  for (const name of state.globalSet) if (!sources.has(name)) warnings.push(`全局集中的「${name}」不在仓库里，无法分发`)
  for (const [id, rule] of Object.entries(state.agents)) {
    for (const n of rule.include ?? []) if (!sources.has(n)) warnings.push(`${id} 指定包含的「${n}」不在仓库里，无法分发`)
  }

  const actions: PlanAction[] = []
  const targets: TargetSummary[] = []
  const satisfied = new Map<string, Set<string>>()
  const allNames = [...sources.keys()]

  for (const g of groups) {
    const desired = new Set<string>()
    for (const id of g.agentIds) for (const n of desiredNames(state.agents[id], state, allNames)) if (sources.has(n)) desired.add(n)

    let entries: import('fs').Dirent[] = []
    let exists = true
    try {
      entries = await fs.readdir(g.dir, { withFileTypes: true })
    } catch {
      exists = false
    }

    const ok = new Set<string>()
    const seen = new Set<string>()
    const copyMode = g.mode === 'copy'
    const push = (a: Omit<PlanAction, 'id' | 'agentIds' | 'dir' | 'mode'>) =>
      actions.push({ ...a, id: `${a.type}:${a.linkPath}`, agentIds: g.agentIds, dir: g.dir, mode: g.mode })
    const isWarehouseOrigin = (p: string) => warehouseParents.has(path.dirname(p)) || sourceReals.has(p)

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      seen.add(entry.name)
      const linkPath = path.join(g.dir, entry.name)
      const want = desired.has(entry.name) ? sources.get(entry.name)! : null

      if (!entry.isSymbolicLink()) {
        const marker = copyMode && entry.isDirectory() ? await readMarker(linkPath) : null
        const managedCopy = !!marker?.originPath && isWarehouseOrigin(marker.originPath)
        if (!managedCopy) {
          if (want) push({ type: 'conflict', name: entry.name, linkPath, current: linkPath, reason: '同名真实目录占用，未覆盖' })
          continue
        }
        if (!want) {
          push({ type: 'unlink', name: entry.name, linkPath, current: marker!.originPath, reason: '不在期望集合中（副本）', isCopy: true })
          continue
        }
        const [copyHash, srcHash] = await Promise.all([getSkillFolderHash(linkPath), getSkillFolderHash(want.realPath)])
        if (copyHash === srcHash) {
          ok.add(entry.name)
        } else if (!marker!.fingerprint || copyHash !== marker!.fingerprint) {
          push({ type: 'conflict', name: entry.name, linkPath, current: linkPath, reason: '副本已在该 IDE 中被修改，未覆盖', isCopy: true })
        } else {
          push({ type: 'update', name: entry.name, linkPath, target: want.realPath, current: linkPath, reason: '仓库版本已更新，刷新副本', isCopy: true })
        }
        continue
      }

      const raw = await fs.readlink(linkPath).catch(() => '')
      const lexical = path.resolve(g.dir, raw)
      const real = await realOr(linkPath)
      const managed =
        warehouseParents.has(path.dirname(lexical)) ||
        (!!real && (warehouseParents.has(path.dirname(real)) || sourceReals.has(real)))

      if (want && real === want.realPath && !copyMode) {
        ok.add(entry.name)
        continue
      }
      if (managed) {
        if (want && copyMode) push({ type: 'copy', name: entry.name, linkPath, target: want.realPath, current: real ?? lexical, reason: '软链接改为真实副本（该 IDE 不识别软链接）' })
        else if (want) push({ type: 'relink', name: entry.name, linkPath, target: want.realPath, current: real ?? lexical, reason: '链接指向旧位置，重新指向仓库' })
        else push({ type: 'unlink', name: entry.name, linkPath, current: real ?? lexical, reason: real ? '不在期望集合中' : '仓库中已不存在（悬空链接）', dangling: !real })
        continue
      }
      const legacyReason = !real
        ? '悬空链接'
        : agentDirReals.has(path.dirname(real)) || agentDirReals.has(path.dirname(lexical))
          ? '指向另一个 Agent 的目录（旧版交叉链接）'
          : projectDirs.has(path.dirname(real))
            ? '指向项目私有 Skill（旧版交叉链接）'
            : null
      if (want) {
        if (legacyReason) {
          // An old cross-link sits on a name the rules want: replace it with
          // the warehouse link, but only when legacy cleanup is opted in.
          push({ type: 'legacy', name: entry.name, linkPath, target: want.realPath, current: real ?? lexical, reason: `${legacyReason}，占用了仓库同名 Skill，将改为${copyMode ? '仓库副本' : '指向仓库'}` })
        } else {
          push({ type: 'conflict', name: entry.name, linkPath, current: real ?? lexical, reason: '同名链接指向仓库以外的位置，未覆盖' })
        }
        continue
      }
      if (legacyReason) push({ type: 'legacy', name: entry.name, linkPath, current: real ?? lexical, reason: legacyReason })
      // anything else: a link owned by the user or another tool — untouched.
    }

    for (const name of desired) {
      if (seen.has(name)) continue
      push({ type: copyMode ? 'copy' : 'link', name, linkPath: path.join(g.dir, name), target: sources.get(name)!.realPath, reason: copyMode ? '新增副本' : '新增' })
    }

    satisfied.set(g.realDir, ok)
    targets.push({
      dir: g.dir,
      realDir: g.realDir,
      agentIds: g.agentIds,
      sharedWith: g.unmanaged,
      mode: g.mode,
      exists,
      desired: desired.size,
      satisfied: ok.size,
    })
  }

  const filtered = actions.filter(
    (a) =>
      (!filter.skills?.length || filter.skills.includes(a.name)) &&
      (!filter.agentIds?.length || a.agentIds.some((id) => filter.agentIds!.includes(id))),
  )
  const counts = emptyCounts()
  for (const a of filtered) counts[a.type]++

  return {
    state,
    sources,
    groups,
    satisfied,
    plan: {
      actions: filtered,
      counts,
      targets,
      warnings,
      warehouses,
      sourceCount: sources.size,
      fingerprint: fingerprintOf(filtered),
    },
  }
}

export async function plan(filter: PlanFilter = {}): Promise<Plan> {
  return (await inspect(filter)).plan
}

export class PlanChangedError extends Error {
  constructor() {
    super('分发计划已变化，请刷新预览后再应用')
    this.name = 'PlanChangedError'
  }
}

export interface ApplyOptions extends PlanFilter {
  /** If given, apply only when the freshly computed plan still matches it. */
  fingerprint?: string
  includeLegacy?: boolean
}

export interface ApplyResult {
  applied: number
  failed: number
  skipped: number
  results: { id: string; ok: boolean; error?: string }[]
}

/**
 * Copy `source` next to `linkPath` under a hidden temp name and stamp the
 * marker; the caller renames it into place, so the agent never sees a
 * half-written skill.
 */
export async function materializeCopy(source: string, linkPath: string): Promise<string> {
  const tmp = path.join(path.dirname(linkPath), `.${path.basename(linkPath)}.ss-tmp-${crypto.randomBytes(4).toString('hex')}`)
  try {
    await copyDir(source, tmp, { skip: (n) => n === '.git' })
    const marker = (await readMarker(tmp)) ?? {}
    Object.assign(marker, {
      name: path.basename(linkPath),
      originPath: source,
      fingerprint: await getSkillFolderHash(source),
      copiedAt: new Date().toISOString(),
      managedBy: 'skill-studio',
    })
    await fs.writeFile(path.join(tmp, '.skill-source'), JSON.stringify(marker, null, 2), 'utf-8')
    return tmp
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

/** True when a managed copy still matches what we wrote (not edited in place). */
export async function copyUnmodified(dir: string): Promise<boolean> {
  const marker = await readMarker(dir)
  return !!marker?.fingerprint && (await getSkillFolderHash(dir)) === marker.fingerprint
}

async function lstatOrNull(p: string) {
  try {
    return await fs.lstat(p)
  } catch {
    return null
  }
}

export async function apply(opts: ApplyOptions = {}): Promise<ApplyResult> {
  const current = await plan({ skills: opts.skills, agentIds: opts.agentIds })
  if (opts.fingerprint && opts.fingerprint !== current.fingerprint) throw new PlanChangedError()
  return executeActions(current.actions, { includeLegacy: opts.includeLegacy })
}

/**
 * Execute planned actions. Shared by global distribution and project sync.
 * Every action re-checks the disk right before touching it; conflicts are
 * never executed, legacy actions only with includeLegacy.
 */
export async function executeActions(actions: PlanAction[], opts: { includeLegacy?: boolean } = {}): Promise<ApplyResult> {
  const result: ApplyResult = { applied: 0, failed: 0, skipped: 0, results: [] }
  await withWriteLock(async () => {
    for (const a of actions) {
      if (a.type === 'conflict' || (a.type === 'legacy' && !opts.includeLegacy)) {
        result.skipped++
        continue
      }
      try {
        const st = await lstatOrNull(a.linkPath)
        const linkText = a.linkText ?? a.target!
        if (a.type === 'link') {
          if (st) throw new Error('目标位置已被占用')
          await fs.mkdir(a.dir, { recursive: true })
          await fs.symlink(linkText, a.linkPath, 'dir')
        } else if (a.type === 'update') {
          if (!st?.isDirectory() || st.isSymbolicLink() || !(await copyUnmodified(a.linkPath))) {
            throw new Error('副本已被修改或已不是受管副本，未覆盖')
          }
          const tmp = await materializeCopy(a.target!, a.linkPath)
          const old = `${tmp}-old`
          await fs.rename(a.linkPath, old)
          await fs.rename(tmp, a.linkPath)
          await fs.rm(old, { recursive: true, force: true })
        } else if (a.isCopy && (a.type === 'unlink' || a.type === 'legacy') && !a.target) {
          if (!st?.isDirectory() || st.isSymbolicLink()) throw new Error('已不是受管副本，未改动')
          // An untouched copy is just a duplicate of its source; an edited
          // one goes to the recycle bin.
          if (await copyUnmodified(a.linkPath)) await fs.rm(a.linkPath, { recursive: true, force: true })
          else await moveToTrash(a.linkPath, a.name)
        } else if (a.type === 'copy' || (a.type === 'legacy' && a.mode === 'copy' && a.target)) {
          if (st && !st.isSymbolicLink()) throw new Error('目标位置已被占用')
          await fs.mkdir(a.dir, { recursive: true })
          const tmp = await materializeCopy(a.target!, a.linkPath)
          if (st) await fs.unlink(a.linkPath) // replacing a symlink
          await fs.rename(tmp, a.linkPath)
        } else {
          if (!st?.isSymbolicLink()) throw new Error('目标已不是符号链接，未改动')
          await fs.unlink(a.linkPath)
          if (a.target) await fs.symlink(linkText, a.linkPath, 'dir') // relink, or legacy replacement
        }
        result.applied++
        result.results.push({ id: a.id, ok: true })
      } catch (err: any) {
        result.failed++
        result.results.push({ id: a.id, ok: false, error: err?.message || String(err) })
      }
    }
  })
  return result
}

/**
 * Migration helper: make a freshly migrated state preserve every working
 * warehouse link already on disk. Links the legacy config did not account
 * for (e.g. ones the user created by hand) become explicit `include`s, so
 * the first plan never removes anything that currently works.
 */
export async function seedIncludesFromDisk(state: DistributionState): Promise<DistributionState> {
  const { plan: p } = await inspect({}, state)
  for (const a of p.actions) {
    if (a.type !== 'unlink' || a.dangling) continue
    const owner = state.agents[a.agentIds[0]]
    // An explicit legacy opt-out (skillOverrides → exclude) still wins.
    if (owner && !owner.exclude?.includes(a.name)) owner.include = Array.from(new Set([...(owner.include ?? []), a.name]))
  }
  return state
}
