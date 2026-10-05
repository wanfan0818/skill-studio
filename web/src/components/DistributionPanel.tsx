import { useCallback, useEffect, useMemo, useState } from 'react'

type Mode = 'all' | 'global' | 'off'
type ActionType = 'link' | 'relink' | 'copy' | 'update' | 'unlink' | 'legacy' | 'conflict'

interface AgentRow {
  id: string
  name: string
  icon: string
  dirs: string[]
  exists: boolean
  symlinkCount: number
  realCount: number
  rule: { mode: Mode; include?: string[]; exclude?: string[] } | null
  linkMode?: 'symlink' | 'copy'
  desired: number
  satisfied: number
  sharedDirWith: string[]
}

interface PlanAction {
  id: string
  type: ActionType
  name: string
  dir: string
  linkPath: string
  target?: string
  current?: string
  agentIds: string[]
  reason: string
}

interface Plan {
  actions: PlanAction[]
  counts: Record<ActionType, number>
  warnings: string[]
  warehouses: string[]
  sourceCount: number
  fingerprint: string
}

const MODE_LABEL: Record<string, string> = {
  unmanaged: '未托管',
  all: '全部仓库 Skill',
  global: '仅全局集',
  off: '关闭',
}

const TYPE_META: Record<ActionType, { label: string; cls: string }> = {
  link: { label: '新增链接', cls: 'text-emerald-400' },
  relink: { label: '重新指向', cls: 'text-sky-400' },
  copy: { label: '新增副本', cls: 'text-emerald-400' },
  update: { label: '更新副本', cls: 'text-sky-400' },
  unlink: { label: '移除链接', cls: 'text-amber-400' },
  legacy: { label: '旧版遗留', cls: 'text-violet-400' },
  conflict: { label: '冲突（不处理）', cls: 'text-red-400' },
}

/** Fired whenever distribution state or disk changed, so badges can refresh. */
export const DISTRIBUTION_CHANGED = 'skill-studio:distribution-changed'
const announce = () => window.dispatchEvent(new Event(DISTRIBUTION_CHANGED))

export function DistributionPanel({ onApplied }: { onApplied?: () => void }) {
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyAgent, setBusyAgent] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [includeLegacy, setIncludeLegacy] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [showAllAgents, setShowAllAgents] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [d, p] = await Promise.all([
        fetch('/api/distribution').then((r) => r.json()),
        fetch('/api/distribution/plan').then((r) => r.json()),
      ])
      if (d.ok) setAgents(d.agents)
      if (p.ok) setPlan(p.plan)
      if (!d.ok || !p.ok) setNotice({ kind: 'err', text: d.error || p.error || '读取分发状态失败' })
    } catch (err: any) {
      setNotice({ kind: 'err', text: '读取分发状态失败: ' + err.message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const setMode = async (agentId: string, value: string) => {
    setBusyAgent(agentId)
    setNotice(null)
    try {
      const res = await fetch(`/api/distribution/agents/${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: value === 'unmanaged' ? null : value }),
      })
      const data = await res.json()
      if (!data.ok) setNotice({ kind: 'err', text: data.error || '保存失败' })
      await refresh()
      announce()
    } finally {
      setBusyAgent(null)
    }
  }

  const applicable = plan
    ? plan.counts.link + plan.counts.relink + plan.counts.copy + plan.counts.update + plan.counts.unlink + (includeLegacy ? plan.counts.legacy : 0)
    : 0

  const handleApply = async () => {
    if (!plan || applicable === 0) return
    setApplying(true)
    setNotice(null)
    try {
      const res = await fetch('/api/distribution/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint: plan.fingerprint, includeLegacy }),
      })
      const data = await res.json()
      if (res.status === 409) {
        setNotice({ kind: 'err', text: '磁盘状态已变化，已刷新预览，请确认后再应用。' })
      } else if (data.ok) {
        setNotice({ kind: 'ok', text: `已应用 ${data.applied} 项变更。` })
        setIncludeLegacy(false)
        onApplied?.()
      } else {
        const firstErr = (data.results || []).find((r: any) => !r.ok)
        setNotice({ kind: 'err', text: `应用 ${data.applied ?? 0} 项，失败 ${data.failed ?? '?'} 项${firstErr ? `：${firstErr.error}` : ''}` })
      }
      await refresh()
      announce()
    } catch (err: any) {
      setNotice({ kind: 'err', text: '应用失败: ' + err.message })
    } finally {
      setApplying(false)
    }
  }

  const visibleAgents = useMemo(() => {
    const relevant = agents.filter((a) => a.rule || a.exists)
    return showAllAgents ? agents : relevant
  }, [agents, showAllAgents])

  const grouped = useMemo(() => {
    const out: Partial<Record<ActionType, PlanAction[]>> = {}
    for (const a of plan?.actions ?? []) (out[a.type] ??= []).push(a)
    return out
  }, [plan])

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id

  if (loading && !plan) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="w-8 h-8 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Plan */}
      <div className="bg-slate-900/40 border border-slate-800/80 rounded-xl p-5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-300">分发计划</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              修改下方规则不会立即改动磁盘；确认变更后点击应用。只会创建 / 移除指向仓库的软链接，真实目录永远不会被改动。
            </p>
          </div>
          <button
            onClick={handleApply}
            disabled={applying || applicable === 0}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs font-semibold text-white shrink-0"
          >
            {applying ? '正在应用…' : applicable === 0 ? '已与规则一致' : `应用 ${applicable} 项变更`}
          </button>
        </div>

        {plan && (
          <div className="flex flex-wrap gap-2 text-[11px]">
            {(Object.keys(TYPE_META) as ActionType[]).map((t) => (
              <span key={t} className="px-2 py-1 rounded bg-slate-950/50 border border-slate-800/60">
                <span className={TYPE_META[t].cls}>{TYPE_META[t].label}</span>{' '}
                <span className="font-bold tabular-nums text-slate-200">{plan.counts[t]}</span>
              </span>
            ))}
            {plan.actions.length > 0 && (
              <button onClick={() => setShowDetails((v) => !v)} className="px-2 py-1 text-slate-400 hover:text-slate-200 cursor-pointer">
                {showDetails ? '收起明细' : '查看明细'}
              </button>
            )}
          </div>
        )}

        {plan && plan.counts.legacy > 0 && (
          <label className="flex items-start gap-2 text-[11px] text-slate-400 select-none">
            <input type="checkbox" checked={includeLegacy} onChange={(e) => setIncludeLegacy(e.target.checked)} className="mt-0.5" />
            <span>
              同时清理 {plan.counts.legacy} 个旧版遗留链接（旧版本创建的交叉链接：指向项目私有 Skill、其它 Agent 目录，或已悬空）。只删除链接本身。
            </span>
          </label>
        )}

        {showDetails && plan && (
          <div className="border border-slate-800/60 rounded-lg max-h-72 overflow-y-auto divide-y divide-slate-800/40 bg-slate-950/20">
            {(Object.keys(TYPE_META) as ActionType[]).flatMap((t) =>
              (grouped[t] ?? []).slice(0, 300).map((a) => (
                <div key={a.id} className="px-3 py-1.5 text-[11px] font-mono flex items-center gap-3">
                  <span className={`shrink-0 w-16 ${TYPE_META[t].cls}`}>{TYPE_META[t].label.slice(0, 4)}</span>
                  <span className="text-slate-200 truncate">/{a.name}</span>
                  <span className="text-slate-500 truncate flex-1" title={a.linkPath}>
                    {a.agentIds.map(agentName).join(' · ')} — {a.reason}
                  </span>
                </div>
              )),
            )}
          </div>
        )}

        {plan && plan.warnings.length > 0 && (
          <ul className="text-[11px] text-amber-400/90 space-y-0.5 list-disc pl-4">
            {plan.warnings.slice(0, 8).map((w) => (
              <li key={w}>{w}</li>
            ))}
            {plan.warnings.length > 8 && <li>…另有 {plan.warnings.length - 8} 条</li>}
          </ul>
        )}

        {notice && (
          <div className={`text-xs px-3 py-2 rounded-lg ${notice.kind === 'ok' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}>
            {notice.text}
          </div>
        )}
      </div>

      {/* Rules */}
      <div className="bg-slate-900/40 border border-slate-800/80 rounded-xl p-5 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-300">IDE 分发规则</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            来源仓库（{plan?.sourceCount ?? 0} 个 Skill）：{plan?.warehouses.join('、') || '未配置'}。「未托管」的 IDE 目录不会被触碰。
          </p>
        </div>
        <div className="space-y-2 max-h-[28rem] overflow-y-auto">
          {visibleAgents.map((a) => {
            const mode = a.rule?.mode ?? 'unmanaged'
            return (
              <div key={a.id} className="bg-slate-950/40 border border-slate-800/50 rounded-xl p-3 flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-base shrink-0">{a.icon}</span>
                    <span className="font-semibold text-slate-200 text-xs truncate">{a.name}</span>
                    {a.linkMode === 'copy' && (
                      <span
                        className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-500/10 text-amber-300 border border-amber-500/20"
                        title="该 IDE 不识别软链接，分发为真实副本；仓库更新时自动刷新，在 IDE 内被修改过的副本不会被覆盖"
                      >
                        复制模式
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-slate-500 truncate" title={a.dirs.join('\n')}>
                    {a.dirs[0] ?? '（无账号目录）'}
                  </div>
                  <div className="flex flex-wrap gap-3 mt-1.5 text-[10px] text-slate-400">
                    {a.rule && (
                      <span>
                        已就绪 <b className="text-indigo-300 tabular-nums">{a.satisfied}</b>/<span className="tabular-nums">{a.desired}</span>
                      </span>
                    )}
                    <span>软链 {a.symlinkCount}</span>
                    <span className={a.realCount ? 'text-red-400' : ''}>物理 {a.realCount}</span>
                    {!!a.rule?.include?.length && <span>额外包含 {a.rule.include.length}</span>}
                    {!!a.rule?.exclude?.length && <span>排除 {a.rule.exclude.length}</span>}
                    {a.sharedDirWith.length > 0 && <span className="text-amber-400/80">与 {a.sharedDirWith.map(agentName).join('、')} 共用同一目录</span>}
                  </div>
                </div>
                <select
                  value={mode}
                  disabled={busyAgent !== null}
                  onChange={(e) => setMode(a.id, e.target.value)}
                  className="text-xs text-slate-300 shrink-0"
                >
                  {Object.entries(MODE_LABEL).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>
        <button onClick={() => setShowAllAgents((v) => !v)} className="text-[11px] text-slate-500 hover:text-slate-300 cursor-pointer">
          {showAllAgents ? '只显示已托管或已安装的 IDE' : `显示全部 ${agents.length} 个 IDE`}
        </button>
      </div>
    </div>
  )
}
