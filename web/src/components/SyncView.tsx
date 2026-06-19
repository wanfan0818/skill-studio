import { useCallback, useEffect, useState } from 'react'
import type { Skill } from '../hooks/useSkills'
import { AGENT_ORDER, AGENT_META } from '../agents'

interface SyncViewProps {
  allSkills: Skill[]
}

interface Anomaly {
  id: string
  name: string
  path: string
  agentId: string
  agentName: string
}

interface AgentStat {
  agentId: string
  agentName: string
  icon: string
  symlinkCount: number
  realCount: number
  globalPath: string
  exists: boolean
  enabled: boolean
}

interface PublicSyncConfig {
  connected: boolean
  repoUrl: string | null
  owner: string | null
  name: string | null
  defaultBranch: string | null
  hasToken: boolean
  lastValidatedAt: string | null
}

export function SyncView({ allSkills }: SyncViewProps) {
  const [tab, setTab] = useState<'github' | 'symlinks' | 'settings'>('github')
  const [config, setConfig] = useState<PublicSyncConfig | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchConfig = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/sync/config')
      const data = await res.json()
      setConfig(data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchConfig()
  }, [fetchConfig])

  if (loading && tab === 'github') {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Tab Navigation */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3 flex-wrap gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 mb-1">同步与 IDE 分发</h2>
          <p className="text-sm text-slate-500 font-medium">
            在此备份管理你的 Skills，或者将其批量分发挂载到不同的 IDE 专属目录。
          </p>
        </div>

        <div className="flex items-center bg-slate-900/60 border border-slate-800 rounded-lg p-0.5 shadow-inner">
          <button
            onClick={() => setTab('github')}
            className={`px-4 py-1.5 rounded-md text-xs font-semibold transition-all cursor-pointer ${
              tab === 'github'
                ? 'bg-slate-700 text-slate-200'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            GitHub 备份
          </button>
          <button
            onClick={() => setTab('symlinks')}
            className={`px-4 py-1.5 rounded-md text-xs font-semibold transition-all cursor-pointer ${
              tab === 'symlinks'
                ? 'bg-slate-700 text-slate-200'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            IDE 软链分发 & 异常修复
          </button>
          <button
            onClick={() => setTab('settings')}
            className={`px-4 py-1.5 rounded-md text-xs font-semibold transition-all cursor-pointer ${
              tab === 'settings'
                ? 'bg-slate-700 text-slate-200'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            自定义路径
          </button>
        </div>
      </div>

      {tab === 'github' ? (
        <div className="max-w-2xl mx-auto space-y-6">
          {config?.connected ? (
            <ConnectedPanel config={config} onDisconnect={fetchConfig} onRevalidated={fetchConfig} />
          ) : (
            <ConnectForm onConnected={fetchConfig} />
          )}
        </div>
      ) : tab === 'symlinks' ? (
        <SymlinksManagePanel allSkills={allSkills} />
      ) : (
        <SettingsPanel />
      )}

      <div className="max-w-2xl mx-auto pt-6 border-t border-slate-800/40">
        <ExportSection />
      </div>
    </div>
  )
}

function SymlinksManagePanel({ allSkills }: { allSkills: Skill[] }) {
  const [anomalies, setAnomalies] = useState<Anomaly[]>([])
  const [agentStats, setAgentStats] = useState<AgentStat[]>([])
  const [loading, setLoading] = useState(true)
  const [fixing, setFixing] = useState(false)
  const [clearingId, setClearingId] = useState<string | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const handleToggleIde = async (agentId: string, enabled: boolean) => {
    if (togglingId) return

    if (!enabled) {
      if (!confirm(`确定要关闭该 IDE 的全局 Skill 共享吗？\n\n这会安全地清空该 IDE 下挂载的所有软链接。`)) {
        return
      }
    }

    setTogglingId(agentId)
    try {
      const res = await fetch('/api/ide/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, enabled }),
      })
      const data = await res.json()
      if (data.ok) {
        await fetchAnomaliesAndStats()
      } else {
        alert(data.error || '切换共享状态失败')
      }
    } catch (err: any) {
      alert('请求失败: ' + err.message)
    } finally {
      setTogglingId(null)
    }
  }

  // 批量分发的 states
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(new Set())
  const [targetAgentId, setTargetAgentId] = useState<string>('')
  const [batchSyncing, setBatchSyncing] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const fetchAnomaliesAndStats = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/symlinks/anomalies')
      const data = await res.json()
      if (data.ok) {
        setAnomalies(data.anomalies || [])
        setAgentStats(data.stats || [])
      }
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchAnomaliesAndStats()
  }, [fetchAnomaliesAndStats])

  const handleFixAnomalies = async () => {
    if (anomalies.length === 0 || fixing) return
    if (
      !confirm(
        `确定要将这 ${anomalies.length} 个异常安装的 Skill 一键收归并修复吗？\n\n我们将把它们的物理实体目录移至全局共享路径下，并在原 IDE 专属目录生成软链接以确保原有服务依然正常运作。`
      )
    )
      return

    setFixing(true)
    try {
      const res = await fetch('/api/symlinks/anomalies/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (data.ok) {
        alert(
          `一键修复成功！已成功收归并修复了 ${data.fixedCount} 个物理冲突技能。`
        )
        await fetchAnomaliesAndStats()
      } else {
        alert(data.error || '修复失败')
      }
    } catch (err: any) {
      alert('修复网络请求失败: ' + err.message)
    } finally {
      setFixing(false)
    }
  }

  const handleClearSymlinks = async (agentId: string, agentName: string) => {
    if (clearingId) return
    if (
      !confirm(
        `确定要清空 ${agentName} 下的所有符号链接吗？\n\n这只会删除软链接以解绑 IDE 对这些 Skill 的使用权，不会损害真正的物理技能文件夹，保证绝对安全。`
      )
    )
      return

    setClearingId(agentId)
    try {
      const res = await fetch('/api/skills/batch/symlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'remove_all',
          agentId,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        alert(`已成功清空 ${agentName} 下的 ${data.removedCount} 个软链接。`)
        await fetchAnomaliesAndStats()
      } else {
        alert(data.error || '清空失败')
      }
    } catch (err: any) {
      alert('请求错误: ' + err.message)
    } finally {
      setClearingId(null)
    }
  }

  const handleBatchSync = async () => {
    if (selectedSkillIds.size === 0) {
      alert('请先勾选需要挂载的 Skill。')
      return
    }
    if (!targetAgentId) {
      alert('请选择目标 IDE 目录。')
      return
    }

    setBatchSyncing(true)
    try {
      const res = await fetch('/api/skills/batch/symlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add',
          agentId: targetAgentId,
          skillIds: Array.from(selectedSkillIds),
        }),
      })
      const data = await res.json()
      if (data.ok) {
        const warning = (data.results || []).find((r: any) => !r.success)
        if (warning) {
          alert(`挂载同步部分成功，但有报错: ${warning.error}`)
        } else {
          alert(`批量挂载成功！已一键建立 ${selectedSkillIds.size} 个软链接到选定的 IDE。`)
          setSelectedSkillIds(new Set())
        }
        await fetchAnomaliesAndStats()
      } else {
        alert(data.error || '同步失败')
      }
    } catch (err: any) {
      alert('同步失败: ' + err.message)
    } finally {
      setBatchSyncing(false)
    }
  }

  const toggleSkillSelect = (id: string) => {
    setSelectedSkillIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const filteredSkills = allSkills.filter((skill) =>
    skill.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    skill.description.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const handleSelectAll = () => {
    if (selectedSkillIds.size === filteredSkills.length) {
      setSelectedSkillIds(new Set())
    } else {
      setSelectedSkillIds(new Set(filteredSkills.map((s) => s.id)))
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 1. 异常 Skill 安装警告与一键修复 */}
      {anomalies.length > 0 ? (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-5 space-y-3.5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <span className="text-xl shrink-0">⚠️</span>
              <div>
                <h4 className="text-sm font-semibold text-red-400">检测到 {anomalies.length} 个非常规 IDE 技能安装</h4>
                <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                  这些 Skill 直接以真实物理文件夹形式存放在 IDE 专属目录下，这会导致其它 IDE 无法访问到这些 Skill，破坏了软链的统一统筹体系。
                </p>
              </div>
            </div>
            <button
              onClick={handleFixAnomalies}
              disabled={fixing}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-40 rounded-lg text-xs font-semibold text-white transition-all shadow-md shrink-0"
            >
              {fixing ? '正在修复...' : '🔧 一键收归与修复'}
            </button>
          </div>
          <div className="border border-red-500/10 rounded-lg overflow-hidden max-h-36 overflow-y-auto divide-y divide-red-500/5 bg-slate-950/20">
            {anomalies.map((item) => (
              <div key={item.id} className="px-3 py-2 text-[11px] font-mono flex items-center justify-between gap-3 text-slate-300">
                <div className="truncate">
                  <span className="text-red-400">/{item.name}</span>
                  <span className="text-slate-500 text-[10px] ml-2">({item.path})</span>
                </div>
                <span className="px-2 py-0.5 rounded bg-slate-900 text-slate-400 shrink-0">{item.agentName}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-slate-900/30 border border-slate-800 rounded-xl p-4 flex items-center gap-3">
          <span className="text-lg">✨</span>
          <div className="text-xs text-slate-400 font-medium">IDE 专属路径下结构正常，未检测到任何异常/物理安装冲突。</div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* 2. 批量同步挂载区 */}
        <div className="lg:col-span-7 bg-slate-900/40 border border-slate-800/80 rounded-xl p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-300 mb-1">批量分发 Skills 软链接</h3>
            <p className="text-xs text-slate-500">
              勾选下方 Skills，选择目标 IDE，一键创建软链接将其挂载在相应 IDE 技能目录下。
            </p>
          </div>

          <div className="flex gap-2 items-center">
            <input
              type="text"
              placeholder="搜索可用技能..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 px-3 py-1.5 text-xs text-slate-300"
            />
            {filteredSkills.length > 0 && (
              <button
                onClick={handleSelectAll}
                className="px-2.5 py-1.5 bg-slate-850 hover:bg-slate-800 rounded text-[10px] text-slate-400 whitespace-nowrap cursor-pointer"
              >
                {selectedSkillIds.size === filteredSkills.length ? '取消全选' : '全选'}
              </button>
            )}
          </div>

          <div className="border border-slate-800/60 rounded-lg divide-y divide-slate-800/40 max-h-72 overflow-y-auto bg-slate-950/20">
            {filteredSkills.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-slate-500">无匹配技能</div>
            ) : (
              filteredSkills.map((skill) => (
                <label key={skill.id} className="px-3 py-2 text-xs flex items-center gap-3 hover:bg-slate-900/20 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={selectedSkillIds.has(skill.id)}
                    onChange={() => toggleSkillSelect(skill.id)}
                    className="w-3.5 h-3.5 text-blue-500 focus:ring-blue-500/30 cursor-pointer"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-slate-300 truncate font-medium">{skill.name}</div>
                    <div className="text-[10px] text-slate-500 truncate mt-0.5">{skill.description || '无描述'}</div>
                  </div>
                  <div className="text-[10px] shrink-0 text-slate-500 uppercase font-semibold tracking-wider bg-slate-900 px-1.5 py-0.5 rounded">
                    {skill.scope}
                  </div>
                </label>
              ))
            )}
          </div>

          <div className="flex items-center gap-3 border-t border-slate-800/80 pt-4 flex-wrap">
            <div className="flex-1 min-w-[150px]">
              <select
                value={targetAgentId}
                onChange={(e) => setTargetAgentId(e.target.value)}
                className="w-full text-xs text-slate-300"
              >
                <option value="">-- 选择目标 IDE --</option>
                {AGENT_ORDER.map((id) => {
                  const meta = AGENT_META[id]
                  if (!meta || id === 'unknown') return null
                  return (
                    <option key={id} value={id}>
                      {meta.icon} {meta.name}
                    </option>
                  )
                })}
              </select>
            </div>
            <button
              onClick={handleBatchSync}
              disabled={batchSyncing || selectedSkillIds.size === 0 || !targetAgentId}
              className="px-4 py-2 bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed text-xs cursor-pointer"
            >
              {batchSyncing ? '正在同步...' : `批量挂载到目标 IDE (${selectedSkillIds.size})`}
            </button>
          </div>
        </div>

        {/* 3. 各 IDE 共享开关与统计 */}
        <div className="lg:col-span-5 bg-slate-900/40 border border-slate-800/80 rounded-xl p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-300 mb-1">IDE 全局共享管理</h3>
            <p className="text-xs text-slate-500">
              一键启用 IDE 的全局共享后，所有已扫描的 Skill 都会自动链接并在该 IDE 中可用。
            </p>
          </div>

          <div className="space-y-2.5 max-h-96 overflow-y-auto">
            {agentStats.map((agent) => (
              <div key={agent.agentId} className="bg-slate-950/40 border border-slate-800/50 rounded-xl p-3.5 flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-base shrink-0">{agent.icon}</span>
                    <span className="font-semibold text-slate-200 text-xs truncate">{agent.agentName}</span>
                  </div>
                  <div className="text-[10px] text-slate-500 truncate max-w-[200px]" title={agent.globalPath}>
                    {agent.globalPath}
                  </div>
                  <div className="flex items-center gap-3 mt-2 font-medium">
                    <div className="text-[10px] text-slate-400">
                      软链: <span className="text-indigo-400 text-xs font-bold tabular-nums">{agent.symlinkCount}</span>
                    </div>
                    <div className="text-[10px] text-slate-400">
                      物理: <span className={`text-xs font-bold tabular-nums ${agent.realCount > 0 ? 'text-red-400' : 'text-slate-500'}`}>{agent.realCount}</span>
                    </div>
                  </div>
                </div>
                
                {/* Toggle Switch */}
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <button
                    onClick={() => handleToggleIde(agent.agentId, !agent.enabled)}
                    disabled={togglingId !== null}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      agent.enabled ? 'bg-indigo-600' : 'bg-slate-800'
                    } ${togglingId !== null ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        agent.enabled ? 'translate-x-4' : 'translate-x-0'
                      }`}
                    />
                  </button>
                  <span className="text-[9px] text-slate-500 font-semibold uppercase tracking-wider">
                    {togglingId === agent.agentId ? '同步中...' : agent.enabled ? '全局共享' : '未共享'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ExportSection() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const download = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/sync/export/tar')
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: '导出失败' }))
        setError(data.error || `HTTP ${res.status}`)
        return
      }
      const skillCount = res.headers.get('X-Skill-Count') || '?'
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const cd = res.headers.get('Content-Disposition') || ''
      const match = cd.match(/filename="([^"]+)"/)
      const filename = match?.[1] || 'skill-hub-backup.tar.gz'
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      console.info(`[skill-hub] exported ${skillCount} skills as ${filename}`)
    } catch (e: any) {
      setError(e?.message || '导出失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-slate-900/40 border border-slate-800/60 rounded-xl p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-300 mb-1">导出为 tar.gz(离线备份)</h3>
          <p className="text-xs text-slate-500">
            不想用 GitHub?直接导出一个压缩包,解压后把 <code className="text-slate-400 bg-slate-950 px-1 rounded">&lt;agent&gt;/&lt;skill&gt;/</code> 目录拷贝到目标机器即可。
          </p>
        </div>
        <button
          onClick={download}
          disabled={busy}
          className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded-lg text-xs text-slate-300 whitespace-nowrap"
        >
          {busy ? '打包中...' : '下载 .tar.gz'}
        </button>
      </div>
      {error && (
        <div className="p-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
          {error}
        </div>
      )}
    </div>
  )
}

function ConnectForm({ onConnected }: { onConnected: () => void }) {
  const [repoUrl, setRepoUrl] = useState('')
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (endpoint: '/api/sync/validate' | '/api/sync/config') => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl, token }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || '未知错误')
        return null
      }
      return data
    } catch (e: any) {
      setError(e?.message || '请求失败')
      return null
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 space-y-5">
      <div>
        <label className="block text-xs text-slate-400 mb-1.5 font-medium">GitHub 仓库地址</label>
        <input
          type="text"
          placeholder="https://github.com/用户名/仓库名  或  用户名/仓库名"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          className="w-full text-sm placeholder:text-slate-500"
        />
        <p className="text-[11px] text-slate-600 mt-1.5">
          建议使用一个新的私有仓库。如果还没有,可以先到 GitHub 创建一个空仓库。
        </p>
      </div>

      <div>
        <label className="block text-xs text-slate-400 mb-1.5 font-medium">
          Personal Access Token
        </label>
        <input
          type="password"
          placeholder="ghp_... 或 github_pat_..."
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="w-full text-sm font-mono placeholder:text-slate-500"
        />
        <p className="text-[11px] text-slate-600 mt-1.5">
          <a
            href="https://github.com/settings/tokens/new?description=Skill%20Hub&scopes=repo"
            target="_blank"
            rel="noreferrer"
            className="text-blue-500 hover:underline"
          >
            在此创建 Token
          </a>{' '}
          — 需要 <code className="text-slate-400 bg-slate-950 px-1 rounded">repo</code> scope(或
          Fine-grained 的 Contents: Read & Write)。Token 会保存在 ~/.config/skill-hub/credentials.json
          (权限 600),仅本机可读。
        </p>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={async () => {
            const data = await submit('/api/sync/config')
            if (data?.ok) onConnected()
          }}
          disabled={submitting || !repoUrl || !token}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium text-white transition-all shadow-lg shadow-indigo-600/20"
        >
          {submitting ? '验证中...' : '验证并保存'}
        </button>
        <button
          onClick={() => submit('/api/sync/validate')}
          disabled={submitting || !repoUrl || !token}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm text-slate-300 transition-all"
        >
          仅验证(不保存)
        </button>
      </div>
    </div>
  )
}

function ConnectedPanel({
  config,
  onDisconnect,
  onRevalidated,
}: {
  config: PublicSyncConfig
  onDisconnect: () => void
  onRevalidated: () => void
}) {
  const [busy, setBusy] = useState<'revalidate' | 'disconnect' | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const revalidate = async () => {
    setBusy('revalidate')
    setMsg(null)
    try {
      const res = await fetch('/api/sync/revalidate', { method: 'POST' })
      const data = await res.json()
      if (data.ok) {
        setMsg({ kind: 'ok', text: '仓库连接正常' })
        onRevalidated()
      } else {
        setMsg({ kind: 'err', text: data.error || '校验失败' })
      }
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async () => {
    if (!confirm('断开连接会删除本机保存的 Token。本地的 Skills 文件不受影响。继续?')) return
    setBusy('disconnect')
    try {
      await fetch('/api/sync/config', { method: 'DELETE' })
      onDisconnect()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-sm text-green-400 font-medium">已连接</span>
          </div>
          <div className="text-base text-slate-100 font-semibold">
            {config.owner}/{config.name}
          </div>
          <a
            href={config.repoUrl || '#'}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-indigo-400 hover:text-indigo-300 underline"
          >
            {config.repoUrl}
          </a>
        </div>
        <div className="text-right text-[11px] text-slate-500 space-y-0.5">
          <div>默认分支: <span className="text-slate-400">{config.defaultBranch}</span></div>
          {config.lastValidatedAt && (
            <div>上次验证: <span className="text-slate-400">{formatTime(config.lastValidatedAt)}</span></div>
          )}
        </div>
      </div>

      {msg && (
        <div
          className={`p-3 rounded-lg text-sm border ${
            msg.kind === 'ok'
              ? 'bg-green-500/10 border-green-500/20 text-green-400'
              : 'bg-red-500/10 border-red-500/20 text-red-400'
          }`}
        >
          {msg.text}
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={revalidate}
          disabled={busy !== null}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded-lg text-sm text-slate-300 transition-all"
        >
          {busy === 'revalidate' ? '验证中...' : '重新验证'}
        </button>
        <button
          onClick={disconnect}
          disabled={busy !== null}
          className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 disabled:opacity-40 rounded-lg text-sm text-red-400 transition-all"
        >
          {busy === 'disconnect' ? '断开中...' : '断开连接'}
        </button>
      </div>

      <UploadSection />
      <DownloadSection />
    </div>
  )
}

// ------------------------- Upload section -------------------------

interface ScanFinding {
  file: string
  line: number
  column: number
  match: string
  kind: string
  severity: 'danger' | 'warn'
}

interface UploadPreview {
  localSkillCount: number
  syncableSkillCount: number
  excludedSkillCount: number
  skillChanges: {
    agent: string
    name: string
    vaultDir: string
    status: 'add' | 'update' | 'delete' | 'unchanged'
    filesAdded: number
    filesUpdated: number
    filesDeleted: number
    filesUnchanged: number
  }[]
  totals: {
    skillsAdded: number
    skillsUpdated: number
    skillsDeleted: number
    skillsUnchanged: number
    filesAdded: number
    filesUpdated: number
    filesDeleted: number
  }
  scan: { totalFindings: number; danger: number; warn: number; findings: ScanFinding[] }
  skippedFiles: { relPath: string; reason: string }[]
}

function UploadSection() {
  const [preview, setPreview] = useState<UploadPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [allowSecrets, setAllowSecrets] = useState(false)
  const [resultMsg, setResultMsg] = useState<string | null>(null)

  const openPreview = async () => {
    setLoading(true)
    setError(null)
    setPreview(null)
    setAllowSecrets(false)
    setResultMsg(null)
    try {
      const res = await fetch('/api/sync/upload/preview', { method: 'POST' })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || '预览失败')
        return
      }
      setPreview(data.preview)
    } catch (e: any) {
      setError(e?.message || '预览失败')
    } finally {
      setLoading(false)
    }
  }

  const confirmUpload = async () => {
    setConfirming(true)
    setError(null)
    try {
      const res = await fetch('/api/sync/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowSecrets }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || '上传失败')
        if (data.preview) setPreview(data.preview)
        return
      }
      setResultMsg(data.noop ? '没有需要上传的改动' : `上传成功 (${data.sha.slice(0, 7)})`)
      setPreview(null)
    } catch (e: any) {
      setError(e?.message || '上传失败')
    } finally {
      setConfirming(false)
    }
  }

  const t = preview?.totals
  const hasChanges = t ? t.skillsAdded + t.skillsUpdated + t.skillsDeleted > 0 : false
  const hasDanger = (preview?.scan.danger ?? 0) > 0

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-200 mb-1">上传到 GitHub</h3>
          <p className="text-xs text-slate-500">
            把本机所有 Skill(自动排除 marketplace/plugin)备份到仓库。先预览再确认。
          </p>
        </div>
        <button
          onClick={openPreview}
          disabled={loading}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-all shadow-lg shadow-indigo-600/20"
        >
          {loading ? '预览中...' : '预览上传'}
        </button>
      </div>

      {resultMsg && (
        <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
          ✓ {resultMsg}
        </div>
      )}

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      {preview && (
        <div className="space-y-3 pt-2">
          <div className="text-xs text-slate-400">
            本机共 <span className="text-slate-200 font-semibold">{preview.localSkillCount}</span> 个 Skill,
            其中{' '}
            <span className="text-slate-200 font-semibold">{preview.syncableSkillCount}</span> 个可同步,
            <span className="text-slate-600"> {preview.excludedSkillCount} 个已排除(marketplace/plugin)</span>。
          </div>

          {/* Totals */}
          <div className="grid grid-cols-4 gap-2">
            <Stat label="新增" value={t!.skillsAdded} color="green" />
            <Stat label="更新" value={t!.skillsUpdated} color="amber" />
            <Stat label="删除" value={t!.skillsDeleted} color="red" />
            <Stat label="未变" value={t!.skillsUnchanged} color="slate" />
          </div>

          {/* Secret scan */}
          {preview.scan.totalFindings > 0 && (
            <div
              className={`p-3 rounded-lg border text-xs ${
                hasDanger
                  ? 'bg-red-500/10 border-red-500/30 text-red-300'
                  : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
              }`}
            >
              <div className="font-medium mb-1.5">
                {hasDanger ? '⚠ 检测到疑似密钥' : '注意'}(
                {preview.scan.danger} 个敏感 / {preview.scan.warn} 个警告)
              </div>
              <div className="max-h-32 overflow-y-auto space-y-0.5 font-mono text-[11px] leading-snug">
                {preview.scan.findings.slice(0, 20).map((f, i) => (
                  <div key={i} className="truncate">
                    <span className={f.severity === 'danger' ? 'text-red-400' : 'text-amber-400'}>
                      [{f.kind}]
                    </span>{' '}
                    <span className="text-slate-400">{f.file}:{f.line}</span>{' '}
                    <span className="text-slate-500">— {f.match}</span>
                  </div>
                ))}
                {preview.scan.findings.length > 20 && (
                  <div className="text-slate-500">...还有 {preview.scan.findings.length - 20} 条</div>
                )}
              </div>
              {hasDanger && (
                <label className="flex items-center gap-2 mt-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allowSecrets}
                    onChange={(e) => setAllowSecrets(e.target.checked)}
                    className="w-3.5 h-3.5"
                  />
                  <span className="text-red-300">我已确认,这些是误报,继续上传</span>
                </label>
              )}
            </div>
          )}

          {/* Per-skill changes */}
          <div className="max-h-60 overflow-y-auto border border-slate-800 rounded-lg divide-y divide-slate-800/60">
            {preview.skillChanges
              .filter((c) => c.status !== 'unchanged')
              .map((c, i) => (
                <div key={i} className="px-3 py-2 text-xs flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusPill status={c.status} />
                    <span className="text-slate-300 truncate">{c.vaultDir}</span>
                  </div>
                  <div className="text-slate-500 text-[11px] shrink-0">
                    {c.filesAdded > 0 && <span className="text-green-400">+{c.filesAdded} </span>}
                    {c.filesUpdated > 0 && <span className="text-amber-400">~{c.filesUpdated} </span>}
                    {c.filesDeleted > 0 && <span className="text-red-400">-{c.filesDeleted}</span>}
                  </div>
                </div>
              ))}
            {!hasChanges && <div className="px-3 py-4 text-xs text-slate-500 text-center">仓库已是最新</div>}
          </div>

          {/* Confirm button */}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={confirmUpload}
              disabled={confirming || (hasDanger && !allowSecrets) || !hasChanges}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium text-white"
            >
              {confirming ? '上传中...' : hasChanges ? '确认上传' : '无变动'}
            </button>
            <button
              onClick={() => setPreview(null)}
              disabled={confirming}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded-lg text-sm text-slate-300"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color: 'green' | 'amber' | 'red' | 'slate' }) {
  const colors = {
    green: 'bg-green-500/10 text-green-400 border-green-500/20',
    amber: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    red: 'bg-red-500/10 text-red-400 border-red-500/20',
    slate: 'bg-slate-800/60 text-slate-400 border-slate-700',
  }
  return (
    <div className={`px-3 py-2 rounded-lg border ${colors[color]} text-center`}>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wider opacity-70">{label}</div>
    </div>
  )
}

// ------------------------- Download section -------------------------

type SkillState = 'remote_only' | 'local_only' | 'identical' | 'different'

interface SyncSkillRow {
  key: string
  agent: string
  name: string
  state: SkillState
  localPath: string | null
  localModifiedAt: string | null
  remoteModifiedAt: string | null
  filesInRemote: number
  filesInLocal: number
  filesDiffering: number
  excluded: boolean
  excludeReason: string | null
}

interface DownloadListing {
  vaultHead: string | null
  rows: SyncSkillRow[]
  totals: {
    remoteOnly: number
    localOnly: number
    identical: number
    different: number
    excluded: number
  }
}

type DownloadFilter = 'all' | 'remote_only' | 'different' | 'local_only'

function DownloadSection() {
  const [listing, setListing] = useState<DownloadListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<DownloadFilter>('all')
  const [applying, setApplying] = useState(false)
  const [resultMsg, setResultMsg] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    setResultMsg(null)
    try {
      const res = await fetch('/api/sync/download/listing')
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || '加载失败')
        return
      }
      setListing(data.listing)
      setSelected(new Set())
    } catch (e: any) {
      setError(e?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  const applySelected = async () => {
    setApplying(true)
    setError(null)
    try {
      const res = await fetch('/api/sync/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: Array.from(selected) }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || '下载失败')
        return
      }
      setResultMsg(`已下载 ${data.applied.length} 个 skill`)
      setConfirmOpen(false)
      await refresh()
    } catch (e: any) {
      setError(e?.message || '下载失败')
    } finally {
      setApplying(false)
    }
  }

  const visibleRows = (listing?.rows || []).filter((r) => {
    if (filter === 'all') return true
    if (filter === 'remote_only') return r.state === 'remote_only'
    if (filter === 'different') return r.state === 'different'
    if (filter === 'local_only') return r.state === 'local_only'
    return true
  })

  const selectableRows = visibleRows.filter(
    (r) => !r.excluded && (r.state === 'remote_only' || r.state === 'different'),
  )

  const allSelected = selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.key))

  const toggleAll = () => {
    const next = new Set(selected)
    if (allSelected) {
      for (const r of selectableRows) next.delete(r.key)
    } else {
      for (const r of selectableRows) next.add(r.key)
    }
    setSelected(next)
  }

  const toggleRow = (key: string) => {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSelected(next)
  }

  // Selected rows that would overwrite local content — used in confirm dialog
  const overwritingSelected = Array.from(selected)
    .map((k) => listing?.rows.find((r) => r.key === k))
    .filter((r): r is SyncSkillRow => !!r && r.state === 'different')

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-200 mb-1">从 GitHub 下载</h3>
          <p className="text-xs text-slate-500">
            查看仓库里有哪些 skill,勾选要下载的项。下载会覆盖本地同名 skill 的内容。
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded-lg text-sm text-slate-300"
        >
          {loading ? '加载中...' : listing ? '刷新列表' : '加载列表'}
        </button>
      </div>

      {resultMsg && (
        <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
          ✓ {resultMsg}
        </div>
      )}

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      {listing && (
        <>
          {/* Totals */}
          <div className="grid grid-cols-4 gap-2">
            <Stat label="仅仓库" value={listing.totals.remoteOnly} color="green" />
            <Stat label="两边不同" value={listing.totals.different} color="amber" />
            <Stat label="仅本地" value={listing.totals.localOnly} color="slate" />
            <Stat label="两边一致" value={listing.totals.identical} color="slate" />
          </div>

          {/* Filter tabs */}
          <div className="flex items-center gap-1 bg-slate-950 rounded-lg border border-slate-800 p-0.5 w-fit">
            {(
              [
                { value: 'all', label: '全部' },
                { value: 'remote_only', label: '仅新增' },
                { value: 'different', label: '有差异' },
                { value: 'local_only', label: '仅本地' },
              ] as { value: DownloadFilter; label: string }[]
            ).map((opt) => (
              <button
                key={opt.value}
                onClick={() => setFilter(opt.value)}
                className={`px-3 py-1 rounded-md text-xs transition-all ${
                  filter === opt.value
                    ? 'bg-slate-700 text-slate-200 shadow-sm'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Select all + action */}
          <div className="flex items-center justify-between text-xs">
            <label className="flex items-center gap-2 cursor-pointer text-slate-400">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                disabled={selectableRows.length === 0}
                className="w-3.5 h-3.5"
              />
              全选可下载 ({selectableRows.length})
            </label>
            <div className="text-slate-500">已选 {selected.size} 个</div>
          </div>

          {/* Table */}
          <div className="max-h-96 overflow-y-auto border border-slate-800 rounded-lg divide-y divide-slate-800/60">
            {visibleRows.length === 0 ? (
              <div className="px-3 py-6 text-xs text-slate-500 text-center">无匹配项</div>
            ) : (
              visibleRows.map((row) => (
                <DownloadRow
                  key={row.key}
                  row={row}
                  checked={selected.has(row.key)}
                  onToggle={() => toggleRow(row.key)}
                />
              ))
            )}
          </div>

          {/* Action */}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={applying || selected.size === 0}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium text-white"
            >
              {applying ? '下载中...' : `下载选中的 ${selected.size} 个`}
            </button>
          </div>
        </>
      )}

      {/* Confirm dialog */}
      {confirmOpen && listing && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-lg w-full p-6 space-y-4">
            <h3 className="text-base font-semibold text-slate-100">确认下载</h3>
            <p className="text-sm text-slate-400">
              即将下载 <span className="text-slate-200 font-semibold">{selected.size}</span> 个 skill 到本地。
            </p>
            {overwritingSelected.length > 0 && (
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs">
                <div className="font-medium mb-1">⚠ 以下 {overwritingSelected.length} 个 skill 在本机有未上传的修改,会被覆盖:</div>
                <ul className="space-y-0.5 max-h-32 overflow-y-auto">
                  {overwritingSelected.map((r) => (
                    <li key={r.key} className="truncate">
                      · {r.key}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={applySelected}
                disabled={applying}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg text-sm font-medium text-white"
              >
                {applying ? '下载中...' : '确认下载'}
              </button>
              <button
                onClick={() => setConfirmOpen(false)}
                disabled={applying}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm text-slate-300"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function DownloadRow({
  row,
  checked,
  onToggle,
}: {
  row: SyncSkillRow
  checked: boolean
  onToggle: () => void
}) {
  const selectable = !row.excluded && (row.state === 'remote_only' || row.state === 'different')
  return (
    <div
      className={`px-3 py-2 flex items-center gap-3 text-xs ${
        row.excluded || !selectable ? 'opacity-60' : ''
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={!selectable}
        className="w-3.5 h-3.5 shrink-0"
      />
      <StateBadge state={row.state} />
      <div className="flex-1 min-w-0">
        <div className="text-slate-300 truncate">{row.key}</div>
        {row.excluded && (
          <div className="text-[10px] text-slate-600">已排除 — {row.excludeReason}</div>
        )}
      </div>
      <div className="text-[10px] text-slate-600 shrink-0 text-right space-y-0.5">
        {row.state === 'different' && (
          <div className="text-amber-400/80">{row.filesDiffering} 个文件不同</div>
        )}
        {row.remoteModifiedAt && (
          <div>仓库: {formatShort(row.remoteModifiedAt)}</div>
        )}
        {row.localModifiedAt && <div>本地: {formatShort(row.localModifiedAt)}</div>}
      </div>
    </div>
  )
}

function StateBadge({ state }: { state: SkillState }) {
  const map: Record<SkillState, { label: string; cls: string }> = {
    remote_only: { label: '🆕 新增', cls: 'bg-green-500/15 text-green-400' },
    different: { label: '⚠ 不同', cls: 'bg-amber-500/15 text-amber-400' },
    local_only: { label: '📤 仅本地', cls: 'bg-slate-700/40 text-slate-400' },
    identical: { label: '✓ 一致', cls: 'bg-slate-800/60 text-slate-500' },
  }
  const m = map[state]
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium shrink-0 whitespace-nowrap ${m.cls}`}
    >
      {m.label}
    </span>
  )
}

function formatShort(iso: string): string {
  try {
    const d = new Date(iso)
    const now = Date.now()
    const diffMs = now - d.getTime()
    const h = Math.floor(diffMs / 3600_000)
    if (h < 1) return `${Math.floor(diffMs / 60_000)} 分钟前`
    if (h < 24) return `${h} 小时前`
    const days = Math.floor(h / 24)
    if (days < 30) return `${days} 天前`
    return d.toISOString().slice(0, 10)
  } catch {
    return iso
  }
}

function StatusPill({ status }: { status: 'add' | 'update' | 'delete' | 'unchanged' }) {
  const map = {
    add: { label: '新增', cls: 'bg-green-500/15 text-green-400' },
    update: { label: '更新', cls: 'bg-amber-500/15 text-amber-400' },
    delete: { label: '删除', cls: 'bg-red-500/15 text-red-400' },
    unchanged: { label: '未变', cls: 'bg-slate-700/40 text-slate-400' },
  }
  const m = map[status]
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${m.cls}`}>
      {m.label}
    </span>
  )
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}

function SettingsPanel() {
  const [customDir, setCustomDir] = useState('')
  const [githubToken, setGithubToken] = useState('')
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
          setGithubToken(data.settings.githubToken || '')
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
          githubToken: githubToken.trim(),
          httpProxy: httpProxy.trim(),
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setSuccess(true)
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
                onChange={(e) => setGithubToken(e.target.value)}
                placeholder="例如: ghp_xxxxxxxxxxxxxxxxxxxx"
                className="w-full text-sm placeholder:text-slate-500"
              />
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
    </div>
  )
}


