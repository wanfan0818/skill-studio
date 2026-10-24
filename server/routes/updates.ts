import type { FastifyInstance } from 'fastify'
import { invalidateCache } from './skills.js'
import { versionsReport, checkUpstream, updateSkills, keepLocal, refreshCopies, overwriteCopy, pullBackCopy, bindSource, unbindSource } from '../updates/status.js'

const names = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : undefined

export async function updateStateRoutes(app: FastifyInstance) {
  // Local-only: no network. Cheap enough to call on page open.
  app.get('/api/updates', async () => ({ ok: true, ...(await versionsReport()) }))

  // Ask GitHub for new commits (all GitHub skills, or `names`).
  app.post<{ Body: { names?: string[] } }>('/api/updates/check', async (req) => {
    const r = await checkUpstream(names(req.body?.names))
    return { ok: true, ...r, report: await versionsReport() }
  })

  // One-click update: skills with upstream news and no local edits.
  // `force` with explicit names takes upstream over local edits (old version → recycle bin).
  app.post<{ Body: { names?: string[]; force?: boolean } }>('/api/updates/update', async (req) => {
    const r = await updateSkills({ names: names(req.body?.names), force: req.body?.force === true })
    if (r.updated.length) invalidateCache()
    return { ok: true, ...r, report: await versionsReport() }
  })

  app.post<{ Body: { name: string } }>('/api/updates/keep-local', async (req, reply) => {
    if (typeof req.body?.name !== 'string') return reply.status(400).send({ ok: false, error: 'name is required' })
    await keepLocal(req.body.name)
    return { ok: true, report: await versionsReport() }
  })

  app.post<{ Body: { names?: string[] } }>('/api/updates/refresh-copies', async (req) => {
    const r = await refreshCopies(names(req.body?.names))
    return { ok: true, ...r, report: await versionsReport() }
  })

  // An IDE copy edited in place: keep its edits (pull-back) or the source (overwrite).
  app.post<{ Body: { path: string; action: 'pull-back' | 'overwrite' } }>('/api/updates/copy', async (req, reply) => {
    const { path: p, action } = req.body ?? ({} as any)
    if (typeof p !== 'string' || (action !== 'pull-back' && action !== 'overwrite')) {
      return reply.status(400).send({ ok: false, error: 'path and action (pull-back | overwrite) are required' })
    }
    try {
      if (action === 'pull-back') await pullBackCopy(p)
      else await overwriteCopy(p)
    } catch (err: any) {
      return reply.status(409).send({ ok: false, error: err?.message || String(err) })
    }
    invalidateCache()
    return { ok: true, report: await versionsReport() }
  })

  app.post<{ Body: { name: string; url: string } }>('/api/updates/bind', async (req, reply) => {
    const { name, url } = req.body ?? ({} as any)
    if (typeof name !== 'string' || typeof url !== 'string') return reply.status(400).send({ ok: false, error: 'name and url are required' })
    try {
      await bindSource(name, url)
    } catch (err: any) {
      return reply.status(400).send({ ok: false, error: err?.message || String(err) })
    }
    return { ok: true, report: await versionsReport() }
  })

  app.post<{ Body: { name: string } }>('/api/updates/unbind', async (req, reply) => {
    if (typeof req.body?.name !== 'string') return reply.status(400).send({ ok: false, error: 'name is required' })
    await unbindSource(req.body.name)
    return { ok: true, report: await versionsReport() }
  })
}
