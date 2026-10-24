export interface SkillFrontmatter {
  name?: string
  description?: string
  'allowed-tools'?: string
  model?: string
  effort?: string
  'user-invocable'?: boolean
  'disable-model-invocation'?: boolean
  context?: string
  agent?: string
  paths?: string[]
  shell?: string
  'argument-hint'?: string
  source?: string // Added for GitHub update tracking
}

import type { AgentId } from './scanner/agents.js'
import type { CategorySummary, MergeSuggestion } from './scanner/taxonomy.js'
import type { HealthReport } from './scanner/health.js'

import type { SecurityStatus } from './scanner/security.js'

export interface SkillGithubSource {
  owner?: string
  repo?: string
  branch?: string
  subPath?: string
  installedCommit?: string
  installedAt?: string
  lastChecked?: string
  updateAvailable?: boolean
  latestCommit?: string
  /** Upstream commit the user chose not to take (keep local edits). */
  ignoredCommit?: string
  /** git tree SHA of the skill folder as installed / as upstream now (see server/updates/upstream.ts). */
  installedTree?: string
  latestTree?: string
  /** Upstream tree the user chose not to take (keep local edits). */
  ignoredTree?: string
  /** The folder no longer exists upstream (removed, moved, or the repo is gone). */
  upstreamMissing?: boolean
  /** The repository can't be read (private without token access, or deleted). */
  upstreamNoAccess?: boolean
  /** The user detached it from its upstream: never look it up in lock files again. */
  unbound?: boolean
  originPath?: string
  copiedAt?: string
}

export interface Skill {
  id: string
  name: string
  description: string
  scope: 'global' | 'project' | 'plugin'
  agent: AgentId
  source: 'local' | 'newmax' | 'agents' | 'symlink' | 'unknown'
  category: string
  path: string
  realPath: string
  symlinkTarget?: string
  projectName?: string
  projectPath?: string
  frontmatter: SkillFrontmatter
  content: string
  files: string[]
  enabled: boolean
  hasConflict: boolean
  hasDrift?: boolean
  lastModified: string
  security?: SecurityStatus
  githubSource?: SkillGithubSource // Added for GitHub update tracking & distribution marker
  linkedIdes?: string[] // IDE IDs that link to this skill
  linkedProjects?: Array<{
    name: string
    path: string
    agentId: string
    isCopy?: boolean
    hasDrift?: boolean
  }>
  isWarehouseSource?: boolean
  isGlobalActive?: boolean
  globalDeployments?: string[]
}

export interface GlobalSkillsConfig {
  globalSkills: string[]
  targetIdes?: string[]
  updatedAt?: string
}

export interface IDESettings {
  enabledAgentIds: string[]
  customGlobalSkillsDir?: string
  skillWarehouses?: string[]
  githubToken?: string
  httpProxy?: string
  skillOverrides?: Record<string, { enabledIdes?: string[]; disabledIdes?: string[] }>
}

export interface Project {
  name: string
  path: string
  skillCount: number
}

export interface ConflictGroup {
  name: string
  skills: Skill[]
}

export interface ScanPathReport {
  label: string
  path: string
  exists: boolean
  count: number
  error?: string
}

export interface ScanResult {
  skills: Skill[]
  projects: Project[]
  conflicts: ConflictGroup[]
  categories: CategorySummary[]
  mergeSuggestions: MergeSuggestion[]
  health: HealthReport
  stats: {
    total: number
    global: number
    project: number
    bySource: Record<string, number>
    byAgent: Record<string, number>
    byCategory: Record<string, number>
  }
  scannedPaths: ScanPathReport[]
  durationMs: number
  /** Per-phase wall time in ms, for /api/debug and benchmarks. */
  timings?: Record<string, number>
}

export interface SkillProfile {
  version: number
  name: string
  description: string
  skills: string[]
  targetIde: string
  createdAt: string
  updatedAt: string
}

export interface ProjectWithProfile extends Project {
  profile?: SkillProfile
  linkedSkillCount: number
  profileSkillCount: number
  syncStatus: 'synced' | 'drift' | 'no-profile'
}

// ---- Wire types shared with the web client (web/src imports these with
// `import type`, so the two sides can no longer drift apart silently). ----

/** A skill as sent in list payloads: the SKILL.md text is omitted and is
 *  fetched on demand from GET /api/skills/:id. */
export type SkillDTO = Omit<Skill, 'content'> & { content?: string }

export interface ConflictGroupDTO {
  name: string
  skills: SkillDTO[]
}

export type ScanStats = ScanResult['stats']

export type { AgentId }
