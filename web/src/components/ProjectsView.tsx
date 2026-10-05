import { useCallback, useEffect, useMemo, useState } from 'react'
import { ProjectWizard } from './ProjectWizard'
import { WarehouseSkillPickerModal } from './WarehouseSkillPickerModal'
import { DeleteProjectModal } from './DeleteProjectModal'
import type { Skill } from '../hooks/useSkills'

type CellStatus = 'ok' | 'pending' | 'outdated' | 'conflict' | 'unavailable' | 'local'
type ActionType = 'link' | 'relink' | 'copy' | 'update' | 'unlink' | 'legacy' | 'conflict'

interface IdeInfo {
  id: string
  name: string
  icon: string
  writeDirs: string[]
  mode: 'symlink' | 'copy'
}

interface ProjectProfile {
  name: string
  description: string
  skills: string[]
  ides: string[]
}

interface ProjectRow {
  name: string
  path: string
  profile: ProjectProfile
  ides: { id: string; name: string; icon: string; dirs: string[]; mode: 'symlink' | 'copy' }[]
  matrix: Record<string, Record<string, CellStatus>>
  counts: Record<ActionType, number>
  pending: number
  strayDirs: { rel: string; readBy: string[]; managed: number; real: number }[]
  warnings: string[]
  fingerprint: string
}

interface Candidate {
  name: string
  path: string
  dirs: { rel: string; entries: number; readBy: string[] }[]
  suggestedIdes: string[]
  skills: string[]
  autoProfile: boolean
}

const CELL: Record<CellStatus, { icon: string; cls: string; label: string }> = {
  ok: { icon: '✓', cls: 'text-emerald-400', label: '已就绪' },
  local: { icon: '⌂', cls: 'text-emerald-300', label: '项目自带' },
  pending: { icon: '○', cls: 'text-amber-400', label: '待同步' },
  outdated: { icon: '↻', cls: 'text-sky-400', label: '副本待更新' },
  conflict: { icon: '!', cls: 'text-red-400', label: '冲突（未覆盖）' },
  unavailable: { icon: '–', cls: 'text-slate-500', label: '找不到来源' },
}

interface ProjectsViewProps {
  allSkills: Skill[]
  onRefreshSkills: () => void
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

export function ProjectsView({ allSkills, onRefreshSkills }: ProjectsViewProps) {
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [ideCatalog, setIdeCatalog] = useState<IdeInfo[]>([])
  const [excluded, setExcluded] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [cleanup, setCleanup] = useState<Record<string, boolean>>({})
  const [showCandidates, setShowCandidates] = useState(false)
  const [candidateIdes, setCandidateIdes] = useState<Record<string, string[]>>({})
  const [wizardOpen, setWizardOpen] = useState(false)
  const [pickerProject, setPickerProject] = useState<ProjectRow | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; path: string } | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [p, c, i, e] = await Promise.all([
        fetch('/api/projects').then((r) => r.json()),
        fetch('/api/projects/candidates').then((r) => r.json()),
        fetch('/api/projects/ides').then((r) => r.json()),
        fetch('/api/projects/excluded').then((r) => r.json()),
      ])
      if (p.ok) setProjects(p.projects)
      if (c.ok) {
        setCandidates(c.candidates)
        setCandidateIdes((prev) => {
          const next = { ...prev }
          for (const cand of c.candidates as Candidate[]) next[cand.path] ??= cand.suggestedIdes
          return next
        })
      }
      if (i.ok) setIdeCatalog(i.ides)
      if (e.ok) setExcluded(e.excludedProjects)
    } catch (err: any) {
      setNotice({ kind: 'err', text: '读取项目失败：' + err.message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const afterChange = async (text?: string, kind: 'ok' | 'err' = 'ok') => {
    if (text) setNotice({ kind, text })
    await refresh()
    onRefreshSkills()
  }

  const saveProfile = async (p: ProjectRow, patch: Partial<ProjectProfile>) => {
    setBusy(p.path)
    try {
      const { data } = await postJson('/api/projects/profile', { projectPath: p.path, profile: { ...p.profile, ...patch } })
      if (!data.ok) setNotice({ kind: 'err', text: data.error || '保存失败' })
      await refresh() // profile edits only change the plan; nothing is applied yet
    } finally {
      setBusy(null)
    }
  }

  const applyProject = async (p: ProjectRow) => {
    setBusy(p.path)
    try {
      const { status, data } = await postJson('/api/projects/apply', {
        projectPath: p.path,
        fingerprint: p.fingerprint,
        includeLegacy: !!cleanup[p.path],
      })
      if (status === 409) await afterChange('磁盘状态已变化，已刷新预览，请确认后再应用。', 'err')
      else if (data.ok) {
        setCleanup((c) => ({ ...c, [p.path]: false }))
        await afterChange(`「${p.name}」已应用 ${data.applied} 项变更`)
      } else {
        const first = (data.results || []).find((r: any) => !r.ok)
        await afterChange(`应用 ${data.applied ?? 0} 项，失败 ${data.failed ?? '?'} 项${first ? '：' + first.error : ''}`, 'err')
      }
    } finally {
      setBusy(null)
    }
  }

  const importCandidate = async (c: Candidate) => {
    setBusy(c.path)
    try {
      const { data } = await postJson('/api/projects/import', { projectPath: c.path, ides: candidateIdes[c.path] ?? c.suggestedIdes })
      if (data.ok) {
        setExpanded(c.path)
        await afterChange(`已导入「${c.name}」，请预览后应用`)
      } else setNotice({ kind: 'err', text: data.error || '导入失败' })
    } finally {
      setBusy(null)
    }
  }

  const hideProject = async (projectPath: string, purgeFiles = false) => {
    const { data } = await postJson('/api/projects/delete', { projectPath, purgeFiles })
    if (data.ok) await afterChange(purgeFiles ? '项目已移除，Skill 目录已清理（真实目录进回收站）' : '已从列表中移除')
    else setNotice({ kind: 'err', text: data.error || '操作失败' })
  }

  const ideName = (id: string) => ideCatalog.find((i) => i.id === id)?.name ?? id

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-slate-100">项目</h2>
          <p className="text-sm text-slate-500 mt-1">
            一个项目 = 一个文件夹：一套 Skill，同步到你在这个项目里用的每一个 IDE。修改不会立即写盘，预览后点「应用」。
          </p>
        </div>
        <button onClick={() => setWizardOpen(true)} className="px-3 py-1.5 bg-indigo-600 text-xs font-semibold rounded-lg cursor-pointer">
          + 新建项目
        </button>
      </div>

      {notice && (
        <div className={`text-xs px-3 py-2 rounded-lg flex justify-between ${notice.kind === 'ok' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}>
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} className="cursor-pointer">✕</button>
        </div>
      )}

      {loading && projects.length === 0 ? (
        <div className="flex justify-center py-16">
          <div className="w-8 h-8 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
        </div>
      ) : projects.length === 0 ? (
        <div className="border border-dashed border-slate-800 rounded-xl p-8 text-center text-sm text-slate-500">
          还没有配置过的项目。新建一个，或从下方「发现的候选项目」导入。
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map((p) => (
            <ProjectCard
              key={p.path}
              project={p}
              ideCatalog={ideCatalog}
              expanded={expanded === p.path}
              busy={busy === p.path}
              cleanup={!!cleanup[p.path]}
              onToggleExpand={() => setExpanded(expanded === p.path ? null : p.path)}
              onSetIdes={(ides) => saveProfile(p, { ides })}
              onRemoveSkill={(name) => saveProfile(p, { skills: p.profile.skills.filter((s) => s !== name) })}
              onPickSkills={() => setPickerProject(p)}
              onCleanup={(v) => setCleanup((c) => ({ ...c, [p.path]: v }))}
              onApply={() => applyProject(p)}
              onDelete={() => setDeleteTarget({ name: p.name, path: p.path })}
              ideName={ideName}
            />
          ))}
        </div>
      )}

      {/* Candidates */}
      <div className="border border-slate-800/80 rounded-xl">
        <button onClick={() => setShowCandidates((v) => !v)} className="w-full px-4 py-3 flex justify-between items-center text-sm cursor-pointer">
          <span className="font-semibold text-slate-300">
            发现的候选项目 <span className="text-slate-500 font-normal">（{candidates.length}，未配置，不会被管理）</span>
          </span>
          <span className="text-slate-500">{showCandidates ? '收起' : '展开'}</span>
        </button>
        {showCandidates && (
          <div className="border-t border-slate-800/80 divide-y divide-slate-800/60">
            {candidates.length === 0 && <div className="px-4 py-4 text-xs text-slate-500">没有候选项目。</div>}
            {candidates.map((c) => (
              <div key={c.path} className="px-4 py-3 space-y-2">
                <div className="flex justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="text-sm text-slate-200 font-medium">
                      {c.name}
                      {c.autoProfile && <span className="ml-2 text-[10px] text-amber-400/80">旧版本自动生成的配置，未确认</span>}
                    </div>
                    <div className="text-[11px] text-slate-500 truncate" title={c.path}>{c.path}</div>
                    <div className="text-[11px] text-slate-500 mt-1">
                      {c.dirs.map((d) => `${d.rel}（${d.entries}）`).join('、') || '无 Skill 目录'} · {c.skills.length} 个 Skill
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0 items-start">
                    <button disabled={busy === c.path} onClick={() => importCandidate(c)} className="px-3 py-1 text-xs rounded bg-indigo-600 disabled:opacity-40 cursor-pointer">
                      导入为项目
                    </button>
                    <button onClick={() => hideProject(c.path)} className="px-3 py-1 text-xs rounded bg-slate-800 text-slate-400 cursor-pointer">
                      忽略
                    </button>
                  </div>
                </div>
                <IdePicker
                  catalog={ideCatalog}
                  selected={candidateIdes[c.path] ?? c.suggestedIdes}
                  onChange={(ides) => setCandidateIdes((m) => ({ ...m, [c.path]: ides }))}
                  hint="导入后同步到："
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {excluded.length > 0 && (
        <div className="text-[11px] text-slate-500">
          已忽略 {excluded.length} 个文件夹：
          {excluded.map((e) => (
            <button key={e} onClick={async () => { await postJson('/api/projects/restore', { projectPath: e }); await refresh() }} className="ml-2 underline hover:text-slate-300 cursor-pointer" title="恢复">
              {e.split('/').pop()}
            </button>
          ))}
        </div>
      )}

      {wizardOpen && (
        <ProjectWizard
          project={null}
          allSkills={allSkills}
          onClose={(changed) => {
            setWizardOpen(false)
            if (changed) afterChange('项目已创建')
          }}
        />
      )}

      {pickerProject && (
        <WarehouseSkillPickerModal
          isOpen
          onClose={() => setPickerProject(null)}
          projectName={pickerProject.name}
          projectPath={pickerProject.path}
          targetIde={pickerProject.profile.ides.map(ideName).join(' / ') || '未选择 IDE'}
          installedSkillNames={projects.find((x) => x.path === pickerProject.path)?.profile.skills ?? pickerProject.profile.skills}
          allSkills={allSkills}
          onToggleSkill={async (name, installed) => {
            const cur = projects.find((x) => x.path === pickerProject.path) ?? pickerProject
            const skills = installed ? cur.profile.skills.filter((s) => s !== name) : [...cur.profile.skills, name]
            await saveProfile(cur, { skills })
          }}
        />
      )}

      {deleteTarget && (
        <DeleteProjectModal
          isOpen
          projectName={deleteTarget.name}
          projectPath={deleteTarget.path}
          onClose={() => setDeleteTarget(null)}
          onConfirm={async (purge) => {
            await hideProject(deleteTarget.path, purge)
            setDeleteTarget(null)
          }}
        />
      )}
    </div>
  )
}

/** Selected IDEs as removable chips + a dropdown to add one (32 IDEs is too many to lay out). */
function IdePicker({ catalog, selected, onChange, hint, disabled }: { catalog: IdeInfo[]; selected: string[]; onChange: (ides: string[]) => void; hint?: string; disabled?: boolean }) {
  const byId = new Map(catalog.map((i) => [i.id, i]))
  const others = catalog.filter((i) => !selected.includes(i.id))
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {hint && <span className="text-[11px] text-slate-500 mr-1">{hint}</span>}
      {selected.map((id) => {
        const ide = byId.get(id)
        return (
          <span
            key={id}
            title={ide ? `写入 ${ide.writeDirs.join(' + ')}${ide.mode === 'copy' ? '（真实副本）' : ''}` : id}
            className="pl-2 pr-1 py-0.5 rounded-full text-[11px] border border-indigo-400/60 bg-indigo-500/15 text-slate-100 inline-flex items-center gap-1"
          >
            {ide ? `${ide.icon} ${ide.name}` : id}
            <button
              disabled={disabled}
              onClick={() => onChange(selected.filter((x) => x !== id))}
              className="text-slate-400 hover:text-red-300 disabled:opacity-40 cursor-pointer px-0.5"
              title="从项目中移除这个 IDE"
            >
              ✕
            </button>
          </span>
        )
      })}
      <select
        disabled={disabled}
        value=""
        onChange={(e) => e.target.value && onChange([...selected, e.target.value])}
        className="text-[11px] py-0.5 pl-2 pr-6 rounded-full border border-dashed border-slate-700 bg-transparent text-slate-400 cursor-pointer"
      >
        <option value="">＋ 添加 IDE…</option>
        {others.map((i) => (
          <option key={i.id} value={i.id}>
            {i.icon} {i.name}
          </option>
        ))}
      </select>
    </div>
  )
}

interface CardProps {
  project: ProjectRow
  ideCatalog: IdeInfo[]
  expanded: boolean
  busy: boolean
  cleanup: boolean
  onToggleExpand: () => void
  onSetIdes: (ides: string[]) => void
  onRemoveSkill: (name: string) => void
  onPickSkills: () => void
  onCleanup: (v: boolean) => void
  onApply: () => void
  onDelete: () => void
  ideName: (id: string) => string
}

function ProjectCard(props: CardProps) {
  const { project: p, expanded, busy, cleanup } = props
  const cleanupCount = p.counts.legacy
  const applicable = p.pending + (cleanup ? cleanupCount : 0)
  const skills = p.profile.skills
  const commonIdes = useMemo(() => props.ideCatalog.filter((i) => p.profile.ides.includes(i.id)), [props.ideCatalog, p.profile.ides])

  return (
    <div className="bg-slate-900/40 border border-slate-800/80 rounded-xl">
      <div className="p-4 flex items-start justify-between gap-4 flex-wrap">
        <button onClick={props.onToggleExpand} className="min-w-0 text-left cursor-pointer flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-slate-100">{p.name}</span>
            <span className="text-[11px] text-slate-500">{skills.length} 个 Skill</span>
            {p.pending > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300">待同步 {p.pending}</span>}
            {p.counts.conflict > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-300">冲突 {p.counts.conflict}</span>}
            {cleanupCount > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-300">旧目录 {cleanupCount}</span>}
            {p.pending === 0 && p.counts.conflict === 0 && p.profile.ides.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300">已同步</span>
            )}
          </div>
          <div className="text-[11px] text-slate-500 truncate mt-0.5" title={p.path}>{p.path}</div>
        </button>
        <div className="flex gap-2 shrink-0">
          <button onClick={props.onPickSkills} className="px-3 py-1 text-xs rounded bg-slate-800 text-slate-300 cursor-pointer">管理 Skill</button>
          <button
            onClick={props.onApply}
            disabled={busy || applicable === 0}
            className="px-3 py-1 text-xs rounded bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {busy ? '处理中…' : applicable ? `应用 ${applicable} 项` : '无需同步'}
          </button>
        </div>
      </div>

      <div className="px-4 pb-3">
        <IdePicker catalog={props.ideCatalog} selected={p.profile.ides} onChange={props.onSetIdes} disabled={busy} hint="同步到：" />
        {p.profile.ides.length === 0 && <div className="text-[11px] text-amber-400/90 mt-1.5">还没有选择 IDE，这个项目的 Skill 不会同步到任何地方。</div>}
      </div>

      {expanded && (
        <div className="border-t border-slate-800/80 p-4 space-y-3">
          {skills.length === 0 ? (
            <div className="text-xs text-slate-500">这个项目还没有 Skill，点「管理 Skill」添加。</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-xs w-full">
                <thead>
                  <tr className="text-slate-500">
                    <th className="text-left font-medium py-1 pr-3">Skill</th>
                    {commonIdes.map((ide) => (
                      <th key={ide.id} className="font-medium py-1 px-2 text-center whitespace-nowrap" title={`写入 ${ide.writeDirs.join(' + ')}`}>
                        {ide.icon} {ide.name}
                        {ide.mode === 'copy' && <div className="text-[9px] text-amber-300/80 font-normal">副本</div>}
                      </th>
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {skills.map((name) => (
                    <tr key={name}>
                      <td className="py-1.5 pr-3 font-mono text-slate-300 truncate max-w-[16rem]">/{name}</td>
                      {commonIdes.map((ide) => {
                        const st = p.matrix[name]?.[ide.id] ?? 'pending'
                        return (
                          <td key={ide.id} className={`text-center px-2 ${CELL[st].cls}`} title={CELL[st].label}>
                            {CELL[st].icon}
                          </td>
                        )
                      })}
                      <td className="text-right">
                        <button onClick={() => props.onRemoveSkill(name)} className="text-slate-600 hover:text-red-400 cursor-pointer" title="从项目移除">✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex flex-wrap gap-3 mt-2 text-[10px] text-slate-500">
                {(Object.keys(CELL) as CellStatus[]).map((k) => (
                  <span key={k}><span className={CELL[k].cls}>{CELL[k].icon}</span> {CELL[k].label}</span>
                ))}
              </div>
            </div>
          )}

          {p.warnings.length > 0 && (
            <ul className="text-[11px] text-amber-400/90 list-disc pl-4">{p.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          )}

          {p.strayDirs.length > 0 && (
            <div className="text-[11px] text-slate-400 bg-slate-950/40 border border-slate-800/60 rounded-lg p-3 space-y-1">
              <div className="text-slate-300 font-medium">项目里还有其它 IDE 目录</div>
              {p.strayDirs.map((d) => (
                <div key={d.rel}>
                  <code className="text-slate-300">{d.rel}</code>
                  {' '}— {d.readBy.length ? `${d.readBy.map(props.ideName).join(' / ')} 会读取` : '没有 IDE 读取'}；
                  Skill Studio 管理的 {d.managed} 项{d.real ? `，你自己的真实目录 ${d.real} 个（不会动）` : ''}
                  {d.managed > 0 && d.readBy.some((id) => p.profile.ides.includes(id)) && (
                    <span className="text-amber-300/90">；应用时会迁移到项目的写入目录，避免同一个 IDE 看到两份</span>
                  )}
                  {d.readBy.some((id) => !p.profile.ides.includes(id)) && d.readBy.length > 0 && (
                    <button
                      onClick={() => props.onSetIdes([...p.profile.ides, ...d.readBy.filter((id) => !p.profile.ides.includes(id)).slice(0, 1)])}
                      className="ml-2 underline hover:text-slate-200 cursor-pointer"
                    >
                      把 {props.ideName(d.readBy.find((id) => !p.profile.ides.includes(id))!)} 加入项目
                    </button>
                  )}
                </div>
              ))}
              {cleanupCount > 0 && (
                <label className="flex items-center gap-2 pt-1 select-none">
                  <input type="checkbox" checked={cleanup} onChange={(e) => props.onCleanup(e.target.checked)} />
                  应用时一并清理这些旧目录里由 Skill Studio 管理的 {cleanupCount} 项（只删链接/受管副本，改过的副本进回收站）
                </label>
              )}
            </div>
          )}

          <div className="flex justify-end">
            <button onClick={props.onDelete} className="text-[11px] text-slate-500 hover:text-red-400 cursor-pointer">从列表中移除项目…</button>
          </div>
        </div>
      )}
    </div>
  )
}
