import { useState, useEffect } from 'react'
import { AGENT_ORDER, AGENT_META } from '../agents'
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

interface ProjectWizardProps {
  project: ProjectWithProfile | null // null 表示新建项目配置，有值表示编辑项目配置
  allSkills: Skill[]
  onClose: (shouldRefresh: boolean) => void
}

interface AIRecommendation {
  name: string
  reason: string
  confidence: number
}

export function ProjectWizard({ project, allSkills, onClose }: ProjectWizardProps) {
  const [step, setStep] = useState<1 | 2>(1)
  
  // 第一步表单状态
  const [projectPath, setProjectPath] = useState('')
  const [projectName, setProjectName] = useState('')
  const [projectDesc, setProjectDesc] = useState('')
  const [targetIde, setTargetIde] = useState('claude-code')
  const [formError, setFormError] = useState<string | null>(null)

  // 第二步状态
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set())
  const [aiRecs, setAiRecs] = useState<AIRecommendation[]>([])
  const [recLoading, setRecLoading] = useState(false)
  const [syncLoading, setSyncLoading] = useState(false)

  // 初始化编辑数据
  useEffect(() => {
    if (project) {
      setProjectPath(project.path)
      setProjectName(project.profile?.name || project.name)
      setProjectDesc(project.profile?.description || '')
      setTargetIde(project.profile?.targetIde || 'claude-code')
      setSelectedSkills(new Set(project.profile?.skills || []))
    }
  }, [project])

  // 当路径改变时，自动生成项目名
  const handlePathChange = (val: string) => {
    setProjectPath(val)
    if (!project) {
      // 提取路径最后一级目录作为项目名称
      const parts = val.replace(/[\\/]+$/, '').split(/[\\/]/)
      const base = parts[parts.length - 1] || ''
      setProjectName(base)
    }
  }

  // 提交第一步，前往第二步，触发 AI 推荐
  const handleGoToStep2 = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)

    if (!projectPath.trim()) {
      setFormError('项目绝对路径不能为空')
      return
    }
    if (!projectName.trim()) {
      setFormError('项目名称不能为空')
      return
    }

    setStep(2)
    setRecLoading(true)

    try {
      const res = await fetch('/api/projects/recommend-skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: projectDesc })
      })
      const data = await res.json()
      if (data.ok) {
        setAiRecs(data.recommended || [])
        // 如果是新建配置且还没有手动选择技能，则默认勾选置信度大于 0.6 的推荐 Skill
        if (!project && selectedSkills.size === 0) {
          const defaults = new Set<string>()
          for (const rec of data.recommended || []) {
            if (rec.confidence >= 0.6) {
              defaults.add(rec.name)
            }
          }
          setSelectedSkills(defaults)
        }
      }
    } catch {
      // 容错：即使推荐失败，用户也可以手动从列表选择
    } finally {
      setRecLoading(false)
    }
  }

  // 选择/反选技能
  const toggleSkill = (skillName: string) => {
    setSelectedSkills(prev => {
      const next = new Set(prev)
      if (next.has(skillName)) {
        next.delete(skillName)
      } else {
        next.add(skillName)
      }
      return next
    })
  }

  // 一键勾选所有推荐 Skill
  const selectAllRecs = () => {
    setSelectedSkills(prev => {
      const next = new Set(prev)
      aiRecs.forEach(r => next.add(r.name))
      return next
    })
  }

  // 一键清空所有已选
  const clearAllSelected = () => {
    setSelectedSkills(new Set())
  }

  // 确认并同步
  const handleSaveAndSync = async () => {
    setSyncLoading(true)
    try {
      // 1. 保存 profile
      const profile = {
        version: 1,
        name: projectName,
        description: projectDesc,
        skills: Array.from(selectedSkills),
        targetIde
      }

      const saveRes = await fetch('/api/projects/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, profile })
      })

      const saveData = await saveRes.json()
      if (!saveData.ok) {
        alert(`保存配置失败: ${saveData.error}`)
        setSyncLoading(false)
        return
      }

      // 2. 触发同步
      const syncRes = await fetch('/api/projects/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath })
      })

      const syncData = await syncRes.json()
      if (!syncData.ok) {
        alert(`配置已保存，但软链接同步失败: ${syncData.error}`)
      }

      // 关闭模态框并通知刷新
      onClose(true)
    } catch (err: any) {
      alert(`保存出错: ${err.message}`)
    } finally {
      setSyncLoading(false)
    }
  }

  // 获取有效的 IDE 选项列表（排除 universal/unknown 等）
  const ideOptions = AGENT_ORDER.filter(id => id !== 'universal' && id !== 'unknown')

  // 对所有 Skill 过滤出“其他技能”（排除 AI 推荐之外的）
  const recNames = new Set(aiRecs.map(r => r.name))
  const otherSkills = allSkills.filter(s => {
    // 排除被标记为推荐的
    if (recNames.has(s.name)) return false
    // 模糊搜索
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      return s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q)
    }
    return true
  })

  // 搜索推荐列表
  const filteredRecs = aiRecs.filter(r => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return r.name.toLowerCase().includes(q) || r.reason.toLowerCase().includes(q)
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-4 overflow-y-auto">
      <div className="relative max-w-3xl w-full h-[650px] bg-slate-900/95 border border-slate-800 rounded-2xl flex flex-col overflow-hidden shadow-2xl shadow-black/80 animate-in fade-in zoom-in-95 duration-200">
        
        {/* 顶部标题及关闭按钮 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800/80 bg-slate-900/40">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <span>⚙️</span> {project ? '修改项目 Skill 配置' : '新建项目 Skill 配置'}
          </h2>
          <button
            onClick={() => onClose(false)}
            className="text-slate-400 hover:text-white transition w-8 h-8 rounded-lg hover:bg-slate-800 flex items-center justify-center"
          >
            ✕
          </button>
        </div>

        {/* 步骤指示器 */}
        <div className="flex items-center justify-center py-4 bg-slate-950/20 border-b border-slate-800/40">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold ${
                step === 1 ? 'bg-blue-600 text-white shadow-md shadow-blue-500/20' : 'bg-emerald-600 text-white'
              }`}>
                {step === 2 && project ? '✓' : '1'}
              </span>
              <span className={`text-sm ${step === 1 ? 'text-white font-medium' : 'text-slate-400'}`}>基本信息</span>
            </div>
            <div className="w-12 h-px bg-slate-800" />
            <div className="flex items-center gap-2">
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold ${
                step === 2 ? 'bg-blue-600 text-white shadow-md shadow-blue-500/20' : 'bg-slate-800 text-slate-500'
              }`}>
                2
              </span>
              <span className={`text-sm ${step === 2 ? 'text-white font-medium' : 'text-slate-500'}`}>选择 Skill 并同步</span>
            </div>
          </div>
        </div>

        {/* 步骤一：表单输入 */}
        {step === 1 && (
          <form onSubmit={handleGoToStep2} className="flex-1 flex flex-col p-6 overflow-y-auto space-y-5 justify-between">
            <div className="space-y-4">
              {formError && (
                <div className="p-3 text-xs bg-rose-500/10 text-rose-400 border border-rose-500/20 rounded-lg">
                  ⚠️ {formError}
                </div>
              )}

              {/* 项目绝对路径 */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-300">项目绝对路径 *</label>
                <input
                  type="text"
                  required
                  disabled={!!project} // 编辑时路径不可更改
                  placeholder="/Users/username/Projects/my-app"
                  value={projectPath}
                  onChange={(e) => handlePathChange(e.target.value)}
                  className="px-3.5 py-2 text-sm bg-slate-950 border border-slate-800 rounded-lg text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500/50 disabled:opacity-50 disabled:cursor-not-allowed font-mono transition"
                />
                <span className="text-[10px] text-slate-500">请输入您项目的物理根路径（例如 git 仓库根目录）</span>
              </div>

              {/* 项目名称 */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-300">项目显示名称 *</label>
                <input
                  type="text"
                  required
                  placeholder="例如：我的 Web 网页"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  className="px-3.5 py-2 text-sm bg-slate-950 border border-slate-800 rounded-lg text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500/50 transition"
                />
              </div>

              {/* 目标 IDE */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-300">主要开发 IDE（目标编译端）</label>
                <select
                  value={targetIde}
                  onChange={(e) => setTargetIde(e.target.value)}
                  className="px-3 py-2 text-sm bg-slate-950 border border-slate-800 rounded-lg text-slate-100 focus:outline-none focus:border-blue-500/50 transition appearance-none cursor-pointer"
                  style={{
                    backgroundImage: `url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none'%3E%3Cpath d='M7 9l3 3 3-3' stroke='%2394a3b8' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
                    backgroundPosition: 'right 0.75rem center',
                    backgroundSize: '1.25rem',
                    backgroundRepeat: 'no-repeat',
                    paddingRight: '2.5rem'
                  }}
                >
                  {ideOptions.map(id => {
                    const meta = AGENT_META[id]
                    return (
                      <option key={id} value={id}>
                        {meta ? `${meta.icon} ${meta.name}` : id}
                      </option>
                    )
                  })}
                </select>
                <span className="text-[10px] text-slate-500">指定该项目关联的 IDE，Skill Studio 会将软链接软植入到此 IDE 的项目配置夹中</span>
              </div>

              {/* 项目描述（用于 AI 匹配） */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-300">项目功能描述（AI 推荐的依据）</label>
                <textarea
                  rows={4}
                  placeholder="请描述您的项目：例如，这是一个使用 Next.js 构建的 AI 全栈网页应用，包含用户认证、数据可视化看板、生成 PDF 报表与发送微信公众号通知等功能..."
                  value={projectDesc}
                  onChange={(e) => setProjectDesc(e.target.value)}
                  className="px-3.5 py-2 text-sm bg-slate-950 border border-slate-800 rounded-lg text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500/50 transition resize-none"
                />
                <span className="text-[10px] text-slate-500">描述写得越清晰，本地推荐引擎对所需 Skill 的匹配精确度就越高</span>
              </div>
            </div>

            {/* 底部按钮 */}
            <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800/40">
              <button
                type="button"
                onClick={() => onClose(false)}
                className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition"
              >
                取消
              </button>
              <button
                type="submit"
                className="px-5 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition active:scale-95 shadow-lg shadow-blue-500/10"
              >
                下一步：智能匹配 Skill
              </button>
            </div>
          </form>
        )}

        {/* 步骤二：选择技能并同步 */}
        {step === 2 && (
          <div className="flex-1 flex flex-col overflow-hidden">
            
            {/* 搜索过滤条 */}
            <div className="px-6 py-3 border-b border-slate-800/40 bg-slate-950/20 flex items-center justify-between gap-4">
              <div className="relative flex-1">
                <span className="absolute inset-y-0 left-3 flex items-center text-slate-500">🔍</span>
                <input
                  type="text"
                  placeholder="搜索可用技能..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-4 py-1.5 text-xs bg-slate-950 border border-slate-800 rounded-lg text-slate-100 placeholder-slate-600 focus:outline-none focus:border-blue-500/50 transition"
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={selectAllRecs}
                  disabled={aiRecs.length === 0}
                  className="px-2.5 py-1.5 text-[10px] font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded transition disabled:opacity-50"
                >
                  全选推荐
                </button>
                <button
                  onClick={clearAllSelected}
                  className="px-2.5 py-1.5 text-[10px] font-medium text-slate-300 hover:text-rose-400 bg-slate-800 hover:bg-slate-700 rounded transition"
                >
                  全取消
                </button>
              </div>
            </div>

            {/* 技能双栏列表 */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              
              {/* AI 智能推荐 Skill */}
              <div className="space-y-3">
                <h3 className="text-xs font-bold text-blue-400 tracking-wider uppercase flex items-center gap-1.5">
                  <span>🤖</span> AI 专属智能推荐
                </h3>
                
                {recLoading ? (
                  <div className="flex items-center justify-center p-8 gap-2 bg-slate-900/30 rounded-xl border border-slate-800">
                    <span className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs text-slate-400">正在分析项目描述，精准推荐技能中...</span>
                  </div>
                ) : filteredRecs.length === 0 ? (
                  <p className="text-xs text-slate-500 italic p-3 bg-slate-900/20 rounded-lg border border-slate-850">
                    没有匹配到推荐技能，请在下方手动勾选。
                  </p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {filteredRecs.map((rec) => {
                      const isSelected = selectedSkills.has(rec.name)
                      return (
                        <div
                          key={rec.name}
                          onClick={() => toggleSkill(rec.name)}
                          className={`p-3.5 rounded-xl border cursor-pointer transition flex flex-col justify-between select-none ${
                            isSelected
                              ? 'bg-blue-950/20 border-blue-500/40 hover:border-blue-500/60'
                              : 'bg-slate-900/30 border-slate-800/60 hover:bg-slate-900/50 hover:border-slate-700'
                          }`}
                        >
                          <div>
                            <div className="flex items-center justify-between gap-2 mb-1.5">
                              <span className="font-semibold text-xs text-white break-all flex items-center gap-1.5">
                                <span className={`w-3.5 h-3.5 rounded-sm flex items-center justify-center text-[10px] text-white ${
                                  isSelected ? 'bg-blue-600' : 'border border-slate-700 bg-slate-950'
                                }`}>
                                  {isSelected ? '✓' : ''}
                                </span>
                                <span>{rec.name}</span>
                              </span>
                              <span className="px-1.5 py-0.5 text-[9px] font-bold bg-blue-500/10 text-blue-400 rounded">
                                相似度 {Math.round(rec.confidence * 100)}%
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-400 line-clamp-2 leading-relaxed">
                              {rec.reason}
                            </p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* 其他可用 Skill 库 */}
              <div className="space-y-3">
                <h3 className="text-xs font-bold text-slate-400 tracking-wider uppercase flex items-center gap-1.5">
                  <span>🧩</span> 其他可用技能库 ({otherSkills.length})
                </h3>

                {otherSkills.length === 0 ? (
                  <p className="text-xs text-slate-500 italic p-3 text-center bg-slate-900/10 rounded-lg">
                    暂无其他相符的可用 Skill。
                  </p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {otherSkills.map((s) => {
                      const isSelected = selectedSkills.has(s.name)
                      return (
                        <div
                          key={s.name}
                          onClick={() => toggleSkill(s.name)}
                          className={`p-3 rounded-lg border cursor-pointer transition select-none flex items-start gap-2.5 ${
                            isSelected
                              ? 'bg-blue-950/10 border-blue-500/30 hover:border-blue-500/50'
                              : 'bg-slate-900/20 border-slate-800/80 hover:bg-slate-900/40 hover:border-slate-700'
                          }`}
                        >
                          <span className={`mt-0.5 w-3.5 h-3.5 rounded-sm flex items-center justify-center text-[10px] text-white shrink-0 ${
                            isSelected ? 'bg-blue-600' : 'border border-slate-700 bg-slate-950'
                          }`}>
                            {isSelected ? '✓' : ''}
                          </span>
                          <div className="overflow-hidden">
                            <h4 className="font-medium text-xs text-white truncate break-all" title={s.name}>
                              {s.name}
                            </h4>
                            <p className="text-[10px] text-slate-500 line-clamp-1 truncate mt-0.5" title={s.description}>
                              {s.description || '无具体说明'}
                            </p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* 底部按钮栏 */}
            <div className="px-6 py-4 border-t border-slate-800/60 bg-slate-900/40 flex items-center justify-between">
              <span className="text-xs text-slate-400 font-medium">
                已选中 <span className="text-white font-bold">{selectedSkills.size}</span> 个技能
              </span>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition"
                >
                  上一步
                </button>
                <button
                  type="button"
                  onClick={handleSaveAndSync}
                  disabled={syncLoading}
                  className="px-5 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition active:scale-95 shadow-lg shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {syncLoading ? (
                    <>
                      <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      <span>正在保存并同步...</span>
                    </>
                  ) : (
                    <>
                      <span>💾</span>
                      <span>确认并同步</span>
                    </>
                  )}
                </button>
              </div>
            </div>

          </div>
        )}

      </div>
    </div>
  )
}
