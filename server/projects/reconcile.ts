import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { AGENTS, agentGlobalPaths, allAgentProjectRelPaths, projectWriteDirs, type AgentDef } from '../scanner/agents.js'
import { parseSkillMd } from '../scanner/parser.js'
import { getSkillFolderHash } from '../scanner/drift.js'
import { getWarehouseDirs } from '../settings.js'
import { isPlainSegment } from '../utils/safe.js'
import {
  listSources,
  readMarker,
  realOr,
  fingerprintOf,
  emptyCounts,
  executeActions,
  PlanChangedError,
  type ActionType,
  type PlanAction,
  type ApplyResult,
  type SourceSkill,
} from '../distribution/reconcile.js'
import { readProfile, type ProjectProfile } from './model.js'

/**
 * Project sync on the same plan → apply engine as global distribution.
 *
 * One skill list per project, written to the write dir(s) of every IDE in
 * `profile.ides`. IDEs that share a write dir (.agents/skills: Codex,
 * OpenCode, ZCode, Antigravity) share one copy; a dir is copy mode when any
 * IDE writing it needs copies.
 *
 * Sources: the warehouse, plus the project's own real skill directories
 * (preferred — a project's local version wins). Links to project-local
 * skills are relative so the project can move.
 *
 * Safety (same rules as global): real directories are never touched unless
 * they are managed copies (`.skill-source` marker); copies edited in place
 * are never overwritten; leftovers in dirs no selected IDE writes to are only
 * removed with includeLegacy ("清理旧目录").
 */

export interface InventoryItem {
  name: string
  description: string
  /** On the project's skill list. */
  inList: boolean
  /** Where its content comes from: the project itself, the warehouse, or nowhere. */
  source: 'local' | 'warehouse' | 'missing'
  /** For project-local skills: the dir it lives in. */
  localRel?: string
  /** Project skill dirs where an entry with this name exists. */
  foundIn: string[]
  /** Not on the list: kind of entry found (own real dir vs leftover link/copy). */
  untrackedKind?: 'local' | 'leftover'
}

export type CellStatus = 'ok' | 'pending' | 'outdated' | 'conflict' | 'unavailable' | 'local'

export interface ProjectPlan {
  projectPath: string
  name: string
  profile: ProjectProfile | null
  ides: { id: string; name: string; icon: string; dirs: string[]; mode: 'symlink' | 'copy' }[]
  /** skill → ide → status */
  matrix: Record<string, Record<string, CellStatus>>
  actions: PlanAction[]
  counts: Record<ActionType, number>
  /** Skill dirs in the project that no selected IDE writes to. */
  strayDirs: { rel: string; readBy: string[]; managed: number; real: number }[]
  /**
   * What the project contains: every listed skill, plus skills found in the
   * project's skill dirs that are NOT on the list (e.g. created in place).
   */
  inventory: InventoryItem[]
  warnings: string[]
  fingerprint: string
}

interface Ctx {
  warehouseSources: Map<string, SourceSkill>
  warehouseParents: Set<string>
  warehouseWarnings: string[]
  agentDirReals: Set<string>
}

/** Expensive, project-independent inputs; build once and share across projects. */
export async function buildProjectContext(): Promise<Ctx> {
  const warehouses = await getWarehouseDirs()
  const warehouseWarnings: string[] = []
  const warehouseSources = await listSources(warehouses, warehouseWarnings)
  const reals = (await Promise.all(warehouses.map((w) => realOr(w)))).filter((x): x is string => !!x)
  const agentDirReals = new Set<string>()
  for (const a of AGENTS) for (const d of agentGlobalPaths(a, os.homedir())) agentDirReals.add((await realOr(d)) ?? path.resolve(d))
  return { warehouseSources, warehouseParents: new Set([...warehouses.map((w) => path.resolve(w)), ...reals]), warehouseWarnings, agentDirReals }
}

interface LocalSource extends SourceSkill {
  rel: string
}

/** Real (non-symlink, non-managed-copy) skill dirs inside the project's skill dirs. */
async function projectLocalSources(projectPath: string): Promise<Map<string, LocalSource>> {
  const out = new Map<string, LocalSource>()
  for (const rel of allAgentProjectRelPaths()) {
    const dir = path.join(projectPath, rel)
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.name.startsWith('.') || !e.isDirectory()) continue
      const full = path.join(dir, e.name)
      if ((await readMarker(full))?.originPath) continue // a managed copy, not a source
      let name = e.name
      let description: string | undefined
      try {
        const fm = (await parseSkillMd(path.join(full, 'SKILL.md'))).frontmatter
        if (typeof fm?.name === 'string' && fm.name.trim()) name = fm.name.trim()
        if (typeof fm?.description === 'string') description = fm.description
      } catch {
        continue // no SKILL.md → not a skill
      }
      if (!isPlainSegment(name) || out.has(name)) continue
      out.set(name, { name, path: full, realPath: (await realOr(full)) ?? full, warehouse: projectPath, rel, description })
    }
  }
  return out
}

interface Target {
  dir: string
  rel: string
  realDir: string
  agentIds: string[]
  mode: 'symlink' | 'copy'
}

function agentById(id: string): AgentDef | undefined {
  return AGENTS.find((a) => a.id === id)
}

export async function planProject(projectPath: string, opts: { profile?: ProjectProfile; ctx?: Ctx } = {}): Promise<ProjectPlan> {
  const ctx = opts.ctx ?? (await buildProjectContext())
  const profile = opts.profile ?? (await readProfile(projectPath)) ?? null
  const warnings: string[] = []
  const ides = profile?.ides ?? []
  const local = await projectLocalSources(projectPath)
  const sourceFor = (name: string): SourceSkill | undefined => local.get(name) ?? ctx.warehouseSources.get(name)
  const knownReals = new Set([...ctx.warehouseSources.values(), ...local.values()].map((s) => s.realPath))

  const wanted = new Set<string>()
  for (const name of profile?.skills ?? []) {
    if (sourceFor(name)) wanted.add(name)
    else warnings.push(`「${name}」既不在 Skill 仓库也不在项目里，无法同步`)
  }

  // Write targets, grouped by physical directory.
  const targets = new Map<string, Target>()
  for (const id of ides) {
    const agent = agentById(id)
    if (!agent) continue
    for (const rel of projectWriteDirs(agent)) {
      const dir = path.join(projectPath, rel)
      const realDir = (await realOr(dir)) ?? path.resolve(dir)
      const t = targets.get(realDir) ?? { dir, rel, realDir, agentIds: [], mode: 'symlink' as const }
      t.agentIds.push(id)
      if (agent.projectLinkMode === 'copy') t.mode = 'copy'
      targets.set(realDir, t)
    }
  }

  const actions: PlanAction[] = []
  // status per (realDir, skill)
  const status = new Map<string, Map<string, CellStatus>>()
  const setStatus = (realDir: string, name: string, s: CellStatus) => {
    if (!status.has(realDir)) status.set(realDir, new Map())
    status.get(realDir)!.set(name, s)
  }
  const isManagedLink = (real: string | null, lexical: string) =>
    (!!real && (knownReals.has(real) || ctx.warehouseParents.has(path.dirname(real)) || ctx.agentDirReals.has(path.dirname(real)))) ||
    ctx.warehouseParents.has(path.dirname(lexical)) ||
    ctx.agentDirReals.has(path.dirname(lexical))

  // Relative links must be computed between REAL paths: a lexical path through
  // a symlinked parent (e.g. /var → /private/var) yields the wrong number of
  // `..` and a dangling link.
  const projectReal = (await realOr(projectPath)) ?? path.resolve(projectPath)
  for (const t of targets.values()) {
    const copyMode = t.mode === 'copy'
    const linkBase = (await realOr(t.dir)) ?? path.join(projectReal, t.rel)
    const relativeTo = (target: string) => path.relative(linkBase, target)
    const push = (a: Omit<PlanAction, 'id' | 'agentIds' | 'dir' | 'mode' | 'projectPath'>) =>
      actions.push({ ...a, id: `${a.type}:${a.linkPath}`, agentIds: t.agentIds, dir: t.dir, mode: t.mode, projectPath })
    const entries = await fs.readdir(t.dir, { withFileTypes: true }).catch(() => [])
    const seen = new Set<string>()

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      seen.add(entry.name)
      const linkPath = path.join(t.dir, entry.name)
      const want = wanted.has(entry.name) ? sourceFor(entry.name)! : null

      if (!entry.isSymbolicLink()) {
        if (!entry.isDirectory()) continue
        const real = (await realOr(linkPath)) ?? linkPath
        if (want && real === want.realPath) {
          setStatus(t.realDir, entry.name, 'local') // the project's own skill, living right here
          continue
        }
        const marker = await readMarker(linkPath)
        if (!marker?.originPath) {
          if (want) {
            push({ type: 'conflict', name: entry.name, linkPath, current: linkPath, reason: '同名真实目录占用，未覆盖' })
            setStatus(t.realDir, entry.name, 'conflict')
          }
          continue
        }
        if (!want) {
          push({ type: 'unlink', name: entry.name, linkPath, current: marker.originPath, reason: '不在项目 Skill 列表中（副本）', isCopy: true })
          continue
        }
        const [copyHash, srcHash] = await Promise.all([getSkillFolderHash(linkPath), getSkillFolderHash(want.realPath)])
        if (copyHash === srcHash) setStatus(t.realDir, entry.name, 'ok')
        else if (!marker.fingerprint) {
          // Written by an older version without a fingerprint: we can't tell an
          // in-place edit from an outdated copy. Offer replacement on opt-in;
          // the old copy goes to the recycle bin.
          push({ type: 'legacy', name: entry.name, linkPath, target: want.realPath, current: linkPath, isCopy: true, reason: '旧版副本（无指纹）与来源不一致；勾选清理后用当前来源替换，原副本进回收站' })
          setStatus(t.realDir, entry.name, 'conflict')
        } else if (copyHash !== marker.fingerprint) {
          push({ type: 'conflict', name: entry.name, linkPath, current: linkPath, reason: '副本已在 IDE 中被修改，未覆盖', isCopy: true })
          setStatus(t.realDir, entry.name, 'conflict')
        } else {
          push({ type: 'update', name: entry.name, linkPath, target: want.realPath, current: linkPath, reason: '来源已更新，刷新副本', isCopy: true })
          setStatus(t.realDir, entry.name, 'outdated')
        }
        continue
      }

      const raw = await fs.readlink(linkPath).catch(() => '')
      const lexical = path.resolve(t.dir, raw)
      const real = await realOr(linkPath)
      const managed = isManagedLink(real, lexical) || !real
      if (want && real === want.realPath) {
        if (copyMode) {
          push({ type: 'copy', name: entry.name, linkPath, target: want.realPath, current: real, reason: '软链接改为真实副本（该 IDE 使用副本）' })
          setStatus(t.realDir, entry.name, 'pending')
        } else setStatus(t.realDir, entry.name, 'ok')
        continue
      }
      const linkText = want && local.has(entry.name) ? relativeTo(want.realPath) : undefined
      if (!want) {
        if (managed) push({ type: 'unlink', name: entry.name, linkPath, current: real ?? lexical, reason: real ? '不在项目 Skill 列表中' : '悬空链接', dangling: !real })
        else push({ type: 'legacy', name: entry.name, linkPath, current: real ?? lexical, reason: '指向未知位置的链接（非 Skill Studio 管理）' })
        continue
      }
      const type: ActionType = managed ? (copyMode ? 'copy' : 'relink') : 'legacy'
      push({ type, name: entry.name, linkPath, target: want.realPath, linkText, current: real ?? lexical, reason: managed ? '链接指向旧位置，改为当前来源' : '同名链接指向未知位置，勾选清理后替换' })
      setStatus(t.realDir, entry.name, managed ? 'pending' : 'conflict')
    }

    for (const name of wanted) {
      if (seen.has(name)) continue
      const src = sourceFor(name)!
      push({
        type: copyMode ? 'copy' : 'link',
        name,
        linkPath: path.join(t.dir, name),
        target: src.realPath,
        linkText: !copyMode && local.has(name) ? relativeTo(src.realPath) : undefined,
        reason: copyMode ? '新增副本' : '新增',
      })
      setStatus(t.realDir, name, 'pending')
    }
  }

  // Leftovers: skill dirs in the project that no selected IDE writes to.
  const strayDirs: ProjectPlan['strayDirs'] = []
  for (const rel of allAgentProjectRelPaths()) {
    const dir = path.join(projectPath, rel)
    const realDir = (await realOr(dir)) ?? path.resolve(dir)
    if (targets.has(realDir)) continue
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null)
    if (!entries) continue
    const readBy = AGENTS.filter((a) => a.projectPaths.includes(rel)).map((a) => a.id)
    // A selected IDE still reads this dir: leaving our entries here would show
    // it every skill twice, so moving them to the write dir is part of the
    // default plan. Dirs no selected IDE reads are only cleaned on opt-in.
    const readBySelected = readBy.some((id) => ides.includes(id))
    const leftoverType: ActionType = readBySelected ? 'unlink' : 'legacy'
    const why = readBySelected
      ? `迁移到 ${[...targets.values()].map((t) => t.rel).join(' / ')}（${rel} 也会被读取，留着会重复）`
      : readBy.length
        ? `${readBy.map((id) => agentById(id)?.name ?? id).join(' / ')} 未在项目中启用`
        : '旧版本写入的目录，IDE 不会读取'
    let managed = 0
    let realCount = 0
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      const base = { name: e.name, linkPath: p, reason: why }
      if (e.isSymbolicLink()) {
        const real = await realOr(p)
        if (isManagedLink(real, path.resolve(dir, await fs.readlink(p).catch(() => ''))) || !real) {
          managed++
          actions.push({ ...base, id: `${leftoverType}:${p}`, type: leftoverType, current: real ?? undefined, agentIds: readBy, dir, mode: 'symlink', projectPath })
        }
      } else if (e.isDirectory()) {
        if ((await readMarker(p))?.originPath) {
          managed++
          actions.push({ ...base, id: `${leftoverType}:${p}`, type: leftoverType, isCopy: true, agentIds: readBy, dir, mode: 'copy', projectPath })
        } else realCount++
      }
    }
    if (managed || realCount) strayDirs.push({ rel, readBy, managed, real: realCount })
  }

  // Inventory: listed skills + anything else sitting in the project's skill dirs.
  const foundIn = new Map<string, Set<string>>()
  const untrackedKind = new Map<string, 'local' | 'leftover'>()
  for (const rel of allAgentProjectRelPaths()) {
    const entries = await fs.readdir(path.join(projectPath, rel), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.name.startsWith('.') || !(e.isDirectory() || e.isSymbolicLink())) continue
      if (!foundIn.has(e.name)) foundIn.set(e.name, new Set())
      foundIn.get(e.name)!.add(rel)
    }
  }
  for (const s of local.values()) untrackedKind.set(s.name, 'local')
  const listed = new Set(profile?.skills ?? [])
  const inventory: InventoryItem[] = []
  for (const name of profile?.skills ?? []) {
    const src = local.get(name) ?? ctx.warehouseSources.get(name)
    inventory.push({
      name,
      description: src?.description ?? '',
      inList: true,
      source: local.has(name) ? 'local' : src ? 'warehouse' : 'missing',
      localRel: local.get(name)?.rel,
      foundIn: [...(foundIn.get(name) ?? [])],
    })
  }
  for (const [name, rels] of foundIn) {
    if (listed.has(name)) continue
    const src = local.get(name) ?? ctx.warehouseSources.get(name)
    inventory.push({
      name,
      description: src?.description ?? '',
      inList: false,
      source: local.has(name) ? 'local' : src ? 'warehouse' : 'missing',
      localRel: local.get(name)?.rel,
      foundIn: [...rels],
      untrackedKind: untrackedKind.get(name) ?? 'leftover',
    })
  }

  // Matrix: per IDE, a skill is as good as its worst write dir.
  const rank: CellStatus[] = ['unavailable', 'conflict', 'outdated', 'pending', 'local', 'ok']
  const matrix: ProjectPlan['matrix'] = {}
  const ideRows = ides.map((id) => {
    const agent = agentById(id)!
    const ts = [...targets.values()].filter((t) => t.agentIds.includes(id))
    return { id, name: agent.name, icon: agent.icon, dirs: ts.map((t) => t.rel), mode: ts.some((t) => t.mode === 'copy') ? ('copy' as const) : ('symlink' as const), ts }
  })
  for (const name of profile?.skills ?? []) {
    matrix[name] = {}
    for (const ide of ideRows) {
      if (!wanted.has(name)) {
        matrix[name][ide.id] = 'unavailable'
        continue
      }
      let worst: CellStatus = 'ok'
      for (const t of ide.ts) {
        const s = status.get(t.realDir)?.get(name) ?? 'pending'
        if (rank.indexOf(s) < rank.indexOf(worst)) worst = s
      }
      matrix[name][ide.id] = worst
    }
  }

  const counts = emptyCounts()
  for (const a of actions) counts[a.type]++
  return {
    projectPath,
    name: profile?.name ?? path.basename(projectPath),
    profile,
    ides: ideRows.map(({ ts: _ts, ...r }) => r),
    matrix,
    actions,
    counts,
    strayDirs,
    inventory,
    warnings,
    fingerprint: fingerprintOf(actions),
  }
}

export async function applyProject(
  projectPath: string,
  opts: { fingerprint?: string; includeLegacy?: boolean; skills?: string[]; profile?: ProjectProfile } = {},
): Promise<ApplyResult & { plan: ProjectPlan }> {
  const plan = await planProject(projectPath, { profile: opts.profile })
  if (opts.fingerprint && opts.fingerprint !== plan.fingerprint) throw new PlanChangedError()
  const actions = opts.skills?.length ? plan.actions.filter((a) => opts.skills!.includes(a.name)) : plan.actions
  const result = await executeActions(actions, { includeLegacy: opts.includeLegacy })
  return { ...result, plan: await planProject(projectPath) }
}
