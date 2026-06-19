import { SourceBadge, ScopeBadge, AgentBadge } from './SourceBadge'
import { CategoryBadge } from './CategoryBadge'
import type { Skill } from '../hooks/useSkills'

interface SkillCardProps {
  skill: Skill
  onClick?: (skill: Skill) => void
  selectMode?: boolean
  selected?: boolean
  onSelectToggle?: (skill: Skill) => void
}

function asText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return '[object]'
  }
}

export function SkillCard({ skill, onClick, selectMode, selected, onSelectToggle }: SkillCardProps) {
  const name = asText(skill.name)
  const description = asText(skill.description)
  const model = asText(skill.frontmatter?.model)

  const handleClick = () => {
    if (selectMode) {
      onSelectToggle?.(skill)
    } else {
      onClick?.(skill)
    }
  }

  return (
    <div
      onClick={handleClick}
      className={`group relative rounded-xl border p-4 cursor-pointer transition-all duration-200
        ${selected
          ? 'border-blue-500 bg-slate-900 shadow-md'
          : skill.enabled
            ? 'border-slate-700 bg-slate-950 hover:border-slate-500 hover:bg-slate-900'
            : 'border-slate-800 bg-slate-900 opacity-50 hover:opacity-75'
        }`}
    >
      {/* Conflict indicator */}
      {skill.hasConflict && (
        <div 
          className="absolute -top-1.5 -right-1.5 w-3 h-3 rounded-full bg-amber-500 ring-2 ring-slate-950" 
          title="发生命名冲突"
        />
      )}

      {/* Update indicator */}
      {skill.githubSource?.updateAvailable && (
        <div 
          className={`absolute -top-1.5 w-3.5 h-3.5 rounded-full bg-blue-500 ring-2 ring-slate-950 flex items-center justify-center text-[8px] text-white font-bold ${
            skill.hasConflict ? 'right-2.5' : '-right-1.5'
          }`} 
          title="GitHub 有更新可用"
        >
          ↑
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between mb-2 gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {selectMode && (
            <div
              className={`w-4 h-4 shrink-0 rounded border flex items-center justify-center transition-all ${
                selected
                  ? 'bg-blue-500 border-blue-500 text-white'
                  : 'bg-slate-950 border-slate-700 group-hover:border-slate-500'
              }`}
            >
              {selected && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" className="text-white">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </div>
          )}
          <h3 className="text-sm font-semibold text-slate-100 group-hover:text-blue-500 transition-colors truncate">
            /{name}
          </h3>
        </div>
        <div className="flex gap-1 shrink-0 items-center">
          <AgentBadge agent={skill.agent} />
          <ScopeBadge scope={skill.scope} />
        </div>
      </div>

      {/* Description */}
      <p className="text-xs text-slate-400 line-clamp-2 mb-3 leading-relaxed min-h-[2.5rem]">
        {description || '无描述'}
      </p>

      {/* Footer */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <SourceBadge source={skill.source} />
          {skill.githubSource && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-500/10 text-blue-500 border border-blue-500/20" title="已链接 GitHub 来源">
              🐙 GitHub
            </span>
          )}
          {skill.category && skill.category !== 'other' && (
            <CategoryBadge category={skill.category} />
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          {skill.symlinkTarget && (
            <span title={`→ ${skill.symlinkTarget}`}>🔗</span>
          )}
          {!skill.enabled && (
            <span className="text-red-400/80 text-[11px]">禁用</span>
          )}
          {model && (
            <span className="text-slate-500">{model}</span>
          )}
        </div>
      </div>
    </div>
  )
}
