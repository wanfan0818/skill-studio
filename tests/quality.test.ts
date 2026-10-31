import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { setupSandbox, writeSkill } from './helpers'

const home = setupSandbox()
const warehouse = path.join(home, 'warehouse')
const wbDir = path.join(home, '.workbuddy', 'skills')
fs.mkdirSync(wbDir, { recursive: true })
fs.mkdirSync(path.join(home, '.config', 'skill-studio'), { recursive: true })
fs.writeFileSync(path.join(home, '.config', 'skill-studio', 'ide-settings.json'), JSON.stringify({ customGlobalSkillsDir: warehouse }))
fs.writeFileSync(path.join(home, '.config', 'skill-studio', 'distribution.json'), JSON.stringify({ version: 1, globalSet: [], agents: { workbuddy: { mode: 'all' } } }))

const names = Array.from({ length: 60 }, (_, i) => `skill-${String(i).padStart(2, '0')}`)
for (const n of names) writeSkill(warehouse, n)
writeSkill(wbDir, 'my-own') // a real folder the user put there: not Skill Studio's to remove

const proj = path.join(home, 'Documents', 'p1')
fs.mkdirSync(proj, { recursive: true })
fs.writeFileSync(
  path.join(proj, '.skills-profile.json'),
  JSON.stringify({ version: 2, name: 'p1', description: '', skills: ['skill-05'], ides: ['workbuddy'], createdAt: 'a', updatedAt: 'b' }),
)

const lintDir = path.join(home, 'lint')
function skill(name: string, frontmatter: string, body = '# body\n') {
  const dir = path.join(lintDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`)
  return dir
}

let Q: typeof import('../server/quality/report')
let L: typeof import('../server/quality/lint')
const codes = async (dir: string) => (await L.lintSkill(dir)).issues.map((i) => i.code)

beforeAll(async () => {
  Q = await import('../server/quality/report')
  L = await import('../server/quality/lint')
  const { apply } = await import('../server/distribution/reconcile')
  await apply()
})

describe('skill checks', () => {
  it('a well-formed skill only gets suggestions, if anything', async () => {
    const dir = skill('good-one', 'name: good-one\ndescription: 把会议录音整理成纪要。用于会议结束后整理要点和待办；不用于逐字稿翻译。', 'See [guide](references/guide.md).\n')
    fs.mkdirSync(path.join(dir, 'references'))
    fs.writeFileSync(path.join(dir, 'references', 'guide.md'), 'x')
    expect((await L.lintSkill(dir)).issues).toEqual([])
  })

  it('flags what makes an IDE reject, truncate or mis-route a skill', async () => {
    expect(await codes(skill('no-desc', 'name: no-desc'))).toContain('missing-description')
    expect(await codes(skill('long-desc', `name: long-desc\ndescription: "${'很长的描述。'.repeat(200)}"`))).toContain('description-too-long')
    expect(await codes(skill('short-desc', 'name: short-desc\ndescription: 做图'))).toContain('description-too-short')
    expect(await codes(skill('folder-a', 'name: other-name\ndescription: 用于测试名称与目录不一致的情况，这里需要足够长的描述文字。'))).toContain('name-folder-mismatch')
    expect(await codes(skill('bad:name', 'name: "bad:name"\ndescription: 用于测试名称格式的情况，这里需要足够长的描述文字才行。'))).toContain('name-format')
    const bad = path.join(lintDir, 'bad-yaml')
    fs.mkdirSync(bad, { recursive: true })
    fs.writeFileSync(path.join(bad, 'SKILL.md'), '---\nname: [unclosed\n---\n')
    expect(await codes(bad)).toContain('bad-frontmatter')
  })

  it('flags package-structure problems', async () => {
    const dir = skill('structure', 'name: structure\ndescription: 用于测试结构问题的 Skill，这里需要足够长的描述文字。', 'Read [ref](references/missing.md) and [x](../outside.md).\n')
    fs.mkdirSync(path.join(dir, 'examples', 'demo'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'examples', 'demo', 'SKILL.md'), '---\nname: demo\n---\n')
    const issues = (await L.lintSkill(dir)).issues
    expect(issues.find((i) => i.code === 'nested-skill-md')?.message).toContain('examples/demo/SKILL.md')
    expect(issues.find((i) => i.code === 'broken-links')?.message).toContain('references/missing.md')
    const lower = path.join(lintDir, 'lower')
    fs.mkdirSync(lower)
    fs.writeFileSync(path.join(lower, 'skill.md'), '---\nname: lower\ndescription: 用于测试小写入口文件名的情况，描述需要足够长。\n---\n')
    expect(await codes(lower)).toContain('lowercase-skill-md')
    fs.mkdirSync(path.join(lintDir, 'empty'))
    expect(await codes(path.join(lintDir, 'empty'))).toEqual(['missing-skill-md'])
  })

  it('estimates tokens for CJK and Latin text', () => {
    expect(L.estimateTokens('abcdabcd')).toBe(2)
    expect(L.estimateTokens('会议纪要')).toBe(4)
  })
})

describe('IDE routing load', () => {
  it('counts what the IDE actually loads, which entries Skill Studio manages, and project usage', async () => {
    const r = await Q.qualityReport()
    const wb = r.ides.find((i) => i.id === 'workbuddy')!
    expect(wb).toMatchObject({ count: 61, level: 'red', mode: 'all' })
    expect(wb.tokens).toBeGreaterThan(0)
    const by = Object.fromEntries(wb.skills.map((s) => [s.name, s]))
    expect(by['skill-00'].managed).toBe(true)
    expect(by['my-own'].managed).toBe(false)
    expect(by['skill-05'].projects).toEqual(['p1'])
    expect(r.counts.overloadedIdes).toBe(1)
    expect(r.skills).toHaveLength(60)
  })

  it('previewing a trim changes nothing', async () => {
    const keep = names.slice(0, 10)
    const p = await Q.previewTrim('workbuddy', keep)
    expect(p.remove).toHaveLength(50)
    expect(p.add).toEqual([])
    expect(fs.readdirSync(wbDir)).toHaveLength(61)
    const { readDistribution } = await import('../server/distribution/state')
    expect((await readDistribution()).agents.workbuddy.mode).toBe('all')
  })

  it('trimming keeps only the chosen skills, leaves the warehouse and user folders alone, and stops auto-adding', async () => {
    const keep = names.slice(0, 10)
    const p = await Q.previewTrim('workbuddy', keep)
    const r = await Q.applyTrim('workbuddy', keep, p.fingerprint)
    expect(r.failed).toBe(0)
    expect(fs.readdirSync(wbDir).sort()).toEqual([...keep, 'my-own'].sort())
    expect(fs.readdirSync(warehouse)).toHaveLength(60)
    const { readDistribution } = await import('../server/distribution/state')
    expect((await readDistribution()).agents.workbuddy).toMatchObject({ mode: 'global', include: keep })

    writeSkill(warehouse, 'brand-new')
    const { plan } = await import('../server/distribution/reconcile')
    expect((await plan({ agentIds: ['workbuddy'] })).actions.filter((a) => a.name === 'brand-new')).toEqual([])
    const after = (await Q.qualityReport()).ides.find((i) => i.id === 'workbuddy')!
    expect(after).toMatchObject({ count: 11, level: 'green', mode: 'global' })
  })

  it('a stale preview is refused', async () => {
    await expect(Q.applyTrim('workbuddy', names.slice(0, 5), 'stale-fingerprint')).rejects.toThrow()
    expect(fs.readdirSync(wbDir)).toHaveLength(11)
  })

  it('an old link into the warehouse under another name counts as managed (a trim removes it, so the panel must say so)', async () => {
    fs.symlinkSync(path.join(warehouse, 'skill-01'), path.join(wbDir, 'old-alias'))
    const wb = (await Q.qualityReport()).ides.find((i) => i.id === 'workbuddy')!
    expect(wb.skills.find((s) => s.name === 'old-alias')?.managed).toBe(true)
    expect(wb.skills.find((s) => s.name === 'my-own')?.managed).toBe(false)
    expect((await Q.previewTrim('workbuddy', names.slice(0, 10))).remove).toContain('old-alias')
  })

  it('restoring "all" brings every warehouse skill back', async () => {
    const r = await Q.applyTrim('workbuddy', 'all')
    expect(r.failed).toBe(0)
    expect(fs.readdirSync(wbDir).sort()).toEqual([...names, 'brand-new', 'my-own'].sort()) // old-alias cleaned up
  })
})
