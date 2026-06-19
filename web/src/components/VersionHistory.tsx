import { useState, useEffect } from 'react'
import { DiffViewer } from './DiffViewer'

interface VersionMeta {
  id: string
  skillPath: string
  skillName: string
  timestamp: string
  message: string
  source: 'auto' | 'manual'
  contentHash: string
}

interface DiffResult {
  oldVersion: VersionMeta
  newVersion: VersionMeta
  lines: { type: 'add' | 'remove' | 'same'; lineNumber: { old?: number; new?: number }; content: string }[]
  stats: { additions: number; deletions: number; unchanged: number }
}

interface VersionHistoryProps {
  skillPath: string
  skillName: string
  onClose: () => void
  onRollback: () => void
}

export function VersionHistory({ skillPath, skillName, onClose, onRollback }: VersionHistoryProps) {
  const [history, setHistory] = useState<VersionMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [message, setMessage] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [selectedVersions, setSelectedVersions] = useState<string[]>([])
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null)
  const [rollbackLoading, setRollbackLoading] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const fetchHistory = async () => {
    setLoading(true)
    try {
      const url = `/api/versions/history?skillPath=${encodeURIComponent(skillPath)}`
      const res = await fetch(url)
      const data = await res.json()
      setHistory(data.history || [])
    } catch (e: any) {
      console.error('[VersionHistory] fetchHistory error:', e)
    }
    setLoading(false)
  }

  useEffect(() => {
    fetchHistory()
  }, [skillPath])

  const handleCreateSnapshot = async () => {
    if (!message.trim()) return
    setCreating(true)
    try {
      const res = await fetch('/api/versions/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillPath, skillName, message: message.trim() }),
      })
      const data = await res.json()
      if (data.ok) {
        showToast('快照已创建')
        setMessage('')
        setShowCreate(false)
        await fetchHistory()
      } else {
        showToast(`创建失败: ${data.error || '未知错误'}`)
      }
    } catch (e: any) {
      showToast(`请求失败: ${e.message}`)
    }
    setCreating(false)
  }

  const handleDiffWithCurrent = async (versionId: string) => {
    setDiffLoading(true)
    try {
      const res = await fetch(
        `/api/versions/diff-current?skillPath=${encodeURIComponent(skillPath)}&versionId=${versionId}`,
      )
      const data = await res.json()
      if (data.ok) setDiff(data.diff)
    } catch {}
    setDiffLoading(false)
  }

  const handleDiffBetween = async () => {
    if (selectedVersions.length !== 2) return
    setDiffLoading(true)
    try {
      const [oldId, newId] = selectedVersions
      const res = await fetch(
        `/api/versions/diff?skillPath=${encodeURIComponent(skillPath)}&oldId=${oldId}&newId=${newId}`,
      )
      const data = await res.json()
      if (data.ok) setDiff(data.diff)
    } catch {}
    setDiffLoading(false)
  }

  const handleRollback = async (versionId: string) => {
    setRollbackLoading(true)
    try {
      const res = await fetch('/api/versions/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillPath, versionId }),
      })
      const data = await res.json()
      if (data.ok) {
        showToast('已回滚成功')
        setRollbackTarget(null)
        await fetchHistory()
        onRollback()
      }
    } catch {}
    setRollbackLoading(false)
  }

  const toggleSelect = (id: string) => {
    setSelectedVersions((prev) => {
      if (prev.includes(id)) return prev.filter((v) => v !== id)
      if (prev.length >= 2) return [prev[1], id]
      return [...prev, id]
    })
  }

  return (
    <div className="w-full h-full bg-slate-900/10 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-800/80 flex items-center justify-between shrink-0">
        <div className="min-w-0 flex-1 mr-2">
          <h2 className="text-sm font-bold text-slate-100 flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-500">
              <circle cx="12" cy="12" r="3" /><path d="M12 3v6m0 6v6" /><path d="M3 12h6m6 0h6" />
            </svg>
            版本历史
          </h2>
          <p className="text-[10px] text-slate-500 mt-0.5 truncate">/{skillName}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {selectedVersions.length === 2 && (
            <button
              onClick={handleDiffBetween}
              disabled={diffLoading}
              className="px-2 py-1 bg-cyan-600/20 hover:bg-cyan-600/30 text-cyan-400 rounded-lg text-[10px] font-medium transition-all"
            >
              对比 ({selectedVersions.length})
            </button>
          )}
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="px-2 py-1 bg-indigo-600 disabled:opacity-50 text-[10px] cursor-pointer"
          >
            + 快照
          </button>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 p-1 rounded-lg hover:bg-slate-800">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="mx-4 mt-2 px-3 py-1.5 rounded-lg bg-green-500/10 text-green-400 text-xs shrink-0">
          {toast}
        </div>
      )}

      {/* Create snapshot form */}
      {showCreate && (
        <div className="mx-4 mt-2 p-3 bg-slate-950/30 rounded-lg border border-slate-800/60 shrink-0">
          <div className="flex gap-2">
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="版本描述"
              className="flex-1 text-xs placeholder:text-slate-400"
              onKeyDown={(e) => e.key === 'Enter' && handleCreateSnapshot()}
            />
            <button
              onClick={handleCreateSnapshot}
              disabled={creating || !message.trim()}
              className="px-3 py-1 bg-indigo-600 disabled:opacity-40 text-xs cursor-pointer"
            >
              {creating ? '...' : '保存'}
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-5 h-5 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
          </div>
        ) : history.length === 0 ? (
          <div className="text-center py-10">
            <div className="text-2xl mb-2">📦</div>
            <p className="text-slate-400 text-xs">暂无版本历史</p>
            <button
              onClick={() => setShowCreate(true)}
              className="text-blue-500 text-[11px] mt-1.5 hover:underline cursor-pointer"
            >
              点击创建首个快照
            </button>
          </div>
        ) : (
          <>
            {/* Timeline */}
            <div className="relative">
              {/* Timeline line */}
              <div className="absolute left-[15px] top-5 bottom-0 w-px bg-slate-800/60" />

              {history.map((v, i) => (
                <div key={v.id} className="relative flex gap-2 pb-3.5">
                  {/* Dot */}
                  <div
                    className={`relative z-10 w-8 h-8 rounded-full border flex items-center justify-center shrink-0 cursor-pointer transition-all
                      ${selectedVersions.includes(v.id)
                        ? 'border-cyan-400 bg-cyan-500/20'
                        : v.source === 'manual'
                        ? 'border-blue-500 bg-blue-500/10'
                        : 'border-slate-700 bg-slate-800'
                      }`}
                    onClick={() => toggleSelect(v.id)}
                    title="点击选中以对比"
                  >
                    <span className="text-[10px]">
                      {selectedVersions.includes(v.id)
                        ? selectedVersions.indexOf(v.id) + 1
                        : v.source === 'manual' ? '📌' : '⚡'}
                    </span>
                  </div>

                  {/* Card */}
                  <div className={`flex-1 rounded-lg border p-2.5 transition-all ${
                    selectedVersions.includes(v.id)
                      ? 'border-cyan-500/30 bg-cyan-500/5'
                      : 'border-slate-800/60 bg-slate-900/30 hover:bg-slate-900/60'
                  }`}>
                    <div className="flex items-start justify-between">
                      <div className="min-w-0 flex-1 mr-1.5">
                        <span className="text-xs text-slate-200 break-words block">{v.message}</span>
                        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                          <span className="text-[9px] text-slate-500 font-mono">{v.id.slice(0, 8)}</span>
                          <span className="text-[9px] text-slate-600">
                            {new Date(v.timestamp).toLocaleString('zh-CN')}
                          </span>
                          <span className={`text-[8px] px-1 rounded ${
                            v.source === 'manual'
                              ? 'bg-blue-500/10 text-blue-500'
                              : 'bg-slate-700/50 text-slate-500'
                          }`}>
                            {v.source === 'manual' ? '手动' : '自动'}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => handleDiffWithCurrent(v.id)}
                          className="px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-cyan-400 hover:bg-cyan-500/10 rounded transition-all"
                          title="与当前版本对比"
                        >
                          diff
                        </button>
                        {rollbackTarget === v.id ? (
                          <div className="flex gap-0.5">
                            <button
                              onClick={() => handleRollback(v.id)}
                              disabled={rollbackLoading}
                              className="px-1.5 py-0.5 text-[10px] text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded font-medium"
                            >
                              {rollbackLoading ? '...' : '确认'}
                            </button>
                            <button
                              onClick={() => setRollbackTarget(null)}
                              className="px-1 py-0.5 text-[10px] text-slate-400 hover:bg-slate-800 rounded"
                            >
                              x
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setRollbackTarget(v.id)}
                            className="px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-amber-400 hover:bg-amber-500/10 rounded transition-all"
                            title="回滚到此版本"
                          >
                            回滚
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Tip */}
            <div className="text-[10px] text-slate-600 text-center pt-1 shrink-0">
              提示：点击左侧圆圈选中两个版本进行对比
            </div>
          </>
        )}

        {/* Diff panel */}
        {diff && (
          <div className="mt-3 border-t border-slate-800/80 pt-3 shrink-0">
            <div className="flex items-center justify-between mb-1.5">
              <h3 className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">版本对比</h3>
              <button
                onClick={() => setDiff(null)}
                className="text-[10px] text-slate-500 hover:text-slate-300"
              >
                关闭
              </button>
            </div>
            <DiffViewer
              lines={diff.lines}
              stats={diff.stats}
              oldLabel={`${diff.oldVersion.message.slice(0, 10)}...`}
              newLabel={diff.newVersion.id === 'current' ? '当前' : `${diff.newVersion.message.slice(0, 10)}...`}
            />
          </div>
        )}
      </div>
    </div>
  )
}
