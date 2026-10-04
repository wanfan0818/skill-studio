
export function Stat({ label, value, color }: { label: string; value: number; color: 'green' | 'amber' | 'red' | 'slate' }) {
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

export function StatusPill({ status }: { status: 'add' | 'update' | 'delete' | 'unchanged' }) {
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

export function formatShort(iso: string): string {
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

export function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}
