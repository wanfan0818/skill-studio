import type { FastifyInstance } from 'fastify'
import { invalidateCache } from './skills.js'
import { PlanChangedError } from '../distribution/reconcile.js'
import { qualityReport, previewTrim, applyTrim } from '../quality/report.js'

/** keep: string[] → hand-picked set; 'all' → back to every warehouse skill. */
function parseKeep(v: unknown): string[] | 'all' | null {
  if (v === 'all') return 'all'
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v
  return null
}

export async function qualityRoutes(app: FastifyInstance) {
  // Local only (no network): per-skill checks + per-IDE routing load.
  app.get('/api/quality', async () => ({ ok: true, ...(await qualityReport()) }))

  // What trimming an IDE's global set would change. Nothing is written.
  app.post<{ Body: { agentId: string; keep: unknown } }>('/api/quality/trim/preview', async (req, reply) => {
    const keep = parseKeep(req.body?.keep)
    if (typeof req.body?.agentId !== 'string' || !keep) return reply.status(400).send({ ok: false, error: 'agentId and keep are required' })
    try {
      return { ok: true, preview: await previewTrim(req.body.agentId, keep) }
    } catch (err: any) {
      return reply.status(400).send({ ok: false, error: err?.message || String(err) })
    }
  })

  // Save the IDE's new rule and apply it to that IDE only (symlinks / managed copies).
  app.post<{ Body: { agentId: string; keep: unknown; fingerprint?: string } }>('/api/quality/trim', async (req, reply) => {
    const keep = parseKeep(req.body?.keep)
    if (typeof req.body?.agentId !== 'string' || !keep) return reply.status(400).send({ ok: false, error: 'agentId and keep are required' })
    try {
      const r = await applyTrim(req.body.agentId, keep, typeof req.body.fingerprint === 'string' ? req.body.fingerprint : undefined)
      invalidateCache()
      return { ok: r.failed === 0, ...r, report: await qualityReport() }
    } catch (err: any) {
      if (err instanceof PlanChangedError) return reply.status(409).send({ ok: false, code: 'PLAN_CHANGED', error: '磁盘上的情况变了，请重新预览后再执行' })
      return reply.status(400).send({ ok: false, error: err?.message || String(err) })
    }
  })
}
