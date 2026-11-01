import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { AGENTS, agentGlobalPaths, isValidAgentId } from '../scanner/agents.js'
import { parseSkillMd } from '../scanner/parser.js'
import { getSkillFolderSignature } from '../scanner/drift.js'
import { getWarehouseDirs } from '../settings.js'
import { resolvePreferredIdes } from '../ides.js'
import { mapLimit } from '../utils/concurrency.js'
import { listSources, inspect, apply, readMarker, realOr, PlanChangedError, type ApplyResult } from '../distribution/reconcile.js'
import { readDistribution, updateDistribution, type AgentMode, type DistributionState } from '../distribution/state.js'
import { listConfiguredProjects } from '../projects/model.js'
import { lintSkill, estimateTokens, type LintIssue, type LintResult } from './lint.js'
import { BUILTIN_SYNONYMS, buildSynonymIndex, tokenize, jaccard } from '../scanner/nlp.js'

/**
 * Skill 体检: per-skill package checks, and the routing load of every IDE —
 * how many skills it loads globally and what their names + descriptions cost
 * in every session. An agent routes among the skills IT sees, so the load
 * that matters is per IDE, not the size of the warehouse.
 */

export type LoadLevel = 'green' | 'yellow' | 'red'

// Same research thresholds as the overall health check (server/scanner/health.ts).
const GREEN_MAX = 20
const YELLOW_MAX = 50

export function loadLevel(count: number): LoadLevel {
  return count <= GREEN_MAX ? 'green' : count <= YELLOW_MAX ? 'yellow' : 'red'
}

export interface IdeSkill {
  name: string
  tokens: number
  /** Other skills in the same IDE this one competes with for triggering (see IdeConflict). */
  competitors: string[]
  /**
   * A link straight into the warehouse, or a managed copy of a warehouse
   * skill — the same ownership rule the distribution engine uses, so these
   * are exactly the entries a trim can remove.
   */
  managed: boolean
  /** Configured projects that use this skill AND select this IDE: still available there after trimming. */
  projects: string[]
}

/**
 * Two skills in one IDE that an agent may confuse. Research on skill routing:
 * a single semantic competitor costs 7–30% accuracy, two cost 17–63%.
 *   duplicate – the same skill folder loaded twice under two names
 *   same-name – two different skills declaring the same name
 *   similar   – overlapping name + description (Jaccard over word / CJK bigram tokens)
 */
export interface IdeConflict {
  a: string
  b: string
  kind: 'duplicate' | 'same-name' | 'similar'
  score: number
  shared: string[]
}

export const SIMILAR_MIN = 0.25
export const SIMILAR_STRONG = 0.4

export interface IdeLoad {
  id: string
  name: string
  icon: string
  dirs: string[]
  count: number
  tokens: number
  level: LoadLevel
  /** Distribution rule mode; null = Skill Studio doesn't manage this IDE's global dir. */
  mode: AgentMode | null
  skills: IdeSkill[]
  /** Strongest first; duplicates and same-name pairs count as strong. */
  conflicts: IdeConflict[]
  strongConflicts: number
}

export interface SkillCheck {
  name: string
  path: string
  realPath: string
  routingTokens: number
  skillMdLines: number
  issues: LintIssue[]
}

export interface QualityReport {
  ides: IdeLoad[]
  skills: SkillCheck[]
  counts: { error: number; warn: number; info: number; skillsWithProblems: number; overloadedIdes: number; strongConflicts: number }
}

// Lint results by real path, valid while the folder's stat signature is unchanged.
const lintCache = new Map<string, { signature: string | null; result: LintResult }>()

async function cachedLint(dir: string): Promise<LintResult> {
  const signature = await getSkillFolderSignature(dir)
  const hit = lintCache.get(dir)
  if (hit && signature && hit.signature === signature) return hit.result
  const result = await lintSkill(dir)
  lintCache.set(dir, { signature, result })
  return result
}

/** Routing-relevant metadata (name + description) of a skill folder, by real path. */
type Meta = { name: string; tokens: number; sig: Set<string> }
type MetaCache = Map<string, Promise<Meta | null>>
const synonymIndex = buildSynonymIndex(BUILTIN_SYNONYMS)

function skillMeta(real: string, fallbackName: string, cache: MetaCache) {
  let hit = cache.get(real)
  if (!hit) {
    hit = (async () => {
      for (const file of ['SKILL.md', 'skill.md']) {
        try {
          await fs.access(path.join(real, file))
        } catch {
          continue
        }
        const fm = (await parseSkillMd(path.join(real, file))).frontmatter ?? {}
        const name = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : fallbackName
        const desc = typeof fm.description === 'string' ? fm.description : ''
        return { name, tokens: estimateTokens(`${name}: ${desc}`), sig: tokenize(`${name} ${desc}`, synonymIndex) }
      }
      return null
    })()
    cache.set(real, hit)
  }
  return hit
}

async function ideLoad(
  agentId: string,
  state: DistributionState,
  warehouseParents: Set<string>,
  usedBy: Map<string, Map<string, string[]>>,
  meta: MetaCache,
): Promise<IdeLoad | null> {
  const agent = AGENTS.find((a) => a.id === agentId)
  if (!agent || !agent.globalPaths.length) return null
  const dirs = agentGlobalPaths(agent, os.homedir())
  const byName = new Map<string, IdeSkill>()
  const loaded: Loaded[] = []
  for (const dir of dirs) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    const found = await mapLimit(
      entries.filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink())),
      16,
      async (e) => {
        const entry = path.join(dir, e.name)
        const real = await realOr(entry)
        if (!real) return null
        const m = await skillMeta(real, e.name, meta)
        if (!m) return null
        let managed: boolean
        if (e.isSymbolicLink()) {
          const lexical = path.resolve(dir, await fs.readlink(entry).catch(() => ''))
          managed = warehouseParents.has(path.dirname(real)) || warehouseParents.has(path.dirname(lexical))
        } else {
          const origin = (await readMarker(entry))?.originPath
          managed = !!origin && warehouseParents.has(path.dirname((await realOr(origin)) ?? path.resolve(origin)))
        }
        return { entryName: e.name, real, ...m, managed }
      },
    )
    for (const f of found) {
      if (!f || byName.has(f.entryName)) continue
      byName.set(f.entryName, { name: f.entryName, tokens: f.tokens, competitors: [], managed: f.managed, projects: usedBy.get(agentId)?.get(f.entryName) ?? [] })
      loaded.push(f)
    }
  }
  const conflicts = findConflicts(loaded)
  for (const c of conflicts) {
    byName.get(c.a)?.competitors.push(c.b)
    byName.get(c.b)?.competitors.push(c.a)
  }
  const skills = [...byName.values()].sort((a, b) => b.tokens - a.tokens)
  return {
    id: agent.id,
    name: agent.name,
    icon: agent.icon,
    dirs,
    count: skills.length,
    tokens: skills.reduce((n, s) => n + s.tokens, 0),
    level: loadLevel(skills.length),
    mode: state.agents[agent.id]?.mode ?? null,
    skills,
    conflicts,
    strongConflicts: conflicts.filter((c) => c.kind !== 'similar' || c.score >= SIMILAR_STRONG).length,
  }
}

type Loaded = { entryName: string; real: string } & Meta

// Overlap words worth showing: CJK bigram fragments ("页中") and routing boilerplate say nothing.
const GENERIC = new Set(['trigger', 'triggers', 'how', 'use', 'when', 'user', 'skill', 'skills', 'this', 'auto-generated'])
const readable = (t: string) => !/^[\u4e00-\u9fff]{2}$/.test(t) && !GENERIC.has(t)

/** Pairs of loaded skills an agent may confuse, strongest first. */
export function findConflicts(loaded: Loaded[]): IdeConflict[] {
  const out: IdeConflict[] = []
  for (let i = 0; i < loaded.length; i++) {
    for (let j = i + 1; j < loaded.length; j++) {
      const x = loaded[i]
      const y = loaded[j]
      if (x.real === y.real) {
        out.push({ a: x.entryName, b: y.entryName, kind: 'duplicate', score: 1, shared: [] })
      } else if (x.name === y.name) {
        out.push({ a: x.entryName, b: y.entryName, kind: 'same-name', score: 1, shared: [x.name] })
      } else {
        const score = jaccard(x.sig, y.sig)
        if (score < SIMILAR_MIN) continue
        const shared = [...x.sig].filter((t) => y.sig.has(t) && readable(t)).slice(0, 6)
        out.push({ a: x.entryName, b: y.entryName, kind: 'similar', score: Math.round(score * 100) / 100, shared })
      }
    }
  }
  return out.sort((p, q) => q.score - p.score || p.a.localeCompare(q.a))
}

/** agentId → skill → names of configured projects that use the skill with that IDE. */
async function projectUsage(): Promise<Map<string, Map<string, string[]>>> {
  const out = new Map<string, Map<string, string[]>>()
  for (const p of await listConfiguredProjects().catch(() => [])) {
    for (const ide of p.profile.ides) {
      const m = out.get(ide) ?? new Map<string, string[]>()
      for (const s of p.profile.skills) m.set(s, [...(m.get(s) ?? []), p.name])
      out.set(ide, m)
    }
  }
  return out
}

export async function qualityReport(): Promise<QualityReport> {
  const warnings: string[] = []
  const warehouses = await getWarehouseDirs()
  const sources = await listSources(warehouses, warnings)
  const warehouseParents = new Set([...warehouses.map((w) => path.resolve(w)), ...((await Promise.all(warehouses.map((w) => realOr(w)))).filter(Boolean) as string[])])
  const state = await readDistribution()
  const usedBy = await projectUsage()
  const meta: MetaCache = new Map()
  const { ides: preferred } = await resolvePreferredIdes()
  const ides = (await Promise.all(preferred.map((id) => ideLoad(id, state, warehouseParents, usedBy, meta)))).filter((x): x is IdeLoad => !!x)

  const skills = await mapLimit([...sources.values()], 8, async (s): Promise<SkillCheck> => {
    const r = await cachedLint(s.realPath)
    return { name: s.name, path: s.path, realPath: s.realPath, routingTokens: r.routingTokens, skillMdLines: r.skillMdLines, issues: r.issues }
  })
  skills.sort((a, b) => a.name.localeCompare(b.name))

  const counts = { error: 0, warn: 0, info: 0, skillsWithProblems: 0, overloadedIdes: ides.filter((i) => i.level === 'red').length, strongConflicts: ides.reduce((n, i) => n + i.strongConflicts, 0) }
  for (const s of skills) {
    for (const i of s.issues) counts[i.severity]++
    if (s.issues.some((i) => i.severity !== 'info')) counts.skillsWithProblems++
  }
  return { ides, skills, counts }
}

// ── Trimming an IDE's global set ─────────────────────────────────────────

export interface TrimPreview {
  agentId: string
  /** Links / copies to remove and add. */
  remove: string[]
  add: string[]
  /** Entries that will stay because Skill Studio doesn't manage them. */
  conflicts: number
  fingerprint: string
}

function validAgent(agentId: string) {
  if (!isValidAgentId(agentId)) throw new Error(`未知的 IDE：${agentId}`)
  const agent = AGENTS.find((a) => a.id === agentId)
  if (!agent?.globalPaths.length) throw new Error(`${agent?.name ?? agentId} 没有全局 Skill 目录`)
  return agent
}

/**
 * The rule that gives `agentId` exactly `keep` (of the warehouse) globally:
 * hand-picked mode, so new warehouse skills no longer flow in automatically.
 */
function keepRule(state: DistributionState, keep: Set<string>) {
  const global = new Set(state.globalSet)
  return {
    mode: 'global' as const,
    include: [...keep].filter((n) => !global.has(n)).sort(),
    exclude: [...global].filter((n) => !keep.has(n)).sort(),
  }
}

async function previewWith(agentId: string, state: DistributionState): Promise<TrimPreview> {
  const ins = await inspect({ agentIds: [agentId] }, state)
  const p = ins.plan
  return {
    agentId,
    remove: p.actions.filter((a) => a.type === 'unlink').map((a) => a.name).sort(),
    add: p.actions.filter((a) => a.type === 'link' || a.type === 'copy').map((a) => a.name).sort(),
    conflicts: p.counts.conflict,
    fingerprint: p.fingerprint,
  }
}

async function nextState(agentId: string, keep: string[] | 'all'): Promise<{ state: DistributionState }> {
  validAgent(agentId)
  const state = structuredClone(await readDistribution())
  const sources = await listSources(await getWarehouseDirs(), [])
  if (keep === 'all') {
    state.agents[agentId] = { mode: 'all' }
  } else {
    const keepSet = new Set(keep.filter((n) => sources.has(n)))
    state.agents[agentId] = keepRule(state, keepSet)
  }
  return { state }
}

/** What keeping only `keep` (or restoring 'all') would change on disk. Nothing is written. */
export async function previewTrim(agentId: string, keep: string[] | 'all'): Promise<TrimPreview> {
  const { state } = await nextState(agentId, keep)
  return previewWith(agentId, state)
}

/**
 * Save the rule and apply it to this IDE only. With `fingerprint` (from the
 * preview the user confirmed), refuses if the outcome would differ.
 */
export async function applyTrim(agentId: string, keep: string[] | 'all', fingerprint?: string): Promise<ApplyResult & { preview: TrimPreview }> {
  const { state } = await nextState(agentId, keep)
  const preview = await previewWith(agentId, state)
  if (fingerprint && fingerprint !== preview.fingerprint) throw new PlanChangedError()
  await updateDistribution((s) => {
    s.agents[agentId] = state.agents[agentId]
  })
  const result = await apply({ agentIds: [agentId], fingerprint: preview.fingerprint })
  return { ...result, preview }
}
