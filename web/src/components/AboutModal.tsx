import { useEffect, useState } from 'react'

interface Props {
  open: boolean
  onClose: () => void
  stats: { total: number; global: number; project: number }
  conflictCount: number
}

const VERSION = '0.3.0'

export function AboutModal({ open, onClose, stats, conflictCount }: Props) {
  // Lock scroll while open + esc to close
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-8 shadow-2xl relative"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-all flex items-center justify-center"
          aria-label="关闭"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {/* Logo + title */}
        <div className="flex flex-col items-center text-center mb-6">
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-tr from-indigo-600 via-purple-600 to-cyan-500 flex items-center justify-center text-white font-bold text-3xl shadow-lg shadow-indigo-600/20 mb-4">
            S
          </div>
          <h2 className="text-xl font-bold text-slate-100 mb-1">Skill Studio · 技能库</h2>
          <div className="text-xs text-slate-500 mb-3">v{VERSION}</div>
          <p className="text-sm text-slate-400 leading-relaxed max-w-xs">
            多 Agent 本地 Skill 可视化统筹与多端软链分发管理工具
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-2 mb-6">
          <StatCell label="管理中" value={stats.total} />
          <StatCell label="全局" value={stats.global} />
          <StatCell label="项目级" value={stats.project} />
          <StatCell label="冲突" value={conflictCount} warn={conflictCount > 0} />
        </div>

        {/* User & Environment Info */}
        <div className="space-y-2 mb-2 text-left">
          <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-800/40 border border-slate-800/60">
            <div className="w-8 h-8 rounded-lg bg-slate-950 flex items-center justify-center text-indigo-400 text-sm font-bold shrink-0">
              👤
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] text-slate-500">当前用户</div>
              <div className="text-xs text-slate-200 truncate font-mono">wanfan</div>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-800/40 border border-slate-800/60">
            <div className="w-8 h-8 rounded-lg bg-slate-950 flex items-center justify-center text-indigo-400 text-sm font-bold shrink-0">
              ✉️
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] text-slate-500">用户邮箱</div>
              <div className="text-xs text-slate-200 truncate font-mono">nashirenran@gmail.com</div>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-800/40 border border-slate-800/60">
            <div className="w-8 h-8 rounded-lg bg-slate-950 flex items-center justify-center text-indigo-400 text-sm font-bold shrink-0">
              💻
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] text-slate-500">系统环境</div>
              <div className="text-xs text-slate-200 truncate font-mono">macOS (Localhost)</div>
            </div>
          </div>
        </div>

        <p className="text-[9px] text-slate-600 text-center mt-6">
          Skill Studio 可视化管理器 · MIT License
        </p>
      </div>
    </div>
  )
}

function StatCell({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div
      className={`p-2.5 rounded-lg border text-center ${
        warn ? 'bg-amber-500/10 border-amber-500/30' : 'bg-slate-800/50 border-slate-800'
      }`}
    >
      <div className={`text-lg font-bold tabular-nums ${warn ? 'text-amber-300' : 'text-slate-200'}`}>
        {value}
      </div>
      <div className="text-[10px] text-slate-500 mt-0.5">{label}</div>
    </div>
  )
}

// --- Inline SVG icons (no deps) ---

function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

function JikeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="10" fill="#FFE411" />
      <text x="12" y="16" textAnchor="middle" fontSize="11" fontWeight="bold" fill="#000">J</text>
    </svg>
  )
}

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

function WechatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.328.328 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.01.812-.033-.218-.67-.337-1.377-.337-2.113 0-4.317 4.182-7.813 9.336-7.813.225 0 .447.01.67.027C17.797 4.34 13.65 2.188 8.691 2.188zM5.785 6.752c.662 0 1.2.538 1.2 1.2a1.201 1.201 0 0 1-2.4 0c0-.662.537-1.2 1.2-1.2zm5.813 0c.664 0 1.2.538 1.2 1.2a1.201 1.201 0 0 1-2.4 0c0-.662.537-1.2 1.2-1.2zm3.706 2.627c-4.54 0-8.23 3.12-8.23 6.682 0 3.562 3.69 6.682 8.23 6.682.822 0 1.624-.103 2.386-.295a.721.721 0 0 1 .607.082l1.585.928a.281.281 0 0 0 .139.045.246.246 0 0 0 .246-.246c0-.061-.024-.12-.04-.18l-.326-1.233a.49.49 0 0 1 .178-.554C22.019 22.214 23 20.547 23 18.69c0-3.562-3.69-6.312-8.23-6.312l.534-2.999zm-2.588 2.228c.551 0 1 .449 1 1a1.001 1.001 0 0 1-2 0c0-.551.449-1 1-1zm4.964 0c.551 0 1 .449 1 1a1.001 1.001 0 0 1-2 0c0-.551.449-1 1-1z" />
    </svg>
  )
}
