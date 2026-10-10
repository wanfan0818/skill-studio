import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { setupSandbox, writeSkill, settle } from './helpers'

const home = setupSandbox()
const warehouse = path.join(home, 'warehouse')
writeSkill(warehouse, 'alpha')
writeSkill(warehouse, 'beta')
const teleDir = path.join(home, '.config', 'TeleAgent', 'users', 'v1_public_1', 'skills')
fs.mkdirSync(teleDir, { recursive: true })
fs.mkdirSync(path.join(home, '.config', 'skill-studio'), { recursive: true })
fs.writeFileSync(path.join(home, '.config', 'skill-studio', 'ide-settings.json'), JSON.stringify({ customGlobalSkillsDir: warehouse }))
fs.writeFileSync(path.join(home, '.config', 'skill-studio', 'distribution.json'), JSON.stringify({ version: 1, globalSet: [], agents: { teleagent: { mode: 'off' } } }))

const proj = path.join(home, 'Documents', 'tele-proj')
fs.mkdirSync(proj, { recursive: true })
writeSkill(path.join(proj, '.claude', 'skills'), 'local-x')
fs.writeFileSync(
  path.join(proj, '.skills-profile.json'),
  JSON.stringify({ version: 2, name: 'tele-proj', description: '', skills: ['alpha', 'local-x'], ides: ['codex', 'teleagent'], createdAt: 'a', updatedAt: 'b' }),
)

let app: FastifyInstance
const get = async (url: string) => JSON.parse((await app.inject({ method: 'GET', url })).body)
const post = async (url: string, payload: any) => JSON.parse((await app.inject({ method: 'POST', url, payload })).body)
const plan = async () => (await get('/api/projects/plan?projectPath=' + encodeURIComponent(proj))).plan

beforeAll(async () => {
  const { projectRoutes } = await import('../server/routes/projects')
  const { distributionRoutes } = await import('../server/routes/distribution')
  const { settingsRoutes } = await import('../server/routes/settings')
  const { skillRoutes } = await import('../server/routes/skills')
  app = Fastify()
  for (const r of [skillRoutes, projectRoutes, distributionRoutes, settingsRoutes]) await app.register(r)
})
afterAll(async () => {
  await settle()
  await app.close()
})

describe('TeleAgent as a project IDE (account-level skills)', () => {
  it('is offered as an account-level project IDE', async () => {
    const { ides } = await get('/api/projects/ides')
    const tele = ides.find((i: any) => i.id === 'teleagent')
    expect(tele).toMatchObject({ viaGlobal: true, mode: 'copy' })
    expect(tele.name).toContain('账号级')
  })

  it("plans the project's warehouse skills into TeleAgent; project-local ones are unavailable", async () => {
    const p = await plan()
    expect(p.matrix.alpha.teleagent).toBe('pending')
    expect(p.matrix['local-x'].teleagent).toBe('unavailable')
    expect(p.warnings.some((w: string) => w.includes('local-x'))).toBe(true)
    expect(p.actions.find((a: any) => a.viaGlobal && a.name === 'alpha')).toMatchObject({ type: 'copy' })
  })

  it('applying the project writes a real copy into TeleAgent and counts it as project-needed', async () => {
    const r = await post('/api/projects/apply', { projectPath: proj })
    expect(r.ok).toBe(true)
    const copy = path.join(teleDir, 'alpha')
    expect(fs.lstatSync(copy).isSymbolicLink()).toBe(false)
    expect(fs.existsSync(path.join(copy, '.skill-source'))).toBe(true)
    expect(fs.existsSync(path.join(teleDir, 'local-x'))).toBe(false)
    const p = await plan()
    expect(p.matrix.alpha.teleagent).toBe('ok')
    expect(p.matrix.alpha.codex).toBe('ok')
    const d = await get('/api/distribution')
    expect(d.agents.find((a: any) => a.id === 'teleagent')).toMatchObject({ fromProjects: 1, desired: 1, satisfied: 1 })
  })

  it('dropping the skill from the project leaves removal to the distribution panel', async () => {
    const prof = (await plan()).profile
    await post('/api/projects/profile', { projectPath: proj, profile: { ...prof, skills: ['local-x'] } })
    await post('/api/projects/apply', { projectPath: proj })
    expect(fs.existsSync(path.join(teleDir, 'alpha'))).toBe(true) // project apply doesn't remove other TeleAgent state
    const g = (await get('/api/distribution/plan?agents=teleagent')).plan
    expect(g.actions.find((a: any) => a.name === 'alpha')).toMatchObject({ type: 'unlink', isCopy: true })
    await post('/api/distribution/apply', { agentIds: ['teleagent'] })
    expect(fs.existsSync(path.join(teleDir, 'alpha'))).toBe(false)
  })
})

describe('preferred IDEs', () => {
  it('defaults to the IDEs already in use, in registry order', async () => {
    const s = (await get('/api/settings')).settings
    expect(s.preferredIdesIsDefault).toBe(true)
    expect(s.preferredIdes).toEqual(['codex', 'teleagent'])
  })

  it('an explicit list limits the project IDE catalog; null returns to auto', async () => {
    await post('/api/settings/preferred-ides', { preferredIdes: ['claude-code', 'codex'] })
    expect((await get('/api/projects/ides')).ides.map((i: any) => i.id)).toEqual(['claude-code', 'codex'])
    const d = await get('/api/distribution')
    expect(d.agents.find((a: any) => a.id === 'cursor').preferred).toBe(false)
    await post('/api/settings/preferred-ides', { preferredIdes: null })
    expect((await get('/api/settings')).settings.preferredIdesIsDefault).toBe(true)
  })
})
