import { useState, useCallback } from 'react'
import type { HealthReport, MergeSuggestion, CategorySummary } from '../components/HealthPanel'

// Wire types come from the server so both sides stay in sync.
import type {
  SkillDTO,
  SkillGithubSource as ServerSkillGithubSource,
  ScanStats,
  Project as ServerProject,
  ConflictGroupDTO,
} from '../../../server/types'

export type Skill = SkillDTO
export type SkillGithubSource = ServerSkillGithubSource
export type Stats = ScanStats
export type Project = ServerProject
export type ConflictGroup = ConflictGroupDTO

export function useSkills() {
  const [allSkills, setAllSkills] = useState<Skill[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [stats, setStats] = useState<Stats>({ total: 0, global: 0, project: 0, bySource: {}, byAgent: {}, byCategory: {} })
  const [projects, setProjects] = useState<Project[]>([])
  const [conflicts, setConflicts] = useState<ConflictGroup[]>([])
  const [categories, setCategories] = useState<CategorySummary[]>([])
  const [health, setHealth] = useState<HealthReport | null>(null)
  const [mergeSuggestions, setMergeSuggestions] = useState<MergeSuggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // force=false serves the server's cache (invalidated by file changes and
  // every mutation); the manual scan button forces a rescan.
  const scan = useCallback(async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(force ? '/api/scan?force=1' : '/api/scan')
      if (!res.ok) throw new Error('Scan failed')
      const data = await res.json()
      setAllSkills(data.skills)
      setSkills(data.skills)
      setStats(data.stats)
      setProjects(data.projects)
      setConflicts(data.conflicts)
      setCategories(data.categories || [])
      setHealth(data.health || null)
      setMergeSuggestions(data.mergeSuggestions || [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const filterSkills = useCallback(
    (opts: { scope?: string; source?: string; agent?: string; category?: string; search?: string; project?: string; conflictOnly?: boolean; globalOnly?: boolean }) => {
      let filtered = [...allSkills]

      if (opts.globalOnly) {
        filtered = filtered.filter((s) => s.isGlobalActive || s.scope === 'global')
      }
      if (opts.scope && opts.scope !== 'all') {
        filtered = filtered.filter((s) => s.scope === opts.scope)
      }
      if (opts.source && opts.source !== 'all') {
        filtered = filtered.filter((s) => s.source === opts.source)
      }
      if (opts.agent && opts.agent !== 'all') {
        filtered = filtered.filter((s) => s.agent === opts.agent)
      }
      if (opts.category && opts.category !== 'all') {
        filtered = filtered.filter((s) => s.category === opts.category)
      }
      if (opts.project && opts.project !== 'all') {
        filtered = filtered.filter((s) => s.projectPath === opts.project || (opts.project === 'global' && s.scope === 'global'))
      }
      if (opts.conflictOnly) {
        filtered = filtered.filter((s) => s.hasConflict)
      }
      if (opts.search) {
        const q = opts.search.toLowerCase()
        filtered = filtered.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.source.toLowerCase().includes(q),
        )
      }

      setSkills(filtered)
    },
    [allSkills],
  )

  return {
    allSkills,
    skills,
    stats,
    projects,
    conflicts,
    categories,
    health,
    mergeSuggestions,
    loading,
    error,
    scan,
    filterSkills,
  }
}
