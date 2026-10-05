import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { setupSandbox, writeSkill, settle } from './helpers'

const home = setupSandbox()
const warehouse = path.join(home, 'warehouse')
fs.mkdirSync(path.join(home, '.config', 'skill-studio'), { recursive: true })
fs.writeFileSync(path.join(home, '.config', 'skill-studio', 'ide-settings.json'), JSON.stringify({ customGlobalSkillsDir: warehouse, skillWarehouses: [path.join(home, 'Documents', 'kb', 'skills-warehouse')] }))

// One warehouse skill linked from three agents: must be parsed once, listed once.
const shared = writeSkill(warehouse, 'shared', '# shared body\n')
for (const dir of ['.cursor/skills', '.codex/skills', '.workbuddy/skills']) {
  fs.mkdirSync(path.join(home, dir), { recursive: true })
  fs.symlinkSync(shared, path.join(home, dir, 'shared'))
}
// Frontmatter `source:` used to make the scan write a .skill-source file.
const sourced = path.join(warehouse, 'sourced')
fs.mkdirSync(sourced)
fs.writeFileSync(path.join(sourced, 'SKILL.md'), '---\nname: sourced\ndescription: d\nsource: https://github.com/acme/skills/tree/main/sourced\n---\nbody\n')
// Malformed YAML frontmatter.
const broken = path.join(warehouse, 'broken')
fs.mkdirSync(broken)
fs.writeFileSync(path.join(broken, 'SKILL.md'), '---\nname: broken\ndescription: "unterminated: [\n---\n# still readable\n')
// Project buried under a hidden dir must not be discovered by walking.
writeSkill(path.join(home, 'Documents', '.hidden', 'proj', '.claude', 'skills'), 'hidden-proj')
writeSkill(path.join(home, 'Documents', 'visible', '.claude', 'skills'), 'visible-proj')
// A warehouse that lives under ~/Documents and contains project-like markers
// (like the real 004-Resource/002-skills with its .claude/.agents dirs).
const docWarehouse = path.join(home, 'Documents', 'kb', 'skills-warehouse')
writeSkill(path.join(docWarehouse, '.claude', 'skills'), 'wh-inner')
writeSkill(path.join(docWarehouse, 'bundle', '.agents', 'skills'), 'bundle-inner')

let app: FastifyInstance
let discovery: typeof import('../server/scanner/discovery')

beforeAll(async () => {
  discovery = await import('../server/scanner/discovery')
  const { skillRoutes } = await import('../server/routes/skills')
  app = Fastify()
  await app.register(skillRoutes)
})
afterAll(async () => {
  await settle()
  await app.close()
})

describe('scan performance changes keep results correct', () => {
  it('scanning never writes into skill directories', async () => {
    await discovery.fullScan()
    expect(fs.existsSync(path.join(sourced, '.skill-source'))).toBe(false)
    const res = await discovery.fullScan()
    const s = res.skills.find((x) => x.name === 'sourced')!
    expect(s.githubSource).toMatchObject({ owner: 'acme', repo: 'skills', branch: 'main', subPath: 'sourced' })
  })

  it('a skill linked from several agents is one entry with all agents attached', async () => {
    discovery.markScanDirty()
    const res = await discovery.fullScan()
    const entries = res.skills.filter((x) => x.name === 'shared')
    expect(entries).toHaveLength(1)
    expect([...(entries[0].linkedIdes ?? [])].sort()).toEqual(['codex', 'cursor', 'workbuddy'])
  })

  it('malformed frontmatter gives the same result on every scan', async () => {
    const pick = async () => {
      discovery.markScanDirty()
      const s = (await discovery.fullScan()).skills.find((x) => x.realPath === fs.realpathSync(broken))!
      return { name: s.name, desc: s.description, content: s.content }
    }
    const first = await pick()
    expect(first.name).toBe('broken') // falls back to the directory name
    expect(first.content).toContain('# still readable')
    expect(await pick()).toEqual(first)
  })

  it('project discovery skips hidden directories', async () => {
    const projects = (await discovery.discoverProjects()).map((p) => path.basename(p.path))
    expect(projects).toContain('visible')
    expect(projects).not.toContain('proj')
  })

  it('a skill warehouse (and anything inside it) is never a project', async () => {
    const projects = (await discovery.discoverProjects()).map((p) => path.basename(p.path))
    expect(projects).not.toContain('skills-warehouse')
    expect(projects).not.toContain('bundle')
    expect(projects).toContain('visible')
  })

  it('concurrent scans are coalesced, but a scan after markScanDirty is fresh', async () => {
    discovery.markScanDirty()
    const [a, b] = await Promise.all([discovery.fullScan(), discovery.fullScan()])
    expect(a).toBe(b)
    writeSkill(warehouse, 'late-addition')
    discovery.markScanDirty()
    const c = await discovery.fullScan()
    expect(c).not.toBe(a)
    expect(c.skills.some((x) => x.name === 'late-addition')).toBe(true)
  })

  it('drift is detected after a copy changes, and cleared when it matches again', async () => {
    const { checkSkillDrift } = await import('../server/scanner/drift')
    const copy = path.join(home, 'copy-of-shared')
    fs.cpSync(shared, copy, { recursive: true })
    expect(await checkSkillDrift(shared, copy)).toBe(false)
    fs.writeFileSync(path.join(copy, 'SKILL.md'), 'edited in the project\n')
    expect(await checkSkillDrift(shared, copy)).toBe(true)
    fs.cpSync(path.join(shared, 'SKILL.md'), path.join(copy, 'SKILL.md'))
    expect(await checkSkillDrift(shared, copy)).toBe(false)
  })

  it('list payload omits SKILL.md text; the detail endpoint returns it', async () => {
    const list = JSON.parse((await app.inject({ method: 'GET', url: '/api/scan?force=1' })).body)
    const s = list.skills.find((x: any) => x.name === 'shared')
    expect(s.content).toBeUndefined()
    expect(s.description).toBe('test skill shared')
    const detail = JSON.parse((await app.inject({ method: 'GET', url: `/api/skills/${s.id}` })).body)
    expect(detail.content).toContain('# shared body')
  })

  it('/api/scan serves the cache until invalidated', async () => {
    const first = JSON.parse((await app.inject({ method: 'GET', url: '/api/scan' })).body)
    writeSkill(warehouse, 'not-yet-visible')
    const cached = JSON.parse((await app.inject({ method: 'GET', url: '/api/scan' })).body)
    expect(cached.skills.length).toBe(first.skills.length)
    const forced = JSON.parse((await app.inject({ method: 'GET', url: '/api/scan?force=1' })).body)
    expect(forced.skills.some((x: any) => x.name === 'not-yet-visible')).toBe(true)
  })
})
