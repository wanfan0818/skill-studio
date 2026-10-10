import type { FastifyInstance } from 'fastify'
import { skillFileRoutes } from './skill-files.js'
import { agentDirRoutes } from './agent-dirs.js'
import { associationRoutes } from './association.js'
import { settingsRoutes } from './settings.js'

/**
 * Former 1400-line grab bag, now split by concern. Kept as an aggregator so
 * existing registrations / imports keep working.
 */
export { readIdeSettingsFull, writeIdeSettingsFull, type AppSettings } from '../settings.js'

export async function manageRoutes(app: FastifyInstance) {
  await app.register(skillFileRoutes)
  await app.register(agentDirRoutes)
  await app.register(associationRoutes)
  await app.register(settingsRoutes)
}
