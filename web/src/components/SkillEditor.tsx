import { useState } from 'react'
import type { Skill } from '../hooks/useSkills'

interface SkillEditorProps {
  skill: Skill
  onSave: (content: string) => Promise<void>
  onClose: () => void
}

export function SkillEditor({ skill, onSave, onClose }: SkillEditorProps) {
  const [content, setContent] = useState(skill.content)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(content)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  const hasChanges = content !== skill.content

  return (
    <div className="w-full h-full bg-slate-900/10 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3.5 border-b border-slate-800/80 flex items-center justify-between shrink-0">
        <div className="min-w-0 flex-1 mr-2">
          <h2 className="text-sm font-bold text-slate-100">编辑 SKILL.md</h2>
          <p className="text-[10px] text-slate-500 mt-0.5 font-mono truncate">{skill.realPath}/SKILL.md</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {saved && (
            <span className="text-xs text-green-400 animate-pulse">已保存</span>
          )}
          <button
            onClick={handleSave}
            disabled={saving || !hasChanges}
            className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40
                       rounded-lg text-xs font-medium text-white transition-all"
          >
            {saving ? '保存中...' : '保存'}
          </button>
          <button
            onClick={onClose}
            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs text-slate-300 transition-colors"
          >
            关闭
          </button>
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-hidden">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          className="w-full h-full bg-slate-950 text-slate-200 font-mono text-xs p-4
                     resize-none focus:outline-none leading-relaxed"
          placeholder="---
name: my-skill
description: Skill description
---

Your skill instructions here..."
        />
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-slate-800/80 flex items-center justify-between text-[10px] text-slate-500 shrink-0">
        <span>{hasChanges ? '有未保存的修改' : '无修改'}</span>
        <span>Ctrl+S / Cmd+S 保存</span>
      </div>
    </div>
  )
}
