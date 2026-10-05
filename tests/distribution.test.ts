import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { setupSandbox, writeSkill, settle } from './helpers'

const home = setupSandbox()
const warehouse = path.join(home, 'warehouse')
const cursorDir = path.join(home, '.cursor', 'skills')
const codexDir = path.join(home, '.codex', 'skills')
const geminiDir = path.join(home, '.gemini', 'skills')
const windsurfDir = path.join(home, '.codeium', 'windsurf', 'skills')
const projSkill = path.join(home, 'Documents', 'proj', '.agents', 'skills', 'x-proj')
const elsewhere = path.join(home, 'elsewhere', 'foreign')

// --- fixture: legacy config + a messy agent directory --------------------
for (const n of ['a', 'b', 'c']) writeSkill(warehouse, n)
fs.mkdirSync(path.join(home, '.config', 'skill-studio'), { recursive: true })
fs.writeFileSync(
  path.join(home, '.config', 'skill-studio', 'ide-settings.json'),
  JSON.stringify({
    customGlobalSkillsDir: warehouse,
    enabledAgentIds: ['cursor'],
    skillOverrides: { b: { disabledIdes: ['cursor'] } },
  }),
)
fs.writeFileSync(
  path.join(home, '.config', 'skill-studio', 'global-skills.json'),
  JSON.stringify({ globalSkills: ['c'], targetIdes: ['codex', 'cursor', 'windsurf'] }),
)
// A hand-made warehouse link in an agent the old global config targeted.
fs.mkdirSync(windsurfDir, { recursive: true })
fs.symlinkSync(path.join(warehouse, 'a'), path.join(windsurfDir, 'a'))
writeSkill(path.dirname(projSkill), 'x-proj')
writeSkill(path.dirname(elsewhere), 'foreign')
fs.mkdirSync(cursorDir, { recursive: true })
fs.symlinkSync(path.join(warehouse, 'stale'), path.join(cursorDir, 'stale')) // dangling, warehouse-owned
fs.symlinkSync(path.join(warehouse, 'b'), path.join(cursorDir, 'b')) // excluded by override
fs.symlinkSync(elsewhere, path.join(cursorDir, 'foreign')) // someone else's link
fs.symlinkSync(projSkill, path.join(cursorDir, 'x-proj')) // old cross-pollution
writeSkill(cursorDir, 'mine') // real dir
fs.mkdirSync(geminiDir, { recursive: true })
fs.symlinkSync(path.join(warehouse, 'a'), path.join(geminiDir, 'a')) // unmanaged agent

let app: FastifyInstance
const get = async (url: string) => JSON.parse((await app.inject({ method: 'GET', url })).body)
const send = (method: 'POST' | 'PUT', url: string, payload: any) => app.inject({ method, url, payload })
const getPlan = async (q = '') => (await get('/api/distribution/plan' + q)).plan
const types = (plan: any, type: string) => plan.actions.filter((a: any) => a.type === type).map((a: any) => `${a.agentIds.join('+')}:${a.name}`).sort()
const isLink = (p: string) => {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

beforeAll(async () => {
  const { skillRoutes } = await import('../server/routes/skills')
  const { manageRoutes } = await import('../server/routes/manage')
  const { distributionRoutes } = await import('../server/routes/distribution')
  const { globalRoutes } = await import('../server/routes/global')
  app = Fastify()
  for (const r of [skillRoutes, manageRoutes, distributionRoutes, globalRoutes]) await app.register(r)
})

afterAll(async () => {
  await settle()
  await app.close()
})

describe('unified distribution model', () => {
  it('migrates legacy config into distribution.json without touching disk', async () => {
    const before = fs.readdirSync(cursorDir).sort()
    const d = await get('/api/distribution')
    expect(d.state.agents.cursor).toEqual({ mode: 'all', exclude: ['b'] })
    expect(d.state.agents.codex).toEqual({ mode: 'global' })
    // Existing working links are preserved as explicit includes…
    expect(d.state.agents.windsurf).toEqual({ mode: 'global', include: ['a'] })
    // …but an explicit legacy opt-out still wins over the link on disk.
    expect(d.state.agents.cursor.include).toBeUndefined()
    expect(d.state.agents['gemini-cli']).toBeUndefined()
    expect(d.state.globalSet).toEqual(['c'])
    expect(fs.existsSync(path.join(home, '.config', 'skill-studio', 'distribution.json'))).toBe(true)
    expect(fs.readdirSync(cursorDir).sort()).toEqual(before)
  })

  it('scanning has no side effects on agent directories', async () => {
    const before = fs.readdirSync(cursorDir).sort()
    await get('/api/scan')
    expect(fs.readdirSync(cursorDir).sort()).toEqual(before)
    expect(fs.existsSync(codexDir)).toBe(false)
  })

  it('plans exactly the expected diff', async () => {
    const plan = await getPlan()
    expect(types(plan, 'link')).toEqual(['codex:c', 'cursor:a', 'cursor:c', 'windsurf:c']) // codex gets only the global set
    expect(types(plan, 'unlink')).toEqual(['cursor:b', 'cursor:stale']) // windsurf:a is NOT removed
    expect(types(plan, 'legacy')).toEqual(['cursor:x-proj'])
    const touched = plan.actions.map((a: any) => a.name)
    expect(touched).not.toContain('foreign') // someone else's link
    expect(touched).not.toContain('mine') // real directory
    expect(plan.actions.some((a: any) => a.dir === geminiDir)).toBe(false) // unmanaged agent
  })

  it('refuses to apply a stale preview', async () => {
    const r = await send('POST', '/api/distribution/apply', { fingerprint: 'not-the-plan' })
    expect(r.statusCode).toBe(409)
    expect(fs.existsSync(path.join(cursorDir, 'a'))).toBe(false)
  })

  it('applies the previewed plan, leaving legacy links until opted in', async () => {
    const plan = await getPlan()
    const r = await send('POST', '/api/distribution/apply', { fingerprint: plan.fingerprint })
    expect(JSON.parse(r.body).ok).toBe(true)

    expect(fs.realpathSync(path.join(cursorDir, 'a'))).toBe(fs.realpathSync(path.join(warehouse, 'a')))
    expect(isLink(path.join(cursorDir, 'c'))).toBe(true)
    expect(isLink(path.join(codexDir, 'c'))).toBe(true)
    expect(fs.existsSync(path.join(codexDir, 'a'))).toBe(false)
    expect(isLink(path.join(cursorDir, 'b'))).toBe(false)
    expect(isLink(path.join(cursorDir, 'stale'))).toBe(false)
    expect(isLink(path.join(cursorDir, 'x-proj'))).toBe(true) // legacy: not without opt-in
    expect(isLink(path.join(cursorDir, 'foreign'))).toBe(true)
    expect(fs.existsSync(path.join(cursorDir, 'mine', 'SKILL.md'))).toBe(true)
    expect(isLink(path.join(geminiDir, 'a'))).toBe(true)
    expect(fs.existsSync(path.join(warehouse, 'b', 'SKILL.md'))).toBe(true) // sources untouched

    const after = await getPlan()
    expect(after.counts.link + after.counts.relink + after.counts.unlink).toBe(0)
  })

  it('removes legacy cross-links only with includeLegacy, never their targets', async () => {
    await send('POST', '/api/distribution/apply', { includeLegacy: true })
    expect(isLink(path.join(cursorDir, 'x-proj'))).toBe(false)
    expect(fs.existsSync(path.join(projSkill, 'SKILL.md'))).toBe(true)
  })

  it('replaces an old cross-link squatting on a warehouse name only with opt-in', async () => {
    writeSkill(path.dirname(projSkill), 'c-fork', '# project copy\n')
    writeSkill(warehouse, 'c-fork', '# warehouse copy\n')
    fs.symlinkSync(path.join(path.dirname(projSkill), 'c-fork'), path.join(cursorDir, 'c-fork'))
    let plan = await getPlan()
    expect(plan.actions.find((a: any) => a.name === 'c-fork')).toMatchObject({ type: 'legacy', target: fs.realpathSync(path.join(warehouse, 'c-fork')) })
    await send('POST', '/api/distribution/apply', {})
    expect(fs.realpathSync(path.join(cursorDir, 'c-fork'))).toContain(path.join('proj', '.agents'))
    await send('POST', '/api/distribution/apply', { includeLegacy: true })
    expect(fs.realpathSync(path.join(cursorDir, 'c-fork'))).toBe(fs.realpathSync(path.join(warehouse, 'c-fork')))
    expect(fs.existsSync(path.join(path.dirname(projSkill), 'c-fork', 'SKILL.md'))).toBe(true)
    plan = await getPlan()
    expect(plan.actions.some((a: any) => a.name === 'c-fork')).toBe(false)
  })

  it('reports a real directory in the way as a conflict and leaves it alone', async () => {
    writeSkill(warehouse, 'mine', '# warehouse version\n')
    const plan = await getPlan()
    expect(types(plan, 'conflict')).toContain('cursor:mine')
    await send('POST', '/api/distribution/apply', {})
    expect(fs.lstatSync(path.join(cursorDir, 'mine')).isSymbolicLink()).toBe(false)
    fs.rmSync(path.join(warehouse, 'mine'), { recursive: true })
  })

  it('per-skill toggles edit include/exclude and apply only that skill', async () => {
    let r = await send('PUT', '/api/distribution/skills/a', { agents: { cursor: false } })
    expect(JSON.parse(r.body).ok).toBe(true)
    expect(isLink(path.join(cursorDir, 'a'))).toBe(false)
    expect((await get('/api/distribution')).state.agents.cursor.exclude).toEqual(['b', 'a'])

    r = await send('PUT', '/api/distribution/skills/a', { agents: { cursor: true } })
    expect(isLink(path.join(cursorDir, 'a'))).toBe(true)
    expect((await get('/api/distribution')).state.agents.cursor.exclude).toEqual(['b'])
  })

  it('refuses to distribute a skill that is not in the warehouse', async () => {
    const r = await send('PUT', '/api/distribution/skills/x-proj', { agents: { cursor: true } })
    expect(r.statusCode).toBe(400)
    expect(fs.existsSync(path.join(cursorDir, 'x-proj'))).toBe(false)
  })

  it('legacy association endpoint goes through the same model', async () => {
    const r = await send('POST', '/api/skills/b/association', { ides: { cursor: true }, enabledProjectPaths: [] })
    expect(JSON.parse(r.body).ok).toBe(true)
    expect(isLink(path.join(cursorDir, 'b'))).toBe(true)
    const status = await get('/api/skills/b/association')
    expect(status.ides.find((i: any) => i.id === 'cursor')).toMatchObject({ enabled: true, linked: true, managed: true })
  })

  it('global set changes apply to mode "global" agents', async () => {
    await send('POST', '/api/global-skills/toggle', { skillName: 'a', isGlobal: true })
    expect(isLink(path.join(codexDir, 'a'))).toBe(true)
    await send('POST', '/api/global-skills/toggle', { skillName: 'a', isGlobal: false })
    expect(isLink(path.join(codexDir, 'a'))).toBe(false)
  })

  it('agents sharing one physical directory get the union of their rules', async () => {
    const shared = path.join(home, '.mirasim', 'skills')
    fs.mkdirSync(shared, { recursive: true })
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.symlinkSync(shared, path.join(home, '.claude', 'skills'))
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true })
    fs.symlinkSync(shared, path.join(home, '.agents', 'skills'))

    await send('PUT', '/api/distribution/agents/claude-code', { mode: 'global' })
    await send('PUT', '/api/distribution/agents/universal', { mode: 'off', include: ['a'] })
    await send('POST', '/api/distribution/apply', {})
    expect(fs.readdirSync(shared).sort()).toEqual(['a', 'c'])

    // Dropping universal's include must not remove what claude-code still wants.
    await send('PUT', '/api/distribution/agents/universal', { mode: 'off', include: [] })
    await send('POST', '/api/distribution/apply', {})
    expect(fs.readdirSync(shared)).toEqual(['c'])
  })

  it('"remove all" sets the agent off and removes only managed links', async () => {
    const r = await send('POST', '/api/skills/batch/symlink', { action: 'remove_all', agentId: 'cursor' })
    expect(JSON.parse(r.body).ok).toBe(true)
    expect(fs.readdirSync(cursorDir).sort()).toEqual(['foreign', 'mine'])
    expect(isLink(path.join(windsurfDir, 'a'))).toBe(true) // other agents untouched
    expect((await get('/api/distribution')).state.agents.cursor).toEqual({ mode: 'off' })
  })
})
