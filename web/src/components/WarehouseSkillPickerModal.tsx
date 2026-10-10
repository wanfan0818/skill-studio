import { useState, useMemo } from 'react'
import type { Skill } from '../hooks/useSkills'
import { WarehouseSourceBadge } from './SourceBadge'

interface WarehouseSkillPickerModalProps {
  isOpen: boolean
  onClose: () => void
  projectName: string
  projectPath: string
  targetIde: string
  installedSkillNames: string[]
  allSkills: Skill[]
  onToggleSkill: (skillName: string, currentlyInstalled: boolean) => Promise<void>
}

export function WarehouseSkillPickerModal({
  isOpen,
  onClose,
  projectName,
  projectPath,
  targetIde,
  installedSkillNames,
  allSkills,
  onToggleSkill,
}: WarehouseSkillPickerModalProps) {
  const [searchQuery, setSearchQuery] = useState('')
  // Only warehouse skills can be synced into a project from elsewhere; skills
  // of other projects / IDEs would show up as "找不到来源".
  const [filterWarehouseOnly, setFilterWarehouseOnly] = useState(true)
  const [onlyInstalled, setOnlyInstalled] = useState(false)
  const [busySkills, setBusySkills] = useState<Set<string>>(new Set())

  const installedSet = useMemo(() => new Set(installedSkillNames), [installedSkillNames])

  // Filter skills: deduplicate master skills and search
  const availableSkills = useMemo(() => {
    const map = new Map<string, Skill>()
    for (const s of allSkills) {
      if (!map.has(s.name) || s.isWarehouseSource) {
        map.set(s.name, s)
      }
    }
    let list = Array.from(map.values())

    if (filterWarehouseOnly) {
      list = list.filter((s) => s.isWarehouseSource || installedSet.has(s.name))
    }
    if (onlyInstalled) {
      list = list.filter((s) => installedSet.has(s.name))
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim()
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          (s.category && s.category.toLowerCase().includes(q))
      )
    }

    // Sort: already in the project first, then warehouse skills, then alphabetical
    return list.sort((a, b) => {
      const ia = installedSet.has(a.name), ib = installedSet.has(b.name)
      if (ia !== ib) return ia ? -1 : 1
      if (a.isWarehouseSource !== b.isWarehouseSource) {
        return a.isWarehouseSource ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
  }, [allSkills, filterWarehouseOnly, onlyInstalled, searchQuery, installedSet])

  if (!isOpen) return null

  const handleToggle = async (skillName: string) => {
    if (busySkills.has(skillName)) return
    const isCurrentlyInstalled = installedSet.has(skillName)
    
    setBusySkills((prev) => new Set(prev).add(skillName))
    try {
      await onToggleSkill(skillName, isCurrentlyInstalled)
    } finally {
      setBusySkills((prev) => {
        const next = new Set(prev)
        next.delete(skillName)
        return next
      })
    }
  }


  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">🏛️</span>
              <h2 className="text-lg font-bold text-slate-100">为项目添加 Skill</h2>
              <span className="px-2 py-0.5 rounded text-xs bg-slate-800 text-blue-400 font-mono">
                {projectName}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              添加的 Skill 会同步到：<span className="text-slate-200">{targetIde}</span>（点卡片上的「应用」后生效）
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Search & Filters */}
        <div className="p-4 border-b border-slate-800/80 bg-slate-900/50 flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[240px]">
            <span className="absolute left-3 top-2.5 text-slate-500 text-xs">🔍</span>
            <input
              type="text"
              placeholder="搜索技能名称、关键字或分类..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-8 pr-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={filterWarehouseOnly}
                onChange={(e) => setFilterWarehouseOnly(e.target.checked)}
                className="rounded border-slate-700 bg-slate-950 text-blue-500 focus:ring-0"
              />
              <span>只看仓库原件</span>
            </label>
            <span className="text-slate-600 text-xs">|</span>
            <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={onlyInstalled}
                onChange={(e) => setOnlyInstalled(e.target.checked)}
                className="rounded border-slate-700 bg-slate-950 text-blue-500 focus:ring-0"
              />
              <span>只看已在项目中（<strong className="text-blue-400">{installedSet.size}</strong>）</span>
            </label>
          </div>
        </div>

        {/* Skill List Grid */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {availableSkills.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-sm">
              未找到匹配的 Skill
            </div>
          ) : (
            availableSkills.map((skill) => {
              const isInstalled = installedSet.has(skill.name)
              const isBusy = busySkills.has(skill.name)
              return (
                <div
                  key={skill.name}
                  onClick={() => handleToggle(skill.name)}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-4 ${
                    isInstalled
                      ? 'bg-blue-950/20 border-blue-500/50 shadow-sm'
                      : 'bg-slate-950/40 border-slate-800/80 hover:border-slate-700 hover:bg-slate-950'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="text-sm font-semibold text-slate-100 font-mono">
                        /{skill.name}
                      </h4>
                      {skill.isWarehouseSource && <WarehouseSourceBadge />}
                      {skill.category && skill.category !== 'other' && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-800 text-slate-400">
                          {skill.category}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 line-clamp-1">
                      {skill.description || '无描述'}
                    </p>
                  </div>

                  <div className="shrink-0 flex items-center gap-2">
                    <button
                      disabled={isBusy}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleToggle(skill.name)
                      }}
                      className={`px-3 py-1 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 ${
                        isInstalled
                          ? 'bg-blue-500/20 text-blue-300 hover:bg-red-500/20 hover:text-red-300 border border-blue-500/30'
                          : 'bg-slate-800 text-slate-300 hover:bg-blue-600 hover:text-white border border-slate-700'
                      }`}
                    >
                      {isBusy ? (
                        <span className="animate-spin text-xs">⏳</span>
                      ) : isInstalled ? (
                        <>
                          <span>✓ 已在项目中</span>
                          <span className="text-[10px] opacity-60">点击移除</span>
                        </>
                      ) : (
                        <>
                          <span>＋ 添加</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/60 flex items-center justify-between">
          <span className="text-xs text-slate-500">
            路径: <span className="font-mono text-slate-400">{projectPath}</span>
          </span>
          <button
            onClick={onClose}
            className="px-5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-lg shadow-blue-900/20 transition-all"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
