import { useState } from 'react'
import { SourceBadge, ScopeBadge } from './SourceBadge'
import { SkillEditor } from './SkillEditor'
import { VersionHistory } from './VersionHistory'

import type { Skill, Project } from '../hooks/useSkills'

interface SkillDetailProps {
  skill: Skill
  projects: Project[]
  onClose: () => void
  onToggle: (skill: Skill, enabled: boolean) => Promise<void>
  onSaveContent: (skill: Skill, content: string) => Promise<void>
  onCopy: (skill: Skill, targetScope: 'global' | 'project', projectPath?: string) => Promise<void>
  onMove: (skill: Skill, targetScope: 'global' | 'project', projectPath?: string) => Promise<void>
  onDelete: (skill: Skill) => Promise<void>
  onChanged?: () => Promise<void>
}

export function SkillDetail({
  skill,
  projects,
  onClose,
  onToggle,
  onSaveContent,
  onCopy,
  onMove,
  onDelete,
  onChanged,
}: SkillDetailProps) {
  const [editing, setEditing] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [showActions, setShowActions] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [bindUrl, setBindUrl] = useState('')
  const [isEditingBind, setIsEditingBind] = useState(false)
  const [bindLoading, setBindLoading] = useState(false)
  const [checkLoading, setCheckLoading] = useState(false)
  const [updateLoading, setUpdateLoading] = useState(false)

  const showMsg = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    if (type === 'success') setTimeout(() => setMessage(null), 3000)
  }

  const handleBind = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!bindUrl.trim()) return

    setBindLoading(true)
    try {
      const res = await fetch('/api/skills/updater/bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId: skill.id, githubUrl: bindUrl.trim() }),
      })
      const data = await res.json()
      if (data.ok) {
        showMsg('success', '绑定 GitHub 来源成功！')
        setIsEditingBind(false)
        if (onChanged) await onChanged()
      } else {
        showMsg('error', data.error || '绑定失败')
      }
    } catch (err: any) {
      showMsg('error', '绑定失败: ' + err.message)
    } finally {
      setBindLoading(false)
    }
  }

  const handleCheckUpdate = async () => {
    setCheckLoading(true)
    try {
      const res = await fetch(`/api/skills/updater/check/${skill.id}`)
      const data = await res.json()
      if (data.ok) {
        if (data.hasUpdate) {
          showMsg('success', '检测到新版本！')
        } else {
          showMsg('success', '已是最新版本')
        }
        if (onChanged) await onChanged()
      } else {
        showMsg('error', data.error || '检查更新失败')
      }
    } catch (err: any) {
      showMsg('error', '检查失败: ' + err.message)
    } finally {
      setCheckLoading(false)
    }
  }

  const handleUpdate = async () => {
    if (!confirm('确定要更新此 Skill 吗？这将会覆盖本地对该 Skill 的任何修改。')) {
      return
    }

    setUpdateLoading(true)
    try {
      const res = await fetch(`/api/skills/updater/update/${skill.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latestCommit: skill.githubSource?.latestCommit }),
      })
      const data = await res.json()
      if (data.ok) {
        showMsg('success', 'Skill 更新成功！')
        if (onChanged) await onChanged()
      } else {
        showMsg('error', data.error || '更新失败')
      }
    } catch (err: any) {
      showMsg('error', '更新失败: ' + err.message)
    } finally {
      setUpdateLoading(false)
    }
  }

  // Surface the real server error so users aren't stuck guessing why an
  // operation failed. The server includes Node fs error codes (EBUSY / EPERM
  // / EACCES / EXDEV ...) plus any human-readable hint it attached.
  const errMsg = (e: unknown, fallback: string): string => {
    const raw = e instanceof Error ? e.message : String(e ?? '')
    return raw && raw.trim().length > 0 ? raw : fallback
  }

  const handleToggle = async () => {
    setActionLoading('toggle')
    try {
      await onToggle(skill, !skill.enabled)
      showMsg('success', skill.enabled ? '已禁用' : '已启用')
    } catch (e) { showMsg('error', errMsg(e, '操作失败')) }
    finally { setActionLoading(null) }
  }

  const handleCopy = async (scope: 'global' | 'project', projectPath?: string) => {
    setActionLoading('copy')
    try {
      await onCopy(skill, scope, projectPath)
      showMsg('success', '复制成功')
      setShowActions(false)
    } catch (e) { showMsg('error', errMsg(e, '复制失败')) }
    finally { setActionLoading(null) }
  }

  const handleMove = async (scope: 'global' | 'project', projectPath?: string) => {
    setActionLoading('move')
    try {
      await onMove(skill, scope, projectPath)
      showMsg('success', '移动成功')
      setShowActions(false)
    } catch (e) { showMsg('error', errMsg(e, '移动失败')) }
    finally { setActionLoading(null) }
  }

  const handleDelete = async () => {
    setActionLoading('delete')
    try {
      await onDelete(skill)
      onClose()
    } catch (e) { showMsg('error', errMsg(e, '删除失败')) }
    finally { setActionLoading(null) }
  }

  if (showVersions) {
    return (
      <VersionHistory
        skillPath={skill.path}
        skillName={skill.name}
        onClose={() => setShowVersions(false)}
        onRollback={() => {
          setShowVersions(false)
        }}
      />
    )
  }

  if (editing) {
    return (
      <SkillEditor
        skill={skill}
        onSave={async (content) => {
          await onSaveContent(skill, content)
          showMsg('success', '保存成功')
        }}
        onClose={() => setEditing(false)}
      />
    )
  }

  return (
    <div className="w-full h-full bg-slate-900/10 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-slate-800/80 shrink-0">
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-slate-100 truncate">/{skill.name}</h2>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              <ScopeBadge scope={skill.scope} />
              <SourceBadge source={skill.source} />
              {!skill.enabled && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/20 text-red-400">
                  已禁用
                </span>
              )}
              {skill.hasConflict && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/20 text-amber-400">
                  冲突
                </span>
              )}
              {skill.security && (
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                  skill.security.level === 'safe'
                    ? 'bg-green-500/10 text-green-400 border-green-500/20'
                    : skill.security.level === 'warning'
                    ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                    : 'bg-red-500/10 text-red-400 border-red-500/20'
                }`}>
                  {skill.security.level === 'safe' ? '🛡️ 安全' : skill.security.level === 'warning' ? '⚠️ 警告' : '🚨 高危'}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-300 p-1 rounded-lg hover:bg-slate-800 transition-colors shrink-0 ml-3"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Message */}
        {message && (
          <div
            className={`mt-2 px-3 py-2 rounded-lg text-xs flex items-start gap-2 ${
              message.type === 'success'
                ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                : 'bg-red-500/10 text-red-300 border border-red-500/30'
            }`}
          >
            <span className="flex-1 whitespace-pre-wrap break-words font-mono leading-relaxed">
              {message.text}
            </span>
            {message.type === 'error' && (
              <button
                onClick={() => setMessage(null)}
                className="text-red-400/60 hover:text-red-300 shrink-0"
                aria-label="关闭"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {skill.description && (
          <p className="text-xs text-slate-400 leading-relaxed">{skill.description}</p>
        )}

        {skill.security && skill.security.flags.length > 0 && (
          <div className={`p-3 rounded-xl border text-[11px] space-y-2 ${
            skill.security.level === 'danger'
              ? 'bg-red-500/5 border-red-500/20 text-red-300'
              : 'bg-amber-500/5 border-amber-500/20 text-amber-300'
          }`}>
            <h4 className="font-semibold uppercase tracking-wider text-[10px] opacity-80 flex items-center gap-1.5">
              <span>⚠️</span> 本地静态安全指令审计发现：
            </h4>
            <ul className="list-disc list-inside space-y-1 font-medium opacity-90">
              {skill.security.flags.map((flag, idx) => (
                <li key={idx}>{flag}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap gap-1.5">
          <ActionButton
            onClick={handleToggle}
            loading={actionLoading === 'toggle'}
            variant={skill.enabled ? 'warning' : 'success'}
          >
            {skill.enabled ? '禁用' : '启用'}
          </ActionButton>
          <ActionButton onClick={() => setEditing(true)}>编辑 SKILL.md</ActionButton>
          <ActionButton onClick={() => setShowVersions(true)} variant="default">
            版本历史
          </ActionButton>
          <ActionButton onClick={() => setShowActions(!showActions)}>
            复制/移动
          </ActionButton>
          {confirmDelete ? (
            <div className="flex gap-1">
              <ActionButton onClick={handleDelete} loading={actionLoading === 'delete'} variant="danger">
                移入回收站
              </ActionButton>
              <ActionButton onClick={() => setConfirmDelete(false)}>取消</ActionButton>
            </div>
          ) : (
            <ActionButton onClick={() => setConfirmDelete(true)} variant="danger">删除</ActionButton>
          )}
        </div>

        {confirmDelete && (
          <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-300">
            将移入回收站，7 天内可从「回收站」还原；7 天后自动清除。
          </div>
        )}

        {/* Copy/Move panel */}
        {showActions && (
          <div className="bg-slate-950/30 rounded-lg border border-slate-800/80 p-3 space-y-2.5">
            <h4 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">复制或移动到</h4>

            {skill.scope !== 'global' && (
              <div className="flex gap-1.5">
                <ActionButton onClick={() => handleCopy('global')} loading={actionLoading === 'copy'}>
                  复制到全局
                </ActionButton>
                <ActionButton onClick={() => handleMove('global')} loading={actionLoading === 'move'}>
                  移动到全局
                </ActionButton>
              </div>
            )}

            {projects.length > 0 && (
              <div className="space-y-1.5 pt-1 border-t border-slate-800/40">
                <span className="text-[11px] text-slate-500 block">项目:</span>
                {projects.map((p) => (
                  <div key={p.path} className="flex items-center gap-2">
                    <span className="text-xs text-slate-400 truncate flex-1">{p.name}</span>
                    <ActionButton
                      onClick={() => handleCopy('project', p.path)}
                      loading={actionLoading === 'copy'}
                      small
                    >
                      复制
                    </ActionButton>
                    <ActionButton
                      onClick={() => handleMove('project', p.path)}
                      loading={actionLoading === 'move'}
                      small
                    >
                      移动
                    </ActionButton>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}


        {/* GitHub 来源与更新 */}
        <div>
          <SectionTitle>GitHub 来源与更新</SectionTitle>
          {skill.githubSource && !isEditingBind ? (
            <div className="bg-slate-950/30 rounded-lg border border-slate-800/60 p-3 space-y-3">
              <div className="space-y-1">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">仓库</span>
                  <a
                    href={`https://github.com/${skill.githubSource.owner}/${skill.githubSource.repo}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-500 hover:underline font-medium truncate max-w-[200px]"
                  >
                    {skill.githubSource.owner}/{skill.githubSource.repo}
                  </a>
                </div>
                {skill.githubSource.subPath && (
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-500">子目录</span>
                    <span className="text-slate-400 font-mono">{skill.githubSource.subPath}</span>
                  </div>
                )}
                {skill.githubSource.branch && (
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-500">分支</span>
                    <span className="text-slate-400 font-mono">{skill.githubSource.branch}</span>
                  </div>
                )}
                {skill.githubSource.installedCommit && (
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-500">已安装 Commit</span>
                    <span className="text-slate-400 font-mono text-[10px]" title={skill.githubSource.installedCommit}>
                      {skill.githubSource.installedCommit.slice(0, 7)}
                    </span>
                  </div>
                )}
                {skill.githubSource.lastChecked && (
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-500">上次检查</span>
                    <span className="text-slate-400">
                      {new Date(skill.githubSource.lastChecked).toLocaleString('zh-CN')}
                    </span>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between border-t border-slate-800/65 pt-2.5">
                <div className="flex items-center gap-1.5">
                  {skill.githubSource.updateAvailable ? (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/20 text-red-400">
                      有更新可用
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-500/20 text-green-400">
                      已是最新
                    </span>
                  )}
                </div>
                
                <div className="flex gap-1.5">
                  {skill.githubSource.updateAvailable ? (
                    <button
                      onClick={handleUpdate}
                      disabled={updateLoading}
                      className="px-2.5 py-1 text-[11px] font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded transition-all"
                    >
                      {updateLoading ? '更新中...' : '更新'}
                    </button>
                  ) : (
                    <button
                      onClick={handleCheckUpdate}
                      disabled={checkLoading}
                      className="px-2.5 py-1 text-[11px] font-semibold text-slate-300 bg-slate-850 hover:bg-slate-800 disabled:opacity-50 rounded transition-all"
                    >
                      {checkLoading ? '检查中...' : '检查更新'}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setBindUrl(`${skill.githubSource!.owner}/${skill.githubSource!.repo}${skill.githubSource!.subPath ? `/tree/${skill.githubSource!.branch || 'main'}/${skill.githubSource!.subPath}` : ''}`)
                      setIsEditingBind(true)
                    }}
                    className="px-2.5 py-1 text-[11px] font-semibold text-slate-400 hover:text-slate-200 transition-colors"
                  >
                    重绑
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <form onSubmit={handleBind} className="bg-slate-950/30 rounded-lg border border-slate-800/60 p-3 space-y-2.5">
              <p className="text-[10px] text-slate-500 font-medium">
                输入 GitHub 仓库地址（如: `owner/repo` 或带子目录的链接）来与原始仓库进行一对一的连接 and 更新。
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={bindUrl}
                  onChange={(e) => setBindUrl(e.target.value)}
                  placeholder="例如: alice/skills/tree/main/skills/impeccable"
                  className="flex-1 px-2.5 py-1 text-xs placeholder:text-slate-600"
                />
                <button
                  type="submit"
                  disabled={bindLoading || !bindUrl.trim()}
                  className="px-2.5 py-1 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded transition-all whitespace-nowrap"
                >
                  {bindLoading ? '绑定中...' : '绑定'}
                </button>
              </div>
              {isEditingBind && (
                <button
                  type="button"
                  onClick={() => setIsEditingBind(false)}
                  className="text-[10px] text-slate-500 hover:text-slate-400 transition-colors block"
                >
                  取消
                </button>
              )}
            </form>
          )}
        </div>

        {/* Metadata */}
        <div>
          <SectionTitle>详细信息</SectionTitle>
          <div className="bg-slate-950/30 rounded-lg border border-slate-800/60 divide-y divide-slate-800/60">
            <InfoRow label="路径" value={skill.path} mono />
            <InfoRow label="实际路径" value={skill.realPath} mono />
            {skill.symlinkTarget && <InfoRow label="符号链接" value={skill.symlinkTarget} mono />}
            {skill.projectName && <InfoRow label="所属项目" value={skill.projectName} />}
            {skill.frontmatter['allowed-tools'] && (
              <InfoRow label="允许工具" value={skill.frontmatter['allowed-tools']} />
            )}
            {skill.frontmatter.model && <InfoRow label="模型" value={skill.frontmatter.model} />}
            {skill.frontmatter.effort && <InfoRow label="Effort" value={skill.frontmatter.effort} />}
            {skill.frontmatter.agent && <InfoRow label="Agent" value={skill.frontmatter.agent} />}
            {skill.files.length > 0 && <InfoRow label="文件" value={skill.files.join(', ')} />}
            <InfoRow label="修改时间" value={new Date(skill.lastModified).toLocaleString('zh-CN')} />
          </div>
        </div>

        {/* Content preview */}
        {skill.content && (
          <div>
            <SectionTitle>SKILL.md 预览</SectionTitle>
            <pre className="bg-slate-950 border border-slate-800/60 rounded-lg p-3 text-[11px] text-slate-300 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap leading-relaxed font-mono">
              {skill.content}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-widest mb-2">
      {children}
    </h3>
  )
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3 px-3 py-2 text-sm">
      <span className="text-slate-500 shrink-0 w-20 text-xs pt-0.5">{label}</span>
      <span className={`text-slate-300 break-all min-w-0 ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </span>
    </div>
  )
}

function ActionButton({
  onClick,
  children,
  loading,
  variant = 'default',
  small,
}: {
  onClick: () => void
  children: React.ReactNode
  loading?: boolean
  variant?: 'default' | 'success' | 'warning' | 'danger'
  small?: boolean
}) {
  const colors = {
    default: 'bg-slate-800 hover:bg-slate-700 text-slate-300',
    success: 'bg-green-600/20 hover:bg-green-600/30 text-green-400',
    warning: 'bg-amber-600/20 hover:bg-amber-600/30 text-amber-400',
    danger: 'bg-red-600/20 hover:bg-red-600/30 text-red-400',
  }

  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`${small ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1.5 text-xs'} rounded-lg font-medium transition-all disabled:opacity-50 ${colors[variant]}`}
    >
      {loading ? '...' : children}
    </button>
  )
}
