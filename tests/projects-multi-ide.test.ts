import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { setupSandbox, writeSkill, writeProfile, settle } from './helpers'

const home = setupSandbox()
const warehouse = path.join(home, 'warehouse')
for (const n of ['alpha', 'beta']) writeSkill(warehouse, n, `# ${n}\n`)
fs.mkdirSync(path.join(home, '.config', 'skill-studio'), { recursive: true })
fs.writeFileSync(path.join(home, '.config', 'skill-studio', 'ide-settings.json'), JSON.stringify({ customGlobalSkillsDir: warehouse }))

const docs = path.join(home, 'Documents')
const proj = path.join(docs, 'multi')
fs.mkdirSync(proj, { recursive: true })
// v1 profile (single targetIde) + a leftover managed link in .codex/skills
writeProfile(proj, ['alpha', 'beta'], 'codex')
fs.mkdirSync(path.join(proj, '.codex', 'skills'), { recursive: true })
fs.symlinkSync(path.join(warehouse, 'alpha'), path.join(proj, '.codex', 'skills', 'alpha'))
const ownSkill = writeSkill(path.join(proj, '.claude', 'skills'), 'own', '# project-local\n')
// …and one in a dir no selected IDE will read (ZCode's own dir)
fs.mkdirSync(path.join(proj, '.zcode', 'skills'), { recursive: true })
fs.symlinkSync(path.join(warehouse, 'beta'), path.join(proj, '.zcode', 'skills', 'beta'))

// An old auto-generated profile → candidate, not configured
const auto = path.join(docs, 'auto')
fs.mkdirSync(auto, { recursive: true })
writeSkill(path.join(auto, '.workbuddy-ai', 'skills'), 'w1')
fs.writeFileSync(path.join(auto, '.skills-profile.json'), JSON.stringify({ version: 1, name: 'auto', description: '自动配置的项目 Profile', skills: ['w1'], targetIde: 'antigravity', createdAt: 't', updatedAt: 't' }))
// A folder with skills but no profile → candidate
const loose = path.join(docs, 'loose')
writeSkill(path.join(loose, '.agents', 'skills'), 'l1')

let app: FastifyInstance
const get = async (url: string) => JSON.parse((await app.inject({ method: 'GET', url })).body)
const post = async (url: string, payload: any) => JSON.parse((await app.inject({ method: 'POST', url, payload })).body)
const plan = async (p = proj) => (await get('/api/projects/plan?projectPath=' + encodeURIComponent(p))).plan
const setIdes = (ides: string[], skills = ['alpha', 'beta']) => post('/api/projects/profile', { projectPath: proj, profile: { ides, skills } })
const lst = (p: string) => fs.lstatSync(p)

beforeAll(async () => {
  const { skillRoutes } = await import('../server/routes/skills')
  const { projectRoutes } = await import('../server/routes/projects')
  app = Fastify()
  await app.register(skillRoutes)
  await app.register(projectRoutes)
})
afterAll(async () => {
  await settle()
  await app.close()
})

describe('project-centric, multi-IDE model', () => {
  it('lists only configured projects; reads v1 profiles as ides: [targetIde]', async () => {
    const { projects } = await get('/api/projects')
    expect(projects.map((p: any) => path.basename(p.path))).toEqual(['multi'])
    expect(projects[0].profile.ides).toEqual(['codex'])
    const { candidates } = await get('/api/projects/candidates')
    const byName = Object.fromEntries(candidates.map((c: any) => [path.basename(c.path), c]))
    expect(Object.keys(byName).sort()).toEqual(['auto', 'loose'])
    expect(byName.auto.autoProfile).toBe(true)
    expect(byName.auto.suggestedIdes).toContain('workbuddy-ai') // its own dir names it
    expect(byName.loose.suggestedIdes).toEqual([]) // .agents/skills alone is ambiguous
  })

  it('several IDEs sharing .agents/skills get ONE link per skill; WorkBuddy AI gets its own dirs', async () => {
    await setIdes(['codex', 'opencode', 'workbuddy-ai'])
    const p = await plan()
    expect(p.ides.map((i: any) => i.id)).toEqual(['codex', 'opencode', 'workbuddy-ai'])
    const links = p.actions.filter((a: any) => a.type === 'link').map((a: any) => path.relative(proj, a.linkPath)).sort()
    expect(links).toEqual([
      '.agents/skills/alpha', '.agents/skills/beta',
      '.workbuddy-ai/skills/alpha', '.workbuddy-ai/skills/beta',
      '.workbuddy/skills/alpha', '.workbuddy/skills/beta',
    ])
    await post('/api/projects/apply', { projectPath: proj, fingerprint: p.fingerprint })
    const after = await plan()
    for (const skill of ['alpha', 'beta']) for (const ide of ['codex', 'opencode', 'workbuddy-ai']) expect(after.matrix[skill][ide]).toBe('ok')
  })

  it('an old dir a selected IDE still reads is migrated by default (no duplicates)', async () => {
    // .codex/skills is read by Codex (selected) → its managed link moves to .agents/skills
    expect(fs.existsSync(path.join(proj, '.codex', 'skills', 'alpha'))).toBe(false)
    expect(lst(path.join(proj, '.agents', 'skills', 'alpha')).isSymbolicLink()).toBe(true)
  })

  it('a dir no selected IDE reads is only cleaned with includeLegacy', async () => {
    const p = await plan()
    expect(p.strayDirs.find((d: any) => d.rel === '.zcode/skills')).toMatchObject({ managed: 1 })
    expect(p.actions.find((a: any) => a.linkPath.includes('.zcode'))).toMatchObject({ type: 'legacy' })
    await post('/api/projects/apply', { projectPath: proj })
    expect(lst(path.join(proj, '.zcode', 'skills', 'beta')).isSymbolicLink()).toBe(true)
    await post('/api/projects/apply', { projectPath: proj, includeLegacy: true })
    expect(fs.existsSync(path.join(proj, '.zcode', 'skills', 'beta'))).toBe(false)
    expect(fs.existsSync(path.join(ownSkill, 'SKILL.md'))).toBe(true) // real dirs stay
  })

  it("a project's own skill is distributed with a relative link and shown as local where it lives", async () => {
    await setIdes(['claude-code', 'codex'], ['alpha', 'own'])
    await post('/api/projects/apply', { projectPath: proj })
    const link = path.join(proj, '.agents', 'skills', 'own')
    expect(lst(link).isSymbolicLink()).toBe(true)
    expect(path.isAbsolute(fs.readlinkSync(link))).toBe(false)
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(ownSkill))
    const p = await plan()
    expect(p.matrix.own['claude-code']).toBe('local')
    expect(p.matrix.own.codex).toBe('ok')
    // beta was dropped from the list → its managed links are removed
    expect(fs.existsSync(path.join(proj, '.agents', 'skills', 'beta'))).toBe(false)
  })

  it('adding Antigravity turns the shared dir into real copies', async () => {
    await setIdes(['codex', 'antigravity'], ['alpha'])
    const p = await plan()
    expect(p.actions.find((a: any) => a.name === 'alpha' && a.linkPath.includes('.agents'))).toMatchObject({ type: 'copy' })
    await post('/api/projects/apply', { projectPath: proj })
    const dir = path.join(proj, '.agents', 'skills', 'alpha')
    expect(lst(dir).isSymbolicLink()).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.skill-source'), 'utf-8')).originPath).toBe(fs.realpathSync(path.join(warehouse, 'alpha')))
    expect((await plan()).matrix.alpha).toEqual({ codex: 'ok', antigravity: 'ok' })
  })

  it('an old copy without a fingerprint is replaced only on opt-in, old copy to the trash', async () => {
    const dir = path.join(proj, '.agents', 'skills', 'alpha')
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.skill-source'), 'utf-8'))
    delete marker.fingerprint // as written by older versions
    fs.writeFileSync(path.join(dir, '.skill-source'), JSON.stringify(marker))
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: alpha\ndescription: d\n---\n# old copy\n')
    let p = await plan()
    expect(p.matrix.alpha.antigravity).toBe('conflict')
    expect(p.actions.find((a: any) => a.name === 'alpha' && a.linkPath === dir)).toMatchObject({ type: 'legacy', isCopy: true })
    await post('/api/projects/apply', { projectPath: proj })
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8')).toContain('# old copy')
    await post('/api/projects/apply', { projectPath: proj, includeLegacy: true })
    expect(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8')).toContain('# alpha')
    const trashRoot = path.join(home, '.skill-studio', 'trash')
    expect(fs.readdirSync(trashRoot).some((id) => JSON.parse(fs.readFileSync(path.join(trashRoot, id, '.trash-meta.json'), 'utf-8')).skillName === 'alpha')).toBe(true)
    p = await plan()
    expect(p.matrix.alpha.antigravity).toBe('ok')
  })

  it('importing a candidate configures it with the suggested IDEs', async () => {
    const r = await post('/api/projects/import', { projectPath: auto })
    expect(r.ok).toBe(true)
    expect(r.profile.ides).toContain('workbuddy-ai')
    expect(r.profile.skills).toEqual(['w1'])
    const { projects } = await get('/api/projects')
    expect(projects.map((p: any) => path.basename(p.path)).sort()).toEqual(['auto', 'multi'])
  })

  it('a shared project dir is attributed to "universal", not the first agent claiming it', async () => {
    writeSkill(path.join(proj, '.agents', 'skills'), 'shared-own')
    const { fullScan, markScanDirty } = await import('../server/scanner/discovery')
    markScanDirty()
    const r = await fullScan()
    const s = r.skills.find((x) => x.name === 'shared-own')
    expect(s?.agent).toBe('universal')
  })
})
