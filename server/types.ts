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
  owner: string
  repo: string
  branch: string
  subPath: string
  installedCommit?: string
  installedAt?: string
  lastChecked?: string
  updateAvailable?: boolean
  latestCommit?: string
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
  lastModified: string
  security?: SecurityStatus
  githubSource?: SkillGithubSource // Added for GitHub update tracking
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
