import { useState, useMemo } from 'react'
import { getAgentMeta } from '../agents'
import type { Skill } from '../hooks/useSkills'

interface SkillProfile {
  version: number
  name: string
  description: string
  skills: string[]
  targetIde: string
  createdAt: string
  updatedAt: string
}

interface ProjectWithProfile {
  name: string
  path: string
  skillCount: number
  profile?: SkillProfile
  linkedSkillCount: number
  profileSkillCount: number
  syncStatus: 'synced' | 'drift' | 'no-profile'
}

interface ProjectManageModalProps {
  isOpen: boolean
  onClose: () => void
  project: ProjectWithProfile
  allSkills: Skill[]
  onUninstallSkill: (projectPath: string, skillName: string) => Promise<void>
  onChangeIde: (projectPath: string, newTargetIde: string) => Promise<void>
  onOpenWarehousePicker: () => void
  onSyncProject: (projectPath: string) => Promise<void>
  onDeleteProject?: (projectPath: string, projectName: string) => void
}

export function ProjectManageModal({
  isOpen,
  onClose,
  project,
  allSkills = [],
  onUninstallSkill,
  onChangeIde,
  onOpenWarehousePicker,
  onSyncProject,
  onDeleteProject,
}: ProjectManageModalProps) {
  if (!isOpen || !project) return null

  const profile = project.profile
  const currentIde = profile?.targetIde || 'claude-code'
  const [selectedIde, setSelectedIde] = useState(currentIde)
  const [busySkills, setBusySkills] = useState<Set<string>>(new Set())
  const [isChangingIde, setIsChangingIde] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)

  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const activeSkillsList = profile?.skills || []

  // Create a map of skills from allSkills for metadata lookup safely
  const skillMap = useMemo(() => {
    const map = new Map<string, Skill>()
    const safeSkills = Array.isArray(allSkills) ? allSkills : []
    for (const s of safeSkills) {
      if (s && s.name) {
        if (!map.has(s.name) || s.isWarehouseSource) {
          map.set(s.name, s)
        }
      }
    }
    return map
  }, [allSkills])

  const handleIdeChange = async (newIde: string) => {
    setSelectedIde(newIde)
    if (newIde === currentIde) return
    setIsChangingIde(true)
    setNotice(null)
    try {
      await onChangeIde(project.path, newIde)
      setNotice({ kind: 'success', text: `IDE 代理配置已更变为 ${newIde}` })
    } catch (err: any) {
      setNotice({ kind: 'error', text: `切换 IDE 失败: ${err.message}` })
    } finally {
      setIsChangingIde(false)
    }
  }

  const handleRemoveSkill = async (skillName: string) => {
    if (busySkills.has(skillName)) return
    setBusySkills((prev) => new Set(prev).add(skillName))
    setNotice(null)
    try {
      await onUninstallSkill(project.path, skillName)
      setNotice({ kind: 'success', text: `已成功解绑移除 /${skillName}` })
    } catch (err: any) {
      setNotice({ kind: 'error', text: `解绑失败: ${err.message}` })
    } finally {
      setBusySkills((prev) => {
        const next = new Set(prev)
        next.delete(skillName)
        return next
      })
    }
  }

  const handleSync = async () => {
    setIsSyncing(true)
    try {
      await onSyncProject(project.path)
    } finally {
      setIsSyncing(false)
    }
  }

  const selectedAgentMeta = getAgentMeta(selectedIde)
  const isSymlinkIde = selectedIde === 'claude-code' || selectedIde === 'codex' || selectedIde === 'cursor'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">📁</span>
              <h2 className="text-lg font-bold text-slate-100">项目集中操控台</h2>
              <span className="px-2 py-0.5 rounded text-xs bg-slate-800 text-blue-400 font-mono">
                {project.name}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1 font-mono break-all">
              {project.path}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Modal internal notice */}
          {notice && (
            <div className={`px-4 py-3 rounded-lg flex items-center justify-between text-xs backdrop-blur-sm ${
              notice.kind === 'success' ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20' :
              'bg-rose-500/10 text-rose-300 border border-rose-500/20'
            }`}>
              <div className="flex items-center gap-2">
                <span>{notice.kind === 'success' ? '✨' : '🚨'}</span>
                <span>{notice.text}</span>
              </div>
              <button onClick={() => setNotice(null)} className="text-slate-400 hover:text-white transition">×</button>
            </div>
          )}

          {/* Section 1: Target IDE Engine */}
          <div className="space-y-3 bg-slate-950/40 p-4 rounded-xl border border-slate-800/80">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <span>⚙️ 目标 IDE 引擎</span>
                {isChangingIde && <span className="text-blue-400 text-[10px] animate-pulse">(应用新规则中...)</span>}
              </label>
              <div className="flex items-center gap-1.5 text-xs text-slate-400">
                <span>当前应用:</span>
                <span className={`px-2 py-0.5 rounded text-xs font-medium border ${selectedAgentMeta.color.bg} ${selectedAgentMeta.color.text} ${selectedAgentMeta.color.ring.replace('ring', 'border')}`}>
                  {selectedAgentMeta.icon} {selectedAgentMeta.name}
                </span>
              </div>
            </div>

            {/* Popular IDE selector buttons */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
              {['claude-code', 'codex', 'antigravity', 'workbuddy', 'zcode', 'cursor'].map((ideId) => {
                const meta = getAgentMeta(ideId)
                const isSelected = selectedIde === ideId
                return (
                  <button
                    key={ideId}
                    disabled={isChangingIde}
                    onClick={() => handleIdeChange(ideId)}
                    className={`p-2.5 rounded-xl border text-xs text-left transition-all flex items-center gap-2 ${
                      isSelected
                        ? 'bg-blue-600/20 border-blue-500 text-white font-semibold shadow-sm'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                    }`}
                  >
                    <span className="text-base">{meta.icon}</span>
                    <span className="truncate">{meta.name}</span>
                  </button>
                )
              })}
            </div>

            {/* Hint message based on selected IDE */}
            <div className="text-[11px] text-slate-400 bg-slate-900/60 p-2.5 rounded-lg border border-slate-800 flex items-center gap-2">
              <span>💡</span>
              {isSymlinkIde ? (
                <span>
                  <strong>快捷软链接模式</strong>: 自动建立快捷 Symlink 至 <code className="text-emerald-400 font-mono">.agents/skills</code> 并自动维护 <code className="text-emerald-400 font-mono">.{selectedIde}/skills</code> 网关。仓库 `git pull` 一键全网更新。
                </span>
              ) : (
                <span>
                  <strong>物理副本隔离模式 ({selectedAgentMeta?.name || selectedIde})</strong>: 为兼容沙盒隔离，部署物理实体文件夹。源 Skill 修改后当显示「副本已过时」，点击【覆盖更新】或下方【应用全量同步】即可立刻强力覆盖更新至项目。
                </span>
              )}
            </div>
          </div>

          {/* Section 2: Active Skills Management */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-slate-200 flex items-center gap-1.5">
                  <span>🧩 已绑定的 Skills</span>
                  <span className="px-2 py-0.5 rounded-full text-xs bg-slate-800 text-slate-300">
                    {activeSkillsList.length}
                  </span>
                </h3>
              </div>

              <button
                onClick={onOpenWarehousePicker}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-900/20 transition-all flex items-center gap-1.5"
              >
                <span>➕ 从仓库新增 Skill</span>
              </button>
            </div>

            {/* Skills List */}
            {activeSkillsList.length === 0 ? (
              <div className="py-10 bg-slate-950/20 rounded-xl border border-dashed border-slate-800 text-center text-slate-500 text-xs">
                当前项目未绑定任何 Skill，点击上方「从仓库新增 Skill」进行配给
              </div>
            ) : (
              <div className="space-y-2">
                {activeSkillsList.map((skillName) => {
                  const masterSkill = skillMap.get(skillName)
                  const linkedInfo = masterSkill?.linkedProjects?.find((p) => p.path === project.path)
                  const isRemoving = busySkills.has(skillName)

                  return (
                    <div
                      key={skillName}
                      className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800/80 flex items-center justify-between gap-4 hover:border-slate-700/80 transition-all"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-sm font-semibold text-slate-100 font-mono">
                            /{skillName}
                          </span>

                          {/* Deployment & Drift Status */}
                          {linkedInfo?.isCopy ? (
                            <span className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                              📂 物理副本
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              ⚡ 快捷软链接
                            </span>
                          )}

                          {linkedInfo?.hasDrift && (
                            <span className="px-1.5 py-0.2 rounded text-[10px] font-semibold bg-red-500/20 text-red-400 border border-red-500/30 animate-pulse">
                              ⚠️ 副本已过时 (仓库已更新)
                            </span>
                          )}

                          {masterSkill?.isWarehouseSource && (
                            <span className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-indigo-500/20 text-indigo-400">
                              🏛️ 仓库原件
                            </span>
                          )}
                        </div>

                        <p className="text-xs text-slate-400 line-clamp-1">
                          {masterSkill?.description || '无描述'}
                        </p>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2 shrink-0">
                        {linkedInfo?.hasDrift && (
                          <button
                            disabled={isSyncing}
                            onClick={async () => {
                              setNotice(null)
                              try {
                                await handleSync()
                                setNotice({ kind: 'success', text: `已成功将 /${skillName} 最新的源文件覆盖更新至项目中！` })
                              } catch (err: any) {
                                setNotice({ kind: 'error', text: `覆盖更新失败: ${err.message}` })
                              }
                            }}
                            className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 transition-all flex items-center gap-1 animate-bounce"
                            title="从仓库强力覆盖更新最新物理文件至本项目"
                          >
                            <span>⚡</span>
                            <span>覆盖更新</span>
                          </button>
                        )}

                        <button
                          disabled={isRemoving}
                          onClick={() => handleRemoveSkill(skillName)}
                          className="px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-900 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 border border-slate-800 hover:border-rose-500/30 transition-all flex items-center gap-1"
                          title="从当前项目解绑此 Skill"
                        >
                          {isRemoving ? (
                            <span className="animate-spin text-xs">⏳</span>
                          ) : (
                            <>
                              <span>🗑️</span>
                              <span>解绑移除</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/60 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              onClick={handleSync}
              disabled={isSyncing}
              className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition-all flex items-center gap-1.5"
            >
              {isSyncing ? (
                <span className="animate-spin text-xs">⏳</span>
              ) : (
                <span>🔄</span>
              )}
              <span>应用全量同步</span>
            </button>

            {onDeleteProject && (
              <button
                onClick={() => {
                  onClose()
                  onDeleteProject(project.path, project.name)
                }}
                className="px-3 py-1.5 rounded-xl bg-red-950/40 hover:bg-red-900/60 text-red-300 border border-red-800/40 hover:border-red-700/60 text-xs font-medium transition-all flex items-center gap-1.5"
                title="删除/隐藏此项目"
              >
                <span>🗑️</span>
                <span>删除项目</span>
              </button>
            )}
          </div>

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
