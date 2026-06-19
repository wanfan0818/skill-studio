import { useState, useEffect } from 'react'
import type { Skill } from '../hooks/useSkills'

interface UpdaterPanelProps {
  skills: Skill[]
  isOpen: boolean
  onClose: () => void
  onUpdated: () => Promise<void>
}

export function UpdaterPanel({ skills, isOpen, onClose, onUpdated }: UpdaterPanelProps) {
  const [checking, setChecking] = useState(false)
  const [updatingAll, setUpdatingAll] = useState(false)
  const [autoLinking, setAutoLinking] = useState(false)
  const [rateLimit, setRateLimit] = useState<{ limit: number; remaining: number; reset: number } | null>(null)
  const [updatingSkills, setUpdatingSkills] = useState<Set<string>>(new Set())
  const [updateResults, setUpdateResults] = useState<Record<string, { success: boolean; error?: string }>>({})

  const handleAutoLink = async () => {
    setAutoLinking(true)
    try {
      const res = await fetch('/api/skills/updater/auto-link', {
        method: 'POST'
      })
      const data = await res.json()
      if (data.ok) {
        const totalText = data.totalBound !== undefined ? `系统目前已累计成功关联 ${data.totalBound} 个 Skill。` : ''
        alert(`智能关联成功！\n- 本次自动绑定了 ${data.boundCount} 个新 Skill。${data.boundCount > 0 ? `\n- 新增关联: ${data.boundSkills.join(', ')}` : ''}\n\n${totalText}`)
        await onUpdated()
      } else {
        alert('智能关联失败: ' + (data.error || '未知错误'))
      }
    } catch (err: any) {
      alert('智能关联失败: ' + err.message)
    } finally {
      setAutoLinking(false)
    }
  }

  const githubSkills = skills.filter((s) => s.githubSource)
  const skillsWithUpdates = skills.filter((s) => s.githubSource?.updateAvailable)

  useEffect(() => {
    if (isOpen) {
      fetchRateLimit()
    }
  }, [isOpen])

  const fetchRateLimit = async () => {
    try {
      const res = await fetch('/api/skills/updater/rate-limit')
      const data = await res.json()
      if (data.ok && data.rateLimit) {
        setRateLimit(data.rateLimit)
      }
    } catch {}
  }

  const handleCheckAll = async () => {
    setChecking(true)
    try {
      const res = await fetch('/api/skills/updater/check')
      const data = await res.json()
      if (data.ok) {
        if (data.rateLimit) {
          setRateLimit(data.rateLimit)
        }
        await onUpdated()
        alert(`检查完毕！共检查了 ${data.checkedCount} 个 Skill，发现 ${data.updatedCount} 个有更新。`)
      } else {
        alert('检查更新失败: ' + (data.error || '未知错误'))
      }
    } catch (err: any) {
      alert('检查更新失败: ' + err.message)
    } finally {
      setChecking(false)
    }
  }

  const handleUpdateOne = async (skill: Skill) => {
    setUpdatingSkills((prev) => {
      const next = new Set(prev)
      next.add(skill.id)
      return next
    })
    
    try {
      const res = await fetch(`/api/skills/updater/update/${skill.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latestCommit: skill.githubSource?.latestCommit }),
      })
      const data = await res.json()
      setUpdateResults((prev) => ({
        ...prev,
        [skill.id]: { success: data.ok, error: data.error },
      }))
      if (data.ok) {
        await onUpdated()
      }
    } catch (err: any) {
      setUpdateResults((prev) => ({
        ...prev,
        [skill.id]: { success: false, error: err.message },
      }))
    } finally {
      setUpdatingSkills((prev) => {
        const next = new Set(prev)
        next.delete(skill.id)
        return next
      })
    }
  }

  const handleUpdateAll = async () => {
    if (skillsWithUpdates.length === 0) return
    if (!confirm(`确定要更新所有 ${skillsWithUpdates.length} 个有更新的 Skill 吗？这将会覆盖本地对这些 Skill 的任何修改。`)) {
      return
    }

    setUpdatingAll(true)
    try {
      const res = await fetch('/api/skills/updater/update-all', {
        method: 'POST',
      })
      const data = await res.json()
      if (data.ok) {
        alert(`成功更新了 ${data.updatedCount} 个 Skill！`)
        await onUpdated()
      } else {
        alert('批量更新失败: ' + (data.error || '未知错误'))
      }
    } catch (err: any) {
      alert('批量更新失败: ' + err.message)
    } finally {
      setUpdatingAll(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-xl flex flex-col max-h-[85vh] shadow-2xl animate-in fade-in duration-200">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800/80 flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <span>🔄</span> Skill 更新管理器
            </h3>
            <p className="text-xs text-slate-500 font-medium mt-0.5">
              检查和拉取 GitHub 托管的 Skill 原始版本。共 {githubSkills.length} 个已关联的 GitHub 来源。
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-300 p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          
          {/* Top action cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 shrink-0">
            <div className="bg-slate-950/40 border border-slate-800 p-4 rounded-xl flex flex-col justify-between space-y-3">
              <div className="space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">批量检查更新</span>
                <p className="text-xs text-slate-400 leading-relaxed">调用 GitHub API 对所有已绑定来源的 Skill 进行更新检查。</p>
              </div>
              <button
                onClick={handleCheckAll}
                disabled={checking || updatingAll || autoLinking}
                className="w-full py-2 bg-slate-850 hover:bg-slate-800 active:bg-slate-900 border border-slate-800 disabled:opacity-50 text-slate-200 rounded-lg text-xs font-semibold border border-slate-800 transition-all cursor-pointer"
              >
                {checking ? '正在检查...' : '一键检查所有更新'}
              </button>
            </div>

            <div className="bg-slate-950/40 border border-slate-800 p-4 rounded-xl flex flex-col justify-between space-y-3">
              <div className="space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">批量拉取更新</span>
                <p className="text-xs text-slate-400 leading-relaxed">
                  当前有 <span className="text-indigo-400 font-bold">{skillsWithUpdates.length}</span> 个 Skill 有更新可用。
                </p>
              </div>
              <button
                onClick={handleUpdateAll}
                disabled={skillsWithUpdates.length === 0 || checking || updatingAll || autoLinking}
                className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-30 disabled:hover:bg-indigo-600 disabled:cursor-not-allowed text-white rounded-lg text-xs font-semibold transition-all shadow-md shadow-indigo-600/10 cursor-pointer"
              >
                {updatingAll ? '更新中...' : '一键拉取所有更新'}
              </button>
            </div>

            <div className="bg-slate-950/40 border border-slate-800 p-4 rounded-xl flex flex-col justify-between space-y-3">
              <div className="space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">一键检测关联</span>
                <p className="text-xs text-slate-400 leading-relaxed">
                  扫描本地 `skills-lock.json` 或 `skills.json` 自动关联 GitHub。
                </p>
              </div>
              <button
                onClick={handleAutoLink}
                disabled={checking || updatingAll || autoLinking}
                className="w-full py-2 bg-slate-850 hover:bg-slate-800 active:bg-slate-900 border border-slate-800 disabled:opacity-50 text-slate-200 rounded-lg text-xs font-semibold border border-slate-800 transition-all cursor-pointer"
              >
                {autoLinking ? '正在关联...' : '关联 skills.sh'}
              </button>
            </div>
          </div>

          {/* Rate Limit Info */}
          {rateLimit && (
            <div className="bg-slate-950/20 border border-slate-800/80 px-4 py-2.5 rounded-lg flex items-center justify-between text-[11px] text-slate-500 shrink-0">
              <span className="flex items-center gap-1.5">
                <span>⚡</span> GitHub API 剩余配额: <span className="font-semibold text-slate-400">{rateLimit.remaining} / {rateLimit.limit}</span>
              </span>
              {rateLimit.remaining < 15 && (
                <span className="text-amber-500 font-medium">额度偏低，建议在设置中配置 Token</span>
              )}
            </div>
          )}

          {/* List of Skills */}
          <div className="space-y-3">
            <h4 className="text-[11px] font-semibold text-slate-500 uppercase tracking-widest">
              有更新的 Skill ({skillsWithUpdates.length})
            </h4>

            {skillsWithUpdates.length === 0 ? (
              <div className="py-12 border border-dashed border-slate-800/80 rounded-xl flex flex-col items-center justify-center text-center space-y-1 shrink-0">
                <span className="text-lg">✨</span>
                <p className="text-xs text-slate-400 font-semibold">没有待更新的 Skill</p>
                <p className="text-[10px] text-slate-500">所有绑定的 GitHub 来源均已是最新状态。</p>
              </div>
            ) : (
              <div className="bg-slate-950/20 border border-slate-800/80 rounded-xl divide-y divide-slate-800/60 overflow-hidden shrink-0">
                {skillsWithUpdates.map((skill) => {
                  const isBusy = updatingSkills.has(skill.id)
                  const res = updateResults[skill.id]
                  return (
                    <div key={skill.id} className="p-3.5 flex items-center justify-between text-xs gap-4 hover:bg-slate-800/10 transition-colors">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-200">/{skill.name}</span>
                          <span className="text-[10px] font-mono text-slate-500 truncate max-w-[250px]">
                            {skill.githubSource?.owner}/{skill.githubSource?.repo}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-[10px] text-slate-500">
                          {skill.githubSource?.installedCommit && (
                            <span>本地: <span className="font-mono">{skill.githubSource.installedCommit.slice(0, 7)}</span></span>
                          )}
                          <span>最新: <span className="font-mono text-indigo-400/80">{skill.githubSource?.latestCommit?.slice(0, 7) || '获取中'}</span></span>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        {res && (
                          <span className={`text-[10px] font-medium ${res.success ? 'text-green-400' : 'text-red-400'}`}>
                            {res.success ? '✓ 成功' : '✗ 失败'}
                          </span>
                        )}
                        <button
                          onClick={() => handleUpdateOne(skill)}
                          disabled={isBusy || updatingAll}
                          className="px-3 py-1 bg-slate-850 hover:bg-slate-800 border border-slate-800 text-slate-350 rounded font-semibold transition-all disabled:opacity-50 text-[11px]"
                        >
                          {isBusy ? '更新中...' : '更新'}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
