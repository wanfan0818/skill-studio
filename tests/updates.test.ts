import { describe, it, expect, beforeAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { setupSandbox, writeSkill } from './helpers'

// No network in tests: "upstream" writes a marker file instead of cloning.
vi.mock('../server/updater/installer', () => ({
  updateSkillFromGithub: vi.fn(async (dir: string, source: any, latest?: string) => {
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${path.basename(dir)}\ndescription: upstream\n---\n# upstream ${latest}\n`)
    fs.writeFileSync(path.join(dir, '.skill-source'), JSON.stringify({ ...source, installedCommit: latest, latestCommit: latest, updateAvailable: false }))
  }),
}))

// Upstream folder trees: set per test.
const upstream = new Map<string, string | null>()
vi.mock('../server/updates/upstream', () => ({
  GithubApiError: class extends Error {},
  upstreamTree: vi.fn(async (owner: string, repo: string, _branch: string, sub: string) => {
    const k = `${owner}/${repo}/${sub}`
    if (!upstream.has(k)) throw new Error(`unexpected lookup ${k}`)
    const tree = upstream.get(k)
    return tree ? { status: 'ok', tree, branch: 'main' } : { status: 'missing', branch: 'main' }
  }),
}))

const home = setupSandbox()
const warehouse = path.join(home, 'warehouse')
const teleDir = path.join(home, '.config', 'TeleAgent', 'users', 'u1', 'skills')
fs.mkdirSync(teleDir, { recursive: true })
fs.mkdirSync(path.join(home, '.config', 'skill-studio'), { recursive: true })
fs.writeFileSync(path.join(home, '.config', 'skill-studio', 'ide-settings.json'), JSON.stringify({ customGlobalSkillsDir: warehouse }))
fs.writeFileSync(
  path.join(home, '.config', 'skill-studio', 'distribution.json'),
  JSON.stringify({ version: 1, globalSet: [], agents: { teleagent: { mode: 'global', include: ['mine', 'gh-new'] } } }),
)

writeSkill(warehouse, 'mine') // self-made, no upstream
const ghSource = (installed: string, latest: string) => ({ owner: 'acme', repo: 'tools', branch: 'main', installedCommit: installed, latestCommit: latest, updateAvailable: installed !== latest })
for (const [name, src] of [
  ['gh-new', ghSource('a', 'b')], // upstream has news
  ['gh-edit', ghSource('a', 'a')], // will be edited locally
  ['gh-both', ghSource('a', 'b')], // edited AND upstream news
] as const) {
  writeSkill(warehouse, name)
  fs.writeFileSync(path.join(warehouse, name, '.skill-source'), JSON.stringify(src))
}

let S: typeof import('../server/updates/status')
const state = async (name: string) => (await S.versionsReport()).skills.find((s) => s.name === name)!

beforeAll(async () => {
  S = await import('../server/updates/status')
  await S.versionsReport() // first sight: today's content becomes the baseline
  const { apply } = await import('../server/distribution/reconcile')
  await apply() // TeleAgent gets real copies
  fs.appendFileSync(path.join(warehouse, 'gh-edit', 'SKILL.md'), 'my tweak\n')
  fs.appendFileSync(path.join(warehouse, 'gh-both', 'SKILL.md'), 'my tweak\n')
})

describe('skill update state', () => {
  it('classifies skills: self-made, upstream news, local edits, conflict', async () => {
    const r = await S.versionsReport()
    const by = Object.fromEntries(r.skills.map((s) => [s.name, s]))
    expect(by.mine).toMatchObject({ kind: 'local', state: 'synced' })
    expect(by['gh-new']).toMatchObject({ kind: 'github', state: 'upstream', source: { repo: 'acme/tools' } })
    expect(by['gh-edit'].state).toBe('local-edited')
    expect(by['gh-both'].state).toBe('conflict')
    expect(r.counts).toMatchObject({ upstream: 1, 'local-edited': 1, conflict: 1, github: 3, local: 1 })
  })

  it('a file touched but not changed (e.g. re-synced by a cloud drive) is not an edit', async () => {
    const f = path.join(warehouse, 'gh-new', 'SKILL.md')
    const later = new Date(Date.now() + 60_000)
    fs.utimesSync(f, later, later)
    expect((await state('gh-new')).state).toBe('upstream')
    const { readBaselines } = await import('../server/updates/baseline')
    const { getSkillFolderSignature } = await import('../server/scanner/drift')
    const real = fs.realpathSync(path.join(warehouse, 'gh-new'))
    expect((await readBaselines())[real].signature).toBe(await getSkillFolderSignature(real)) // next time: no content read
  })

  it('one-click update takes only the safe ones and refreshes their copies', async () => {
    const r = await S.updateSkills()
    expect(r.updated).toEqual(['gh-new'])
    expect(r.skipped.map((s) => s.name).sort()).toEqual(['gh-both', 'gh-edit'])
    expect(r.copiesRefreshed).toBe(1)
    expect(fs.readFileSync(path.join(teleDir, 'gh-new', 'SKILL.md'), 'utf-8')).toContain('upstream b')
    expect((await state('gh-new')).state).toBe('synced')
    expect((await state('gh-both')).state).toBe('conflict') // untouched
  })

  it('keeping local edits clears the conflict until a newer upstream commit', async () => {
    await S.keepLocal('gh-both')
    expect((await state('gh-both')).state).toBe('synced')
    expect(fs.readFileSync(path.join(warehouse, 'gh-both', 'SKILL.md'), 'utf-8')).toContain('my tweak')
    const src = JSON.parse(fs.readFileSync(path.join(warehouse, 'gh-both', '.skill-source'), 'utf-8'))
    fs.writeFileSync(path.join(warehouse, 'gh-both', '.skill-source'), JSON.stringify({ ...src, latestCommit: 'c', updateAvailable: true }))
    expect((await state('gh-both')).state).toBe('upstream')
  })

  it('forcing an update over local edits keeps the old version in the recycle bin', async () => {
    const r = await S.updateSkills({ names: ['gh-edit'], force: true })
    expect(r.updated).toEqual(['gh-edit'])
    expect(fs.readFileSync(path.join(warehouse, 'gh-edit', 'SKILL.md'), 'utf-8')).not.toContain('my tweak')
    expect((await state('gh-edit')).state).toBe('synced')
  })
})

describe('copies stay in line with the warehouse', () => {
  it('a source edit makes the copy stale; refresh brings it in line', async () => {
    fs.appendFileSync(path.join(warehouse, 'mine', 'SKILL.md'), 'v2\n')
    expect((await state('mine')).copies).toMatchObject([{ status: 'stale', path: path.join(teleDir, 'mine') }])
    expect((await S.refreshCopies()).refreshed).toBe(1)
    expect((await state('mine')).copies).toEqual([])
    expect(fs.readFileSync(path.join(teleDir, 'mine', 'SKILL.md'), 'utf-8')).toContain('v2')
  })

  it('an edit made inside the IDE is reported, and can be pulled back into the warehouse', async () => {
    fs.appendFileSync(path.join(teleDir, 'mine', 'SKILL.md'), 'edited in TeleAgent\n')
    const c = (await state('mine')).copies
    expect(c).toMatchObject([{ status: 'edited' }])
    await S.pullBackCopy(c[0].path)
    expect(fs.readFileSync(path.join(warehouse, 'mine', 'SKILL.md'), 'utf-8')).toContain('edited in TeleAgent')
    expect((await state('mine')).copies).toEqual([])
  })

  it('or overwritten from the warehouse', async () => {
    fs.appendFileSync(path.join(teleDir, 'mine', 'SKILL.md'), 'throwaway\n')
    await S.overwriteCopy(path.join(teleDir, 'mine'))
    expect(fs.readFileSync(path.join(teleDir, 'mine', 'SKILL.md'), 'utf-8')).not.toContain('throwaway')
    expect((await state('mine')).copies).toEqual([])
  })
})

describe('upstream checks compare folder trees', () => {
  it('a lock-file folder hash stored as a "commit" by older versions is migrated, not reported as an update', async () => {
    // `npx skills add` install: lock records the folder tree; an older Skill Studio
    // copied it into installedCommit and compared it with commit SHAs.
    writeSkill(warehouse, 'lock-skill')
    fs.writeFileSync(
      path.join(warehouse, 'lock-skill', '.skill-source'),
      JSON.stringify({ owner: 'acme', repo: 'kit', branch: 'main', subPath: 'skills/lock-skill', installedCommit: 'tree1', latestCommit: 'c9', updateAvailable: true }),
    )
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true })
    fs.writeFileSync(
      path.join(home, '.agents', '.skill-lock.json'),
      JSON.stringify({ skills: { 'lock-skill': { source: 'acme/kit', sourceType: 'github', skillPath: 'skills/lock-skill/SKILL.md', skillFolderHash: 'tree1' } } }),
    )
    const s = await state('lock-skill')
    expect(s.state).toBe('synced')
    expect(s.source).toMatchObject({ installedTree: 'tree1' })
    expect(s.source!.installedCommit).toBeUndefined()

    upstream.set('acme/kit/skills/lock-skill', 'tree1')
    expect((await S.checkUpstream(['lock-skill'])).withUpdates).toBe(0)
    expect((await state('lock-skill')).state).toBe('synced')

    upstream.set('acme/kit/skills/lock-skill', 'tree2') // the folder changed upstream
    expect((await S.checkUpstream(['lock-skill'])).withUpdates).toBe(1)
    expect((await state('lock-skill')).state).toBe('upstream')
  })

  it('a folder removed upstream is flagged, never "updated", and can be detached', async () => {
    upstream.set('acme/kit/skills/lock-skill', null)
    await S.checkUpstream(['lock-skill'])
    const s = await state('lock-skill')
    expect(s.source!.missing).toBe(true)
    expect(s.state).toBe('synced')
    const r = await S.updateSkills({ names: ['lock-skill'] })
    expect(r.skipped[0].reason).toContain('上游')
    await S.unbindSource('lock-skill')
    expect((await state('lock-skill')).kind).toBe('local') // and not re-bound from the lock file
  })
})
