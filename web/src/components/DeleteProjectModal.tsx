import React, { useState } from 'react'

interface DeleteProjectModalProps {
  isOpen: boolean
  projectName: string
  projectPath: string
  onClose: () => void
  onConfirm: (purgeFiles: boolean) => Promise<void>
}

export const DeleteProjectModal: React.FC<DeleteProjectModalProps> = ({
  isOpen,
  projectName,
  projectPath,
  onClose,
  onConfirm,
}) => {
  const [purgeFiles, setPurgeFiles] = useState(false)
  const [loading, setLoading] = useState(false)

  if (!isOpen) return null

  const handleConfirm = async () => {
    setLoading(true)
    try {
      await onConfirm(purgeFiles)
      onClose()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="p-6">
          <div className="flex items-center gap-3 text-red-400 mb-4">
            <div className="p-2.5 bg-red-500/10 rounded-lg border border-red-500/20">
              <span className="text-xl">🗑️</span>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-slate-100">确认删除项目</h3>
              <p className="text-xs text-slate-400">移除项目管理关联与扫描结果</p>
            </div>
          </div>

          <div className="bg-slate-950/60 rounded-lg p-3 border border-slate-800/80 mb-4 font-mono text-xs">
            <div className="text-slate-300 font-semibold truncate mb-1">{projectName}</div>
            <div className="text-slate-500 truncate">{projectPath}</div>
          </div>

          <div className="text-sm text-slate-300 space-y-2 mb-6">
            <p className="text-xs text-slate-400 leading-relaxed">
              项目将被加入隐藏排除列表，后续全盘扫描将不再显示该项目。
            </p>

            <label className="flex items-start gap-2.5 p-3 rounded-lg bg-red-950/20 border border-red-900/30 cursor-pointer hover:bg-red-950/30 transition-colors mt-3">
              <input
                type="checkbox"
                checked={purgeFiles}
                onChange={(e) => setPurgeFiles(e.target.checked)}
                className="mt-0.5 rounded border-red-800 text-red-500 focus:ring-red-500/40 bg-slate-900"
              />
              <div className="text-xs">
                <span className="font-medium text-red-300 block">物理清理项目磁盘技能配置文件</span>
                <span className="text-red-400/80 text-[11px]">
                  同时彻底删除磁盘上的 <code className="bg-slate-900 px-1 py-0.5 rounded border border-red-900/40 text-red-200">.skills-profile.json</code> 和项目下的技能子目录。
                </span>
              </div>
            </label>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-800/60">
            <button
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 rounded-lg transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleConfirm}
              disabled={loading}
              className="px-4 py-2 text-xs font-medium bg-red-600 hover:bg-red-500 active:bg-red-700 text-white rounded-lg shadow-lg shadow-red-900/30 transition-all flex items-center gap-1.5 disabled:opacity-50"
            >
              {loading ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  删除中...
                </>
              ) : (
                '确认删除项目'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
