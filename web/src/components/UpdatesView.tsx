import { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * 版本与更新: is every skill, and every copy of it, on the same version?
 * The warehouse is the single source; symlinks follow it automatically,
 * copies (IDEs that don't read symlinks) and GitHub upstreams can drift.
 */

type State = 'synced' | 'upstream' | 'local-edited' | 'conflict'

interface CopyState {
  path: string
  where: string
  projectPath?: string
  status: 'stale' | 'edited'
}

interface SkillVersion {
  name: string
  path: string
  description?: string
  kind: 'github' | 'local'
  state: State
  baselineAt?: string
  source?: {
    repo: string
    branch?: string
    subPath?: string
    installedCommit?: string
    latestCommit?: string
    installedTree?: string
    latestTree?: string
    missing: boolean
    noAccess: boolean
    lastChecked?: string
  }
  copies: CopyState[]
}

interface Report {
  skills: SkillVersion[]
  counts: Record<State, number> & { github: number; local: number; staleCopies: number; editedCopies: number; upstreamMissing: number; noAccess: number }
  warnings: string[]
}

type Filter = 'todo' | 'github' | 'local' | 'all'

const STATE_META: Record<State, { label: string; cls: string }> = {
  synced: { label: '✅ 已同步', cls: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' },
  upstream: { label: '🟡 可更新', cls: 'text-amber-300 border-amber-500/30 bg-amber-500/10' },
  'local-edited': { label: '🟠 本地已改', cls: 'text-orange-300 border-orange-500/30 bg-orange-500/10' },
  conflict: { label: '🔴 冲突', cls: 'text-rose-300 border-rose-500/30 bg-rose-500/10' },
}

const short = (c?: string) => (c ? c.slice(0, 7) : '—')
const needsAttention = (s: SkillVersion) => s.state !== 'synced' || s.copies.length > 0 || !!s.source?.missing
/** Version shown to the user: folder tree SHA when known, else commit. */
const installedOf = (src: NonNullable<SkillVersion['source']>) => src.installedTree ?? src.installedCommit
const latestOf = (src: NonNullable<SkillVersion['source']>) => src.latestTree ?? src.latestCommit

function when(iso?: string) {
  if (!iso) return '从未'
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function post(url: string, body: unknown = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败（${res.status}）`)
  return data
}

export function UpdatesView({ onChanged, onCountChange }: { onChanged?: () => void; onCountChange?: (n: number) => void }) {
  const [report, setReport] = useState<Report | null>(null)
  const [filter, setFilter] = useState<Filter>('todo')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [binding, setBinding] = useState<{ name: string; url: string } | null>(null)

  const apply = useCallback(
    (r: Report) => {
      setReport(r)
      onCountChange?.(r.skills.filter(needsAttention).length)
    },
    [onCountChange],
  )

  const load = useCallback(async () => {
    const res = await fetch('/api/updates')
    const data = await res.json()
    if (data.ok) apply(data)
  }, [apply])

  useEffect(() => {
    load().catch((e) => setMessage({ kind: 'err', text: String(e?.message || e) }))
  }, [load])

  /** Run an action; it returns the fresh report. */
  const run = async (key: string, fn: () => Promise<any>, ok?: (d: any) => string) => {
    setBusy(key)
    setMessage(null)
    try {
      const data = await fn()
      if (data.report) apply(data.report)
      if (ok) setMessage({ kind: 'ok', text: ok(data) })
      onChanged?.()
    } catch (e: any) {
      setMessage({ kind: 'err', text: e?.message || String(e) })
    } finally {
      setBusy(null)
    }
  }

  const visible = useMemo(() => {
    if (!report) return []
    const term = q.trim().toLowerCase()
    return report.skills.filter(
      (s) =>
        (filter === 'all' || (filter === 'todo' ? needsAttention(s) : s.kind === filter)) &&
        (!term || s.name.toLowerCase().includes(term) || s.source?.repo.toLowerCase().includes(term)),
    )
  }, [report, filter, q])

  if (!report) {
    return <div className="text-xs text-slate-500 py-10 text-center">正在读取版本状态…</div>
  }

  const c = report.counts
  const todo = report.skills.filter(needsAttention).length
  const lastChecked = report.skills
    .map((s) => s.source?.lastChecked)
    .filter(Boolean)
    .sort()
    .pop()

  return (
    <div className="space-y-4 max-w-5xl">
      {/* Summary */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-slate-100">
              {todo === 0 ? '全部一致 ✅' : `${todo} 个 Skill 需要处理`}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              仓库是唯一真实源：软链接自动跟随仓库；副本和 GitHub 上游可能不一致，在这里统一处理。GitHub 上次检查：{when(lastChecked)}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              disabled={!!busy || c.github === 0}
              onClick={() => run('check', () => post('/api/updates/check'), (d) => `已检查 ${d.checked} 个 GitHub Skill，${d.withUpdates} 个有新版本${d.errors?.length ? `，${d.errors.length} 个检查失败（${d.errors[0].name}: ${d.errors[0].error}）` : ''}`)}
              className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-40 cursor-pointer"
            >
              {busy === 'check' ? '检查中…' : '检查 GitHub 更新'}
            </button>
            <button
              disabled={!!busy || c.upstream === 0}
              onClick={() =>
                run('update-all', () => post('/api/updates/update'), (d) =>
                  [
                    `已更新 ${d.updated.length} 个`,
                    d.copiesRefreshed ? `刷新副本 ${d.copiesRefreshed} 个` : '',
                    d.skipped.length ? `跳过 ${d.skipped.length} 个本地有修改的（需要你逐个决定）` : '',
                    d.failed.length ? `失败 ${d.failed.length} 个：${d.failed[0].name} — ${d.failed[0].error}` : '',
                  ]
                    .filter(Boolean)
                    .join('，'),
                )
              }
              className="px-3 py-1.5 rounded-lg bg-indigo-600 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-40 cursor-pointer"
              title="只更新本地没有修改的 Skill；本地改过的不会被覆盖"
            >
              {busy === 'update-all' ? '更新中…' : `一键更新${c.upstream ? `（${c.upstream}）` : ''}`}
            </button>
            <button
              disabled={!!busy || c.staleCopies === 0}
              onClick={() => run('refresh', () => post('/api/updates/refresh-copies'), (d) => `已刷新 ${d.refreshed} 个副本${d.failed ? `，${d.failed} 个失败` : ''}`)}
              className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-40 cursor-pointer"
            >
              {busy === 'refresh' ? '刷新中…' : `刷新副本${c.staleCopies ? `（${c.staleCopies}）` : ''}`}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px]">
          <Chip cls="text-slate-300 border-slate-700">共 {report.skills.length} 个 · GitHub {c.github} · 本地创作 {c.local}</Chip>
          <Chip cls={STATE_META.synced.cls}>已同步 {c.synced}</Chip>
          <Chip cls={STATE_META.upstream.cls}>可更新 {c.upstream}</Chip>
          <Chip cls={STATE_META['local-edited'].cls}>本地已改 {c['local-edited']}</Chip>
          <Chip cls={STATE_META.conflict.cls}>冲突 {c.conflict}</Chip>
          <Chip cls="text-sky-300 border-sky-500/30 bg-sky-500/10">副本待刷新 {c.staleCopies}</Chip>
          <Chip cls="text-rose-300 border-rose-500/30 bg-rose-500/10">副本被单独修改 {c.editedCopies}</Chip>
          {c.upstreamMissing > 0 && <Chip cls="text-slate-300 border-slate-600 bg-slate-800">上游已移除 {c.upstreamMissing}</Chip>}
          {c.noAccess > 0 && (
            <span title="私有仓库需要在设置里填一个能访问它的 GitHub Token；也可能仓库已被删除">
              <Chip cls="text-slate-400 border-slate-700">🔒 无法访问仓库 {c.noAccess}</Chip>
            </span>
          )}
        </div>
        {message && (
          <div className={`text-xs rounded-lg px-3 py-2 border ${message.kind === 'ok' ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' : 'text-rose-300 border-rose-500/30 bg-rose-500/10'}`}>
            {message.text}
          </div>
        )}
        {report.warnings.length > 0 && <div className="text-[11px] text-amber-300/80">{report.warnings.join('；')}</div>}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ['todo', `需要处理（${todo}）`],
            ['github', `GitHub（${c.github}）`],
            ['local', `本地创作（${c.local}）`],
            ['all', `全部（${report.skills.length}）`],
          ] as [Filter, string][]
        ).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setFilter(v)}
            className={`px-3 py-1 rounded-full text-xs border cursor-pointer ${filter === v ? 'border-indigo-500 bg-indigo-500/20 text-indigo-200' : 'border-slate-800 text-slate-400 hover:text-slate-200'}`}
          >
            {label}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索 Skill 或仓库…"
          className="ml-auto w-56 px-3 py-1 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500"
        />
      </div>

      {/* List */}
      {visible.length === 0 ? (
        <div className="text-xs text-slate-500 py-10 text-center">{filter === 'todo' ? '没有需要处理的 Skill，所有地方版本一致 ✅' : '没有匹配的 Skill'}</div>
      ) : (
        <div className="space-y-2">
          {visible.map((s) => (
            <div key={s.name} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 space-y-2">
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm text-slate-100">{s.name}</span>
                    {s.kind === 'github' ? (
                      <span className="text-[10px] text-slate-400 font-mono">
                        {s.source!.repo}
                        {s.source!.subPath ? `/${s.source!.subPath}` : ''}
                      </span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-slate-700 text-slate-400">本地创作</span>
                    )}
                    {s.kind === 'github' && !s.source!.missing && !s.source!.noAccess && <Chip cls={STATE_META[s.state].cls}>{STATE_META[s.state].label}</Chip>}
                    {s.source?.missing && <Chip cls="text-slate-300 border-slate-600 bg-slate-800">⚪ 上游已移除</Chip>}
                    {s.source?.noAccess && <Chip cls="text-slate-400 border-slate-700">🔒 无法访问仓库</Chip>}
                  </div>
                  {s.kind === 'github' && (
                    <div className="text-[11px] text-slate-500 mt-1">
                      {s.source!.missing
                        ? '上游仓库里已经找不到这个目录（被删除、改名或移走了），没有可更新的版本。可以解除来源，作为本地创作继续用'
                        : s.source!.noAccess
                          ? '读不到这个仓库：如果是私有仓库，需要在设置里填一个有权限的 GitHub Token；也可能仓库已被删除'
                          : installedOf(s.source!)
                          ? `当前 ${short(installedOf(s.source!))}`
                          : '当前版本未知（更新时现在的版本会放进回收站）'}
                      {!s.source!.missing && !s.source!.noAccess && latestOf(s.source!) && latestOf(s.source!) !== installedOf(s.source!) ? ` → 上游最新 ${short(latestOf(s.source!))}` : ''}
                      {' · '}上次检查 {when(s.source!.lastChecked)}
                      {s.state === 'local-edited' && ' · 仓库里的内容自安装/上次更新后被改过'}
                      {s.state === 'conflict' && ' · 你改过本地，上游也有新版本'}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {s.state === 'upstream' && (
                    <Btn primary busy={busy === `u:${s.name}`} disabled={!!busy} onClick={() => run(`u:${s.name}`, () => post('/api/updates/update', { names: [s.name] }), () => `${s.name} 已更新到上游最新版本`)}>
                      更新
                    </Btn>
                  )}
                  {(s.state === 'local-edited' || s.state === 'conflict') && (
                    <>
                      <Btn
                        busy={busy === `k:${s.name}`}
                        disabled={!!busy}
                        onClick={() => run(`k:${s.name}`, () => post('/api/updates/keep-local', { name: s.name }), () => `已保留 ${s.name} 的本地修改${s.state === 'conflict' ? '，并忽略这次上游更新' : ''}`)}
                      >
                        保留本地修改
                      </Btn>
                      <Btn
                        danger
                        busy={busy === `f:${s.name}`}
                        disabled={!!busy}
                        onClick={() => {
                          if (!confirm(`用 GitHub 上游版本替换「${s.name}」？\n你的本地修改会放进回收站，可以从回收站恢复。`)) return
                          run(`f:${s.name}`, () => post('/api/updates/update', { names: [s.name], force: true }), () => `${s.name} 已替换为上游版本，原版本在回收站`)
                        }}
                      >
                        {s.state === 'conflict' ? '用上游覆盖' : '还原为上游版本'}
                      </Btn>
                    </>
                  )}
                  {s.source?.missing && (
                    <Btn
                      busy={busy === `x:${s.name}`}
                      disabled={!!busy}
                      onClick={() => run(`x:${s.name}`, () => post('/api/updates/unbind', { name: s.name }), () => `${s.name} 已解除 GitHub 来源，之后作为本地创作管理`)}
                    >
                      解除来源
                    </Btn>
                  )}
                  {s.kind === 'local' && binding?.name !== s.name && (
                    <Btn disabled={!!busy} onClick={() => setBinding({ name: s.name, url: '' })} title="这个 Skill 其实来自 GitHub？绑定后就能检查和一键更新">
                      绑定 GitHub 来源
                    </Btn>
                  )}
                </div>
              </div>

              {binding?.name === s.name && (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    autoFocus
                    value={binding.url}
                    onChange={(e) => setBinding({ name: s.name, url: e.target.value })}
                    placeholder="owner/repo 或 https://github.com/owner/repo/tree/main/子目录"
                    className="flex-1 min-w-[280px] px-3 py-1 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-200 outline-none focus:border-indigo-500"
                  />
                  <Btn
                    primary
                    busy={busy === `b:${s.name}`}
                    disabled={!!busy || !binding.url.trim()}
                    onClick={() =>
                      run(`b:${s.name}`, () => post('/api/updates/bind', { name: s.name, url: binding.url.trim() }), () => {
                        setBinding(null)
                        return `${s.name} 已绑定来源。当前版本和上游的对应关系未知，更新时会把现在的版本放进回收站`
                      })
                    }
                  >
                    绑定
                  </Btn>
                  <Btn onClick={() => setBinding(null)}>取消</Btn>
                </div>
              )}

              {s.copies.length > 0 && (
                <div className="border-t border-slate-800 pt-2 space-y-1.5">
                  {s.copies.map((cp) => (
                    <div key={cp.path} className="flex flex-wrap items-center gap-2 text-[11px]">
                      <span className={cp.status === 'stale' ? 'text-sky-300' : 'text-rose-300'}>{cp.status === 'stale' ? '副本待刷新' : '副本被单独修改'}</span>
                      <span className="text-slate-300">{cp.where}</span>
                      <span className="text-slate-600 font-mono truncate max-w-[360px]" title={cp.path}>
                        {cp.path}
                      </span>
                      <span className="ml-auto flex gap-1.5">
                        {cp.status === 'stale' ? (
                          <Btn busy={busy === `r:${cp.path}`} disabled={!!busy} onClick={() => run(`r:${cp.path}`, () => post('/api/updates/refresh-copies', { names: [s.name] }), () => `${s.name} 的副本已刷新`)}>
                            刷新
                          </Btn>
                        ) : (
                          <>
                            <Btn
                              busy={busy === `p:${cp.path}`}
                              disabled={!!busy}
                              onClick={() => {
                                if (!confirm(`把 ${cp.where} 里对「${s.name}」的修改收回到仓库？\n仓库里的原版本会放进回收站，其他 IDE 的副本也会同步成新版本。`)) return
                                run(`p:${cp.path}`, () => post('/api/updates/copy', { path: cp.path, action: 'pull-back' }), () => `已把修改收回仓库，所有地方都是同一个版本了`)
                              }}
                            >
                              收回到仓库
                            </Btn>
                            <Btn
                              danger
                              busy={busy === `o:${cp.path}`}
                              disabled={!!busy}
                              onClick={() => {
                                if (!confirm(`用仓库版本覆盖 ${cp.where} 里的「${s.name}」？\n这个副本里的修改会放进回收站。`)) return
                                run(`o:${cp.path}`, () => post('/api/updates/copy', { path: cp.path, action: 'overwrite' }), () => `已用仓库版本覆盖，修改过的副本在回收站`)
                              }}
                            >
                              用仓库覆盖
                            </Btn>
                          </>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Chip({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`px-2 py-0.5 rounded-full border text-[11px] ${cls}`}>{children}</span>
}

function Btn({
  children,
  onClick,
  disabled,
  busy,
  primary,
  danger,
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  busy?: boolean
  primary?: boolean
  danger?: boolean
  title?: string
}) {
  const cls = primary
    ? 'bg-indigo-600 text-white hover:bg-indigo-500 border-indigo-500'
    : danger
      ? 'border-rose-500/40 text-rose-300 hover:bg-rose-500/10'
      : 'border-slate-700 text-slate-300 hover:bg-slate-800'
  return (
    <button title={title} disabled={disabled} onClick={onClick} className={`px-2.5 py-1 rounded-md border text-[11px] disabled:opacity-40 cursor-pointer ${cls}`}>
      {busy ? '处理中…' : children}
    </button>
  )
}
