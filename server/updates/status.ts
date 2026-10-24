import fs from 'fs/promises'
import path from 'path'
import { getWarehouseDirs } from '../settings.js'
import { getSkillFolderHash, getSkillFolderSignature } from '../scanner/drift.js'
import { AGENTS } from '../scanner/agents.js'
import { mapLimit } from '../utils/concurrency.js'
import { copyDir } from '../utils/fs.js'
import { moveToTrash } from '../trash/store.js'
import { listSources, inspect, executeActions, materializeCopy, readMarker, realOr, type PlanAction, type SourceSkill } from '../distribution/reconcile.js'
import { withWriteLock } from '../distribution/lock.js'
import { listConfiguredProjects } from '../projects/model.js'
import { planProject, buildProjectContext } from '../projects/reconcile.js'
import { readSkillSource, writeSkillSource, parseGithubUrl, findSourceInManifests, type ManifestCache } from '../updater/source.js'
import { checkSkillUpdate } from '../updater/checker.js'
import { updateSkillFromGithub } from '../updater/installer.js'
import type { SkillGithubSource } from '../types.js'
import { readBaselines, setBaseline, updateBaselines, type Baseline } from './baseline.js'
import { upstreamTree, GithubApiError, type TreeLookup } from './upstream.js'

/**
 * Version state of every warehouse skill, and of every copy derived from it.
 *
 * The warehouse is the single source of truth. Symlinks can't diverge from
 * it; copies (IDEs that don't follow symlinks) can, and so can the warehouse
 * itself relative to its upstream. States:
 *   synced       – nothing to do
 *   upstream     – GitHub has a newer commit, no local edits: safe to update
 *   local-edited – content changed since install/last update (no upstream news)
 *   conflict     – local edits AND a newer upstream commit: user decides
 * Copies: stale (source changed, copy untouched → refresh) or edited (copy
 * changed in the IDE → pull back into the warehouse, or overwrite).
 */

export type VersionState = 'synced' | 'upstream' | 'local-edited' | 'conflict'

export interface CopyState {
  path: string
  /** Real path of the directory the copy was made from. */
  origin?: string
  /** Agents reading it, or the project it belongs to. */
  where: string
  projectPath?: string
  status: 'stale' | 'edited'
}

export interface SkillVersion {
  name: string
  path: string
  realPath: string
  description?: string
  kind: 'github' | 'local'
  state: VersionState
  fingerprint: string | null
  baselineAt?: string
  source?: {
    repo: string
    branch?: string
    subPath?: string
    installedCommit?: string
    latestCommit?: string
    installedTree?: string
    latestTree?: string
    /** The folder is gone upstream (removed or moved): nothing to update from. */
    missing: boolean
    /** The repository can't be read (private without token access, or deleted). */
    noAccess: boolean
    lastChecked?: string
  }
  copies: CopyState[]
}

export interface VersionsReport {
  skills: SkillVersion[]
  counts: Record<VersionState, number> & { github: number; local: number; staleCopies: number; editedCopies: number; upstreamMissing: number; noAccess: number }
  warnings: string[]
}

function hasGithub(src: SkillGithubSource | null): src is SkillGithubSource & { owner: string; repo: string } {
  return !!src?.owner && !!src?.repo
}

function upstreamAhead(src: SkillGithubSource): boolean {
  if (src.upstreamMissing || src.upstreamNoAccess) return false
  // Folder tree SHAs: exact "did this skill's folder change upstream".
  if (src.latestTree) {
    if (!src.installedTree) return src.latestTree !== src.ignoredTree // installed version unknown
    return src.latestTree !== src.installedTree && src.latestTree !== src.ignoredTree
  }
  // Legacy: commit SHAs from older checks.
  if (!src.latestCommit || !src.updateAvailable) return false
  if (src.latestCommit === src.installedCommit) return false
  return src.latestCommit !== src.ignoredCommit
}

function agentNames(ids: string[]): string {
  return ids.map((id) => AGENTS.find((a) => a.id === id)?.name ?? id).join('、')
}

/** Stale and edited copies of warehouse skills: global IDE dirs + every configured project. */
async function collectCopies(): Promise<{ actions: PlanAction[]; byName: Map<string, CopyState[]> }> {
  const actions: PlanAction[] = []
  const g = await inspect()
  actions.push(...g.plan.actions)
  const projects = await listConfiguredProjects().catch(() => [])
  if (projects.length) {
    const ctx = await buildProjectContext()
    for (const p of projects) {
      try {
        const plan = await planProject(p.path, { profile: p.profile, ctx })
        // viaGlobal actions are global ones already counted above.
        actions.push(...plan.actions.filter((a) => !a.viaGlobal).map((a) => ({ ...a, projectPath: p.path })))
      } catch {}
    }
  }
  const byName = new Map<string, CopyState[]>()
  const copyActions = actions.filter((a) => a.isCopy && (a.type === 'update' || a.type === 'conflict'))
  for (const a of copyActions) {
    const where = a.projectPath ? `项目 ${path.basename(a.projectPath)}（${agentNames(a.agentIds)}）` : agentNames(a.agentIds)
    const marker = a.type === 'conflict' ? await readMarker(a.linkPath) : null
    const origin = a.type === 'update' ? a.target : marker?.originPath ? ((await realOr(marker.originPath)) ?? undefined) : undefined
    const list = byName.get(a.name) ?? []
    list.push({ path: a.linkPath, origin, where, projectPath: a.projectPath, status: a.type === 'update' ? 'stale' : 'edited' })
    byName.set(a.name, list)
  }
  return { actions: copyActions, byName }
}

async function sources(warnings: string[] = []): Promise<Map<string, SourceSkill>> {
  return listSources(await getWarehouseDirs(), warnings)
}

/**
 * A skill's GitHub source: its .skill-source, or else an entry in a skills
 * lock / manifest file (`npx skills add` installs), which is then saved as
 * .skill-source so checks and updates treat both alike.
 */
async function resolveSource(s: SourceSkill, cache: ManifestCache): Promise<SkillGithubSource | null> {
  const own = await readSkillSource(s.realPath)
  if (own && (!hasGithub(own) || own.installedTree)) return own
  const found = await findSourceInManifests(s.name, s.realPath, undefined, cache).catch(() => null)
  if (own) {
    // Older versions copied the lock's folder hash into installedCommit and
    // compared it with commit SHAs — every such skill looked out of date.
    if (found?.installedTree && hasGithub(own) && own.owner === found.owner && own.repo === found.repo) {
      if (own.installedCommit === found.installedTree) delete own.installedCommit
      own.installedTree = found.installedTree
      delete own.latestCommit
      own.updateAvailable = false
      await writeSkillSource(s.realPath, own)
    }
    return own
  }
  if (!found) return null
  const source: SkillGithubSource = {
    owner: found.owner,
    repo: found.repo,
    branch: found.branch,
    subPath: found.subPath,
    installedTree: found.installedTree,
    updateAvailable: false,
  }
  await writeSkillSource(s.realPath, source)
  return source
}

export async function versionsReport(): Promise<VersionsReport> {
  const warnings: string[] = []
  const src = await sources(warnings)
  const baselines = await readBaselines()
  const { byName } = await collectCopies()
  const baselineWrites: { realPath: string; base: Baseline }[] = []

  // Few at a time: on cloud-synced folders parallel reads get slower, not faster.
  const manifests: ManifestCache = new Map()
  const skills = await mapLimit([...src.values()], 4, async (s): Promise<SkillVersion> => {
    const [signature, gh] = await Promise.all([getSkillFolderSignature(s.realPath), resolveSource(s, manifests)])
    let base = baselines[s.realPath]
    let fingerprint: string | null
    let edited: boolean
    if (base && base.signature && base.signature === signature) {
      // Same files, sizes and mtimes as at the baseline: unchanged, nothing to read.
      fingerprint = base.fingerprint
      edited = false
    } else {
      fingerprint = await getSkillFolderHash(s.realPath)
      if (!base) {
        // First time we see it: today's content is the baseline.
        base = { fingerprint, signature, recordedAt: new Date().toISOString(), reason: 'adopt' }
        baselineWrites.push({ realPath: s.realPath, base })
      }
      edited = base.fingerprint !== fingerprint
      // Touched but not changed (e.g. re-synced): remember the new signature
      // so the content isn't read again next time.
      if (!edited && base.signature !== signature) baselineWrites.push({ realPath: s.realPath, base: { ...base, signature } })
    }
    const github = hasGithub(gh)
    const ahead = github && upstreamAhead(gh)
    // Self-made skills are edited all the time; only GitHub skills have a
    // version to drift from.
    const state: VersionState = !github ? 'synced' : edited && ahead ? 'conflict' : ahead ? 'upstream' : edited ? 'local-edited' : 'synced'
    return {
      name: s.name,
      path: s.path,
      realPath: s.realPath,
      description: s.description,
      kind: github ? 'github' : 'local',
      state,
      fingerprint,
      baselineAt: base.recordedAt,
      source: github
        ? {
            repo: `${gh.owner}/${gh.repo}`,
            branch: gh.branch,
            subPath: gh.subPath,
            installedCommit: gh.installedCommit,
            latestCommit: gh.latestCommit,
            installedTree: gh.installedTree,
            latestTree: gh.latestTree,
            missing: !!gh.upstreamMissing,
            noAccess: !!gh.upstreamNoAccess,
            lastChecked: gh.lastChecked,
          }
        : undefined,
      // Only copies made from THIS skill (a project's own skill may share the name).
      copies: (byName.get(s.name) ?? []).filter((c) => c.origin === s.realPath),
    }
  })

  if (baselineWrites.length) {
    await updateBaselines((all) => {
      for (const w of baselineWrites) {
        const cur = all[w.realPath]
        // New baseline, or a signature refresh of the same baseline. Never
        // clobber one set meanwhile by an install / update / accept.
        if (!cur || cur.recordedAt === w.base.recordedAt) all[w.realPath] = w.base
      }
    })
  }

  skills.sort((a, b) => a.name.localeCompare(b.name))
  const counts = { synced: 0, upstream: 0, 'local-edited': 0, conflict: 0, github: 0, local: 0, staleCopies: 0, editedCopies: 0, upstreamMissing: 0, noAccess: 0 }
  for (const s of skills) {
    counts[s.state]++
    counts[s.kind]++
    if (s.source?.missing) counts.upstreamMissing++
    if (s.source?.noAccess) counts.noAccess++
    for (const c of s.copies) c.status === 'stale' ? counts.staleCopies++ : counts.editedCopies++
  }
  return { skills, counts, warnings }
}

async function findSource(name: string): Promise<SourceSkill> {
  const s = (await sources()).get(name)
  if (!s) throw new Error(`仓库里没有「${name}」`)
  return s
}

// ── Upstream ─────────────────────────────────────────────────────────────

export interface CheckResult {
  checked: number
  withUpdates: number
  errors: { name: string; error: string }[]
}

/** Ask GitHub for the latest commit of every GitHub skill (or `names`). */
export async function checkUpstream(names?: string[]): Promise<CheckResult> {
  const result: CheckResult = { checked: 0, withUpdates: 0, errors: [] }
  const list = [...(await sources()).values()].filter((s) => !names?.length || names.includes(s.name))
  const trees: TreeLookup = new Map()
  const manifests: ManifestCache = new Map()
  let stop: string | null = null
  await mapLimit(list, 4, async (s) => {
    if (stop) return
    const gh = await resolveSource(s, manifests)
    if (!hasGithub(gh)) return
    try {
      const up = await upstreamTree(gh.owner, gh.repo, gh.branch || 'main', gh.subPath || '', trees)
      gh.upstreamNoAccess = up.status === 'no-access'
      gh.upstreamMissing = up.status === 'missing'
      if (up.status !== 'no-access') gh.branch = up.branch // e.g. `master`, where older versions assumed `main`
      const tree = up.status === 'ok' ? up.tree : null
      if (tree) gh.latestTree = tree
      // A legacy commit-based record that is still current tells us the
      // installed folder IS today's upstream folder: adopt its tree.
      if (tree && !gh.installedTree && gh.installedCommit) {
        const legacy = await checkSkillUpdate(gh).catch(() => null)
        if (legacy && !legacy.hasUpdate) gh.installedTree = tree
      }
      gh.lastChecked = new Date().toISOString()
      gh.updateAvailable = upstreamAhead(gh)
      await writeSkillSource(s.realPath, gh)
      result.checked++
      if (gh.updateAvailable) result.withUpdates++
    } catch (err: any) {
      // Rate limit: the remaining checks would fail the same way.
      if (err instanceof GithubApiError && /次数用完/.test(err.message)) stop = err.message
      result.errors.push({ name: s.name, error: err?.message || String(err) })
    }
  })
  if (stop) result.errors.unshift({ name: '全部', error: stop })
  return result
}

// ── Copies ───────────────────────────────────────────────────────────────

/** Refresh stale copies (source changed, copy untouched) of `names` (or all). */
export async function refreshCopies(names?: string[]): Promise<{ refreshed: number; failed: number }> {
  const { actions } = await collectCopies()
  const todo = actions.filter((a) => a.type === 'update' && (!names?.length || names.includes(a.name)))
  const r = await executeActions(todo)
  return { refreshed: r.applied, failed: r.failed }
}

/** An edited copy and the directory it was copied from (warehouse or project-private skill). */
async function editedCopy(copyPath: string): Promise<{ action: PlanAction; origin: string }> {
  const { actions } = await collectCopies()
  const action = actions.find((x) => x.type === 'conflict' && x.linkPath === copyPath)
  if (!action) throw new Error('这个副本已不是"被单独修改"的状态，请刷新后重试')
  const marker = await readMarker(copyPath)
  const origin = marker?.originPath ? await realOr(marker.originPath) : null
  if (!origin) throw new Error('找不到这个副本的来源目录')
  return { action, origin }
}

/** Throw away the IDE's edits: the copy goes to the recycle bin and is re-copied from its source. */
export async function overwriteCopy(copyPath: string): Promise<void> {
  const { action, origin } = await editedCopy(copyPath)
  await withWriteLock(async () => {
    const tmp = await materializeCopy(origin, action.linkPath)
    await moveToTrash(action.linkPath, action.name)
    await fs.rename(tmp, action.linkPath)
  })
}

/**
 * Keep the IDE's edits: they become the source version (old source version
 * to the recycle bin), then every other copy is refreshed from it.
 */
export async function pullBackCopy(copyPath: string): Promise<void> {
  const { action, origin } = await editedCopy(copyPath)
  await withWriteLock(async () => {
    const staged = path.join(path.dirname(origin), `.${path.basename(origin)}.ss-pullback-${Date.now()}`)
    try {
      // The source keeps its own .skill-source (upstream info); the copy's
      // marker describes the copy.
      await copyDir(action.linkPath, staged, { skip: (n) => n === '.git' || n === '.skill-source' })
      const gh = await readSkillSource(origin)
      if (gh) await writeSkillSource(staged, gh)
      await moveToTrash(origin, action.name)
      await fs.rename(staged, origin)
    } catch (err) {
      await fs.rm(staged, { recursive: true, force: true }).catch(() => {})
      throw err
    }
    // Re-stamp this copy so it counts as an untouched copy of the new source.
    const tmp = await materializeCopy(origin, action.linkPath)
    const old = `${tmp}-old`
    await fs.rename(action.linkPath, old)
    await fs.rename(tmp, action.linkPath)
    await fs.rm(old, { recursive: true, force: true })
  })
  // For a GitHub skill the warehouse now differs from upstream — intended.
  await refreshCopies([action.name])
}

// ── Warehouse vs upstream ───────────────────────────────────────────────

export interface UpdateResult {
  updated: string[]
  skipped: { name: string; reason: string }[]
  failed: { name: string; error: string }[]
  copiesRefreshed: number
}

/**
 * One-click update. Without `force`, only skills in state `upstream` are
 * updated; locally edited ones are skipped and reported. `force` (per skill,
 * explicit names only) takes upstream and sends the local version to the
 * recycle bin. Afterwards every copy of an updated skill is refreshed.
 */
export async function updateSkills(opts: { names?: string[]; force?: boolean } = {}): Promise<UpdateResult> {
  const report = await versionsReport()
  const wanted = opts.names?.length ? report.skills.filter((s) => opts.names!.includes(s.name)) : report.skills
  const result: UpdateResult = { updated: [], skipped: [], failed: [], copiesRefreshed: 0 }
  const force = !!opts.force && !!opts.names?.length

  for (const s of wanted) {
    if (s.kind !== 'github') {
      if (opts.names?.length) result.skipped.push({ name: s.name, reason: '没有 GitHub 来源' })
      continue
    }
    if (s.source?.missing || s.source?.noAccess) {
      if (opts.names?.length) result.skipped.push({ name: s.name, reason: s.source.missing ? '上游已经删除或移动了这个目录，没有可更新的版本' : '无法访问上游仓库' })
      continue
    }
    const takeable = s.state === 'upstream' || (force && (s.state === 'conflict' || s.state === 'local-edited'))
    if (!takeable) {
      if (s.state === 'conflict' || s.state === 'local-edited') result.skipped.push({ name: s.name, reason: '本地有修改，需要你决定' })
      else if (opts.names?.length) result.skipped.push({ name: s.name, reason: '已是最新' })
      continue
    }
    try {
      const gh = (await readSkillSource(s.realPath))!
      await updateSkillFromGithub(s.realPath, gh, s.state === 'local-edited' ? undefined : gh.latestCommit, {
        // keep the replaced version when it had local edits, or when we never knew which commit it was
        trashOld: s.state !== 'upstream' || (!gh.installedTree && !gh.installedCommit),
      })
      await setBaseline(s.realPath, await getSkillFolderHash(s.realPath), 'update', await getSkillFolderSignature(s.realPath))
      result.updated.push(s.name)
    } catch (err: any) {
      result.failed.push({ name: s.name, error: err?.message || String(err) })
    }
  }
  if (result.updated.length) result.copiesRefreshed = (await refreshCopies(result.updated)).refreshed
  return result
}

/**
 * Keep local edits: they become the new baseline, and the current upstream
 * commit is ignored (a newer one will be reported again).
 */
export async function keepLocal(name: string): Promise<void> {
  const s = await findSource(name)
  const gh = await readSkillSource(s.realPath)
  if (hasGithub(gh) && upstreamAhead(gh)) {
    if (gh.latestTree) gh.ignoredTree = gh.latestTree
    if (gh.latestCommit) gh.ignoredCommit = gh.latestCommit
    gh.updateAvailable = false
    await writeSkillSource(s.realPath, gh)
  }
  await setBaseline(s.realPath, await getSkillFolderHash(s.realPath), 'accept', await getSkillFolderSignature(s.realPath))
}

/** Record a freshly installed skill's source and baseline. */
export async function recordInstall(skillDir: string, source: SkillGithubSource | null): Promise<void> {
  const real = await fs.realpath(skillDir).catch(() => skillDir)
  if (source) await writeSkillSource(real, source)
  await setBaseline(real, await getSkillFolderHash(real), 'install', await getSkillFolderSignature(real))
}

/**
 * Tell Skill Studio where a warehouse skill comes from (a skill copied in by
 * hand from GitHub). Its commit is unknown, so the next check reports an
 * update; taking it keeps the current version in the recycle bin.
 */
export async function bindSource(name: string, url: string): Promise<void> {
  const parsed = parseGithubUrl(url)
  if (!parsed) throw new Error('无法识别的 GitHub 地址，请用 owner/repo 或 GitHub 网址（可带 /tree/分支/子目录）')
  const s = await findSource(name)
  await writeSkillSource(s.realPath, { ...parsed, installedAt: new Date().toISOString(), updateAvailable: false })
  await checkUpstream([name])
}

/** Forget a skill's GitHub source: it becomes a self-made skill (e.g. the folder is gone upstream). */
export async function unbindSource(name: string): Promise<void> {
  const s = await findSource(name)
  const gh = await readSkillSource(s.realPath)
  if (!gh) return
  // Keep a non-GitHub marker (copy origin etc.) if any; drop the upstream fields.
  for (const k of ['owner', 'repo', 'branch', 'subPath', 'installedCommit', 'latestCommit', 'installedTree', 'latestTree', 'ignoredCommit', 'ignoredTree', 'upstreamMissing', 'upstreamNoAccess', 'updateAvailable', 'lastChecked'] as const) delete gh[k]
  gh.unbound = true
  await writeSkillSource(s.realPath, gh)
}
