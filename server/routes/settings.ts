import type { FastifyInstance } from 'fastify'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { invalidateCache } from './skills.js'
import { readIdeSettingsFull, writeIdeSettingsFull, type AppSettings } from '../settings.js'

const homedir = os.homedir()

/** App settings: warehouse paths, GitHub token (write-only), HTTP proxy. */
export async function settingsRoutes(app: FastifyInstance) {
  // GET /api/settings
  app.get('/api/settings', async () => {
    const { githubToken, ...rest } = await readIdeSettingsFull()
    // The token never leaves the server; the UI only needs to know it exists.
    return { ok: true, settings: { ...rest, hasGithubToken: !!githubToken } }
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
