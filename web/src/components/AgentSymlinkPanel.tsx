import { useEffect, useState, useCallback } from 'react'

interface AgentStatus {
  id: string
  name: string
  icon: string
  enabled: boolean
  isRealLocation: boolean
  targetLinkPath: string
  globallyEnabled?: boolean
}

interface AgentSymlinkPanelProps {
  skillId: string
  skillName: string
  realPath: string
  onChanged?: () => void
}

export function AgentSymlinkPanel({ skillId, skillName, realPath, onChanged }: AgentSymlinkPanelProps) {
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [syncingId, setSyncingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const fetchStatus = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const query = `?realPath=${encodeURIComponent(realPath)}&name=${encodeURIComponent(skillName)}`
      const res = await fetch(`/api/skills/${skillId}/agents${query}`)
      const data = await res.json()
      if (data.ok) {
        setAgents(data.agents || [])
      } else {
        setError(data.error || '获取同步状态失败')
      }
    } catch (err: any) {
      setError(err.message || '网络请求错误')
    } finally {
      setLoading(false)
    }
  }, [skillId, skillName, realPath])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  const handleToggle = async (agent: AgentStatus) => {
    if (agent.isRealLocation || agent.globallyEnabled || syncingId) return

    setSyncingId(agent.id)
    setError(null)
    setSuccess(null)

    // Calculate new set of enabled agent IDs
    const currentEnabled = agents.filter((a) => a.enabled).map((a) => a.id)
    let nextEnabled: string[]
    if (agent.enabled) {
      nextEnabled = currentEnabled.filter((id) => id !== agent.id)
    } else {
      nextEnabled = [...currentEnabled, agent.id]
    }

    try {
      const res = await fetch(`/api/skills/${skillId}/agents/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          realPath,
          name: skillName,
          enabledAgentIds: nextEnabled,
        }),
      })
      const data = await res.json()
      if (data.ok) {
        const warning = (data.results || []).find((r: any) => !r.success)
        if (warning) {
          setError(warning.error || '同步过程中出现错误')
        } else {
          setSuccess(`已更新 /${skillName} 软链同步状态`)
          setTimeout(() => setSuccess(null), 3000)
        }
        await fetchStatus()
        if (onChanged) {
          onChanged() // Trigger rescan of local skills
        }
      } else {
        setError(data.error || '同步失败')
      }
    } catch (err: any) {
      setError(err.message || '同步请求网络失败')
    } finally {
      setSyncingId(null)
    }
  }

  if (loading) {
    return (
      <div className="space-y-2">
        <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-widest">多 IDE 软链接分发</h3>
        <div className="flex items-center gap-2 py-4 justify-center bg-slate-950/20 rounded-xl border border-slate-800/60">
          <div className="w-4 h-4 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
          <span className="text-xs text-slate-500">正在获取 IDE 同步状态...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-widest">多 IDE 软链接分发</h3>
      <div className="bg-slate-950/50 rounded-xl border border-slate-800/60 p-4 space-y-3">
        <p className="text-xs text-slate-500 leading-normal">
          勾选以软链接方式将此 Skill 挂载至对应 IDE。未勾选的 IDE 软链将被自动移除。
        </p>

        {error && (
          <div className="p-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
            ⚠️ {error}
          </div>
        )}

        {success && (
          <div className="p-2 rounded bg-green-500/10 border border-green-500/20 text-green-400 text-xs">
            ✓ {success}
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {agents.map((agent) => {
            const isSyncing = syncingId === agent.id
            const canInteractive = !agent.isRealLocation && !agent.globallyEnabled && !isSyncing

            return (
              <div
                key={agent.id}
                onClick={() => canInteractive && handleToggle(agent)}
                className={`px-3 py-2.5 rounded border flex items-center justify-between text-xs transition-all relative select-none ${
                  agent.isRealLocation
                    ? 'border-blue-500/20 bg-blue-500/5 text-slate-200 cursor-not-allowed'
                    : agent.globallyEnabled
                    ? 'border-blue-500/20 bg-blue-500/5 text-slate-200 cursor-not-allowed'
                    : agent.enabled
                    ? 'border-blue-500 bg-blue-500/10 text-slate-100 hover:bg-blue-500/15 cursor-pointer'
                    : 'border-slate-800 hover:border-slate-700 bg-slate-950/40 text-slate-400 hover:text-slate-200 cursor-pointer'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-base shrink-0">{agent.icon}</span>
                  <span className="font-medium truncate">{agent.name}</span>
                </div>

                <div className="flex items-center ml-2 shrink-0">
                  {isSyncing ? (
                    <div className="w-3.5 h-3.5 border border-slate-600 border-t-white rounded-full animate-spin" />
                  ) : agent.isRealLocation ? (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-500 font-semibold uppercase tracking-wider">
                      本体
                    </span>
                  ) : agent.globallyEnabled ? (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-semibold uppercase tracking-wider">
                      全局共享
                    </span>
                  ) : (
                    <input
                      type="checkbox"
                      checked={agent.enabled}
                      disabled={!canInteractive}
                      onChange={() => {}} // Controlled by outer div onClick
                      className="w-3.5 h-3.5 rounded border-slate-700 bg-slate-950 text-blue-500 focus:ring-blue-500/30 cursor-pointer"
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
