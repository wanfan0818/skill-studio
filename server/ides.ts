import { AGENTS, isValidAgentId } from './scanner/agents.js'
import { readIdeSettingsFull } from './settings.js'

/**
 * The IDEs the user actually uses — the only ones offered in IDE pickers.
 *
 * Explicit `preferredIdes` in ide-settings.json wins. Otherwise derived from
 * what is already in use: agents with a distribution rule plus agents any
 * configured project syncs to. Returned in registry order.
 */
export async function resolvePreferredIdes(): Promise<{ ides: string[]; isDefault: boolean }> {
  const settings = await readIdeSettingsFull().catch(() => ({}) as any)
  const order = (ids: Iterable<string>) => {
    const set = new Set(ids)
    return AGENTS.map((a) => a.id as string).filter((id) => set.has(id) && id !== 'universal' && id !== 'unknown')
  }
  if (Array.isArray(settings.preferredIdes) && settings.preferredIdes.length) {
    return { ides: order(settings.preferredIdes.filter((id: string) => isValidAgentId(id))), isDefault: false }
  }

  const used = new Set<string>()
  try {
    const { readDistribution } = await import('./distribution/state.js')
    for (const id of Object.keys((await readDistribution()).agents)) used.add(id)
  } catch {}
  try {
    const { listConfiguredProjects } = await import('./projects/model.js')
    for (const p of await listConfiguredProjects()) for (const id of p.profile.ides) used.add(id)
  } catch {}
  const ides = order(used)
  return { ides: ides.length ? ides : ['claude-code'], isDefault: true }
}
