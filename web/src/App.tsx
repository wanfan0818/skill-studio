import { useEffect, useState, useCallback } from 'react'
import { useSkills } from './hooks/useSkills'
import { useWebSocket } from './hooks/useWebSocket'
import { useTheme } from './hooks/useTheme'
import { StatsBar } from './components/StatsBar'
import { Sidebar } from './components/Sidebar'
import { SkillGrid } from './components/SkillGrid'
import { SkillDetail } from './components/SkillDetail'
import { Dashboard } from './components/Dashboard'
import { SimilarView } from './components/SimilarView'
import { TrashView } from './components/TrashView'
import { SyncView } from './components/SyncView'
import { ConflictsView } from './components/ConflictsView'
import { AboutModal } from './components/AboutModal'
import { Footer } from './components/Footer'
import { ExploreView } from './components/ExploreView'
import { ProjectsView } from './components/ProjectsView'
import { UpdaterPanel } from './components/UpdaterPanel'
import type { Skill } from './hooks/useSkills'
import { AGENT_ORDER, AGENT_META } from './agents'

type GroupBy = 'none' | 'scope' | 'source' | 'project' | 'category'
type View = 'skills' | 'similar' | 'explore' | 'dashboard' | 'trash' | 'sync' | 'conflicts' | 'projects'

function App() {
  const { allSkills, skills, stats, projects, conflicts, categories, health, mergeSuggestions, loading, error, scan, filterSkills } = useSkills()
  const { theme, toggle: toggleTheme } = useTheme()

  const [view, setView] = useState<View>('skills')
  const [scopeFilter, setScopeFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [agentFilter, setAgentFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [conflictOnly, setConflictOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>('scope')
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null)
  const [lastUpdate, setLastUpdate] = useState<string | null>(null)
  const [trashCount, setTrashCount] = useState<number>(0)
  const [selectMode, setSelectMode] = useState<boolean>(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState<boolean>(false)
  const [bulkDeleting, setBulkDeleting] = useState<boolean>(false)
  const [bulkDeleteResult, setBulkDeleteResult] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [conflictRowBusy, setConflictRowBusy] = useState<Set<string>>(new Set())
  const [aboutOpen, setAboutOpen] = useState<boolean>(false)
  const [updaterOpen, setUpdaterOpen] = useState<boolean>(false)
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('skill-hub:sidebar') !== 'closed'
    } catch {
      return true
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('skill-hub:sidebar', sidebarOpen ? 'open' : 'closed')
    } catch {}
  }, [sidebarOpen])

  useEffect(() => {
    scan()
  }, [scan])

  // Fetch trash count for the badge
  const refreshTrashCount = useCallback(async () => {
    try {
      const res = await fetch('/api/trash')
      const data = await res.json()
      if (data.ok) setTrashCount((data.items || []).length)
    } catch {}
  }, [])

  useEffect(() => {
    refreshTrashCount()
  }, [refreshTrashCount])

  // Sync selectedSkill with the updated version in allSkills
  useEffect(() => {
    if (selectedSkill) {
      const updated = allSkills.find(s => s.id === selectedSkill.id)
      if (updated) {
        setSelectedSkill(updated)
      } else {
        setSelectedSkill(null)
      }
    }
  }, [allSkills])

  // WebSocket: auto-refresh on file changes
  useWebSocket(
    useCallback(
      (data: any) => {
        if (data.type === 'change') {
          setLastUpdate(new Date().toLocaleTimeString('zh-CN'))
          scan()
        }
      },
      [scan],
    ),
  )

  const applyFilters = useCallback(
    (overrides?: { scope?: string; source?: string; agent?: string; category?: string; project?: string; search?: string; conflictOnly?: boolean }) => {
      filterSkills({
        scope: overrides?.scope ?? scopeFilter,
        source: overrides?.source ?? sourceFilter,
        agent: overrides?.agent ?? agentFilter,
        category: overrides?.category ?? categoryFilter,
        project: overrides?.project ?? projectFilter,
        search: overrides?.search ?? search,
        conflictOnly: overrides?.conflictOnly ?? conflictOnly,
      })
    },
    [filterSkills, scopeFilter, sourceFilter, agentFilter, categoryFilter, projectFilter, search, conflictOnly],
  )

  const handleScopeChange = (v: string) => {
    setScopeFilter(v)
    setProjectFilter('all')
    applyFilters({ scope: v, project: 'all' })
  }

  const handleSourceChange = (v: string) => {
    setSourceFilter(v)
    applyFilters({ source: v })
  }

  const handleAgentChange = (v: string) => {
    setAgentFilter(v)
    applyFilters({ agent: v })
  }

  const handleCategoryChange = (v: string) => {
    setCategoryFilter(v)
    applyFilters({ category: v })
  }

  const handleProjectChange = (v: string) => {
    setProjectFilter(v)
    if (v !== 'all') {
      setScopeFilter('all')
      applyFilters({ project: v, scope: 'all' })
    } else {
      applyFilters({ project: v })
    }
  }

  const handleSearch = (q: string) => {
    setSearch(q)
    applyFilters({ search: q })
  }

  // Batch selection handlers
  const toggleSelectMode = () => {
    setSelectMode((prev) => {
      if (prev) setSelectedIds(new Set())
      return !prev
    })
    setBulkDeleteResult(null)
  }

  const handleSelectToggle = useCallback((skill: Skill) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(skill.id)) next.delete(skill.id)
      else next.add(skill.id)
      return next
    })
  }, [])

  const selectAllVisible = () => {
    setSelectedIds(new Set(skills.map((s) => s.id)))
  }

  const clearSelection = () => {
    setSelectedIds(new Set())
  }

  const performBulkDelete = async () => {
    setBulkDeleting(true)
    setBulkDeleteResult(null)
    try {
      const items = Array.from(selectedIds)
        .map((id) => allSkills.find((s) => s.id === id))
        .filter((s): s is Skill => !!s)
        .map((s) => ({ id: s.id, path: s.path, skillName: s.name }))

      const res = await fetch('/api/skills/batch/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      const data = await res.json()
      if (!data.ok && !data.results) {
        setBulkDeleteResult({ kind: 'err', text: data.error || '批量删除失败' })
        return
      }
      const okCount: number = data.okCount ?? 0
      const failCount: number = data.failCount ?? 0
      if (failCount === 0) {
        setBulkDeleteResult({ kind: 'ok', text: `已删除 ${okCount} 个 Skill,可在回收站恢复` })
      } else {
        setBulkDeleteResult({ kind: 'err', text: `成功 ${okCount},失败 ${failCount}` })
      }
      setBulkDeleteConfirm(false)
      setSelectedIds(new Set())
      setSelectMode(false)
      await scan()
      await refreshTrashCount()
    } catch (e: any) {
      setBulkDeleteResult({ kind: 'err', text: e?.message || '请求失败' })
    } finally {
      setBulkDeleting(false)
    }
  }

  // Conflict row actions — reuse existing endpoints, track per-row busy state
  const withConflictBusy = async (skill: Skill, fn: () => Promise<void>) => {
    setConflictRowBusy((prev) => new Set(prev).add(skill.id))
    try {
      await fn()
      await scan()
      await refreshTrashCount()
    } finally {
      setConflictRowBusy((prev) => {
        const next = new Set(prev)
        next.delete(skill.id)
        return next
      })
    }
  }

  const handleConflictDelete = (skill: Skill) =>
    withConflictBusy(skill, async () => {
      if (!confirm(`把 "${skill.name}" (${skill.scope}) 移到回收站?\n\n路径: ${skill.path}\n\n7 天内可在回收站恢复。`)) return
      const res = await fetch(`/api/skills/${skill.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: skill.path, skillName: skill.name }),
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error)
    })


  // Keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedSkill(null)
        if (bulkDeleteConfirm) setBulkDeleteConfirm(false)
        else if (selectMode) {
          setSelectMode(false)
          setSelectedIds(new Set())
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectMode, bulkDeleteConfirm])

  const showInspector = !!selectedSkill

  return (
    <div className="h-screen w-screen bg-slate-950 text-slate-100 flex overflow-hidden relative select-none">
      {/* 第一栏：侧边栏 (Sidebar 作为全局一级导航) */}
      <Sidebar
        stats={stats}
        projects={projects}
        scopeFilter={scopeFilter}
        sourceFilter={sourceFilter}
        agentFilter={agentFilter}
        categoryFilter={categoryFilter}
        projectFilter={projectFilter}
        onScopeChange={handleScopeChange}
        onSourceChange={handleSourceChange}
        onAgentChange={handleAgentChange}
        onCategoryChange={handleCategoryChange}
        onProjectChange={handleProjectChange}
        currentView={view}
        onViewChange={(v: any) => {
          setView(v)
          setSelectedSkill(null) // 切换视图时清空选中的 Skill
        }}
        trashCount={trashCount}
      />

      {/* 中间栏与右边栏的容器 */}
      <div className="flex-1 flex min-w-0 h-full overflow-hidden">
        
        {/* 第二栏：核心内容工作区 (中栏) */}
        <div className="flex-1 flex flex-col min-w-0 h-full bg-slate-950/20">
          {view === 'projects' ? (
            <ProjectsView allSkills={allSkills} onRefreshSkills={scan} />
          ) : (
            <>
              {/* Top Bar for header title & actions */}
              <div className="h-14 border-b border-slate-800/80 px-6 flex items-center justify-between shrink-0 bg-slate-950/40">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm font-semibold text-slate-200">
                    {view === 'skills' && '技能库'}
                    {view === 'similar' && '相似度扫描'}
                    {view === 'explore' && '探索市场'}
                    {view === 'dashboard' && '大盘数据'}
                    {view === 'sync' && '路径配置与同步'}
                    {view === 'trash' && '回收站'}
                    {view === 'conflicts' && '冲突管理'}
                  </span>
                  {view === 'skills' && (
                    <span className="text-xs text-slate-500 font-mono">
                      (已过滤出 {skills.length} 个)
                    </span>
                  )}
                  {lastUpdate && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-medium hidden sm:inline-block">
                      最近同步: {lastUpdate}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2.5">
                  {view === 'skills' && (
                    <div className="relative">
                      <svg
                        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500"
                        width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                      >
                        <circle cx="11" cy="11" r="8" />
                        <path d="m21 21-4.3-4.3" />
                      </svg>
                      <input
                        type="text"
                        placeholder="过滤技能..."
                        value={search}
                        onChange={(e) => handleSearch(e.target.value)}
                        className="w-44 pl-7 pr-2.5 py-1.5 text-xs font-mono placeholder:text-slate-400"
                      />
                    </div>
                  )}

                  {/* Theme toggle */}
                  <button
                    onClick={toggleTheme}
                    className="p-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200 transition-all"
                    title={theme === 'dark' ? '日间模式' : '夜间模式'}
                  >
                    {theme === 'dark' ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <circle cx="12" cy="12" r="5" /><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                      </svg>
                    )}
                  </button>

                  {/* Updater Button */}
                  <button
                    onClick={() => setUpdaterOpen(true)}
                    className="p-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200 transition-all flex items-center justify-center"
                    title="更新管理器"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                    </svg>
                  </button>

                  {/* Scan Button */}
                  <button
                    onClick={scan}
                    disabled={loading}
                    className="px-3 py-1.5 bg-indigo-600 disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
                  >
                    {loading ? (
                      <div className="w-3 h-3 border-2 border-slate-950/30 border-t-slate-950 rounded-full animate-spin" />
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                      </svg>
                    )}
                    <span>{loading ? '扫描中...' : '一键扫描'}</span>
                  </button>
                </div>
              </div>

              {/* Scrollable Main Content */}
              <div className="flex-1 overflow-y-auto px-6 py-5 min-w-0">
                {view === 'sync' ? (
                  <SyncView allSkills={allSkills} />
                ) : view === 'explore' ? (
                  <ExploreView projects={projects} onInstalled={scan} />
                ) : view === 'conflicts' ? (
                  <ConflictsView
                    conflicts={conflicts}
                    onSkillClick={setSelectedSkill}
                    onDelete={handleConflictDelete}
                    busy={conflictRowBusy}
                  />
                ) : view === 'dashboard' ? (
                  <Dashboard stats={stats} projects={projects} conflicts={conflicts} skills={allSkills} health={health} categories={categories} mergeSuggestions={mergeSuggestions} onSkillClick={setSelectedSkill} onScan={scan} />
                ) : view === 'similar' ? (
                  <SimilarView onSkillClick={setSelectedSkill} />
                ) : view === 'trash' ? (
                  <TrashView
                    onCountChange={setTrashCount}
                    onRestored={() => {
                      scan()
                    }}
                  />
                ) : (
                  <div className="flex flex-col h-full min-w-0">
                    {/* Stats Bar */}
                    {stats.total > 0 && (
                      <div className="mb-4">
                        <StatsBar stats={stats} projects={projects} conflicts={conflicts.length} health={health} />
                      </div>
                    )}

                    {/* Toolbar */}
                    <div className="flex items-center justify-between mb-4 shrink-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-500">
                          筛选出 <span className="text-slate-300 font-medium">{skills.length}</span> 个 Skill
                        </span>
                        {conflicts.length > 0 && (
                          <button
                            onClick={() => setView('conflicts')}
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border border-amber-500/20 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-all"
                          >
                            <span>{conflicts.length} 组冲突</span>
                          </button>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={toggleSelectMode}
                          className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold border transition-all cursor-pointer ${
                            selectMode
                              ? 'bg-blue-500/10 border-blue-500/30 text-blue-500'
                              : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
                          }`}
                        >
                          <span>{selectMode ? '退出多选' : '批量选择'}</span>
                        </button>
                        <div className="flex items-center bg-slate-900 rounded-lg border border-slate-800 p-0.5">
                          {([
                            { value: 'scope', label: '按层级' },
                            { value: 'category', label: '按分类' },
                            { value: 'source', label: '按来源' },
                            { value: 'none', label: '平铺' },
                          ] as { value: GroupBy; label: string }[]).map((opt) => (
                            <button
                              key={opt.value}
                              onClick={() => setGroupBy(opt.value)}
                              className={`px-2.5 py-0.5 rounded text-[11px] transition-all
                                ${groupBy === opt.value
                                  ? 'bg-slate-700 text-slate-200 shadow-sm'
                                  : 'text-slate-500 hover:text-slate-300'
                                }`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Batch Toggles */}
                    {selectMode && (
                      <div className="mb-4 p-2.5 rounded bg-slate-900 border border-slate-800 flex items-center justify-between gap-3 flex-wrap shrink-0">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-slate-200 font-medium">
                            已选择 <span className="text-blue-500 font-mono font-bold">{selectedIds.size}</span> 个 Skill
                          </span>
                          <button
                            onClick={selectAllVisible}
                            disabled={skills.length === 0}
                            className="text-[11px] text-slate-500 hover:text-slate-300 disabled:opacity-40 cursor-pointer"
                          >
                            全选
                          </button>
                          {selectedIds.size > 0 && (
                            <button
                              onClick={clearSelection}
                              className="text-[11px] text-slate-500 hover:text-slate-300 cursor-pointer"
                            >
                              取消
                            </button>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <select
                            onChange={async (e) => {
                              const val = e.target.value
                              if (!val) return
                              if (selectedIds.size === 0) return

                              const agentName = e.target.options[e.target.selectedIndex].text
                              if (!confirm(`确定要将已选的 ${selectedIds.size} 个 Skill 批量挂载到 ${agentName} 中吗？`)) {
                                e.target.value = ''
                                return
                              }

                              try {
                                const res = await fetch('/api/skills/batch/symlink', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({
                                    action: 'add',
                                    agentId: val,
                                    skillIds: Array.from(selectedIds),
                                  }),
                                })
                                const data = await res.json()
                                if (data.ok) {
                                  const failed = (data.results || []).find((r: any) => !r.success)
                                  if (failed) {
                                    alert(`挂载部分成功，但有报错: ${failed.error}`)
                                  } else {
                                    alert(`批量挂载成功！已一键建立符号链接。`)
                                    setSelectedIds(new Set())
                                    setSelectMode(false)
                                  }
                                  await scan()
                                } else {
                                  alert(data.error || '分发失败')
                                }
                              } catch (err: any) {
                                alert('网络请求失败：' + err.message)
                              } finally {
                                e.target.value = ''
                              }
                            }}
                            disabled={selectedIds.size === 0}
                            className="px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed text-[11px] cursor-pointer"
                          >
                            <option value="">批量挂载到 IDE...</option>
                            {AGENT_ORDER.map((id) => {
                              const meta = AGENT_META[id]
                              if (!meta || id === 'unknown') return null
                              return (
                                <option key={id} value={id}>
                                  {meta.name}
                                </option>
                              )
                            })}
                          </select>

                          <button
                            onClick={() => setBulkDeleteConfirm(true)}
                            disabled={selectedIds.size === 0}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 disabled:opacity-40 border border-red-500/20 rounded text-[11px] font-semibold text-red-400 transition-all"
                          >
                            <span>删除所选 ({selectedIds.size})</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {bulkDeleteResult && (
                      <div
                        className={`mb-4 p-2.5 rounded-lg text-xs border flex items-center justify-between shrink-0 ${
                          bulkDeleteResult.kind === 'ok'
                            ? 'bg-green-500/10 border-green-500/20 text-green-400'
                            : 'bg-red-500/10 border-red-500/20 text-red-400'
                        }`}
                      >
                        <span>{bulkDeleteResult.text}</span>
                        <button
                          onClick={() => setBulkDeleteResult(null)}
                          className="text-[10px] opacity-60 hover:opacity-100"
                        >
                          关闭
                        </button>
                      </div>
                    )}

                    {/* Grid List */}
                    <div className="flex-1 min-h-0">
                      {loading && skills.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-20 gap-3 text-slate-400">
                          <div className="w-8 h-8 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
                          <span className="text-xs">检索中...</span>
                        </div>
                      ) : skills.length === 0 && stats.total === 0 ? (
                        <div className="flex flex-col items-center justify-center py-20 text-slate-500">
                          <div className="text-3xl mb-2">🔍</div>
                          <p className="text-xs">暂无 Skills，点击“一键扫描”开始</p>
                        </div>
                      ) : (
                        <SkillGrid
                          skills={skills}
                          groupBy={groupBy}
                          onSkillClick={setSelectedSkill}
                          selectMode={selectMode}
                          selectedIds={selectedIds}
                          onSelectToggle={handleSelectToggle}
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="shrink-0 bg-slate-950/10">
                <Footer onAboutClick={() => setAboutOpen(true)} />
              </div>
            </>
          )}
        </div>


        {/* 第三栏：Inspector 属性详情与编辑器 (右栏) */}
        {showInspector && (
          <div className="w-[480px] shrink-0 border-l border-slate-800/80 bg-slate-900/10 h-full flex flex-col overflow-hidden relative">
            {selectedSkill ? (
              <SkillDetail
                skill={selectedSkill}
                projects={projects}
                onClose={() => setSelectedSkill(null)}
                onChanged={scan}
                onToggle={async (skill, enabled) => {
                  await fetch(`/api/skills/${skill.id}/toggle`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled, skillName: skill.name }),
                  })
                  await scan()
                }}
                onSaveContent={async (skill, content) => {
                  await fetch(`/api/skills/${skill.id}/content`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ realPath: skill.realPath, content }),
                  })
                  await scan()
                }}
                onCopy={async (skill, targetScope, projectPath) => {
                  const res = await fetch('/api/skills/copy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sourcePath: skill.path, targetScope, projectPath, skillName: skill.name }),
                  })
                  const data = await res.json()
                  if (!data.ok) throw new Error(data.error)
                  await scan()
                }}
                onMove={async (skill, targetScope, projectPath) => {
                  const res = await fetch('/api/skills/move', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sourcePath: skill.path, targetScope, projectPath, skillName: skill.name }),
                  })
                  const data = await res.json()
                  if (!data.ok) throw new Error(data.error)
                  setSelectedSkill(null)
                  await scan()
                }}
                onDelete={async (skill) => {
                  const res = await fetch(`/api/skills/${skill.id}`, {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: skill.path, skillName: skill.name }),
                  })
                  const data = await res.json()
                  if (!data.ok) throw new Error(data.error)
                  setSelectedSkill(null)
                  await scan()
                  await refreshTrashCount()
                }}
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-slate-600 select-none bg-slate-900/5">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-2 opacity-30">
                  <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
                </svg>
                <span className="text-[11px]">选择一个 Skill 查看详情或编辑</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* About modal (Global) */}
      <AboutModal
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        stats={stats}
        conflictCount={conflicts.length}
      />

      <UpdaterPanel
        skills={allSkills}
        isOpen={updaterOpen}
        onClose={() => setUpdaterOpen(false)}
        onUpdated={scan}
      />

      {/* Bulk delete confirm (Global) */}
      {bulkDeleteConfirm && (
        <div className="fixed inset-0 bg-black/65 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-md w-full p-6 space-y-4 shadow-2xl shadow-black/40">
            <h3 className="text-base font-semibold text-slate-100">批量删除确认</h3>
            <p className="text-sm text-slate-400">
              即将把 <span className="text-slate-200 font-semibold">{selectedIds.size}</span> 个 Skill 移到回收站。
              回收站保留 7 天，期间可随时恢复。
            </p>
            <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-800 divide-y divide-slate-850">
              {Array.from(selectedIds)
                .map((id) => allSkills.find((s) => s.id === id))
                .filter((s): s is Skill => !!s)
                .slice(0, 50)
                .map((s) => (
                  <div key={s.id} className="px-3 py-1.5 text-xs flex items-center gap-2">
                    <span className="text-slate-300 truncate flex-1">/{s.name}</span>
                    <span className="text-[10px] text-slate-600 shrink-0">{s.scope}</span>
                  </div>
                ))}
              {selectedIds.size > 50 && (
                <div className="px-3 py-1.5 text-[11px] text-slate-500 text-center">
                  ...还有 {selectedIds.size - 50} 个
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={performBulkDelete}
                disabled={bulkDeleting}
                className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 disabled:opacity-40 rounded-lg text-sm font-medium text-red-350 transition-all"
              >
                {bulkDeleting ? '删除中...' : `确认删除 ${selectedIds.size} 个`}
              </button>
              <button
                onClick={() => setBulkDeleteConfirm(false)}
                disabled={bulkDeleting}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm text-slate-300"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
