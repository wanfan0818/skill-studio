import { useState, FormEvent, ReactNode } from 'react'

interface MarketItem {
  fullId: string
  repoPath: string
  name: string
  installs: string
  url: string
  description?: string
  
  // Custom extensions for GitHub parsed skills
  isGitHubImport?: boolean
  absPath?: string
  tempPath?: string
  hasFrontmatter?: boolean
  dirName?: string
}

interface Project {
  name: string
  path: string
  skillCount: number
}

interface ExploreViewProps {
  projects: Project[]
  onInstalled: () => Promise<void>
}

const RECOMMENDED_SKILLS: MarketItem[] = [
  {
    fullId: 'xixu-me/skills@github-actions-docs',
    repoPath: 'xixu-me/skills',
    name: 'github-actions-docs',
    installs: '221.3K installs',
    url: 'https://skills.sh/xixu-me/skills/github-actions-docs',
    description: '快速生成和校验 GitHub Actions 工作流的配置说明与文档。',
  },
  {
    fullId: 'github/awesome-copilot@git-commit',
    repoPath: 'github/awesome-copilot',
    name: 'git-commit',
    installs: '35.6K installs',
    url: 'https://skills.sh/github/awesome-copilot/git-commit',
    description: '分析 Git 变更，自动生成符合规范的结构化 Commit 信息。',
  },
  {
    fullId: 'github/awesome-copilot@prd',
    repoPath: 'github/awesome-copilot',
    name: 'prd',
    installs: '19.4K installs',
    url: 'https://skills.sh/github/awesome-copilot/prd',
    description: '产品经理的高效辅助，快速生成高质量的产品需求文档模版。',
  },
  {
    fullId: 'github/awesome-copilot@gh-cli',
    repoPath: 'github/awesome-copilot',
    name: 'gh-cli',
    installs: '21.6K installs',
    url: 'https://skills.sh/github/awesome-copilot/gh-cli',
    description: '帮助操作 GitHub CLI 工具，自动处理创建 PR、提 Issue 等日常流程。',
  },
]

function parseMarkdown(md: string): ReactNode[] {
  const lines = md.split('\n')
  let inCodeBlock = false
  let codeLines: string[] = []

  return lines.map((line, idx) => {
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        inCodeBlock = false
        const code = codeLines.join('\n')
        codeLines = []
        return (
          <pre key={idx} className="bg-slate-950 p-4 rounded-xl border border-slate-800 text-[11px] font-mono text-slate-300 my-3 overflow-x-auto">
            <code>{code}</code>
          </pre>
        )
      } else {
        inCodeBlock = true
        return null
      }
    }

    if (inCodeBlock) {
      codeLines.push(line)
      return null
    }

    if (line.startsWith('# ')) {
      return <h1 key={idx} className="text-xl font-bold text-slate-100 mt-6 mb-3 border-b border-slate-850 pb-1.5">{line.slice(2)}</h1>
    }
    if (line.startsWith('## ')) {
      return <h2 key={idx} className="text-lg font-bold text-slate-100 mt-5 mb-2.5">{line.slice(3)}</h2>
    }
    if (line.startsWith('### ')) {
      return <h3 key={idx} className="text-base font-bold text-slate-250 mt-4 mb-2">{line.slice(4)}</h3>
    }

    if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
      return (
        <li key={idx} className="text-xs text-slate-300 list-disc list-inside ml-2 my-1 leading-relaxed">
          {line.trim().slice(2)}
        </li>
      )
    }

    if (!line.trim()) {
      return <div key={idx} className="h-2.5" />
    }

    return (
      <p key={idx} className="text-xs text-slate-300 my-1 leading-relaxed">
        {line}
      </p>
    )
  }).filter((el): el is ReactNode => el !== null)
}

export function ExploreView({ projects, onInstalled }: ExploreViewProps) {
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [items, setItems] = useState<MarketItem[]>(RECOMMENDED_SKILLS)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Install Modal States
  const [installItem, setInstallItem] = useState<MarketItem | null>(null)
  const [scope, setScope] = useState<'global' | 'project'>('global')
  const [selectedProjectPath, setSelectedProjectPath] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installResult, setInstallResult] = useState<{ success: boolean; log: string } | null>(null)

  // Preview Drawer States
  const [previewItem, setPreviewItem] = useState<MarketItem | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewContent, setPreviewContent] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault()
    if (!search.trim()) {
      setItems(RECOMMENDED_SKILLS)
      setSearched(false)
      return
    }

    setLoading(true)
    setError(null)
    setSearched(true)

    const isGithub = /github\.com/i.test(search) || /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/i.test(search.trim())

    try {
      if (isGithub) {
        const res = await fetch('/api/skills/market/github-clone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoUrl: search }),
        })
        const data = await res.json()
        if (res.ok && data.ok) {
          const githubItems: MarketItem[] = (data.skills || []).map((skill: any) => ({
            fullId: `github@${skill.dirName}`,
            repoPath: search.trim(),
            name: skill.name,
            installs: skill.hasFrontmatter ? '✓ 含 YAML 标头' : '⚠️ 缺失标头',
            url: `https://github.com/${search.trim()}`,
            description: skill.description,
            isGitHubImport: true,
            absPath: skill.absPath,
            tempPath: data.tempPath,
            hasFrontmatter: skill.hasFrontmatter,
            dirName: skill.dirName,
          }))
          setItems(githubItems)
        } else {
          setError(data.error || 'GitHub 仓库解析失败')
        }
      } else {
        const res = await fetch(`/api/skills/market/search?q=${encodeURIComponent(search)}`)
        const data = await res.json()
        if (data.ok) {
          setItems(data.items || [])
        } else {
          setError(data.error || '搜索失败')
        }
      }
    } catch (err: any) {
      setError(err.message || '网络请求错误')
    } finally {
      setLoading(false)
    }
  }

  const handleInstallClick = (item: MarketItem) => {
    setInstallItem(item)
    setScope('global')
    if (projects.length > 0) {
      setSelectedProjectPath(projects[0].path)
    } else {
      setSelectedProjectPath('')
    }
    setInstallResult(null)
    setInstalling(false)
  }

  const handlePreviewClick = async (item: MarketItem) => {
    setPreviewItem(item)
    setPreviewLoading(true)
    setPreviewContent(null)
    setPreviewError(null)

    try {
      let url = ''
      if (item.isGitHubImport) {
        url = `/api/skills/market/readme?skillPath=${encodeURIComponent(item.absPath || '')}`
      } else {
        url = `/api/skills/market/readme?repo=${encodeURIComponent(item.repoPath)}&name=${encodeURIComponent(item.name)}`
      }

      const res = await fetch(url)
      const data = await res.json()
      if (res.ok && data.content) {
        setPreviewContent(data.content)
      } else {
        setPreviewError(data.error || '未能加载 SKILL.md 内容')
      }
    } catch (err: any) {
      setPreviewError(err.message || '网络请求失败')
    } finally {
      setPreviewLoading(false)
    }
  }

  const startInstall = async () => {
    if (!installItem) return
    setInstalling(true)
    setError(null)
    try {
      const isGitHub = installItem.isGitHubImport
      const url = isGitHub ? '/api/skills/market/github-install' : '/api/skills/market/install'
      const body = isGitHub
        ? {
            tempPath: installItem.tempPath,
            skillPath: installItem.absPath,
            scope,
            projectPath: scope === 'project' ? selectedProjectPath : undefined,
          }
        : {
            target: installItem.fullId,
            scope,
            projectPath: scope === 'project' ? selectedProjectPath : undefined,
          }

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.ok) {
        setInstallResult({ success: true, log: data.log || '安装成功' })
        await onInstalled()
      } else {
        setInstallResult({ success: false, log: data.error || '安装失败' })
      }
    } catch (err: any) {
      setInstallResult({ success: false, log: err.message || '网络连接失败' })
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Title & Search bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 mb-1">探索 Skills</h2>
          <p className="text-sm text-slate-500 font-normal">
            发现并一键安装开源技能。输入 GitHub 仓库名 (如 <code className="text-blue-500 font-semibold font-mono bg-slate-900 px-1 py-0.5 rounded">luochang212/skill-zoo</code>) 即可一键解析。
          </p>
        </div>

        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            placeholder="搜索开源 Skills 或输入 GitHub 仓库..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full md:w-80 text-sm placeholder:text-slate-400"
          />
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 bg-blue-600 disabled:opacity-50 text-sm cursor-pointer"
          >
            {loading ? '检索中...' : '探索'}
          </button>
        </form>
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Grid Content */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="text-slate-400 flex flex-col items-center gap-3">
            <div className="w-10 h-10 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
            <span className="text-xs">正在拉取并解析中，请稍候...</span>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="flex items-center justify-center h-64 border border-dashed border-slate-800 rounded-xl">
          <div className="text-center">
            <div className="text-3xl mb-3">👻</div>
            <p className="text-slate-300 font-medium mb-1">未搜索到相关 Skill</p>
            <p className="text-xs text-slate-500">尝试输入其他关键词，或输入正确的 GitHub 地址</p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-slate-400">
            {searched ? `搜索结果 (${items.length})` : '推荐/热门技能'}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {items.map((item) => (
              <div
                key={item.fullId}
                className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 flex flex-col justify-between hover:border-slate-700 transition-all group"
              >
                <div>
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <h4 className="text-base font-bold text-slate-200 group-hover:text-blue-500 transition-colors truncate">
                        /{item.name}
                      </h4>
                      {item.isGitHubImport && (
                        <span className="shrink-0 text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.25 rounded">
                          Git 仓库
                        </span>
                      )}
                    </div>
                    <span className={`shrink-0 text-[11px] font-semibold px-2.5 py-0.5 rounded-full border ${
                      item.isGitHubImport
                        ? item.hasFrontmatter
                          ? 'text-emerald-400 bg-emerald-950/40 border-emerald-800/40'
                          : 'text-amber-400 bg-amber-950/40 border-amber-800/40'
                        : 'text-slate-500 bg-slate-950 border-slate-800'
                    }`}>
                      {item.installs}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed mb-4 min-h-[32px] break-words">
                    {item.description || `来自 ${item.repoPath} 的开源 Skill。安装后可以自动激活并赋能你的 AI 助手。`}
                  </p>
                </div>
                <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-800/40">
                  <div className="flex items-center gap-4">
                    {!item.isGitHubImport && (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-slate-500 hover:text-slate-300 underline"
                      >
                        网页端详情 ↗
                      </a>
                    )}
                    <button
                      onClick={() => handlePreviewClick(item)}
                      className="text-xs text-blue-500 hover:underline font-semibold cursor-pointer"
                    >
                      🔍 预览文档
                    </button>
                  </div>
                  <button
                    onClick={() => handleInstallClick(item)}
                    className="px-3.5 py-1.5 bg-blue-500/10 hover:bg-blue-500/20 text-blue-500 border border-blue-500/20 rounded text-xs font-semibold transition-all cursor-pointer"
                  >
                    一键安装
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Document Preview Drawer */}
      {previewItem && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex justify-end">
          <div className="absolute inset-0 cursor-pointer" onClick={() => setPreviewItem(null)} />
          
          <div className="relative w-full max-w-2xl bg-slate-900 border-l border-slate-800 shadow-2xl h-full flex flex-col z-10 animate-slide-in">
            {/* Header */}
            <div className="px-6 py-5 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
                  <span>预览:</span>
                  <span className="text-blue-500 font-mono">/{previewItem.name}</span>
                </h3>
                <p className="text-xs text-slate-500 mt-1 font-mono break-all">{previewItem.repoPath}</p>
              </div>
              <button
                onClick={() => setPreviewItem(null)}
                className="text-slate-500 hover:text-slate-300 p-1.5 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto px-8 py-6 space-y-4">
              {previewLoading ? (
                <div className="flex flex-col items-center justify-center h-full space-y-3">
                  <div className="w-8 h-8 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
                  <span className="text-xs text-slate-450">正在拉取文档内容...</span>
                </div>
              ) : previewError ? (
                <div className="p-4 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-xl font-medium leading-relaxed">
                  {previewError}
                </div>
              ) : previewContent ? (
                <div className="prose prose-invert max-w-none text-slate-300">
                  {parseMarkdown(previewContent)}
                </div>
              ) : (
                <p className="text-slate-500 text-xs text-center">暂无文档内容</p>
              )}
            </div>

            {/* Footer Actions */}
            <div className="px-6 py-4 border-t border-slate-800 bg-slate-950/40 flex items-center justify-end gap-3">
              <button
                onClick={() => setPreviewItem(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold transition-all cursor-pointer"
              >
                关闭
              </button>
              <button
                onClick={() => {
                  const item = previewItem
                  setPreviewItem(null)
                  handleInstallClick(item)
                }}
                className="px-4 py-2 bg-indigo-600 disabled:opacity-50 text-xs cursor-pointer"
              >
                立即安装
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Install Modal */}
      {installItem && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-905 border border-slate-800 rounded-xl max-w-lg w-full p-6 space-y-5 shadow-2xl relative overflow-hidden">
            <h3 className="text-lg font-bold text-slate-100 flex items-center gap-2">
              <span>安装 Skill:</span>
              <span className="text-blue-500 font-mono">/{installItem.name}</span>
            </h3>

            {!installResult && !installing && (
              <div className="space-y-4">
                <p className="text-sm text-slate-400 leading-relaxed">
                  即将安装公共技能 <code className="text-slate-300 bg-slate-950 px-1.5 py-0.5 rounded font-mono text-xs break-all">{installItem.fullId}</code> 到本地。请选择你想要放置的路径范围：
                </p>

                {/* Scope selection */}
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setScope('global')}
                    className={`p-4 rounded border text-left transition-all cursor-pointer ${
                      scope === 'global'
                        ? 'border-blue-500 bg-blue-500/5 text-slate-100'
                        : 'border-slate-800 hover:border-slate-700 bg-slate-950/40 text-slate-400'
                    }`}
                  >
                    <div className="font-bold text-sm mb-1 text-slate-200">全局范围 (Global)</div>
                    <div className="text-[11px] text-slate-500">
                      所有项目下的 AI 助手共享 (~/.claude/skills)
                    </div>
                  </button>

                  <button
                    onClick={() => setScope('project')}
                    disabled={projects.length === 0}
                    className={`p-4 rounded border text-left transition-all ${
                      projects.length === 0 ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
                    } ${
                      scope === 'project'
                        ? 'border-blue-500 bg-blue-500/5 text-slate-100'
                        : 'border-slate-800 hover:border-slate-700 bg-slate-950/40 text-slate-400'
                    }`}
                  >
                    <div className="font-bold text-sm mb-1 text-slate-200">项目范围 (Project)</div>
                    <div className="text-[11px] text-slate-500">
                      仅在选定的某个项目下加载生效
                    </div>
                  </button>
                </div>

                {/* Project selection */}
                {scope === 'project' && projects.length > 0 && (
                  <div className="space-y-2">
                    <label className="block text-xs font-semibold text-slate-400">选择目标项目</label>
                    <select
                      value={selectedProjectPath}
                      onChange={(e) => setSelectedProjectPath(e.target.value)}
                      className="w-full text-sm"
                    >
                      {projects.map((proj) => (
                        <option key={proj.path} value={proj.path}>
                          {proj.name} ({proj.path})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="flex items-center gap-3 pt-2">
                  <button
                    onClick={startInstall}
                    className="px-4 py-2 bg-indigo-600 disabled:opacity-50 text-sm cursor-pointer"
                  >
                    开始安装
                  </button>
                  <button
                    onClick={() => setInstallItem(null)}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-350 rounded text-sm transition-all cursor-pointer font-medium"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {installing && (
              <div className="py-8 flex flex-col items-center justify-center space-y-4">
                <div className="w-12 h-12 border-4 border-slate-600 border-t-white rounded-full animate-spin" />
                <div className="text-center">
                  <p className="text-sm font-medium text-slate-200">正在获取并安装 Skill...</p>
                  <p className="text-xs text-slate-500 mt-1">正在进行本地下载与依赖部署，请耐心等待。</p>
                </div>
              </div>
            )}

            {installResult && (
              <div className="space-y-4">
                <div className={`p-4 rounded-xl border flex gap-3 ${
                  installResult.success
                    ? 'bg-green-500/10 border-green-500/20 text-green-400'
                    : 'bg-red-500/10 border-red-500/20 text-red-400'
                }`}>
                  <div className="text-2xl shrink-0">{installResult.success ? '✓' : '✗'}</div>
                  <div>
                    <h4 className="font-bold text-sm mb-1">
                      {installResult.success ? '安装成功' : '安装失败'}
                    </h4>
                    <p className="text-xs opacity-80">
                      {installResult.success
                        ? `技能 /${installItem.name} 已经成功部署在你的本地环境。`
                        : '执行安装命令时发生异常。'}
                    </p>
                  </div>
                </div>

                <div className="space-y-1">
                  <span className="text-[11px] font-semibold text-slate-500 uppercase">命令执行日志</span>
                  <pre className="max-h-40 overflow-y-auto text-[10px] font-mono bg-slate-950 text-slate-400 p-3 rounded-lg border border-slate-800/80 leading-normal whitespace-pre-wrap">
                    {installResult.log}
                  </pre>
                </div>

                <div className="pt-2">
                  <button
                    onClick={() => {
                      setInstallItem(null)
                      setInstallResult(null)
                    }}
                    className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold rounded-lg transition-all cursor-pointer"
                  >
                    关闭窗口
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
