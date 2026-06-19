/**
 * Minimal GitHub REST client. Only the calls sync actually needs.
 * Uses the built-in fetch (Node 20+).
 */

export interface RepoInfo {
  fullName: string
  defaultBranch: string
  private: boolean
  canPush: boolean
  htmlUrl: string
}

export type ValidationResult =
  | { ok: true; repo: RepoInfo }
  | { ok: false; reason: 'bad_token' | 'not_found' | 'no_push' | 'network' | 'unknown'; message: string }

const API_BASE = 'https://api.github.com'

function headers(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'skill-hub',
  }
}

export async function validateRepo(
  owner: string,
  name: string,
  token: string,
): Promise<ValidationResult> {
  const url = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  let res: Response
  try {
    res = await fetch(url, { headers: headers(token) })
  } catch (e: any) {
    return { ok: false, reason: 'network', message: e?.message || 'network error' }
  }

  if (res.status === 401) {
    return { ok: false, reason: 'bad_token', message: 'Token 无效或已过期' }
  }
  if (res.status === 404) {
    return {
      ok: false,
      reason: 'not_found',
      message: '仓库不存在,或 token 没有访问权限(检查仓库名与 token 的 repo scope)',
    }
  }
  if (!res.ok) {
    return { ok: false, reason: 'unknown', message: `GitHub API ${res.status}: ${await res.text()}` }
  }

  const data = (await res.json()) as any
  const canPush = Boolean(data?.permissions?.push)
  if (!canPush) {
    return {
      ok: false,
      reason: 'no_push',
      message: 'Token 有效,但对该仓库没有写权限。请使用带 repo scope(或 Fine-grained: Contents: Read & Write)的 token。',
    }
  }

  // 额外通过实际的 Git ls-remote 做连通性与鉴权测试，确保 Token 具有真实的 Git 操作权限
  try {
    const { runGit } = await import('./vault.js')
    const expectedRemote = `https://github.com/${owner}/${name}.git`
    const gitCheck = await runGit(['ls-remote', '-h', expectedRemote], { token, timeoutMs: 15000 })
    if (gitCheck.code !== 0) {
      const gitErr = gitCheck.stderr || gitCheck.stdout
      if (gitErr.includes('Authentication failed') || gitErr.includes('Invalid username or token')) {
        return {
          ok: false,
          reason: 'bad_token',
          message: 'Token 认证失败（Git 操作被拒绝）。请检查 Token 是否有效，或是否在 Fine-grained Token 的 Repository permissions 下为 Contents 授予了 Read & Write 权限。'
        }
      }
      return {
        ok: false,
        reason: 'network',
        message: `无法通过 Git 连接到该仓库: ${gitErr.trim()}`
      }
    }
  } catch (err: any) {
    return {
      ok: false,
      reason: 'unknown',
      message: `验证 Git 连通性时发生错误: ${err.message}`
    }
  }

  return {
    ok: true,
    repo: {
      fullName: data.full_name,
      defaultBranch: data.default_branch || 'main',
      private: Boolean(data.private),
      canPush: true,
      htmlUrl: data.html_url,
    },
  }
}
