import { useState } from 'react'
import { Stat, StatusPill } from './shared'

export interface ScanFinding {
  file: string
  line: number
  column: number
  match: string
  kind: string
  severity: 'danger' | 'warn'
}

export interface UploadPreview {
  localSkillCount: number
  syncableSkillCount: number
  excludedSkillCount: number
  skillChanges: {
    agent: string
    name: string
    vaultDir: string
    status: 'add' | 'update' | 'delete' | 'unchanged'
    filesAdded: number
    filesUpdated: number
    filesDeleted: number
    filesUnchanged: number
  }[]
  totals: {
    skillsAdded: number
    skillsUpdated: number
    skillsDeleted: number
    skillsUnchanged: number
    filesAdded: number
    filesUpdated: number
    filesDeleted: number
  }
  scan: { totalFindings: number; danger: number; warn: number; findings: ScanFinding[] }
  skippedFiles: { relPath: string; reason: string }[]
}

export function UploadSection() {
  const [preview, setPreview] = useState<UploadPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [allowSecrets, setAllowSecrets] = useState(false)
  const [resultMsg, setResultMsg] = useState<string | null>(null)

  const openPreview = async () => {
    setLoading(true)
    setError(null)
    setPreview(null)
    setAllowSecrets(false)
    setResultMsg(null)
    try {
      const res = await fetch('/api/sync/upload/preview', { method: 'POST' })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || '预览失败')
        return
      }
      setPreview(data.preview)
    } catch (e: any) {
      setError(e?.message || '预览失败')
    } finally {
      setLoading(false)
    }
  }

  const confirmUpload = async () => {
    setConfirming(true)
    setError(null)
    try {
      const res = await fetch('/api/sync/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowSecrets }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.error || '上传失败')
        if (data.preview) setPreview(data.preview)
        return
      }
      setResultMsg(data.noop ? '没有需要上传的改动' : `上传成功 (${data.sha.slice(0, 7)})`)
      setPreview(null)
    } catch (e: any) {
      setError(e?.message || '上传失败')
    } finally {
      setConfirming(false)
    }
  }

  const t = preview?.totals
  const hasChanges = t ? t.skillsAdded + t.skillsUpdated + t.skillsDeleted > 0 : false
  const hasDanger = (preview?.scan.danger ?? 0) > 0

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-200 mb-1">上传到 GitHub</h3>
          <p className="text-xs text-slate-500">
            把本机所有 Skill(自动排除 marketplace/plugin)备份到仓库。先预览再确认。
          </p>
        </div>
        <button
          onClick={openPreview}
          disabled={loading}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg text-sm font-medium text-white transition-all shadow-lg shadow-indigo-600/20"
        >
          {loading ? '预览中...' : '预览上传'}
        </button>
      </div>

      {resultMsg && (
        <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-sm">
          ✓ {resultMsg}
        </div>
      )}

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      {preview && (
        <div className="space-y-3 pt-2">
          <div className="text-xs text-slate-400">
            本机共 <span className="text-slate-200 font-semibold">{preview.localSkillCount}</span> 个 Skill,
            其中{' '}
            <span className="text-slate-200 font-semibold">{preview.syncableSkillCount}</span> 个可同步,
            <span className="text-slate-600"> {preview.excludedSkillCount} 个已排除(marketplace/plugin)</span>。
          </div>

          {/* Totals */}
          <div className="grid grid-cols-4 gap-2">
            <Stat label="新增" value={t!.skillsAdded} color="green" />
            <Stat label="更新" value={t!.skillsUpdated} color="amber" />
            <Stat label="删除" value={t!.skillsDeleted} color="red" />
            <Stat label="未变" value={t!.skillsUnchanged} color="slate" />
          </div>

          {/* Secret scan */}
          {preview.scan.totalFindings > 0 && (
            <div
              className={`p-3 rounded-lg border text-xs ${
                hasDanger
                  ? 'bg-red-500/10 border-red-500/30 text-red-300'
                  : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
              }`}
            >
              <div className="font-medium mb-1.5">
                {hasDanger ? '⚠ 检测到疑似密钥' : '注意'}(
                {preview.scan.danger} 个敏感 / {preview.scan.warn} 个警告)
              </div>
              <div className="max-h-32 overflow-y-auto space-y-0.5 font-mono text-[11px] leading-snug">
                {preview.scan.findings.slice(0, 20).map((f, i) => (
                  <div key={i} className="truncate">
                    <span className={f.severity === 'danger' ? 'text-red-400' : 'text-amber-400'}>
                      [{f.kind}]
                    </span>{' '}
                    <span className="text-slate-400">{f.file}:{f.line}</span>{' '}
                    <span className="text-slate-500">— {f.match}</span>
                  </div>
                ))}
                {preview.scan.findings.length > 20 && (
                  <div className="text-slate-500">...还有 {preview.scan.findings.length - 20} 条</div>
                )}
              </div>
              {hasDanger && (
                <label className="flex items-center gap-2 mt-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allowSecrets}
                    onChange={(e) => setAllowSecrets(e.target.checked)}
                    className="w-3.5 h-3.5"
                  />
                  <span className="text-red-300">我已确认,这些是误报,继续上传</span>
                </label>
              )}
            </div>
          )}

          {/* Per-skill changes */}
          <div className="max-h-60 overflow-y-auto border border-slate-800 rounded-lg divide-y divide-slate-800/60">
            {preview.skillChanges
              .filter((c) => c.status !== 'unchanged')
              .map((c, i) => (
                <div key={i} className="px-3 py-2 text-xs flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusPill status={c.status} />
                    <span className="text-slate-300 truncate">{c.vaultDir}</span>
                  </div>
                  <div className="text-slate-500 text-[11px] shrink-0">
                    {c.filesAdded > 0 && <span className="text-green-400">+{c.filesAdded} </span>}
                    {c.filesUpdated > 0 && <span className="text-amber-400">~{c.filesUpdated} </span>}
                    {c.filesDeleted > 0 && <span className="text-red-400">-{c.filesDeleted}</span>}
                  </div>
                </div>
              ))}
            {!hasChanges && <div className="px-3 py-4 text-xs text-slate-500 text-center">仓库已是最新</div>}
          </div>

          {/* Confirm button */}
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={confirmUpload}
              disabled={confirming || (hasDanger && !allowSecrets) || !hasChanges}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium text-white"
            >
              {confirming ? '上传中...' : hasChanges ? '确认上传' : '无变动'}
            </button>
            <button
              onClick={() => setPreview(null)}
              disabled={confirming}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded-lg text-sm text-slate-300"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
