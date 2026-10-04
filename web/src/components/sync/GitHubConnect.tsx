import { useState } from 'react'
import { DownloadSection } from './DownloadSection'
import { UploadSection } from './UploadSection'
import { formatTime } from './shared'

export interface PublicSyncConfig {
  connected: boolean
  repoUrl: string | null
  owner: string | null
  name: string | null
  defaultBranch: string | null
  hasToken: boolean
  lastValidatedAt: string | null
}

export function ConnectForm({ onConnected }: { onConnected: () => void }) {
  const [repoUrl, setRepoUrl] = useState('')
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (endpoint: '/api/sync/validate' | '/api/sync/config') => {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl, token }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || '未知错误')
        return null
      }
      return data
    } catch (e: any) {
      setError(e?.message || '请求失败')
      return null
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 space-y-5">
      <div>
        <label className="block text-xs text-slate-400 mb-1.5 font-medium">GitHub 仓库地址</label>
        <input
          type="text"
          placeholder="https://github.com/用户名/仓库名  或  用户名/仓库名"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          className="w-full text-sm placeholder:text-slate-500"
        />
        <p className="text-[11px] text-slate-600 mt-1.5">
          建议使用一个新的私有仓库。如果还没有,可以先到 GitHub 创建一个空仓库。
        </p>
      </div>

      <div>
        <label className="block text-xs text-slate-400 mb-1.5 font-medium">
          Personal Access Token
        </label>
        <input
          type="password"
          placeholder="ghp_... 或 github_pat_..."
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="w-full text-sm font-mono placeholder:text-slate-500"
        />
        <p className="text-[11px] text-slate-600 mt-1.5">
          <a
            href="https://github.com/settings/tokens/new?description=Skill%20Hub&scopes=repo"
            target="_blank"
            rel="noreferrer"
            className="text-blue-500 hover:underline"
          >
            在此创建 Token
          </a>{' '}
          — 需要 <code className="text-slate-400 bg-slate-950 px-1 rounded">repo</code> scope(或
          Fine-grained 的 Contents: Read & Write)。Token 会保存在 ~/.config/skill-hub/credentials.json
          (权限 600),仅本机可读。
        </p>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={async () => {
            const data = await submit('/api/sync/config')
            if (data?.ok) onConnected()
          }}
          disabled={submitting || !repoUrl || !token}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium text-white transition-all shadow-lg shadow-indigo-600/20"
        >
          {submitting ? '验证中...' : '验证并保存'}
        </button>
        <button
          onClick={() => submit('/api/sync/validate')}
          disabled={submitting || !repoUrl || !token}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm text-slate-300 transition-all"
        >
          仅验证(不保存)
        </button>
      </div>
    </div>
  )
}

export function ConnectedPanel({
  config,
  onDisconnect,
  onRevalidated,
}: {
  config: PublicSyncConfig
  onDisconnect: () => void
  onRevalidated: () => void
}) {
  const [busy, setBusy] = useState<'revalidate' | 'disconnect' | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const revalidate = async () => {
    setBusy('revalidate')
    setMsg(null)
    try {
      const res = await fetch('/api/sync/revalidate', { method: 'POST' })
      const data = await res.json()
      if (data.ok) {
        setMsg({ kind: 'ok', text: '仓库连接正常' })
        onRevalidated()
      } else {
        setMsg({ kind: 'err', text: data.error || '校验失败' })
      }
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async () => {
    if (!confirm('断开连接会删除本机保存的 Token。本地的 Skills 文件不受影响。继续?')) return
    setBusy('disconnect')
    try {
      await fetch('/api/sync/config', { method: 'DELETE' })
      onDisconnect()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-sm text-green-400 font-medium">已连接</span>
          </div>
          <div className="text-base text-slate-100 font-semibold">
            {config.owner}/{config.name}
          </div>
          <a
            href={config.repoUrl || '#'}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-indigo-400 hover:text-indigo-300 underline"
          >
            {config.repoUrl}
          </a>
        </div>
        <div className="text-right text-[11px] text-slate-500 space-y-0.5">
          <div>默认分支: <span className="text-slate-400">{config.defaultBranch}</span></div>
          {config.lastValidatedAt && (
            <div>上次验证: <span className="text-slate-400">{formatTime(config.lastValidatedAt)}</span></div>
          )}
        </div>
      </div>

      {msg && (
        <div
          className={`p-3 rounded-lg text-sm border ${
            msg.kind === 'ok'
              ? 'bg-green-500/10 border-green-500/20 text-green-400'
              : 'bg-red-500/10 border-red-500/20 text-red-400'
          }`}
        >
          {msg.text}
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={revalidate}
          disabled={busy !== null}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded-lg text-sm text-slate-300 transition-all"
        >
          {busy === 'revalidate' ? '验证中...' : '重新验证'}
        </button>
        <button
          onClick={disconnect}
          disabled={busy !== null}
          className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 disabled:opacity-40 rounded-lg text-sm text-red-400 transition-all"
        >
          {busy === 'disconnect' ? '断开中...' : '断开连接'}
        </button>
      </div>

      <UploadSection />
      <DownloadSection />
    </div>
  )
}
