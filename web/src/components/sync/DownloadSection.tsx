import { useState } from 'react'
import { Stat, formatShort } from './shared'

export type SkillState = 'remote_only' | 'local_only' | 'identical' | 'different'

export interface SyncSkillRow {
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

export interface DownloadListing {
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

export type DownloadFilter = 'all' | 'remote_only' | 'different' | 'local_only'

export function DownloadSection() {
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

export function DownloadRow({
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

export function StateBadge({ state }: { state: SkillState }) {
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
