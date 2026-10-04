import { useState, useEffect, useMemo } from 'react'
import type { Skill } from '../hooks/useSkills'

interface GlobalSkillsModalProps {
  allSkills: Skill[]
  onClose: (refreshed?: boolean) => void
}

export function GlobalSkillsModal({ allSkills, onClose }: GlobalSkillsModalProps) {
  const [selectedSkillNames, setSelectedSkillNames] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  // Deduplicate master warehouse skills by name safely
  const uniqueMasterSkills = useMemo(() => {
    const map = new Map<string, Skill>()
    const safeList = Array.isArray(allSkills) ? allSkills : []
    for (const s of safeList) {
      if (s && s.name) {
        if (!map.has(s.name) || s.isWarehouseSource) {
          map.set(s.name, s)
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [allSkills])

  // Load current global config on mount
  useEffect(() => {
    let active = true
    setLoading(true)
    fetch('/api/global-skills')
      .then((res) => res.json())
      .then((data) => {
        if (active && data.ok && Array.isArray(data.globalSkills)) {
          setSelectedSkillNames(new Set(data.globalSkills))
        }
      })
      .catch((err) => console.error('Failed reading global skills config:', err))
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const filteredSkills = useMemo(() => {
    if (!search.trim()) return uniqueMasterSkills
    const q = search.toLowerCase().trim()
    return uniqueMasterSkills.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.description && s.description.toLowerCase().includes(q)),
    )
  }, [uniqueMasterSkills, search])

  const toggleSelect = (skillName: string) => {
    setSelectedSkillNames((prev) => {
      const next = new Set(prev)
      if (next.has(skillName)) {
        next.delete(skillName)
      } else {
        next.add(skillName)
      }
      return next
    })
  }

  const handleSave = async () => {
    setSaving(true)
    setNotice(null)
    try {
      const res = await fetch('/api/global-skills/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          globalSkills: Array.from(selectedSkillNames),
          targetIdes: ['claude-code', 'codex', 'antigravity', 'workbuddy', 'zcode'],
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setNotice({ kind: 'success', text: data.message || '全局 Skill 配置保存成功！' })
        setTimeout(() => onClose(true), 1200)
      } else {
        setNotice({ kind: 'error', text: data.error || '保存全局配置失败' })
      }
    } catch (err: any) {
      setNotice({ kind: 'error', text: '请求出错: ' + err.message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">🌐</span>
              <h2 className="text-lg font-bold text-slate-100">全局通用 Skill 配置中心</h2>
              <span className="px-2 py-0.5 rounded text-xs bg-emerald-500/20 text-emerald-400 font-mono">
                已选中 {selectedSkillNames.size} 个全局 Skill
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              勾选提升为全局 Skill 后，无需在各个项目内单独绑定，各大 IDE 即可在所有项目中跨领域全局直接激活调用！
            </p>
          </div>
          <button
            onClick={() => onClose(false)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Notice */}
        {notice && (
          <div className={`mx-6 mt-4 px-4 py-2.5 rounded-lg flex items-center justify-between text-xs backdrop-blur-sm ${
            notice.kind === 'success' ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20' :
            'bg-rose-500/10 text-rose-300 border border-rose-500/20'
          }`}>
            <span>{notice.kind === 'success' ? '✨ ' : '🚨 '}{notice.text}</span>
          </div>
        )}

        {/* Filter bar */}
        <div className="px-6 pt-4 pb-2 border-b border-slate-800/60 flex items-center justify-between gap-4">
          <input
            type="text"
            placeholder="搜索 Skill 名称或描述..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-3.5 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500/50 transition w-full max-w-sm"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelectedSkillNames(new Set())}
              className="text-xs text-slate-400 hover:text-slate-200 transition"
            >
              清空勾选
            </button>
          </div>
        </div>

        {/* Content list */}
        <div className="flex-1 overflow-y-auto p-6 space-y-2">
          {loading ? (
            <div className="py-12 text-center text-slate-500 text-xs animate-pulse">
              ⏳ 正在加载 Skill 列表与全局状态...
            </div>
          ) : filteredSkills.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-xs">
              未找到匹配的 Skill
            </div>
          ) : (
            filteredSkills.map((s) => {
              const isChecked = selectedSkillNames.has(s.name)
              return (
                <div
                  key={s.name}
                  onClick={() => toggleSelect(s.name)}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                    isChecked
                      ? 'bg-emerald-950/20 border-emerald-500/50 text-slate-100 shadow-sm'
                      : 'bg-slate-950/40 border-slate-800/80 text-slate-400 hover:border-slate-700 hover:bg-slate-950'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {}}
                      className="w-4 h-4 rounded border-slate-700 text-emerald-600 focus:ring-emerald-500/20 bg-slate-900 shrink-0 cursor-pointer"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-xs font-bold text-slate-100 font-mono">
                          /{s.name}
                        </span>
                        {isChecked && (
                          <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                            🌐 全局已开启
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400 line-clamp-1">
                        {s.description || '无描述'}
                      </p>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between">
          <div className="text-xs text-slate-400">
            全域生效目标: <span className="text-slate-200 font-mono">Claude Code, Codex, Antigravity, WorkBuddy, ZCode</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onClose(false)}
              className="px-4 py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-all"
            >
              取消
            </button>
            <button
              disabled={saving}
              onClick={handleSave}
              className="px-5 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-950/30 transition-all flex items-center gap-1.5"
            >
              {saving ? (
                <span>⏳ 应用部署中...</span>
              ) : (
                <>
                  <span>🌐</span>
                  <span>保存并应用全局部署 ({selectedSkillNames.size})</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
