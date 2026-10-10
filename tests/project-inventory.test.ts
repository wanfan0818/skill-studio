import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { setupSandbox, writeSkill, settle } from './helpers'

const home = setupSandbox()
const warehouse = path.join(home, 'warehouse')
writeSkill(warehouse, 'alpha')
writeSkill(warehouse, 'beta')
fs.mkdirSync(path.join(home, '.config', 'skill-studio'), { recursive: true })
fs.writeFileSync(path.join(home, '.config', 'skill-studio', 'ide-settings.json'), JSON.stringify({ customGlobalSkillsDir: warehouse }))

const proj = path.join(home, 'Documents', 'inv')
fs.mkdirSync(proj, { recursive: true })
fs.writeFileSync(
  path.join(proj, '.skills-profile.json'),
  JSON.stringify({ version: 2, name: 'inv', description: '', skills: ['alpha', 'ghost'], ides: ['codex'], createdAt: 'a', updatedAt: 'b' }),
)
writeSkill(path.join(proj, '.claude', 'skills'), 'made-here') // created in the project, not listed
fs.mkdirSync(path.join(proj, '.windsurf', 'skills'), { recursive: true })
fs.symlinkSync(path.join(warehouse, 'beta'), path.join(proj, '.windsurf', 'skills', 'beta')) // leftover link

let app: FastifyInstance
const get = async (url: string) => JSON.parse((await app.inject({ method: 'GET', url })).body)

beforeAll(async () => {
  const { projectRoutes } = await import('../server/routes/projects')
  app = Fastify()
  await app.register(projectRoutes)
})
afterAll(async () => {
  await settle()
  await app.close()
})

describe('project skill inventory', () => {
  it('lists every listed skill with description and source', async () => {
    const [p] = (await get('/api/projects')).projects
    const byName = Object.fromEntries(p.inventory.map((i: any) => [i.name, i]))
    expect(byName.alpha).toMatchObject({ inList: true, source: 'warehouse', description: 'test skill alpha' })
    expect(byName.ghost).toMatchObject({ inList: true, source: 'missing' })
  })

  it('surfaces skills sitting in the project that are not on the list', async () => {
    const [p] = (await get('/api/projects')).projects
    const byName = Object.fromEntries(p.inventory.map((i: any) => [i.name, i]))
    expect(byName['made-here']).toMatchObject({ inList: false, source: 'local', untrackedKind: 'local', localRel: '.claude/skills' })
    expect(byName.beta).toMatchObject({ inList: false, untrackedKind: 'leftover', foundIn: ['.windsurf/skills'] })
  })

  it('adding an untracked local skill puts it on the list and syncs it with a relative link', async () => {
    const [p] = (await get('/api/projects')).projects
    await app.inject({ method: 'POST', url: '/api/projects/profile', payload: { projectPath: proj, profile: { ...p.profile, skills: [...p.profile.skills, 'made-here'] } } })
    await app.inject({ method: 'POST', url: '/api/projects/apply', payload: { projectPath: proj } })
    const link = path.join(proj, '.agents', 'skills', 'made-here')
    expect(path.isAbsolute(fs.readlinkSync(link))).toBe(false)
    const [after] = (await get('/api/projects')).projects
    expect(after.inventory.find((i: any) => i.name === 'made-here')).toMatchObject({ inList: true, source: 'local' })
    expect(after.matrix['made-here'].codex).toBe('ok')
  })

  it('relative links resolve even when the project is reached through a symlinked path', async () => {
    // e.g. /var → /private/var on macOS: lexical relative paths would dangle
    const real = path.join(home, 'Documents', 'via-real')
    fs.mkdirSync(real, { recursive: true })
    // alias at a DIFFERENT depth than the real dir, like /var vs /private/var
    const alias = path.join(home, 'deep', 'er', 'alias-dir')
    fs.mkdirSync(path.dirname(alias), { recursive: true })
    fs.symlinkSync(path.join(home, 'Documents'), alias)
    const viaAlias = path.join(alias, 'via-real')
    writeSkill(path.join(real, '.claude', 'skills'), 'local-one')
    fs.writeFileSync(path.join(real, '.skills-profile.json'), JSON.stringify({ version: 2, name: 'via', description: '', skills: ['local-one'], ides: ['codex'], createdAt: 'a', updatedAt: 'b' }))
    const { applyProject } = await import('../server/projects/reconcile')
    const r = await applyProject(viaAlias)
    expect(r.failed).toBe(0)
    const link = path.join(real, '.agents', 'skills', 'local-one')
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(real, '.claude', 'skills', 'local-one')))
    expect(r.plan.matrix['local-one'].codex).toBe('ok')
  })
})
