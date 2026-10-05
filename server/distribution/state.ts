import path from 'path'
import { configDir, ideSettingsPath } from '../settings.js'
import { isPlainSegment, readJsonFile, writeFileAtomic } from '../utils/safe.js'
import { isValidAgentId } from '../scanner/agents.js'

/**
 * distribution.json — the ONE place that says which warehouse skills should be
 * linked into which agent's global skill directory.
 *
 * It replaces four overlapping mechanisms that used to fight each other:
 * `enabledAgentIds` (link everything), `skillOverrides` (per-skill opt-out),
 * global-skills.json (curated set that deleted every other link) and ad-hoc
 * per-skill / batch symlink endpoints.
 *
 * For an agent WITH a rule, the desired link set is
 *     base(mode) ∪ include − exclude
 * where base is: 'all' → every warehouse skill, 'global' → globalSet,
 * 'off' → nothing. An agent WITHOUT a rule is unmanaged: never touched.
 */

export type AgentMode = 'all' | 'global' | 'off'

export interface AgentRule {
  mode: AgentMode
  include?: string[]
  exclude?: string[]
}

export interface DistributionState {
  version: 1
  globalSet: string[]
  agents: Record<string, AgentRule>
  migratedFrom?: string[]
  updatedAt: string
}

const MODES: AgentMode[] = ['all', 'global', 'off']

export function distributionPath(): string {
  return path.join(configDir(), 'distribution.json')
}

function uniqNames(v: unknown): string[] {
  return Array.isArray(v) ? Array.from(new Set(v.filter(isPlainSegment))) : []
}

function normalizeRule(raw: any): AgentRule | null {
  if (!raw || !MODES.includes(raw.mode)) return null
  const rule: AgentRule = { mode: raw.mode }
  const include = uniqNames(raw.include)
  const exclude = uniqNames(raw.exclude)
  if (include.length) rule.include = include
  if (exclude.length) rule.exclude = exclude
  return rule
}

export function normalizeState(raw: any): DistributionState {
  const agents: Record<string, AgentRule> = {}
  for (const [id, r] of Object.entries(raw?.agents ?? {})) {
    if (!isValidAgentId(id) || id === 'unknown') continue
    const rule = normalizeRule(r)
    if (rule) agents[id] = rule
  }
  return {
    version: 1,
    globalSet: uniqNames(raw?.globalSet),
    agents,
    ...(Array.isArray(raw?.migratedFrom) ? { migratedFrom: raw.migratedFrom } : {}),
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  }
}

/**
 * Build the initial state from the legacy config so existing setups keep
 * their intent:
 *   enabledAgentIds              → mode 'all'
 *   skillOverrides.disabledIdes  → per-agent exclude
 *   global-skills.json           → globalSet; its targetIdes that were not
 *                                  already 'all' → mode 'global'
 * Nothing is applied by migrating — it only seeds the desired state.
 */
export async function migrateLegacy(): Promise<DistributionState> {
  const state: DistributionState = { version: 1, globalSet: [], agents: {}, migratedFrom: [], updatedAt: new Date().toISOString() }

  const ide = await readJsonFile<any>(ideSettingsPath())
  if (ide) {
    for (const id of uniqNames(ide.enabledAgentIds)) {
      if (isValidAgentId(id) && id !== 'universal') state.agents[id] = { mode: 'all' }
    }
    for (const [skill, o] of Object.entries<any>(ide.skillOverrides ?? {})) {
      if (!isPlainSegment(skill)) continue
      for (const id of uniqNames(o?.disabledIdes)) {
        const rule = state.agents[id]
        if (rule) rule.exclude = Array.from(new Set([...(rule.exclude ?? []), skill]))
      }
    }
    state.migratedFrom!.push('ide-settings.json')
  }

  const legacyGlobal = await readJsonFile<any>(path.join(configDir(), 'global-skills.json'))
  const globalSkills = uniqNames(legacyGlobal?.globalSkills)
  if (globalSkills.length) {
    state.globalSet = globalSkills
    for (const id of uniqNames(legacyGlobal?.targetIdes)) {
      if (isValidAgentId(id) && id !== 'universal' && !state.agents[id]) state.agents[id] = { mode: 'global' }
    }
    state.migratedFrom!.push('global-skills.json')
  }
  return state
}

/** Missing file → migrate from legacy config and persist. Malformed → throws. */
export async function readDistribution(): Promise<DistributionState> {
  const raw = await readJsonFile<any>(distributionPath())
  if (raw !== undefined) return normalizeState(raw)
  const { seedIncludesFromDisk } = await import('./reconcile.js')
  const migrated = await seedIncludesFromDisk(await migrateLegacy())
  return writeDistribution(migrated)
}

export async function writeDistribution(state: DistributionState): Promise<DistributionState> {
  const normalized = normalizeState({ ...state, updatedAt: new Date().toISOString() })
  await writeFileAtomic(distributionPath(), JSON.stringify(normalized, null, 2))
  return normalized
}

/** Read-modify-write, serialized so concurrent requests can't lose updates. */
let queue: Promise<unknown> = Promise.resolve()
export function updateDistribution(mutate: (s: DistributionState) => void): Promise<DistributionState> {
  const run = queue.then(async () => {
    const state = await readDistribution()
    mutate(state)
    return writeDistribution(state)
  })
  queue = run.catch(() => {})
  return run
}

/** The names an agent should receive, given the full warehouse name list. */
export function desiredNames(rule: AgentRule | undefined, state: DistributionState, allSources: Iterable<string>): Set<string> {
  if (!rule) return new Set()
  const base = rule.mode === 'all' ? new Set(allSources) : rule.mode === 'global' ? new Set(state.globalSet) : new Set<string>()
  for (const n of rule.include ?? []) base.add(n)
  for (const n of rule.exclude ?? []) base.delete(n)
  return base
}

/**
 * Make `skill` present (or absent) for `agentId` with the smallest rule edit:
 * prefer removing an exclude/include over adding one. Enabling a skill on an
 * unmanaged agent creates an 'off' rule that includes just that skill.
 */
export function setSkillForAgent(state: DistributionState, agentId: string, skill: string, enabled: boolean, allSources: Iterable<string>) {
  let rule = state.agents[agentId]
  if (!rule) {
    if (!enabled) return
    rule = state.agents[agentId] = { mode: 'off' }
  }
  const has = () => desiredNames(rule, state, allSources).has(skill)
  if (has() === enabled) return
  if (enabled) {
    rule.exclude = (rule.exclude ?? []).filter((n) => n !== skill)
    if (!has()) rule.include = Array.from(new Set([...(rule.include ?? []), skill]))
  } else {
    rule.include = (rule.include ?? []).filter((n) => n !== skill)
    if (has()) rule.exclude = Array.from(new Set([...(rule.exclude ?? []), skill]))
  }
}
