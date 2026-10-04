import { useCallback, useEffect, useState } from 'react'
import type { Skill } from '../hooks/useSkills'
import { ExportSection } from './sync/ExportSection'
import { ConnectForm, ConnectedPanel } from './sync/GitHubConnect'
import type { PublicSyncConfig } from './sync/GitHubConnect'
import { SettingsPanel } from './sync/SettingsPanel'
import { SymlinksManagePanel } from './sync/SymlinksManagePanel'

export interface SyncViewProps {
  allSkills: Skill[]
}

export function SyncView({ allSkills, initialTab }: SyncViewProps & { initialTab?: 'github' | 'symlinks' | 'settings' }) {
  const [tab, setTab] = useState<'github' | 'symlinks' | 'settings'>(initialTab ?? 'github')
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
