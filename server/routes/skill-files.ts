import type { FastifyInstance } from 'fastify'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { invalidateCache, findKnownSkill } from './skills.js'
import { isPlainSegment, readJsonFile, writeFileAtomic } from '../utils/safe.js'
import { createSnapshot } from '../versioning/store.js'
import { moveToTrash } from '../trash/store.js'
import { copyDir } from '../utils/fs.js'
import { readIdeSettingsFull } from '../settings.js'

/**
 * Operations on individual skill directories: enable/disable (Claude Code
 * deny list), edit SKILL.md, copy, move, delete (recycle bin).
 * Every path comes from the scan (findKnownSkill), never from the client.
 */

const homedir = os.homedir()
const settingsPath = path.join(homedir, '.claude', 'settings.json')

/**
 * Claude Code's own ~/.claude/settings.json. Missing → {}. Anything else that
 * fails (bad JSON, permissions) throws: writing `{ permissions }` back over a
 * file we could not parse would wipe the user's hooks, env, model, etc.
 */
async function readSettings(): Promise<any> {
  return (await readJsonFile<any>(settingsPath)) ?? {}
}

async function writeSettings(settings: any): Promise<void> {
  await writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2))
}

export async function skillFileRoutes(app: FastifyInstance) {
  // Toggle skill enabled/disabled
  app.put<{
    Params: { id: string }
    Body: { enabled: boolean; skillName: string }
  }>('/api/skills/:id/toggle', async (req, reply) => {
    const { enabled, skillName } = req.body ?? ({} as any)
    if (!isPlainSegment(skillName) || /[()\s]/.test(skillName) || typeof enabled !== 'boolean') {
      reply.status(400)
      return { ok: false, error: '参数不合法' }
    }
    let settings: any
    try {
      settings = await readSettings()
    } catch (err: any) {
      reply.status(500)
      return { ok: false, error: err.message }
    }

    if (!settings.permissions) settings.permissions = {}
    if (!settings.permissions.deny) settings.permissions.deny = []

    const rule = `Skill(${skillName})`
    const idx = settings.permissions.deny.indexOf(rule)

    if (enabled && idx >= 0) {
      // Remove from deny list to enable
      settings.permissions.deny.splice(idx, 1)
    } else if (!enabled && idx < 0) {
      // Add to deny list to disable
      settings.permissions.deny.push(rule)
    }

    await writeSettings(settings)
    invalidateCache()
    return { ok: true, enabled }
  })

  // Update SKILL.md content
  app.put<{
    Params: { id: string }
    Body: { realPath: string; content: string }
  }>('/api/skills/:id/content', async (req, reply) => {
    const { content } = req.body ?? ({} as any)
    if (typeof content !== 'string') {
      reply.status(400)
      return { ok: false, error: 'content 必须是字符串' }
    }
    // The target comes from the scan, never from the request body: a
    // client-supplied realPath allowed writing SKILL.md anywhere on disk.
    const skill = await findKnownSkill({ id: req.params.id })
    if (!skill) {
      reply.status(404)
      return { ok: false, error: 'Skill not found' }
    }
    const realPath = skill.realPath
    const skillMdPath = path.join(realPath, 'SKILL.md')

    // Verify the file exists
    try {
      await fs.access(skillMdPath)
    } catch {
      return { ok: false, error: 'SKILL.md not found' }
    }

    // Auto-snapshot before overwriting (save the old version)
    const skillName = path.basename(realPath)
    try {
      await createSnapshot(realPath, skillName, '编辑前自动备份', 'auto')
    } catch {}

    await fs.writeFile(skillMdPath, content, 'utf-8')

    // Snapshot the new version
    try {
      await createSnapshot(realPath, skillName, '通过编辑器保存', 'auto')
    } catch {}

    invalidateCache()
    return { ok: true }
  })

  // Copy skill to another location
  app.post<{
    Body: {
      sourcePath: string
      targetScope: 'global' | 'project'
      projectPath?: string
      skillName: string
    }
  }>('/api/skills/copy', async (req, reply) => {
    const { sourcePath, targetScope, projectPath, skillName } = req.body ?? ({} as any)
    if (!isPlainSegment(skillName) || (projectPath !== undefined && (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)))) {
      reply.status(400)
      return { ok: false, error: '参数不合法' }
    }
    if (!(await findKnownSkill({ path: sourcePath }))) {
      reply.status(404)
      return { ok: false, error: '源路径不是已发现的 Skill' }
    }

    let targetDir: string
    if (targetScope === 'global') {
      const settings = await readIdeSettingsFull()
      if (settings.customGlobalSkillsDir) {
        targetDir = path.join(settings.customGlobalSkillsDir, skillName)
      } else {
        targetDir = path.join(homedir, '.claude', 'skills', skillName)
      }
    } else if (projectPath) {
      targetDir = path.join(projectPath, '.claude', 'skills', skillName)
    } else {
      return { ok: false, error: 'Project path required for project scope' }
    }

    // Resolve source if symlink
    let realSource: string
    try {
      realSource = await fs.realpath(sourcePath)
    } catch {
      realSource = sourcePath
    }

    // Check if target already exists
    try {
      await fs.access(targetDir)
      return { ok: false, error: '目标位置已存在同名 Skill' }
    } catch {
      // Good — doesn't exist
    }

    // Copy directory recursively
    await copyDir(realSource, targetDir)
    invalidateCache()
    return { ok: true, targetDir }
  })

  // Move skill (copy + delete source)
  app.post<{
    Body: {
      sourcePath: string
      targetScope: 'global' | 'project'
      projectPath?: string
      skillName: string
    }
  }>('/api/skills/move', async (req, reply) => {
    const { sourcePath, targetScope, projectPath, skillName } = req.body ?? ({} as any)
    if (!isPlainSegment(skillName) || (projectPath !== undefined && (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)))) {
      reply.status(400)
      return { ok: false, error: '参数不合法' }
    }
    if (!(await findKnownSkill({ path: sourcePath }))) {
      reply.status(404)
      return { ok: false, error: '源路径不是已发现的 Skill' }
    }

    let targetDir: string
    if (targetScope === 'global') {
      const settings = await readIdeSettingsFull()
      if (settings.customGlobalSkillsDir) {
        targetDir = path.join(settings.customGlobalSkillsDir, skillName)
      } else {
        targetDir = path.join(homedir, '.claude', 'skills', skillName)
      }
    } else if (projectPath) {
      targetDir = path.join(projectPath, '.claude', 'skills', skillName)
    } else {
      return { ok: false, error: 'Project path required for project scope' }
    }

    let realSource: string
    try {
      realSource = await fs.realpath(sourcePath)
    } catch {
      realSource = sourcePath
    }

    try {
      await fs.access(targetDir)
      return { ok: false, error: '目标位置已存在同名 Skill' }
    } catch {}

    await copyDir(realSource, targetDir)

    // Remove the source via the recycle bin (symlinks are recorded and unlinked).
    await moveToTrash(sourcePath, skillName)

    invalidateCache()
    return { ok: true, targetDir }
  })

  // Delete skill (soft delete → recycle bin; 7-day TTL)
  app.delete<{
    Params: { id: string }
    Body: { path: string; skillName?: string }
  }>('/api/skills/:id', async (req, reply) => {
    const skillPath = req.body?.path
    const skillName = req.body?.skillName
    if (typeof skillPath !== 'string' || !(await findKnownSkill({ path: skillPath }))) {
      reply.status(404)
      return { ok: false, error: '该路径不是已发现的 Skill' }
    }

    try {
      const meta = await moveToTrash(skillPath, skillName)
      invalidateCache()
      return { ok: true, trashId: meta.id, expiresAt: meta.expiresAt }
    } catch (err: any) {
      reply.status(500)
      return { ok: false, error: err?.message || '删除失败' }
    }
  })

  // Batch delete — move many skills to trash in one call
  app.post<{
    Body: { items: { id: string; path: string; skillName?: string }[] }
  }>('/api/skills/batch/delete', async (req, reply) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : []
    if (items.length === 0) {
      reply.status(400)
      return { ok: false, error: '未提供要删除的 skill' }
    }

    const results: {
      id: string
      skillName?: string
      ok: boolean
      trashId?: string
      error?: string
    }[] = []

    for (const item of items) {
      if (!item || typeof item.path !== 'string') {
        results.push({ id: item?.id || '(unknown)', ok: false, error: '参数不完整' })
        continue
      }
      if (!(await findKnownSkill({ path: item.path }))) {
        results.push({ id: item.id, skillName: item.skillName, ok: false, error: '该路径不是已发现的 Skill' })
        continue
      }
      try {
        const meta = await moveToTrash(item.path, item.skillName)
        results.push({
          id: item.id,
          skillName: item.skillName,
          ok: true,
          trashId: meta.id,
        })
      } catch (err: any) {
        results.push({
          id: item.id,
          skillName: item.skillName,
          ok: false,
          error: err?.message || '删除失败',
        })
      }
    }

    invalidateCache()

    const okCount = results.filter((r) => r.ok).length
    const failCount = results.length - okCount
    return { ok: failCount === 0, okCount, failCount, results }
  })
}
