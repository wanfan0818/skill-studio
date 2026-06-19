import { useEffect, useState, useCallback } from 'react'
import { getAgentMeta } from '../agents'
import { ProjectWizard } from './ProjectWizard'
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
  
  // 操作忙碌状态
  const [busyPaths, setBusyPaths] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState<{ kind: 'info' | 'error' | 'success'; text: string } | null>(null)

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
    } catch (err: any) {
      setError(err?.message || '网络请求错误，无法获取项目列表')
    } finally {
      setLoading(false)
    }
  }, [])

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
        <button
          onClick={openWizardForCreate}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-lg shadow-blue-500/20 active:scale-95 transition flex items-center gap-2"
        >
          <span>＋</span> 新增项目配置
        </button>
      </div>

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
                        暂无项目描述，点击下方管理技能以创建。
                      </p>
                    )}

                    {/* 信息行：包含的 IDE 和 Skill 数量 */}
                    <div className="flex items-center gap-3 text-xs text-slate-400 mt-2">
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
                  <div className="px-5 py-3.5 bg-slate-900/30 border-t border-slate-800/40 flex items-center justify-between gap-2">
                    <button
                      disabled={isBusy}
                      onClick={() => openWizardForEdit(proj)}
                      className="text-xs font-medium text-slate-300 hover:text-white px-2.5 py-1.5 rounded hover:bg-slate-800 border border-slate-800 hover:border-slate-700 transition"
                    >
                      {profile ? '管理 Skill' : '创建配置'}
                    </button>

                    <div className="flex items-center gap-2">
                      {profile && (
                        <button
                          disabled={isBusy}
                          onClick={() => handleClean(proj.path)}
                          className="text-xs font-medium text-slate-500 hover:text-rose-400 px-2 py-1 rounded hover:bg-rose-500/5 transition"
                          title="清理项目下的所有软链接并删除项目配置文件"
                        >
                          清理
                        </button>
                      )}

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

      {/* 新建/编辑配置的向导模态框 */}
      {wizardOpen && (
        <ProjectWizard
          project={wizardEditingProject}
          allSkills={allSkills}
          onClose={handleWizardClose}
        />
      )}
    </div>
  )
}
