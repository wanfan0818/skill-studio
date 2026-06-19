import { readIdeSettingsFull } from '../routes/manage.js'
import type { SkillGithubSource } from '../types.js'

export interface GithubRateLimit {
  limit: number
  remaining: number
  reset: number
}

export interface CheckUpdateResult {
  hasUpdate: boolean
  latestCommit: string
  latestDate: string
  rateLimit: GithubRateLimit
}

export async function getGithubRateLimit(): Promise<GithubRateLimit> {
  const settings = await readIdeSettingsFull()
  const token = settings.githubToken

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Claude-Skill-Hub',
  }

  if (token && token.trim() !== '') {
    headers['Authorization'] = `token ${token.trim()}`
  }

  try {
    const response = await fetch('https://api.github.com/rate_limit', { headers })
    if (!response.ok) {
      return { limit: 60, remaining: 60, reset: 0 }
    }

    const data = await response.json() as any
    return {
      limit: data.rate.limit,
      remaining: data.rate.remaining,
      reset: data.rate.reset,
    }
  } catch {
    return { limit: 60, remaining: 60, reset: 0 }
  }
}

export async function checkSkillUpdate(
  source: SkillGithubSource
): Promise<CheckUpdateResult> {
  const settings = await readIdeSettingsFull()
  const token = settings.githubToken

  const { owner, repo, branch, subPath, installedCommit } = source

  // Build query URL
  let url = `https://api.github.com/repos/${owner}/${repo}/commits?sha=${branch || 'main'}&per_page=1`
  if (subPath) {
    url += `&path=${encodeURIComponent(subPath)}`
  }

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Claude-Skill-Hub',
  }

  if (token && token.trim() !== '') {
    headers['Authorization'] = `token ${token.trim()}`
  }

  const response = await fetch(url, { headers })

  const rateLimit: GithubRateLimit = {
    limit: parseInt(response.headers.get('x-ratelimit-limit') || '0', 10),
    remaining: parseInt(response.headers.get('x-ratelimit-remaining') || '0', 10),
    reset: parseInt(response.headers.get('x-ratelimit-reset') || '0', 10),
  }

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`GitHub API 错误 (${response.status}): ${errText}`)
  }

  const commits = await response.json() as any[]
  if (!commits || commits.length === 0) {
    throw new Error('在该仓库路径下未找到任何 commit 记录')
  }

  const latestCommit = commits[0].sha
  const latestDate = commits[0].commit?.committer?.date || commits[0].commit?.author?.date || new Date().toISOString()

  const hasUpdate = installedCommit ? (installedCommit !== latestCommit) : true

  return {
    hasUpdate,
    latestCommit,
    latestDate,
    rateLimit,
  }
}
