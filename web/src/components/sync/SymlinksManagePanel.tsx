import { useCallback, useEffect, useState } from 'react'
import type { Skill } from '../../hooks/useSkills'
import { AGENT_ORDER, AGENT_META } from '../../agents'
import { DistributionPanel } from '../DistributionPanel'

export interface Anomaly {
  id: string
  name: string
  path: string
  agentId: string
  agentName: string
}

export interface AgentStat {
  agentId: string
  agentName: string
  icon: string
  symlinkCount: number
  realCount: number
  globalPath: string
  exists: boolean
  enabled: boolean
}

export function SymlinksManagePanel({ allSkills }: { allSkills: Skill[] }) {
  const [anomalies, setAnomalies] = useState<Anomaly[]>([])
  const [, setAgentStats] = useState<AgentStat[]>([])
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [fixing, setFixing] = useState(false)

  // 批量分发的 states
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(new Set())
  const [targetAgentId, setTargetAgentId] = useState<string>('')
  const [batchSyncing, setBatchSyncing] = useState(false)
  const [distKey, setDistKey] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')

  const fetchAnomaliesAndStats = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/symlinks/anomalies')
      const data = await res.json()
      if (data.ok) {
        setAnomalies(data.anomalies || [])
        setAgentStats(data.stats || [])
      }
    } catch {}
    setLoading(false)
    setLoaded(true)
  }, [])

  useEffect(() => {
    fetchAnomaliesAndStats()
  }, [fetchAnomaliesAndStats])

  const handleFixAnomalies = async () => {
    if (anomalies.length === 0 || fixing) return
    if (
      !confirm(
        `确定要将这 ${anomalies.length} 个 Skill 收归到仓库吗？\n\n它们的真实目录会被移入 Skill 仓库，并在原 IDE 目录留下指向仓库的软链接，原 IDE 继续可用；之后它们就可以分发到其它 IDE。`
      )
    )
      return

    setFixing(true)
    try {
      const res = await fetch('/api/symlinks/anomalies/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (data.ok) {
        alert(
          `一键修复成功！已成功收归并修复了 ${data.fixedCount} 个物理冲突技能。`
        )
        await fetchAnomaliesAndStats()
      } else {
        alert(data.error || '修复失败')
      }
    } catch (err: any) {
      alert('修复网络请求失败: ' + err.message)
    } finally {
      setFixing(false)
    }
  }

  const handleBatchSync = async () => {
    if (selectedSkillIds.size === 0) {
      alert('请先勾选需要挂载的 Skill。')
      return
    }
    if (!targetAgentId) {
      alert('请选择目标 IDE 目录。')
      return
    }

    setBatchSyncing(true)
    try {
      const res = await fetch('/api/skills/batch/symlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add',
          agentId: targetAgentId,
          skillIds: Array.from(selectedSkillIds),
        }),
      })
      const data = await res.json()
      if (data.ok) {
        const warning = (data.results || []).find((r: any) => !r.success)
        if (warning) {
          alert(`挂载同步部分成功，但有报错: ${warning.error}`)
        } else {
          alert(`批量挂载成功！已一键建立 ${selectedSkillIds.size} 个软链接到选定的 IDE。`)
          setSelectedSkillIds(new Set())
        }
        await fetchAnomaliesAndStats()
        setDistKey((k) => k + 1)
      } else {
        alert(data.error || '同步失败')
      }
    } catch (err: any) {
      alert('同步失败: ' + err.message)
    } finally {
      setBatchSyncing(false)
    }
  }

  const toggleSkillSelect = (id: string) => {
    setSelectedSkillIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Only warehouse skills can be distributed to IDE global directories.
  const filteredSkills = allSkills.filter((skill) =>
    skill.isWarehouseSource &&
    (skill.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      skill.description.toLowerCase().includes(searchQuery.toLowerCase()))
  )

  const handleSelectAll = () => {
    if (selectedSkillIds.size === filteredSkills.length) {
      setSelectedSkillIds(new Set())
    } else {
      setSelectedSkillIds(new Set(filteredSkills.map((s) => s.id)))
    }
  }

  // Full-page spinner only for the first load; refreshes keep children
  // (and their messages) mounted.
  if (loading && !loaded) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-10 h-10 border-2 border-slate-600 border-t-white rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* 1. 异常 Skill 安装警告与一键修复 */}
      {anomalies.length > 0 ? (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-5 space-y-3.5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <span className="text-xl shrink-0">⚠️</span>
              <div>
                <h4 className="text-sm font-semibold text-red-400">检测到 {anomalies.length} 个非常规 IDE 技能安装</h4>
                <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                  这些 Skill 直接以真实物理文件夹形式存放在 IDE 专属目录下，这会导致其它 IDE 无法访问到这些 Skill，破坏了软链的统一统筹体系。
                </p>
              </div>
            </div>
            <button
              onClick={handleFixAnomalies}
              disabled={fixing}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-40 rounded-lg text-xs font-semibold text-white transition-all shadow-md shrink-0"
            >
              {fixing ? '正在修复...' : '🔧 一键收归与修复'}
            </button>
          </div>
          <div className="border border-red-500/10 rounded-lg overflow-hidden max-h-36 overflow-y-auto divide-y divide-red-500/5 bg-slate-950/20">
            {anomalies.map((item) => (
              <div key={item.id} className="px-3 py-2 text-[11px] font-mono flex items-center justify-between gap-3 text-slate-300">
                <div className="truncate">
                  <span className="text-red-400">/{item.name}</span>
                  <span className="text-slate-500 text-[10px] ml-2">({item.path})</span>
                </div>
                <span className="px-2 py-0.5 rounded bg-slate-900 text-slate-400 shrink-0">{item.agentName}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-slate-900/30 border border-slate-800 rounded-xl p-4 flex items-center gap-3">
          <span className="text-lg">✨</span>
          <div className="text-xs text-slate-400 font-medium">IDE 专属路径下结构正常，未检测到任何异常/物理安装冲突。</div>
        </div>
      )}

      {/* 2. 分发规则与计划 */}
      <DistributionPanel key={distKey} onApplied={fetchAnomaliesAndStats} />

      <div className="grid grid-cols-1 gap-6 items-start">
        {/* 3. 批量同步挂载区 */}
        <div className="bg-slate-900/40 border border-slate-800/80 rounded-xl p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-300 mb-1">批量分发 Skills 软链接</h3>
            <p className="text-xs text-slate-500">
              勾选仓库中的 Skill 并选择目标 IDE：会加入该 IDE 的分发规则并立即为这些 Skill 创建链接。
            </p>
          </div>

          <div className="flex gap-2 items-center">
            <input
              type="text"
              placeholder="搜索可用技能..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 px-3 py-1.5 text-xs text-slate-300"
            />
            {filteredSkills.length > 0 && (
              <button
                onClick={handleSelectAll}
                className="px-2.5 py-1.5 bg-slate-850 hover:bg-slate-800 rounded text-[10px] text-slate-400 whitespace-nowrap cursor-pointer"
              >
                {selectedSkillIds.size === filteredSkills.length ? '取消全选' : '全选'}
              </button>
            )}
          </div>

          <div className="border border-slate-800/60 rounded-lg divide-y divide-slate-800/40 max-h-72 overflow-y-auto bg-slate-950/20">
            {filteredSkills.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-slate-500">无匹配技能</div>
            ) : (
              filteredSkills.map((skill) => (
                <label key={skill.id} className="px-3 py-2 text-xs flex items-center gap-3 hover:bg-slate-900/20 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={selectedSkillIds.has(skill.id)}
                    onChange={() => toggleSkillSelect(skill.id)}
                    className="w-3.5 h-3.5 text-blue-500 focus:ring-blue-500/30 cursor-pointer"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-slate-300 truncate font-medium">{skill.name}</div>
                    <div className="text-[10px] text-slate-500 truncate mt-0.5">{skill.description || '无描述'}</div>
                  </div>
                  <div className="text-[10px] shrink-0 text-slate-500 uppercase font-semibold tracking-wider bg-slate-900 px-1.5 py-0.5 rounded">
                    {skill.scope}
                  </div>
                </label>
              ))
            )}
          </div>

          <div className="flex items-center gap-3 border-t border-slate-800/80 pt-4 flex-wrap">
            <div className="flex-1 min-w-[150px]">
              <select
                value={targetAgentId}
                onChange={(e) => setTargetAgentId(e.target.value)}
                className="w-full text-xs text-slate-300"
              >
                <option value="">-- 选择目标 IDE --</option>
                {AGENT_ORDER.map((id) => {
                  const meta = AGENT_META[id]
                  if (!meta || id === 'unknown') return null
                  return (
                    <option key={id} value={id}>
                      {meta.icon} {meta.name}
                    </option>
                  )
                })}
              </select>
            </div>
            <button
              onClick={handleBatchSync}
              disabled={batchSyncing || selectedSkillIds.size === 0 || !targetAgentId}
              className="px-4 py-2 bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed text-xs cursor-pointer"
            >
              {batchSyncing ? '正在同步...' : `批量挂载到目标 IDE (${selectedSkillIds.size})`}
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}
