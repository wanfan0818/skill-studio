import { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * Skill 体检: is each skill packaged so IDEs load and route it correctly, and
 * is each IDE loading a set of skills it can still route between?
 */

type Severity = 'error' | 'warn' | 'info'
type Level = 'green' | 'yellow' | 'red'
type Mode = 'all' | 'global' | 'off' | null

interface Issue {
  code: string
  severity: Severity
  message: string
  hint?: string
}

interface SkillCheck {
  name: string
  path: string
  realPath: string
  routingTokens: number
  skillMdLines: number
  issues: Issue[]
}

interface IdeSkill {
  name: string
  tokens: number
  managed: boolean
  projects: string[]
}

interface IdeLoad {
  id: string
  name: string
  icon: string
  dirs: string[]
  count: number
  tokens: number
  level: Level
  mode: Mode
  skills: IdeSkill[]
}

interface Report {
  ides: IdeLoad[]
  skills: SkillCheck[]
  counts: { error: number; warn: number; info: number; skillsWithProblems: number; overloadedIdes: number }
}

interface Preview {
  remove: string[]
  add: string[]
  conflicts: number
  fingerprint: string
}

const LEVEL: Record<Level, { label: string; cls: string; bar: string }> = {
  green: { label: '负载正常', cls: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10', bar: 'bg-emerald-500' },
  yellow: { label: '偏多', cls: 'text-amber-300 border-amber-500/30 bg-amber-500/10', bar: 'bg-amber-500' },
  red: { label: '过载', cls: 'text-rose-300 border-rose-500/30 bg-rose-500/10', bar: 'bg-rose-500' },
}
const levelOf = (n: number): Level => (n <= 20 ? 'green' : n <= 50 ? 'yellow' : 'red')

const MODE_LABEL: Record<string, string> = { all: '仓库全部分发', global: '精选', off: '关闭', null: '未托管' }

const SEV: Record<Severity, { icon: string; cls: string; label: string }> = {
  error: { icon: '⛔', cls: 'text-rose-300', label: '错误' },
  warn: { icon: '⚠️', cls: 'text-amber-300', label: '警告' },
  info: { icon: '💡', cls: 'text-slate-400', label: '建议' },
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error || data.results?.find((r: any) => !r.ok)?.error || `请求失败（${res.status}）`)
  return data
}

export function QualityView({
  onOpenSkill,
  onChanged,
  onCountChange,
}: {
  onOpenSkill?: (realPath: string, name: string) => void
  onChanged?: () => void
  onCountChange?: (n: number) => void
}) {
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [trimId, setTrimId] = useState<string | null>(null)

  const apply = useCallback(
    (r: Report) => {
      setReport(r)
      onCountChange?.(r.counts.skillsWithProblems + r.counts.overloadedIdes)
    },
    [onCountChange],
  )

  const load = useCallback(async () => {
    try {
      const data = await (await fetch('/api/quality')).json()
      if (data.ok) apply(data)
      else setError(data.error || '读取失败')
    } catch (e: any) {
      setError(e?.message || String(e))
    }
  }, [apply])

  useEffect(() => {
    load()
  }, [load])

  if (error) return <div className="text-xs text-rose-300 py-10 text-center">体检失败：{error}</div>
  if (!report) return <div className="text-xs text-slate-500 py-10 text-center">正在体检…</div>

  const trimIde = report.ides.find((i) => i.id === trimId) ?? null

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="text-sm font-semibold text-slate-100">
          {report.counts.overloadedIdes === 0 && report.counts.skillsWithProblems === 0
            ? '体检通过 ✅'
            : [report.counts.overloadedIdes ? `${report.counts.overloadedIdes} 个 IDE 加载的 Skill 太多` : '', report.counts.skillsWithProblems ? `${report.counts.skillsWithProblems} 个 Skill 有问题` : '']
                .filter(Boolean)
                .join(' · ')}
        </div>
        <div className="text-[11px] text-slate-500 mt-1 leading-relaxed">
          每次对话开始时，IDE 会把它能看到的每个 Skill 的名称和描述都放进上下文，Agent 再从中挑一个用。看到的越多，越费 token，也越容易挑错：研究显示超过 20 个准确率开始下降，超过 50 个下降明显。
          所以要看的是<strong className="text-slate-300">每个 IDE 实际加载了多少</strong>，而不是仓库里一共有多少。
        </div>
      </div>

      {/* IDE load */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-slate-300">IDE 负载（全局目录）</h3>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
          {report.ides.map((ide) => {
            const managed = ide.skills.filter((s) => s.managed).length
            const inProjects = ide.skills.filter((s) => s.projects.length).length
            return (
              <div key={ide.id} className={`rounded-lg border p-3 space-y-2 ${trimId === ide.id ? 'border-indigo-500' : 'border-slate-800'} bg-slate-900/60`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-slate-100 truncate">
                    {ide.icon} {ide.name}
                  </span>
                  <span className={`shrink-0 px-2 py-0.5 rounded-full border text-[10px] ${LEVEL[ide.level].cls}`}>{LEVEL[ide.level].label}</span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-semibold text-slate-100">{ide.count}</span>
                  <span className="text-[11px] text-slate-500">个 Skill · 每次对话约 {k(ide.tokens)} tokens</span>
                </div>
                <div className="h-1 rounded bg-slate-800 overflow-hidden">
                  <div className={`h-full ${LEVEL[ide.level].bar}`} style={{ width: `${Math.min(100, (ide.count / 60) * 100)}%` }} />
                </div>
                <div className="text-[10px] text-slate-500">
                  分发方式：{MODE_LABEL[String(ide.mode)]}
                  {inProjects > 0 && ` · ${inProjects} 个在项目里也在用`}
                  {ide.count - managed > 0 && ` · ${ide.count - managed} 个不是 Skill Studio 放的`}
                </div>
                {managed > 0 && (
                  <button
                    onClick={() => setTrimId(trimId === ide.id ? null : ide.id)}
                    className={`w-full px-2 py-1 rounded-md border text-[11px] cursor-pointer ${ide.level === 'red' ? 'border-indigo-500 bg-indigo-600 text-white hover:bg-indigo-500' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}
                  >
                    {trimId === ide.id ? '收起' : ide.level === 'red' ? '精简' : '调整'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
        {trimIde && (
          <TrimPanel
            key={trimIde.id}
            ide={trimIde}
            onDone={(r) => {
              apply(r)
              onChanged?.()
            }}
          />
        )}
      </section>

      <IssueList skills={report.skills} counts={report.counts} onOpenSkill={onOpenSkill} />
    </div>
  )
}

function TrimPanel({ ide, onDone }: { ide: IdeLoad; onDone: (r: Report) => void }) {
  const trimmable = ide.skills.filter((s) => s.managed)
  const fixed = ide.skills.filter((s) => !s.managed)
  const [keep, setKeep] = useState<Set<string>>(() => new Set(trimmable.map((s) => s.name)))
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'tokens' | 'name'>('tokens')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const list = useMemo(() => {
    const term = q.trim().toLowerCase()
    const l = trimmable.filter((s) => !term || s.name.toLowerCase().includes(term))
    return sort === 'name' ? [...l].sort((a, b) => a.name.localeCompare(b.name)) : l
  }, [trimmable, q, sort])

  const keptCount = keep.size + fixed.length
  const keptTokens = trimmable.filter((s) => keep.has(s.name)).reduce((n, s) => n + s.tokens, 0) + fixed.reduce((n, s) => n + s.tokens, 0)
  const lvl = levelOf(keptCount)

  const change = (fn: (s: Set<string>) => void) => {
    setKeep((prev) => {
      const next = new Set(prev)
      fn(next)
      return next
    })
    setPreview(null)
    setMsg(null)
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message || String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-indigo-500/40 bg-slate-900/80 p-4 space-y-3">
      <div>
        <div className="text-sm font-semibold text-slate-100">
          精简 {ide.icon} {ide.name} 的全局 Skill
        </div>
        <div className="text-[11px] text-slate-400 mt-1 leading-relaxed">
          勾选要在 {ide.name} 里<strong>随时可用</strong>的 Skill。没勾选的只移除 {ide.name} 里的链接，仓库里的文件不会动；
          标着「项目在用」的，在那些项目里照样能用。执行后 {ide.name} 改为「精选」：仓库以后新增的 Skill 不会再自动加进来。
          {ide.mode === 'all' && ' 随时可以一键恢复成全部分发。'}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <button className="px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 cursor-pointer" onClick={() => change((s) => trimmable.forEach((x) => s.add(x.name)))}>
          全选
        </button>
        <button className="px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 cursor-pointer" onClick={() => change((s) => s.clear())}>
          全不选
        </button>
        <button
          className="px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 cursor-pointer"
          title="这些 Skill 在用到它们的项目里照样可用"
          onClick={() => change((s) => trimmable.filter((x) => x.projects.length).forEach((x) => s.delete(x.name)))}
        >
          取消勾选项目里在用的
        </button>
        <select value={sort} onChange={(e) => setSort(e.target.value as any)} className="px-2 py-1 rounded bg-slate-950 border border-slate-700 text-slate-300">
          <option value="tokens">按占用排序</option>
          <option value="name">按名称排序</option>
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索…"
          className="ml-auto w-48 px-2 py-1 rounded bg-slate-950 border border-slate-700 text-slate-200 outline-none focus:border-indigo-500"
        />
      </div>

      <div className="max-h-[360px] overflow-y-auto rounded-lg border border-slate-800 divide-y divide-slate-800/60">
        {list.map((s) => (
          <label key={s.name} className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-slate-800/40 cursor-pointer">
            <input type="checkbox" checked={keep.has(s.name)} onChange={(e) => change((set) => (e.target.checked ? set.add(s.name) : set.delete(s.name)))} />
            <span className="font-mono text-slate-200 truncate">{s.name}</span>
            {s.projects.length > 0 && (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300" title={s.projects.join('、')}>
                项目在用 {s.projects.length}
              </span>
            )}
            <span className="ml-auto shrink-0 text-[10px] text-slate-500">≈{s.tokens} tokens</span>
          </label>
        ))}
        {fixed.length > 0 && (
          <div className="px-3 py-2 text-[10px] text-slate-500">
            另有 {fixed.length} 个不是 Skill Studio 放进去的（{fixed.slice(0, 6).map((s) => s.name).join('、')}
            {fixed.length > 6 ? ' 等' : ''}），不会改动，已算在下面的数字里。
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="text-xs text-slate-300">
          保留 <strong>{keptCount}</strong> 个 · 约 {k(keptTokens)} tokens
          <span className="text-slate-500">（现在 {ide.count} 个 · 约 {k(ide.tokens)}）</span>
        </div>
        <span className={`px-2 py-0.5 rounded-full border text-[10px] ${LEVEL[lvl].cls}`}>{LEVEL[lvl].label}</span>
        <div className="ml-auto flex gap-2">
          {ide.mode === 'global' && (
            <button
              disabled={busy}
              onClick={() => {
                if (!confirm(`把 ${ide.name} 恢复成「仓库全部分发」？仓库里的每个 Skill 都会重新链接进去。`)) return
                run(async () => {
                  const d = await post('/api/quality/trim', { agentId: ide.id, keep: 'all' })
                  onDone(d.report)
                  setMsg({ kind: 'ok', text: `已恢复全部分发，新增 ${d.preview.add.length} 个` })
                })
              }}
              className="px-3 py-1.5 rounded-lg border border-slate-700 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
            >
              恢复全部分发
            </button>
          )}
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const d = await post('/api/quality/trim/preview', { agentId: ide.id, keep: [...keep] })
                setPreview(d.preview)
              })
            }
            className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-40 cursor-pointer"
          >
            {busy && !preview ? '计算中…' : '预览变更'}
          </button>
        </div>
      </div>

      {preview && (
        <div className="rounded-lg border border-slate-700 bg-slate-950/60 p-3 space-y-2 text-xs">
          {preview.remove.length === 0 && preview.add.length === 0 ? (
            <div className="text-slate-400">没有变化。</div>
          ) : (
            <>
              <div className="text-slate-200">
                {preview.remove.length > 0 && <>将从 {ide.name} 移除 <strong>{preview.remove.length}</strong> 个链接或副本</>}
                {preview.remove.length > 0 && preview.add.length > 0 && '，'}
                {preview.add.length > 0 && <>新增 <strong>{preview.add.length}</strong> 个</>}
                。仓库里的 Skill 不受影响。
              </div>
              {preview.remove.length > ide.skills.filter((s) => s.managed && !keep.has(s.name)).length && (
                <div className="text-[11px] text-slate-500">
                  比上面没勾选的多出来的，是指向仓库但没有 SKILL.md 的目录（IDE 本来就不会加载），或名称和 Skill 对不上的旧链接，一并清理。
                </div>
              )}
              {preview.remove.length > 0 && (
                <details className="text-[11px] text-slate-500">
                  <summary className="cursor-pointer">查看将移除的 Skill</summary>
                  <div className="mt-1 font-mono leading-relaxed">{preview.remove.join('、')}</div>
                </details>
              )}
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const d = await post('/api/quality/trim', { agentId: ide.id, keep: [...keep], fingerprint: preview.fingerprint })
                    setPreview(null)
                    onDone(d.report)
                    setMsg({ kind: 'ok', text: `${ide.name} 已精简：移除 ${d.preview.remove.length} 个，现在加载 ${d.report.ides.find((i: IdeLoad) => i.id === ide.id)?.count ?? '—'} 个` })
                  })
                }
                className="px-3 py-1.5 rounded-lg bg-indigo-600 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-40 cursor-pointer"
              >
                {busy ? '执行中…' : '确认执行'}
              </button>
            </>
          )}
        </div>
      )}
      {msg && (
        <div className={`text-xs rounded-lg px-3 py-2 border ${msg.kind === 'ok' ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' : 'text-rose-300 border-rose-500/30 bg-rose-500/10'}`}>
          {msg.text}
        </div>
      )}
    </div>
  )
}

function IssueList({
  skills,
  counts,
  onOpenSkill,
}: {
  skills: SkillCheck[]
  counts: Report['counts']
  onOpenSkill?: (realPath: string, name: string) => void
}) {
  const [filter, setFilter] = useState<'problems' | 'info' | 'all'>('problems')
  const [q, setQ] = useState('')

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase()
    const sevs: Severity[] = filter === 'problems' ? ['error', 'warn'] : filter === 'info' ? ['info'] : ['error', 'warn', 'info']
    const rank = (s: SkillCheck) => (s.issues.some((i) => i.severity === 'error') ? 0 : s.issues.some((i) => i.severity === 'warn') ? 1 : 2)
    return skills
      .map((s) => ({ ...s, issues: s.issues.filter((i) => sevs.includes(i.severity)) }))
      .filter((s) => (filter === 'all' || s.issues.length > 0) && (!term || s.name.toLowerCase().includes(term)))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  }, [skills, filter, q])

  const withInfo = skills.filter((s) => s.issues.some((i) => i.severity === 'info')).length

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold text-slate-300 mr-2">Skill 检查（仓库里的 {skills.length} 个）</h3>
        {(
          [
            ['problems', `需要修（${counts.skillsWithProblems}）`],
            ['info', `可改进（${withInfo}）`],
            ['all', `全部（${skills.length}）`],
          ] as const
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
          placeholder="搜索 Skill…"
          className="ml-auto w-48 px-3 py-1 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-200 placeholder:text-slate-600 outline-none focus:border-indigo-500"
        />
      </div>
      <div className="text-[10px] text-slate-500">
        检查依据：Agent Skills 规范（name 格式、name 与目录同名、description 不超过 1024 字符、SKILL.md 不超过 500 行、一个 Skill 一个入口）和乔木 Meta Skill 的基础门槛（description 写清什么时候用、什么时候不用，引用的文件都在）。
      </div>
      {rows.length === 0 ? (
        <div className="text-xs text-slate-500 py-8 text-center">{filter === 'problems' ? '没有需要修的 Skill ✅' : '没有匹配的 Skill'}</div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((s) => (
            <div key={s.realPath} className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
              <div className="flex items-center gap-2">
                <button onClick={() => onOpenSkill?.(s.realPath, s.name)} className="font-mono text-sm text-slate-100 hover:text-indigo-300 cursor-pointer" title="打开查看和编辑">
                  {s.name}
                </button>
                {s.skillMdLines > 0 && (
                  <span className="text-[10px] text-slate-500">
                    描述 ≈{s.routingTokens} tokens · SKILL.md {s.skillMdLines} 行
                  </span>
                )}
              </div>
              {s.issues.map((i) => (
                <div key={i.code} className="mt-1 text-[11px] leading-relaxed">
                  <span className={SEV[i.severity].cls}>
                    {SEV[i.severity].icon} {i.message}
                  </span>
                  {i.hint && <span className="text-slate-500"> — {i.hint}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
