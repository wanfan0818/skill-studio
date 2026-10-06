import { useEffect, useState } from 'react'
import { AGENT_ORDER, AGENT_META } from '../../agents'
import { PREFERRED_IDES_CHANGED } from '../../hooks/usePreferredIdes'

export function SettingsPanel() {
  const [customDir, setCustomDir] = useState('')
  const [githubToken, setGithubToken] = useState('')
  const [hasGithubToken, setHasGithubToken] = useState(false)
  const [clearGithubToken, setClearGithubToken] = useState(false)
  const [httpProxy, setHttpProxy] = useState('')
  const [rateLimit, setRateLimit] = useState<{ limit: number; remaining: number; reset: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    async function loadSettings() {
      try {
        const res = await fetch('/api/settings')
        const data = await res.json()
        if (data.ok && data.settings) {
          setCustomDir(data.settings.customGlobalSkillsDir || '')
          // The server never sends the token back — only whether one is stored.
          setHasGithubToken(!!data.settings.hasGithubToken)
          setHttpProxy(data.settings.httpProxy || '')
        }
      } catch (err: any) {
        setError('加载设置失败')
      } finally {
        setLoading(false)
      }
    }
    
    async function fetchRateLimit() {
      try {
        const res = await fetch('/api/skills/updater/rate-limit')
        const data = await res.json()
        if (data.ok && data.rateLimit) {
          setRateLimit(data.rateLimit)
        }
      } catch {}
    }

    loadSettings()
    fetchRateLimit()
  }, [])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(false)

    const pathVal = customDir.trim()
    if (pathVal !== '') {
      if (!pathVal.startsWith('/')) {
        setError('存储路径必须是绝对路径（例如：/Users/yourname/MySkills）')
        return
      }
    }

    let pathChanged = false
    try {
      const res = await fetch('/api/settings')
      const data = await res.json()
      if (data.ok && data.settings) {
        if ((data.settings.customGlobalSkillsDir || '') !== pathVal) {
          pathChanged = true
        }
      }
    } catch {}

    if (pathChanged) {
      if (
        !confirm(
          `确定要更改真实 Skill 存储目录吗？\n\n如果这是您第一次设置或修改路径，我们将平滑地将您之前默认目录下的真实全局物理 Skill 文件夹迁移搬运到新路径下，并在原默认路径建立对应的软链接。`
        )
      ) {
        return
      }
    }

    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          customGlobalSkillsDir: pathVal,
          // Empty means "keep the stored token"; clearing is explicit.
          githubToken: githubToken.trim() || undefined,
          clearGithubToken: clearGithubToken || undefined,
          httpProxy: httpProxy.trim(),
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setSuccess(true)
        setHasGithubToken(!!data.settings?.hasGithubToken)
        setGithubToken('')
        setClearGithubToken(false)
        if (pathChanged) {
          alert('配置保存并迁移成功！页面即将刷新以重新扫描技能。')
          window.location.reload()
        } else {
          // Refresh rate limit
          try {
            const rlRes = await fetch('/api/skills/updater/rate-limit')
            const rlData = await rlRes.json()
            if (rlData.ok && rlData.rateLimit) {
              setRateLimit(rlData.rateLimit)
            }
          } catch {}
        }
      } else {
        setError(data.error || '保存失败')
      }
    } catch (err: any) {
      setError('网络请求失败: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-8 h-8 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto bg-slate-900/60 border border-slate-800 rounded-xl p-6 space-y-6">
      <div>
        <h3 className="text-base font-semibold text-slate-100 mb-1">物理 Skill 存储目录设置</h3>
        <p className="text-xs text-slate-500 font-medium">
          默认情况下，物理 Skill 文件分散在各自 IDE 的默认目录下（例如 Claude Code 使用 ~/.claude/skills）。
          您可以指定一个全局自定义目录（如 Google Drive 或 OneDrive 的云同步目录）来集中备份和统一存放真实的物理 Skill，系统会自动将 IDE 默认目录变为指向此处的符号链接。
        </p>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        <div className="space-y-2">
          <label className="block text-xs font-semibold text-slate-400">
            全局真实存储路径 (绝对路径)
          </label>
          <input
            type="text"
            value={customDir}
            onChange={(e) => setCustomDir(e.target.value)}
            placeholder="例如: /Users/wanfan/MySkills"
            className="w-full text-sm placeholder:text-slate-500"
          />
          <p className="text-[10px] text-slate-600">
            提示：留空表示使用系统默认路径，恢复各 IDE 独立物理存储。
          </p>
        </div>

        <div className="border-t border-slate-800/80 pt-6">
          <h3 className="text-base font-semibold text-slate-100 mb-1">GitHub API 认证设置</h3>
          <p className="text-xs text-slate-500 font-medium mb-4">
            用于检查 Skill 的更新。配置 GitHub 个人访问令牌 (Personal Access Token) 可将 API 请求频次限制从每小时 60 次提升至 5000 次，避免批量检查更新时触发限流。
          </p>
          
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-400">
                GitHub Personal Access Token (PAT)
              </label>
              <input
                type="password"
                value={githubToken}
                onChange={(e) => {
                  setGithubToken(e.target.value)
                  if (e.target.value) setClearGithubToken(false)
                }}
                placeholder={hasGithubToken ? '已保存令牌（留空则保持不变，输入新值则替换）' : '例如: ghp_xxxxxxxxxxxxxxxxxxxx'}
                className="w-full text-sm placeholder:text-slate-500"
              />
              {hasGithubToken && (
                <label className="flex items-center gap-2 text-[11px] text-slate-500">
                  <input
                    type="checkbox"
                    checked={clearGithubToken}
                    onChange={(e) => {
                      setClearGithubToken(e.target.checked)
                      if (e.target.checked) setGithubToken('')
                    }}
                  />
                  保存时清除已保存的令牌
                </label>
              )}
              <p className="text-[10px] text-slate-600">
                提示：令牌只需具备公共仓读取权限（或无需特殊权限），用于访问公开 API。
              </p>
            </div>

            {rateLimit && (
              <div className="p-3 rounded-lg bg-slate-950/40 border border-slate-800/60 text-xs space-y-1">
                <div className="flex justify-between text-slate-400">
                  <span>GitHub API 剩余配额:</span>
                  <span className="font-semibold text-slate-200">
                    {rateLimit.remaining} / {rateLimit.limit}
                  </span>
                </div>
                {rateLimit.reset > 0 && (
                  <div className="flex justify-between text-[10px] text-slate-500">
                    <span>配额重置时间:</span>
                    <span>{new Date(rateLimit.reset * 1000).toLocaleString('zh-CN')}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-slate-800/80 pt-6">
          <h3 className="text-base font-semibold text-slate-100 mb-1">网络代理设置</h3>
          <p className="text-xs text-slate-500 font-medium mb-4">
            如果遇到连接 GitHub 失败，可在下方配置代理服务器地址。支持 HTTP 和 SOCKS 代理。
          </p>
          
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-400">
                代理服务器地址 (支持 socks5h:// 或 http:// 协议)
              </label>
              <input
                type="text"
                value={httpProxy}
                onChange={(e) => setHttpProxy(e.target.value)}
                placeholder="例如: socks5h://127.0.0.1:7892 或 http://127.0.0.1:7890"
                className="w-full text-sm placeholder:text-slate-500"
              />
              <p className="text-[10px] text-slate-600">
                提示：留空表示使用系统默认的代理配置。推荐在 macOS 上使用 socks5h 协议以避免 LibreSSL 连接错误。
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
            {error}
          </div>
        )}

        {success && (
          <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-xs">
            ✓ 保存成功！
          </div>
        )}

        <div className="pt-2">
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-semibold text-white shadow-md shadow-indigo-600/20 transition-all"
          >
            {saving ? '保存配置中...' : '保存配置'}
          </button>
        </div>
      </form>

      <PreferredIdesSection />
    </div>
  )
}

/** Which IDEs appear in IDE pickers (project IDEs, distribution rules, batch mount). */
function PreferredIdesSection() {
  const [selected, setSelected] = useState<string[]>([])
  const [isDefault, setIsDefault] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) return
        setSelected(d.settings.preferredIdes ?? [])
        setIsDefault(!!d.settings.preferredIdesIsDefault)
      })
      .catch(() => {})
  }, [])

  const save = async (list: string[] | null) => {
    setSaving(true)
    setMsg(null)
    try {
      const res = await fetch('/api/settings/preferred-ides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferredIdes: list }),
      })
      const d = await res.json()
      if (d.ok) {
        setSelected(d.ides)
        setIsDefault(d.isDefault)
        setMsg(list ? '已保存' : '已恢复为自动识别')
        window.dispatchEvent(new Event(PREFERRED_IDES_CHANGED))
      } else setMsg(d.error || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const all = AGENT_ORDER.filter((id) => id !== 'unknown' && id !== 'universal')
  return (
    <div className="border-t border-slate-800/80 pt-6 mt-6 space-y-3">
      <div>
        <h3 className="text-base font-semibold text-slate-100 mb-1">常用 IDE</h3>
        <p className="text-xs text-slate-500">
          只有这里选中的 IDE 会出现在项目 IDE、分发规则、批量挂载等选项里。
          {isDefault ? '当前是自动识别：已有分发规则的 IDE + 项目里用到的 IDE。' : '当前是手动设置。'}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {all.map((id) => {
          const meta = AGENT_META[id]
          const on = selected.includes(id)
          return (
            <button
              key={id}
              type="button"
              onClick={() => setSelected(on ? selected.filter((x) => x !== id) : [...selected, id])}
              className={`px-2.5 py-1 rounded-full text-xs border cursor-pointer ${on ? 'border-indigo-400/60 bg-indigo-500/15 text-slate-100' : 'border-slate-800 text-slate-500 hover:text-slate-300'}`}
            >
              {meta?.icon} {meta?.name ?? id}
            </button>
          )
        })}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={saving || selected.length === 0}
          onClick={() => save(selected)}
          className="px-4 py-2 bg-indigo-600 disabled:opacity-40 rounded-lg text-sm font-semibold cursor-pointer"
        >
          保存常用 IDE（{selected.length}）
        </button>
        {!isDefault && (
          <button type="button" disabled={saving} onClick={() => save(null)} className="text-xs text-slate-400 hover:text-slate-200 cursor-pointer">
            恢复自动识别
          </button>
        )}
        {msg && <span className="text-xs text-emerald-400">{msg}</span>}
      </div>
    </div>
  )
}
