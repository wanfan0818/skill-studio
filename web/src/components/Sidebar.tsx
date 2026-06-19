import type { Stats, Project } from '../hooks/useSkills'
import { AGENT_ORDER, getAgentMeta } from '../agents'
import { getCategoryMeta } from './CategoryBadge'

interface SidebarProps {
  stats: Stats
  projects: Project[]
  scopeFilter: string
  sourceFilter: string
  agentFilter: string
  categoryFilter: string
  projectFilter: string
  onScopeChange: (v: string) => void
  onSourceChange: (v: string) => void
  onAgentChange: (v: string) => void
  onCategoryChange: (v: string) => void
  onProjectChange: (v: string) => void
  currentView: string
  onViewChange: (v: any) => void
  trashCount: number
}

export function Sidebar({
  stats,
  projects,
  scopeFilter,
  sourceFilter,
  agentFilter,
  categoryFilter,
  projectFilter,
  onScopeChange,
  onSourceChange,
  onAgentChange,
  onCategoryChange,
  onProjectChange,
  currentView,
  onViewChange,
  trashCount,
}: SidebarProps) {
  const scopeItems = [
    { value: 'all', label: '全部', count: stats.total },
    { value: 'global', label: '全局 Skills', count: stats.global },
    { value: 'project', label: '项目级 Skills', count: stats.project },
  ]

  const sourceItems = [
    { value: 'all', label: '全部来源' },
    ...Object.entries(stats.bySource)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({
        value: k,
        label: sourceLabel(k),
        count: v,
      })),
  ]

  const agentEntries = AGENT_ORDER
    .map((id) => ({ id, count: stats.byAgent?.[id] || 0 }))
    .filter((e) => e.count > 0)
  const agentItems = [
    { value: 'all', label: '全部 Agent', icon: '📋', count: stats.total },
    ...agentEntries.map((e) => {
      const meta = getAgentMeta(e.id)
      return { value: meta.id, label: meta.name, icon: meta.icon, count: e.count }
    }),
  ]

  const menuItems = [
    { value: 'dashboard', label: '大盘数据', icon: '📊' },
    { value: 'skills', label: '技能库', icon: '📂', count: stats.total },
    { value: 'explore', label: '探索市场', icon: '🔍' },
    { value: 'projects', label: '项目管理', icon: '📁' },
    { value: 'sync', label: '路径与同步', icon: '⚙️' },
    { value: 'trash', label: '回收站', icon: '🗑️', count: trashCount },
  ]

  return (
    <aside className="w-60 shrink-0 flex flex-col h-full bg-slate-900/30 border-r border-slate-800/80 p-4 space-y-6 overflow-y-auto">
      {/* 顶部 Brand */}
      <div className="flex items-center gap-2.5 px-1 mb-1 shrink-0">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-600 via-purple-600 to-cyan-500 flex items-center justify-center text-white font-extrabold text-sm shadow-md shadow-indigo-600/20">
          S
        </div>
        <span className="font-extrabold text-xs tracking-wider cyber-gradient-text uppercase">
          SKILL STUDIO
        </span>
      </div>

      {/* 1. 功能导航 */}
      <FilterSection title="功能导航">
        {menuItems.map((item) => (
          <button
            key={item.value}
            onClick={() => onViewChange(item.value)}
            className={`w-full text-left px-3 py-2 rounded-lg text-[13px] font-medium transition-all flex justify-between items-center
              ${currentView === item.value
                ? 'bg-slate-800 text-slate-100 shadow-sm border border-slate-700/50'
                : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-300'
              }`}
          >
            <span className="flex items-center gap-2 truncate">
              <span className="text-xs">{item.icon}</span>
              <span>{item.label}</span>
            </span>
            {item.count !== undefined && item.count > 0 && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${currentView === item.value ? 'bg-slate-900 text-slate-300' : 'bg-slate-800 text-slate-500'}`}>
                {item.count}
              </span>
            )}
          </button>
        ))}
      </FilterSection>

      {/* 2. 过滤器 (只在技能库视图下展开) */}
      {currentView === 'skills' && (
        <div className="space-y-5 pt-4 border-t border-slate-800/40">
          {/* Scope */}
          <FilterSection title="层级">
            {scopeItems.map((item) => (
              <FilterButton
                key={item.value}
                active={scopeFilter === item.value}
                onClick={() => onScopeChange(item.value)}
                label={item.label}
                count={item.count}
                icon={scopeIcon(item.value)}
              />
            ))}
          </FilterSection>

          {/* Agent type */}
          <FilterSection title="Agent 类型">
            {agentItems.map((item) => (
              <FilterButton
                key={item.value}
                active={agentFilter === item.value}
                onClick={() => onAgentChange(item.value)}
                label={item.label}
                count={item.count}
                icon={item.icon}
              />
            ))}
          </FilterSection>

          {/* Category */}
          {Object.keys(stats.byCategory || {}).length > 0 && (
            <FilterSection title="分类">
              <FilterButton
                active={categoryFilter === 'all'}
                onClick={() => onCategoryChange('all')}
                label="全部分类"
                icon="📋"
                count={stats.total}
              />
              {Object.entries(stats.byCategory || {})
                .sort((a, b) => b[1] - a[1])
                .map(([catId, count]) => {
                  const meta = getCategoryMeta(catId)
                  return (
                    <FilterButton
                      key={catId}
                      active={categoryFilter === catId}
                      onClick={() => onCategoryChange(catId)}
                      label={meta.name}
                      icon={meta.icon}
                      count={count}
                    />
                  )
                })}
            </FilterSection>
          )}

          {/* Source */}
          <FilterSection title="来源">
            {sourceItems.map((item) => (
              <FilterButton
                key={item.value}
                active={sourceFilter === item.value}
                onClick={() => onSourceChange(item.value)}
                label={item.label}
                count={'count' in item ? (item as any).count : undefined}
                icon={sourceIcon(item.value)}
              />
            ))}
          </FilterSection>

          {/* Projects */}
          {projects.length > 0 && (
            <FilterSection title="项目">
              <FilterButton
                active={projectFilter === 'all'}
                onClick={() => onProjectChange('all')}
                label="全部项目"
              />
              {projects.map((p) => (
                <FilterButton
                  key={p.path}
                  active={projectFilter === p.path}
                  onClick={() => onProjectChange(p.path)}
                  label={p.name}
                  count={p.skillCount}
                  icon="📁"
                />
              ))}
            </FilterSection>
          )}
        </div>
      )}
    </aside>
  )
}

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-widest mb-2 px-1">
        {title}
      </h3>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function FilterButton({
  active,
  onClick,
  label,
  count,
  icon,
}: {
  active: boolean
  onClick: () => void
  label: string
  count?: number
  icon?: string
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 rounded-lg text-[13px] transition-all flex justify-between items-center
        ${active
          ? 'bg-indigo-600/15 text-indigo-400 font-medium'
          : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-300'
        }`}
    >
      <span className="flex items-center gap-2 truncate">
        {icon && <span className="text-xs">{icon}</span>}
        <span className="truncate">{label}</span>
      </span>
      {count !== undefined && (
        <span className={`text-[11px] tabular-nums ${active ? 'text-indigo-400/70' : 'text-slate-600'}`}>
          {count}
        </span>
      )}
    </button>
  )
}

function scopeIcon(scope: string): string {
  const icons: Record<string, string> = { all: '📋', global: '🌐', project: '📂', plugin: '🔌' }
  return icons[scope] || ''
}

function sourceIcon(source: string): string {
  const icons: Record<string, string> = { all: '', newmax: '🟣', agents: '🔵', local: '🟢', unknown: '⚪' }
  return icons[source] || '⚪'
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    newmax: 'Newmax 框架',
    agents: 'Agents 平台',
    local: '本地',
    symlink: '符号链接',
    unknown: '未知',
  }
  return labels[source] || source
}
