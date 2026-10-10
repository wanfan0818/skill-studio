import type { FastifyInstance } from 'fastify'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { invalidateCache } from './skills.js'
import { readIdeSettingsFull, writeIdeSettingsFull, warehouseDirsFrom, type AppSettings } from '../settings.js'
import { resolvePreferredIdes } from '../ides.js'
import { isValidAgentId } from '../scanner/agents.js'

const homedir = os.homedir()

/** App settings: warehouse paths, GitHub token (write-only), HTTP proxy. */
export async function settingsRoutes(app: FastifyInstance) {
  // GET /api/settings
  app.get('/api/settings', async () => {
    const settings = await readIdeSettingsFull()
    const { githubToken, ...rest } = settings
    // The token never leaves the server; the UI only needs to know it exists.
    // `warehouses` is the resolved list (including the default when unset).
    const preferred = await resolvePreferredIdes()
    return {
      ok: true,
      settings: {
        ...rest,
        hasGithubToken: !!githubToken,
        warehouses: warehouseDirsFrom(settings),
        // Resolved list (explicit, or derived from what is in use).
        preferredIdes: preferred.ides,
        preferredIdesIsDefault: preferred.isDefault,
      },
    }
  })

  // Set the IDEs shown in pickers; `null` / [] returns to automatic detection.
  app.post<{ Body: { preferredIdes: string[] | null } }>('/api/settings/preferred-ides', async (req, reply) => {
    const list = req.body?.preferredIdes
    if (list !== null && (!Array.isArray(list) || !list.every((x) => typeof x === 'string' && isValidAgentId(x)))) {
      reply.status(400)
      return { ok: false, error: 'preferredIdes 必须是 IDE id 数组或 null' }
    }
    const settings = await readIdeSettingsFull()
    await writeIdeSettingsFull({ ...settings, preferredIdes: list && list.length ? list : undefined })
    return { ok: true, ...(await resolvePreferredIdes()) }
  })

  // POST /api/settings
  app.post<{
    Body: {
      customGlobalSkillsDir?: string
      skillWarehouses?: string[]
      githubToken?: string
      clearGithubToken?: boolean
      httpProxy?: string
    }
  }>('/api/settings', async (req, reply) => {
    const { customGlobalSkillsDir, skillWarehouses, githubToken, clearGithubToken, httpProxy } = req.body ?? ({} as any)
    
    let normalizedPath: string | undefined = undefined
    if (customGlobalSkillsDir && customGlobalSkillsDir.trim() !== '') {
      const p = customGlobalSkillsDir.trim()
      if (!path.isAbsolute(p)) {
        reply.status(400)
        return { ok: false, error: '存储路径必须是绝对路径' }
      }
      normalizedPath = path.resolve(p)
    }

    let normalizedWarehouses: string[] | undefined = undefined
    if (Array.isArray(skillWarehouses)) {
      normalizedWarehouses = skillWarehouses
        .filter((w) => typeof w === 'string' && w.trim() !== '')
        .map((w) => (w.startsWith('~') ? path.join(homedir, w.slice(1)) : path.resolve(w.trim())))
    }

    const oldSettings = await readIdeSettingsFull()
    const newSettings: AppSettings = {
      customGlobalSkillsDir: normalizedPath,
      skillWarehouses: normalizedWarehouses !== undefined ? normalizedWarehouses : oldSettings.skillWarehouses,
      // Empty / omitted token means "keep the stored one" (the UI never
      // receives it, so it cannot echo it back). Clearing is explicit.
      githubToken: clearGithubToken
        ? undefined
        : typeof githubToken === 'string' && githubToken.trim() !== ''
          ? githubToken.trim()
          : oldSettings.githubToken,
      httpProxy: httpProxy !== undefined ? httpProxy : oldSettings.httpProxy,
      preferredIdes: oldSettings.preferredIdes,
      // Legacy distribution fields: migrated into distribution.json, kept
      // untouched here (they used to be dropped on every save).
      enabledAgentIds: oldSettings.enabledAgentIds,
      skillOverrides: oldSettings.skillOverrides,
    }

    // Changing the warehouse path no longer moves every agent's real skill
    // directories as a side effect. Adopting them is an explicit action
    // ("一键收归"), and the new warehouse only takes effect on the next apply.
    if (newSettings.customGlobalSkillsDir) await fs.mkdir(newSettings.customGlobalSkillsDir, { recursive: true })

    await writeIdeSettingsFull(newSettings)

    // Dynamic apply proxy settings
    const { setupProxy } = await import('../sync/proxy.js')
    await setupProxy()

    invalidateCache()
    const { githubToken: _token, ...publicSettings } = newSettings
    return { ok: true, settings: { ...publicSettings, hasGithubToken: !!newSettings.githubToken } }
  })
}
