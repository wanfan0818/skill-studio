import type { FastifyInstance } from 'fastify'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import {
  fullScan,
  saveProjectToRegistry,
  addExcludedProject,
  getExcludedProjects,
  removeExcludedProject,
  purgeProjectSkillsAndProfile,
} from '../scanner/discovery.js'
import { projectCapableAgents } from '../scanner/agents.js'
import { recommendSkills } from '../recommender/engine.js'
import { resolvePreferredIdes } from '../ides.js'
import { invalidateCache } from './skills.js'
import { isPlainSegment } from '../utils/safe.js'
import { PlanChangedError } from '../distribution/reconcile.js'
import {
  readProfile,
  writeProfile,
  listConfiguredProjects,
  listCandidateProjects,
  suggestIdes,
  validProjectIdes,
} from '../projects/model.js'
import { planProject, applyProject, buildProjectContext } from '../projects/reconcile.js'

const homedir = os.homedir()

/** Project paths from the client must be absolute paths to existing directories. */
async function isValidProjectDir(p: unknown): Promise<boolean> {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false
  if (path.resolve(p) === path.resolve(homedir) || path.resolve(p) === '/') return false
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

function badRequest(reply: any, error: string) {
  reply.status(400)
  return { ok: false, error }
}

/**
 * Accept `ides` (v2) or the legacy single `targetIde`. A legacy client
 * sending only `targetIde` must not shrink a multi-IDE project to one IDE,
 * so it is merged into the existing list (`fallback`) instead.
 */
function idesFrom(body: any, fallback: string[] = []): string[] {
  if (Array.isArray(body?.ides)) return validProjectIdes(body.ides)
  if (typeof body?.targetIde === 'string') {
    const ide = validProjectIdes([body.targetIde])
    return fallback.length ? Array.from(new Set([...ide, ...fallback])) : ide
  }
  return fallback
}

export async function projectRoutes(app: FastifyInstance) {
  // IDEs that can be project targets (for the IDE picker).
  // Only the user's preferred IDEs are offered (unused ones stay out of pickers).
  app.get('/api/projects/ides', async () => {
    const { ides: preferred } = await resolvePreferredIdes()
    return {
      ok: true,
      ides: projectCapableAgents()
        .filter((a) => preferred.includes(a.id))
        .map((a) => ({
          id: a.id,
          name: a.projectViaGlobal ? `${a.name}（账号级）` : a.name,
          icon: a.icon,
          writeDirs: a.projectViaGlobal ? ['账号级 skills 目录（所有项目共用）'] : (a.projectWritePaths ?? [a.projectPaths[0]]),
          mode: a.projectViaGlobal || a.projectLinkMode === 'copy' ? 'copy' : 'symlink',
          viaGlobal: !!a.projectViaGlobal,
        })),
    }
  })

  // Configured projects with a per-project summary (status matrix included).
  app.get('/api/projects', async () => {
    const ctx = await buildProjectContext()
    const projects = []
    for (const p of await listConfiguredProjects()) {
      const plan = await planProject(p.path, { profile: p.profile, ctx })
      const pending = plan.counts.link + plan.counts.relink + plan.counts.copy + plan.counts.update + plan.counts.unlink
      projects.push({
        name: p.name,
        path: p.path,
        profile: p.profile,
        ides: plan.ides,
        matrix: plan.matrix,
        counts: plan.counts,
        pending,
        strayDirs: plan.strayDirs,
        inventory: plan.inventory,
        warnings: plan.warnings,
        fingerprint: plan.fingerprint,
        // legacy fields some views still read
        skillCount: p.profile.skills.length,
        profileSkillCount: p.profile.skills.length,
        syncStatus: pending || plan.counts.conflict ? 'drift' : 'synced',
      })
    }
    return { ok: true, projects }
  })

  // Folders that look like projects but are not configured yet.
  app.get('/api/projects/candidates', async () => {
    return { ok: true, candidates: await listCandidateProjects() }
  })

  // Turn a candidate into a configured project (skills found + inferred IDEs).
  app.post<{ Body: { projectPath: string; ides?: string[] } }>('/api/projects/import', async (req, reply) => {
    const { projectPath } = req.body ?? ({} as any)
    if (!(await isValidProjectDir(projectPath))) return badRequest(reply, '项目路径必须是已存在目录的绝对路径')
    const candidate = (await listCandidateProjects()).find((c) => path.resolve(c.path) === path.resolve(projectPath))
    const existing = await readProfile(projectPath)
    const ides = idesFrom(req.body, candidate?.suggestedIdes ?? suggestIdes([], existing?.ides ?? []))
    const profile = await writeProfile(projectPath, {
      name: existing?.name ?? path.basename(projectPath),
      description: existing?.description && existing.description !== '自动配置的项目 Profile' ? existing.description : '',
      skills: candidate?.skills ?? existing?.skills ?? [],
      ides,
    })
    await saveProjectToRegistry(projectPath, profile.name)
    invalidateCache()
    return { ok: true, profile, plan: await planProject(projectPath, { profile }) }
  })

  app.get<{ Querystring: { projectPath: string } }>('/api/projects/profile', async (req, reply) => {
    const { projectPath } = req.query
    if (!projectPath) return badRequest(reply, '未提供项目路径 projectPath')
    const profile = await readProfile(projectPath)
    return profile ? { ok: true, exists: true, profile } : { ok: true, exists: false }
  })

  // Create or update a project's profile (does not touch disk beyond the profile).
  app.post<{
    Body: { projectPath: string; profile: { name?: string; description?: string; skills?: string[]; ides?: string[]; targetIde?: string } }
  }>('/api/projects/profile', async (req, reply) => {
    const { projectPath, profile } = req.body ?? ({} as any)
    if (!projectPath || !profile) return badRequest(reply, '缺少必填参数 projectPath 或 profile')
    if (!(await isValidProjectDir(projectPath))) return badRequest(reply, '项目路径必须是已存在目录的绝对路径')
    const existing = await readProfile(projectPath)
    const saved = await writeProfile(projectPath, {
      name: profile.name || existing?.name || path.basename(projectPath),
      description: profile.description ?? existing?.description ?? '',
      skills: Array.isArray(profile.skills) ? profile.skills : existing?.skills ?? [],
      ides: idesFrom(profile, existing?.ides ?? ['claude-code']),
    })
    await saveProjectToRegistry(projectPath, saved.name)
    invalidateCache()
    return { ok: true, profile: saved }
  })

  // Preview. Nothing on disk changes.
  app.get<{ Querystring: { projectPath: string } }>('/api/projects/plan', async (req, reply) => {
    const { projectPath } = req.query
    if (!(await isValidProjectDir(projectPath))) return badRequest(reply, '项目路径必须是已存在目录的绝对路径')
    return { ok: true, plan: await planProject(projectPath) }
  })

  // Apply a project's plan; with `fingerprint`, refuses if it changed.
  app.post<{ Body: { projectPath: string; fingerprint?: string; includeLegacy?: boolean } }>('/api/projects/apply', async (req, reply) => {
    const { projectPath, fingerprint, includeLegacy } = req.body ?? ({} as any)
    if (!(await isValidProjectDir(projectPath))) return badRequest(reply, '项目路径必须是已存在目录的绝对路径')
    try {
      const r = await applyProject(projectPath, { fingerprint, includeLegacy: includeLegacy === true })
      invalidateCache()
      return { ok: r.failed === 0, ...r }
    } catch (err: any) {
      if (err instanceof PlanChangedError) {
        reply.status(409)
        return { ok: false, error: err.message, code: 'PLAN_CHANGED' }
      }
      throw err
    }
  })

  app.post<{ Body: { description: string } }>('/api/projects/recommend-skills', async (req, reply) => {
    try {
      const scanRes = await fullScan()
      return { ok: true, recommended: recommendSkills(req.body?.description ?? '', scanRes.skills) }
    } catch (err: any) {
      reply.status(500)
      return { ok: false, error: `推荐失败: ${err.message}` }
    }
  })

  // Legacy: "sync" = apply everything except opt-in cleanup.
  app.post<{ Body: { projectPath: string } }>('/api/projects/sync', async (req, reply) => {
    const { projectPath } = req.body ?? ({} as any)
    if (!(await isValidProjectDir(projectPath))) return badRequest(reply, '项目路径必须是已存在目录的绝对路径')
    if (!(await readProfile(projectPath))) return badRequest(reply, '该目录还不是已配置的项目')
    const r = await applyProject(projectPath)
    invalidateCache()
    const conflicts = r.plan.actions.filter((a) => a.type === 'conflict').map((a) => a.linkPath)
    return {
      ok: r.failed === 0,
      message: r.failed ? `同步完成，但有 ${r.failed} 项失败` : conflicts.length ? `已同步，但有 ${conflicts.length} 个冲突未处理` : '项目 Skill 同步成功',
      conflicts,
      ...r,
    }
  })

  // Remove everything Skill Studio manages in the project, then the profile.
  app.delete<{ Body: { projectPath: string } }>('/api/projects/clean', async (req, reply) => {
    const { projectPath } = req.body ?? ({} as any)
    if (!(await isValidProjectDir(projectPath))) return badRequest(reply, '项目路径必须是已存在目录的绝对路径')
    const profile = await readProfile(projectPath)
    if (profile) {
      await applyProject(projectPath, { profile: { ...profile, skills: [], ides: [] }, includeLegacy: true })
      await fs.unlink(path.join(projectPath, '.skills-profile.json')).catch(() => {})
    }
    invalidateCache()
    return { ok: true }
  })

  // Add one skill to a project (optionally adding an IDE), then apply it.
  app.post<{ Body: { projectPath: string; skillName: string; targetIde?: string; ides?: string[] } }>('/api/projects/install-skill', async (req, reply) => {
    const { projectPath, skillName } = req.body ?? ({} as any)
    if (!(await isValidProjectDir(projectPath))) return badRequest(reply, '项目路径必须是已存在目录的绝对路径')
    if (!isPlainSegment(skillName)) return badRequest(reply, 'skillName 不合法')
    const existing = await readProfile(projectPath)
    const extra = idesFrom(req.body)
    const profile = await writeProfile(projectPath, {
      name: existing?.name ?? path.basename(projectPath),
      description: existing?.description ?? '',
      skills: [...(existing?.skills ?? []), skillName],
      ides: [...new Set([...(existing?.ides ?? []), ...extra])].length ? [...new Set([...(existing?.ides ?? []), ...extra])] : ['claude-code'],
    })
    await saveProjectToRegistry(projectPath, profile.name)
    const r = await applyProject(projectPath, { skills: [skillName] })
    invalidateCache()
    return { ok: r.failed === 0, profile, conflicts: r.plan.actions.filter((a) => a.type === 'conflict' && a.name === skillName).map((a) => a.linkPath) }
  })

  app.post<{ Body: { projectPath: string; skillName: string } }>('/api/projects/uninstall-skill', async (req, reply) => {
    const { projectPath, skillName } = req.body ?? ({} as any)
    if (!(await isValidProjectDir(projectPath))) return badRequest(reply, '项目路径必须是已存在目录的绝对路径')
    if (!isPlainSegment(skillName)) return badRequest(reply, 'skillName 不合法')
    const existing = await readProfile(projectPath)
    if (!existing) return badRequest(reply, '该目录还不是已配置的项目')
    const profile = await writeProfile(projectPath, { ...existing, skills: existing.skills.filter((s) => s !== skillName) })
    const r = await applyProject(projectPath, { skills: [skillName] })
    invalidateCache()
    return { ok: r.failed === 0, profile }
  })

  // Hide a project (and optionally remove its skill dirs, real ones to the trash).
  app.post<{ Body: { projectPath: string; purgeFiles?: boolean } }>('/api/projects/delete', async (req, reply) => {
    const { projectPath, purgeFiles } = req.body ?? ({} as any)
    if (!(await isValidProjectDir(projectPath))) return badRequest(reply, '项目路径必须是已存在目录的绝对路径')
    if (purgeFiles) await purgeProjectSkillsAndProfile(projectPath)
    await addExcludedProject(projectPath)
    invalidateCache()
    return { ok: true }
  })

  app.get('/api/projects/excluded', async () => {
    return { ok: true, excludedProjects: await getExcludedProjects() }
  })

  app.post<{ Body: { projectPath: string } }>('/api/projects/restore', async (req, reply) => {
    const { projectPath } = req.body ?? ({} as any)
    if (!projectPath) return badRequest(reply, '未提供 projectPath')
    await removeExcludedProject(projectPath)
    invalidateCache()
    return { ok: true }
  })
}
