import path from 'path'
import { readIdeSettingsFull } from '../settings.js'

/**
 * What a skill's folder looks like upstream, as a git tree SHA.
 *
 * Comparing tree SHAs instead of commit SHAs means: only a change inside the
 * skill's own folder counts as an update (commits elsewhere in the repo
 * don't), skills installed by `npx skills add` can be compared directly (its
 * lock file records the folder's tree SHA as `skillFolderHash`), and a folder
 * that was removed or moved upstream is detected.
 *
 * One request per (repo, branch, parent dir): all skills under the same
 * parent share it.
 */

export type TreeLookup = Map<string, Promise<any>>

export class GithubApiError extends Error {}

async function api(url: string): Promise<Response> {
  const token = (await readIdeSettingsFull().catch(() => ({}) as any)).githubToken
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'Skill-Studio' }
  if (typeof token === 'string' && token.trim()) headers.Authorization = `token ${token.trim()}`
  return fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
}

async function failure(res: Response): Promise<GithubApiError> {
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    const when = reset ? `，${new Date(reset * 1000).toLocaleTimeString()} 后恢复` : ''
    return new GithubApiError(`GitHub API 次数用完了${when}。在设置里填 GitHub Token 可以提高上限`)
  }
  return new GithubApiError(`GitHub API 错误（${res.status}）`)
}

/** Repository info, or null when it can't be read (private without access, deleted). */
function repoInfo(owner: string, repo: string, cache: TreeLookup): Promise<{ defaultBranch: string } | null> {
  const key = `repo:${owner}/${repo}`
  let hit = cache.get(key)
  if (!hit) {
    hit = (async () => {
      const res = await api(`https://api.github.com/repos/${owner}/${repo}`)
      if (res.status === 404) return null
      if (!res.ok) throw await failure(res)
      return { defaultBranch: ((await res.json()) as any).default_branch || 'main' }
    })()
    cache.set(key, hit)
  }
  return hit
}

/** name → tree SHA of every sub-directory of `dir` (repo root when ''), or 'missing'. */
function listDirs(owner: string, repo: string, branch: string, dir: string, cache: TreeLookup): Promise<Map<string, string> | 'missing'> {
  const key = `dirs:${owner}/${repo}@${branch}:${dir}`
  let hit = cache.get(key)
  if (!hit) {
    hit = (async () => {
      const enc = dir.split('/').map(encodeURIComponent).join('/')
      const res = await api(`https://api.github.com/repos/${owner}/${repo}/contents/${enc}?ref=${encodeURIComponent(branch)}`)
      if (res.status === 404) return 'missing' as const
      if (!res.ok) throw await failure(res)
      const items = (await res.json()) as any
      if (!Array.isArray(items)) return 'missing' as const // a file, not a directory
      return new Map(items.filter((e: any) => e.type === 'dir').map((e: any) => [e.name as string, e.sha as string]))
    })()
    cache.set(key, hit)
  }
  return hit
}

async function rootTree(owner: string, repo: string, branch: string): Promise<string | null> {
  const res = await api(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}`)
  if (res.status === 404) return null
  if (!res.ok) throw await failure(res)
  return ((await res.json()) as any).sha ?? null
}

async function branchExists(owner: string, repo: string, branch: string, cache: TreeLookup): Promise<boolean> {
  const key = `branch:${owner}/${repo}@${branch}`
  let hit = cache.get(key)
  if (!hit) {
    hit = api(`https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`).then(async (res) => {
      if (res.status === 404) return false
      if (!res.ok) throw await failure(res)
      return true
    })
    cache.set(key, hit)
  }
  return hit
}

export type UpstreamLookup =
  /** The folder's tree SHA on `branch` (may differ from the recorded branch: default-branch fallback). */
  | { status: 'ok'; tree: string; branch: string }
  /** Repo readable, folder not there: removed, renamed or moved. */
  | { status: 'missing'; branch: string }
  /** Repo can't be read: private without access via the token, or deleted. */
  | { status: 'no-access' }

/**
 * Upstream state of the skill folder `subPath`. A recorded branch that no
 * longer exists (older versions assumed `main`) falls back to the
 * repository's default branch.
 */
export async function upstreamTree(owner: string, repo: string, branch: string, subPath: string, cache: TreeLookup): Promise<UpstreamLookup> {
  const info = await repoInfo(owner, repo, cache)
  if (!info) return { status: 'no-access' }
  const ref = (await branchExists(owner, repo, branch, cache)) ? branch : info.defaultBranch
  const clean = subPath.replace(/^\/+|\/+$/g, '')
  if (!clean) {
    const tree = await rootTree(owner, repo, ref)
    return tree ? { status: 'ok', tree, branch: ref } : { status: 'missing', branch: ref }
  }
  const parent = path.posix.dirname(clean)
  const dirs = await listDirs(owner, repo, ref, parent === '.' ? '' : parent, cache)
  const tree = dirs === 'missing' ? undefined : dirs.get(path.posix.basename(clean))
  return tree ? { status: 'ok', tree, branch: ref } : { status: 'missing', branch: ref }
}
