import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { setupSandbox, writeSkill, settle } from './helpers'

const home = setupSandbox()
const warehouse = path.join(home, 'warehouse')
const teleDir = path.join(home, '.config', 'TeleAgent', 'users', 'v1_public_123', 'skills')

for (const n of ['alpha', 'beta', 'gamma']) writeSkill(warehouse, n, `# ${n} v1\n`)
fs.mkdirSync(path.join(home, '.config', 'skill-studio'), { recursive: true })
fs.writeFileSync(path.join(home, '.config', 'skill-studio', 'ide-settings.json'), JSON.stringify({ customGlobalSkillsDir: warehouse }))
fs.writeFileSync(
  path.join(home, '.config', 'skill-studio', 'distribution.json'),
  JSON.stringify({ version: 1, globalSet: [], agents: { teleagent: { mode: 'off', include: ['alpha', 'beta'] } } }),
)
fs.mkdirSync(teleDir, { recursive: true })
fs.symlinkSync(path.join(warehouse, 'beta'), path.join(teleDir, 'beta')) // old-style link TeleAgent ignores
writeSkill(teleDir, 'gamma', '# TeleAgent built-in gamma\n') // TeleAgent's own skill, same name

let app: FastifyInstance
const get = async (url: string) => JSON.parse((await app.inject({ method: 'GET', url })).body)
const plan = async () => (await get('/api/distribution/plan')).plan
const apply = (body: any = {}) => app.inject({ method: 'POST', url: '/api/distribution/apply', payload: body })
const byType = (p: any, t: string) => p.actions.filter((a: any) => a.type === t).map((a: any) => a.name).sort()
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf-8')
const isLink = (p: string) => fs.lstatSync(p).isSymbolicLink()

beforeAll(async () => {
  const { skillRoutes } = await import('../server/routes/skills')
  const { distributionRoutes } = await import('../server/routes/distribution')
  app = Fastify()
  await app.register(skillRoutes)
  await app.register(distributionRoutes)
})
afterAll(async () => {
  await settle()
  await app.close()
})

describe('copy mode (agents that ignore symlinks, e.g. TeleAgent)', () => {
  it('plans real copies, converting existing warehouse symlinks', async () => {
    const p = await plan()
    expect(byType(p, 'copy')).toEqual(['alpha', 'beta'])
    expect(byType(p, 'link')).toEqual([])
    const d = await get('/api/distribution')
    expect(d.agents.find((a: any) => a.id === 'teleagent').linkMode).toBe('copy')
  })

  it('applies real directories with a marker, atomically', async () => {
    const r = await apply()
    expect(JSON.parse(r.body).ok).toBe(true)
    for (const n of ['alpha', 'beta']) {
      expect(isLink(path.join(teleDir, n))).toBe(false)
      expect(read(teleDir, n, 'SKILL.md')).toContain(`# ${n} v1`)
      const marker = JSON.parse(read(teleDir, n, '.skill-source'))
      expect(marker.originPath).toBe(fs.realpathSync(path.join(warehouse, n)))
      expect(marker.fingerprint).toBeTruthy()
    }
    expect(fs.readdirSync(teleDir).filter((e) => e.includes('ss-tmp'))).toEqual([]) // no temp leftovers
    expect((await plan()).actions.filter((a: any) => a.type !== 'conflict')).toEqual([])
  })

  it("never touches the agent's own skill with the same name", async () => {
    await app.inject({ method: 'PUT', url: '/api/distribution/skills/gamma', payload: { agents: { teleagent: true }, apply: false } })
    const p = await plan()
    expect(byType(p, 'conflict')).toContain('gamma')
    await apply()
    expect(read(teleDir, 'gamma', 'SKILL.md')).toContain('TeleAgent built-in gamma')
  })

  it('refreshes a copy when the warehouse version changes', async () => {
    fs.writeFileSync(path.join(warehouse, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: d\n---\n# alpha v2\n')
    expect(byType(await plan(), 'update')).toEqual(['alpha'])
    await apply()
    expect(read(teleDir, 'alpha', 'SKILL.md')).toContain('# alpha v2')
  })

  it('never overwrites a copy that was edited inside the agent', async () => {
    fs.writeFileSync(path.join(teleDir, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: d\n---\n# beta evolved by TeleAgent\n')
    fs.writeFileSync(path.join(warehouse, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: d\n---\n# beta v2\n')
    const p = await plan()
    expect(byType(p, 'update')).not.toContain('beta')
    expect(p.actions.find((a: any) => a.name === 'beta' && a.type === 'conflict').reason).toContain('被修改')
    await apply()
    expect(read(teleDir, 'beta', 'SKILL.md')).toContain('evolved by TeleAgent')
  })

  it('deselecting removes an untouched copy, but sends an edited one to the trash', async () => {
    await app.inject({ method: 'PUT', url: '/api/distribution/agents/teleagent', payload: { mode: 'off', include: [] } })
    const p = await plan()
    expect(byType(p, 'unlink')).toEqual(['alpha', 'beta'])
    await apply()
    expect(fs.existsSync(path.join(teleDir, 'alpha'))).toBe(false)
    expect(fs.existsSync(path.join(teleDir, 'beta'))).toBe(false)
    const trashRoot = path.join(home, '.skill-studio', 'trash')
    const trashed = fs.readdirSync(trashRoot).map((id) => JSON.parse(read(trashRoot, id, '.trash-meta.json')).skillName)
    expect(trashed).toEqual(['beta']) // the edited copy is recoverable
    expect(read(teleDir, 'gamma', 'SKILL.md')).toContain('TeleAgent built-in gamma')
    expect(read(warehouse, 'beta', 'SKILL.md')).toContain('# beta v2') // sources untouched
  })
})
