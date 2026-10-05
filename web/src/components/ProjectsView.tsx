import { useEffect, useState, useCallback } from 'react'
import { getAgentMeta } from '../agents'
import { ProjectWizard } from './ProjectWizard'
import { WarehouseSkillPickerModal } from './WarehouseSkillPickerModal'
import { ProjectManageModal } from './ProjectManageModal'
import { DeleteProjectModal } from './DeleteProjectModal'
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

interface ProjectsViewProps {
  allSkills: Skill[]
  onRefreshSkills: () => void
}

export function ProjectsView({ allSkills, onRefreshSkills }: ProjectsViewProps) {
  const [projects, setProjects] = useState<ProjectWithProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  
  // 向导模态框状态
  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardEditingProject, setWizardEditingProject] = useState<ProjectWithProfile | null>(null)

  // 专属项目管理控制台模态框状态
  const [manageProject, setManageProject] = useState<ProjectWithProfile | null>(null)

  // 仓库技能挑选弹窗状态
  const [pickerProject, setPickerProject] = useState<ProjectWithProfile | null>(null)
  
  // 删除确认模态框状态
  const [deleteModalTarget, setDeleteModalTarget] = useState<{ name: string; path: string } | null>(null)

  // 已排除/隐藏项目状态
  const [excludedProjects, setExcludedProjects] = useState<string[]>([])
  const [showExcludedPanel, setShowExcludedPanel] = useState(false)

  // 操作忙碌状态
  const [busyPaths, setBusyPaths] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState<{ kind: 'info' | 'error' | 'success'; text: string } | null>(null)

  const fetchExcludedProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects/excluded')
      const data = await res.json()
      if (data.ok) {
        setExcludedProjects(data.excludedProjects || [])
      }
    } catch {}
  }, [])

  const fetchProjects = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/projects')
      const data = await res.json()
      if (data.ok) {
        setProjects(data.projects || [])
      } else {
        setError(data.error || '获取项目列表失败')
      }
      await fetchExcludedProjects()
    } catch (err: any) {
      setError(err?.message || '网络请求错误，无法获取项目列表')
    } finally {
      setLoading(false)
    }
  }, [fetchExcludedProjects])

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  // 清除通知消息
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 5000)
      return () => clearTimeout(timer)
    }
  }, [message])

  const setPathBusy = (projectPath: string, busy: boolean) => {
    setBusyPaths(prev => {
      const next = new Set(prev)
      if (busy) {
        next.add(projectPath)
      } else {
        next.delete(projectPath)
      }
      return next
    })
  }

  // 同步操作
  const handleSync = async (projectPath: string) => {
    setPathBusy(projectPath, true)
    setMessage(null)
    try {
      const res = await fetch('/api/projects/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath })
      })
      const data = await res.json()
      if (data.ok) {
        setMessage({ kind: 'success', text: '项目 Skill 同步成功！' })
        fetchProjects()
        onRefreshSkills() // 刷新全局缓存，同步缓存
      } else {
        setMessage({ kind: 'error', text: `同步失败: ${data.error}` })
      }
    } catch (err: any) {
      setMessage({ kind: 'error', text: `同步出错: ${err.message}` })
    } finally {
      setPathBusy(projectPath, false)
    }
  }

  // 清理操作
  const handleClean = async (projectPath: string) => {
    if (!confirm('确定要清理该项目下的所有 Skill 软链接并删除配置文件吗？此操作不会删除全局已有的 Skill 真实文件。')) {
      return
    }
    setPathBusy(projectPath, true)
    setMessage(null)
    try {
      const res = await fetch('/api/projects/clean', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath })
      })
      const data = await res.json()
      if (data.ok) {
        setMessage({ kind: 'success', text: '已清除该项目的 Skill 配置与软链接' })
        fetchProjects()
        onRefreshSkills()
      } else {
        setMessage({ kind: 'error', text: `清理失败: ${data.error}` })
      }
    } catch (err: any) {
      setMessage({ kind: 'error', text: `清理出错: ${err.message}` })
    } finally {
      setPathBusy(projectPath, false)
    }
  }

  const openWizardForCreate = () => {
    setWizardEditingProject(null)
    setWizardOpen(true)
  }

  const openWizardForEdit = (project: ProjectWithProfile) => {
    setWizardEditingProject(project)
    setWizardOpen(true)
  }

  const handleWizardClose = (shouldRefresh: boolean) => {
    setWizardOpen(false)
    setWizardEditingProject(null)
    if (shouldRefresh) {
      fetchProjects()
      onRefreshSkills()
    }
  }

  // 单技能切换绑定处理
  const handleTogglePickerSkill = async (skillName: string, currentlyInstalled: boolean) => {
    if (!pickerProject) return
    const endpoint = currentlyInstalled ? '/api/projects/uninstall-skill' : '/api/projects/install-skill'
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath: pickerProject.path,
          skillName,
          targetIde: pickerProject.profile?.targetIde || 'claude-code',
        }),
      })
      const data = await res.json()
      if (data.ok) {
        // 本地更新 pickerProject state
        setProjects((prev) =>
          prev.map((p) => {
            if (p.path === pickerProject.path && p.profile) {
              const currentSkills = p.profile.skills || []
              const nextSkills = currentlyInstalled
                ? currentSkills.filter((s) => s !== skillName)
                : [...currentSkills, skillName]
              return {
                ...p,
                profile: { ...p.profile, skills: nextSkills },
                profileSkillCount: nextSkills.length,
              }
            }
            return p
          })
        )
        setPickerProject((prev) => {
          if (!prev || !prev.profile) return prev
          const currentSkills = prev.profile.skills || []
          const nextSkills = currentlyInstalled
            ? currentSkills.filter((s) => s !== skillName)
            : [...currentSkills, skillName]
          return {
            ...prev,
            profile: { ...prev.profile, skills: nextSkills },
            profileSkillCount: nextSkills.length,
          }
        })
        onRefreshSkills()
      } else {
        setMessage({ kind: 'error', text: `配置 Skill 失败: ${data.error}` })
      }
    } catch (err: any) {
      setMessage({ kind: 'error', text: `请求出错: ${err.message}` })
    }
  }

  const handleUninstallSkill = async (projectPath: string, skillName: string) => {
    try {
      const res = await fetch('/api/projects/uninstall-skill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, skillName }),
      })
      const data = await res.json()
      if (data.ok) {
        setProjects((prev) =>
          prev.map((p) => {
            if (p.path === projectPath && p.profile) {
              const nextSkills = (p.profile.skills || []).filter((s) => s !== skillName)
              return { ...p, profile: { ...p.profile, skills: nextSkills }, profileSkillCount: nextSkills.length }
            }
            return p
          })
        )
        setManageProject((prev) => {
          if (!prev || prev.path !== projectPath || !prev.profile) return prev
          const nextSkills = (prev.profile.skills || []).filter((s) => s !== skillName)
          return { ...prev, profile: { ...prev.profile, skills: nextSkills }, profileSkillCount: nextSkills.length }
        })
        onRefreshSkills()
      } else {
        setMessage({ kind: 'error', text: `解绑失败: ${data.error}` })
      }
    } catch (err: any) {
      setMessage({ kind: 'error', text: `解绑出错: ${err.message}` })
    }
  }

  const handleChangeIde = async (projectPath: string, newTargetIde: string) => {
    try {
      const targetProj = projects.find((p) => p.path === projectPath)
      const currentSkills = targetProj?.profile?.skills || []
      const currentDesc = targetProj?.profile?.description || '项目配置'

      const res = await fetch('/api/projects/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          targetIde: newTargetIde,
          skills: currentSkills,
          description: currentDesc,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setProjects((prev) =>
          prev.map((p) => {
            if (p.path === projectPath && p.profile) {
              return { ...p, profile: { ...p.profile, targetIde: newTargetIde } }
            }
            return p
          })
        )
        setManageProject((prev) => {
          if (!prev || prev.path !== projectPath || !prev.profile) return prev
          return { ...prev, profile: { ...prev.profile, targetIde: newTargetIde } }
        })
        onRefreshSkills()
      }
    } catch (err: any) {
      setMessage({ kind: 'error', text: `更改 IDE 出错: ${err.message}` })
    }
  }

  // 确定删除/隐藏项目
  const handleConfirmDeleteProject = async (purgeFiles: boolean) => {
    if (!deleteModalTarget) return
    const { path: projectPath, name: projectName } = deleteModalTarget
    setPathBusy(projectPath, true)
    try {
      const res = await fetch('/api/projects/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, purgeFiles }),
      })
      const data = await res.json()
      if (data.ok) {
        setMessage({
          kind: 'success',
          text: `项目「${projectName}」已从列表中移除${purgeFiles ? ' (配置与技能目录已物理删除)' : ''}`,
        })
        await fetchProjects()
        onRefreshSkills()
      } else {
        setMessage({ kind: 'error', text: `删除项目失败: ${data.error}` })
      }
    } catch (err: any) {
      setMessage({ kind: 'error', text: `删除项目出错: ${err.message}` })
    } finally {
      setPathBusy(projectPath, false)
      setDeleteModalTarget(null)
    }
  }

  // 恢复显示项目
  const handleRestoreProject = async (projectPath: string) => {
    setPathBusy(projectPath, true)
    try {
      const res = await fetch('/api/projects/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath }),
      })
      const data = await res.json()
      if (data.ok) {
        setMessage({ kind: 'success', text: '项目已恢复显示并纳入扫描' })
        await fetchProjects()
        onRefreshSkills()
      } else {
        setMessage({ kind: 'error', text: `恢复项目失败: ${data.error}` })
      }
    } catch (err: any) {
      setMessage({ kind: 'error', text: `恢复项目出错: ${err.message}` })
    } finally {
      setPathBusy(projectPath, false)
    }
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-slate-950/40 text-slate-100">
      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between px-8 py-6 border-b border-slate-800/60 bg-slate-900/20 backdrop-blur-md">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <span>📁</span> 项目 Skill 管理
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            将全局 Skill 按需软链接到指定项目中，有效降低大模型 Token 消耗并提速
          </p>
        </div>
        <div className="flex items-center gap-3">
          {excludedProjects.length > 0 && (
            <button
              onClick={() => setShowExcludedPanel(!showExcludedPanel)}
              className="px-3 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700 rounded-lg border border-slate-700/60 transition flex items-center gap-1.5"
            >
              <span>🙈</span>
              <span>已隐藏的项目 ({excludedProjects.length})</span>
            </button>
          )}

          <button
            onClick={openWizardForCreate}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-lg shadow-blue-500/20 active:scale-95 transition flex items-center gap-2"
          >
            <span>＋</span> 新增项目配置
          </button>
        </div>
      </div>

      {/* 已排除/隐藏项目面板 */}
      {showExcludedPanel && excludedProjects.length > 0 && (
        <div className="px-8 pt-4">
          <div className="p-4 bg-slate-900/60 rounded-xl border border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm">🙈</span>
                <h3 className="text-xs font-bold text-slate-200">已隐藏/排除的项目清单 ({excludedProjects.length})</h3>
              </div>
              <span className="text-[11px] text-slate-400">这些项目全盘扫描时将被自动跳过</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
              {excludedProjects.map((pPath) => (
                <div key={pPath} className="p-2.5 bg-slate-950/80 rounded-lg border border-slate-800/80 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0 flex-1 font-mono text-slate-400 truncate" title={pPath}>
                    {pPath}
                  </div>
                  <button
                    onClick={() => handleRestoreProject(pPath)}
                    className="px-2.5 py-1 text-[11px] font-medium bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded transition shrink-0 flex items-center gap-1"
                  >
                    <span>🔄</span>
                    <span>恢复显示</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 消息通知区 */}
      {message && (
        <div className="px-8 pt-4">
          <div className={`px-4 py-3 rounded-lg flex items-center justify-between text-sm backdrop-blur-sm ${
            message.kind === 'success' ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20' :
            message.kind === 'error' ? 'bg-rose-500/10 text-rose-300 border border-rose-500/20' :
            'bg-blue-500/10 text-blue-300 border border-blue-500/20'
          }`}>
            <div className="flex items-center gap-2">
              <span>{message.kind === 'success' ? '✨' : message.kind === 'error' ? '🚨' : 'ℹ️'}</span>
              <span>{message.text}</span>
            </div>
            <button onClick={() => setMessage(null)} className="text-slate-400 hover:text-white transition">×</button>
          </div>
        </div>
      )}

      {/* 项目卡片列表 */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-64 gap-3">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            <p className="text-sm text-slate-400">正在扫描并加载项目...</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-64 bg-slate-900/30 rounded-xl border border-rose-500/10 p-6">
            <span className="text-3xl">⚠️</span>
            <h3 className="text-lg font-medium text-rose-300 mt-2">载入项目出错</h3>
            <p className="text-sm text-slate-400 mt-1">{error}</p>
            <button onClick={fetchProjects} className="mt-4 px-4 py-1.5 text-xs text-white bg-slate-800 hover:bg-slate-700 rounded-md transition">
              重试
            </button>
          </div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-80 bg-slate-900/10 rounded-2xl border border-dashed border-slate-800 p-8 text-center">
            <span className="text-4xl text-slate-600 mb-3">📂</span>
            <h3 className="text-lg font-medium text-slate-300">暂无项目</h3>
            <p className="text-sm text-slate-500 max-w-sm mt-1 mb-6">
              未扫描到包含 Skill 目录的项目，或者您还没有为项目创建过 `.skills-profile.json` 配置文件。
            </p>
            <button
              onClick={openWizardForCreate}
              className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition"
            >
              配置您的第一个项目
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects.map((proj) => {
              const profile = proj.profile
              const agentMeta = profile ? getAgentMeta(profile.targetIde) : null
              const isBusy = busyPaths.has(proj.path)

              return (
                <div
                  key={proj.path}
                  className={`relative flex flex-col justify-between rounded-xl bg-slate-900/40 border transition duration-300 hover:border-slate-700/60 hover:bg-slate-900/60 group overflow-hidden ${
                    proj.syncStatus === 'drift' ? 'border-amber-500/20' :
                    proj.syncStatus === 'synced' ? 'border-emerald-500/20' :
                    'border-slate-800/80'
                  }`}
                >
                  {/* 同步状态的顶部发光条 */}
                  <div className={`absolute top-0 left-0 right-0 h-1 transition-opacity ${
                    proj.syncStatus === 'drift' ? 'bg-gradient-to-r from-amber-500/80 to-amber-600/80' :
                    proj.syncStatus === 'synced' ? 'bg-gradient-to-r from-emerald-500/80 to-emerald-600/80' :
                    'bg-slate-800'
                  }`} />

                  {/* 卡片头部 */}
                  <div className="p-5 flex-1">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <h3 className="font-semibold text-white text-base truncate" title={proj.name}>
                        {proj.name}
                      </h3>
                      {/* 同步徽章 */}
                      {proj.syncStatus === 'synced' && (
                        <span className="px-2 py-0.5 text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded">
                          已同步
                        </span>
                      )}
                      {proj.syncStatus === 'drift' && (
                        <span className="px-2 py-0.5 text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded animate-pulse">
                          待同步
                        </span>
                      )}
                      {proj.syncStatus === 'no-profile' && (
                        <span className="px-2 py-0.5 text-xs font-medium bg-slate-800 text-slate-400 border border-slate-700 rounded">
                          未配置
                        </span>
                      )}
                    </div>

                    {/* 项目路径 */}
                    <p className="text-xs text-slate-500 font-mono break-all line-clamp-1 mb-4" title={proj.path}>
                      {proj.path}
                    </p>

                    {/* 项目描述（若有配置） */}
                    {profile?.description ? (
                      <p className="text-xs text-slate-400 line-clamp-2 min-h-[2rem] mb-4 bg-slate-950/20 p-2 rounded border border-slate-800/40">
                        {profile.description}
                      </p>
                    ) : (
                      <p className="text-xs text-slate-600 italic min-h-[2rem] mb-4 flex items-center">
                        暂无项目描述，点击下方管理按钮进入操控台。
                      </p>
                    )}

                    {/* 信息行：包含的 IDE 和 Skill 数量 */}
                    <div className="flex items-center justify-between text-xs text-slate-400 mt-2">
                      {/* IDE 图标标签 */}
                      {agentMeta ? (
                        <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md border ${agentMeta.color.bg} ${agentMeta.color.text} ${agentMeta.color.ring.replace('ring', 'border')}`}>
                          <span>{agentMeta.icon}</span>
                          <span className="font-medium">{agentMeta.name}</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800 text-slate-400 border border-slate-700">
                          <span>🌐</span>
                          <span>未选 IDE</span>
                        </div>
                      )}

                      {/* 数量统计 */}
                      <div className="flex items-center gap-1 text-slate-300">
                        <span>🧩</span>
                        <span>
                          {proj.syncStatus === 'no-profile'
                            ? `${proj.linkedSkillCount} 个软链`
                            : `${proj.linkedSkillCount} / ${proj.profileSkillCount} Skills`}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* 卡片底部操作栏 */}
                  <div className="px-5 py-3.5 bg-slate-900/30 border-t border-slate-800/40 flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      <button
                        disabled={isBusy}
                        onClick={() => setPickerProject(proj)}
                        className="text-xs font-semibold text-blue-400 hover:text-blue-300 px-2.5 py-1.5 rounded hover:bg-blue-500/10 border border-blue-500/30 transition flex items-center gap-1"
                        title="打开仓库技能选择器，快捷配置此项目的技能"
                      >
                        <span>🏛️</span>
                        <span>挑技能</span>
                      </button>

                      <button
                        disabled={isBusy}
                        onClick={() => {
                          if (profile) {
                            setManageProject(proj)
                          } else {
                            openWizardForEdit(proj)
                          }
                        }}
                        className="text-xs font-medium text-slate-300 hover:text-white px-2.5 py-1.5 rounded hover:bg-slate-800 border border-slate-800 hover:border-slate-700 transition"
                      >
                        {profile ? '⚙️ 管理操控台' : '配置项目'}
                      </button>
                    </div>

                    <div className="flex items-center gap-2">
                      {profile && (
                        <button
                          disabled={isBusy}
                          onClick={() => handleClean(proj.path)}
                          className="text-xs font-medium text-slate-500 hover:text-amber-400 px-2 py-1 rounded hover:bg-amber-500/5 transition"
                          title="清理项目下的所有软链接并删除项目配置文件"
                        >
                          清理
                        </button>
                      )}

                      <button
                        disabled={isBusy}
                        onClick={() => setDeleteModalTarget({ name: proj.name, path: proj.path })}
                        className="text-xs font-medium text-slate-500 hover:text-rose-400 px-1.5 py-1 rounded hover:bg-rose-500/10 transition"
                        title="从 Skill Studio 中隐藏或彻底删除此项目"
                      >
                        🗑️
                      </button>

                      {profile && (
                        <button
                          disabled={isBusy || (proj.syncStatus === 'synced' && proj.linkedSkillCount === proj.profileSkillCount)}
                          onClick={() => handleSync(proj.path)}
                          className={`text-xs font-medium px-3 py-1.5 rounded transition active:scale-95 flex items-center gap-1.5 ${
                            proj.syncStatus === 'drift'
                              ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-lg shadow-amber-500/10'
                              : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                          }`}
                        >
                          {isBusy ? (
                            <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          ) : (
                            <span>🔄</span>
                          )}
                          <span>{proj.syncStatus === 'synced' ? '重新同步' : '同步'}</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 专属项目集中操控台模态框 */}
      {manageProject && (
        <ProjectManageModal
          isOpen={!!manageProject}
          onClose={() => setManageProject(null)}
          project={manageProject}
          allSkills={allSkills || []}
          onUninstallSkill={handleUninstallSkill}
          onChangeIde={handleChangeIde}
          onOpenWarehousePicker={() => {
            setPickerProject(manageProject)
          }}
          onSyncProject={async (path) => {
            await handleSync(path)
          }}
          onDeleteProject={(projectPath, projectName) => {
            setDeleteModalTarget({ name: projectName, path: projectPath })
          }}
        />
      )}

      {/* 删除确认模态框 */}
      {deleteModalTarget && (
        <DeleteProjectModal
          isOpen={!!deleteModalTarget}
          projectName={deleteModalTarget.name}
          projectPath={deleteModalTarget.path}
          onClose={() => setDeleteModalTarget(null)}
          onConfirm={handleConfirmDeleteProject}
        />
      )}

      {/* 新建/编辑配置的初始化向导模态框 */}
      {wizardOpen && (
        <ProjectWizard
          project={wizardEditingProject}
          allSkills={allSkills}
          onClose={handleWizardClose}
        />
      )}

      {/* 仓库技能挑选模态框 */}
      {pickerProject && (
        <WarehouseSkillPickerModal
          isOpen={!!pickerProject}
          onClose={() => setPickerProject(null)}
          projectName={pickerProject.name}
          projectPath={pickerProject.path}
          targetIde={pickerProject.profile?.targetIde || 'claude-code'}
          installedSkillNames={pickerProject.profile?.skills || []}
          allSkills={allSkills}
          onToggleSkill={handleTogglePickerSkill}
        />
      )}
    </div>
  )
}
