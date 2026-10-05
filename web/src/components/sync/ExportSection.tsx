import { useState } from 'react'

export function ExportSection() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const download = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/sync/export/tar')
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: '导出失败' }))
        setError(data.error || `HTTP ${res.status}`)
        return
      }
      const skillCount = res.headers.get('X-Skill-Count') || '?'
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const cd = res.headers.get('Content-Disposition') || ''
      const match = cd.match(/filename="([^"]+)"/)
      const filename = match?.[1] || 'skill-hub-backup.tar.gz'
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      console.info(`[skill-hub] exported ${skillCount} skills as ${filename}`)
    } catch (e: any) {
      setError(e?.message || '导出失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-slate-900/40 border border-slate-800/60 rounded-xl p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-300 mb-1">导出为 tar.gz(离线备份)</h3>
          <p className="text-xs text-slate-500">
            不想用 GitHub?直接导出一个压缩包,解压后把 <code className="text-slate-400 bg-slate-950 px-1 rounded">&lt;agent&gt;/&lt;skill&gt;/</code> 目录拷贝到目标机器即可。
          </p>
        </div>
        <button
          onClick={download}
          disabled={busy}
          className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 rounded-lg text-xs text-slate-300 whitespace-nowrap"
        >
          {busy ? '打包中...' : '下载 .tar.gz'}
        </button>
      </div>
      {error && (
        <div className="p-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
          {error}
        </div>
      )}
    </div>
  )
}
