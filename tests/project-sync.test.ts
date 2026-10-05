import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { setupSandbox, writeSkill, writeProfile, settle } from './helpers'

const home = setupSandbox()
let app: FastifyInstance

beforeAll(async () => {
  const { projectRoutes } = await import('../server/routes/projects')
  const { skillRoutes } = await import('../server/routes/skills')
  app = Fastify()
  await app.register(skillRoutes)
  await app.register(projectRoutes)
  // A shared skill that lives outside any project.
  writeSkill(path.join(home, '.agents', 'skills'), 'shared-skill', '# shared master\n')
})

afterAll(async () => {
  await settle()
  await app.close()
})

function newProject(name: string): string {
  const p = path.join(home, 'Documents', name)
  fs.mkdirSync(p, { recursive: true })
  return p
}

const sync = (projectPath: string) =>
  app.inject({ method: 'POST', url: '/api/projects/sync', payload: { projectPath } })

describe('project sync never destroys user-owned skills', () => {
  it('GET /api/projects is read-only (no auto-written antigravity profile)', async () => {
    const proj = newProject('read-only')
    writeSkill(path.join(proj, '.agents', 'skills'), 'handwritten')
    const res = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(res.statusCode).toBe(200)
    expect(fs.existsSync(path.join(proj, '.skills-profile.json'))).toBe(false)
  })

  it('antigravity: a skill whose only copy is in the project survives sync', async () => {
    // Exact reproduction of the original data-loss bug.
    const proj = newProject('antigravity-local')
    const skillDir = writeSkill(path.join(proj, '.agents', 'skills'), 'only-copy', '# precious\n')
    fs.writeFileSync(path.join(skillDir, 'helper.py'), 'print(1)\n')
    writeProfile(proj, ['only-copy'], 'antigravity')

    const res = await sync(proj)
    expect(res.statusCode).toBe(200)
    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')).toContain('# precious')
    expect(fs.existsSync(path.join(skillDir, 'helper.py'))).toBe(true)
  })

  it('antigravity: unlisted real directories are kept, unlisted managed copies go to the trash', async () => {
    const proj = newProject('antigravity-cleanup')
    const skillsDir = path.join(proj, '.agents', 'skills')
    const userDir = writeSkill(skillsDir, 'user-owned')
    const managed = writeSkill(skillsDir, 'old-copy')
    fs.writeFileSync(path.join(managed, '.skill-source'), JSON.stringify({ originPath: '/somewhere/old-copy' }))
    writeProfile(proj, ['shared-skill'], 'antigravity')

    await sync(proj)
    expect(fs.existsSync(path.join(userDir, 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(managed)).toBe(false)
    const trashRoot = path.join(home, '.skill-studio', 'trash')
    const trashed = fs.readdirSync(trashRoot).map((id) =>
      JSON.parse(fs.readFileSync(path.join(trashRoot, id, '.trash-meta.json'), 'utf-8')).skillName,
    )
    expect(trashed).toContain('old-copy')
    // The listed shared skill was materialized as a managed copy.
    expect(fs.existsSync(path.join(skillsDir, 'shared-skill', '.skill-source'))).toBe(true)
  })

  it('claude-code: a real .claude/skills directory is not replaced by a link', async () => {
    const proj = newProject('claude-real-dir')
    fs.mkdirSync(path.join(proj, '.agents', 'skills'), { recursive: true })
    const mine = writeSkill(path.join(proj, '.claude', 'skills'), 'mine', '# my own\n')
    writeProfile(proj, ['shared-skill'], 'claude-code')

    await sync(proj)
    expect(fs.lstatSync(path.join(proj, '.claude', 'skills')).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(mine, 'SKILL.md'), 'utf-8')).toContain('# my own')
    expect(fs.lstatSync(path.join(proj, '.claude', 'skills', 'shared-skill')).isSymbolicLink()).toBe(true)
  })

  it('symlink mode: a same-name real directory is left intact', async () => {
    const proj = newProject('same-name')
    const own = writeSkill(path.join(proj, '.claude', 'skills'), 'shared-skill', '# local fork\n')
    writeProfile(proj, ['shared-skill'], 'claude-code')

    const res = await sync(proj)
    expect(res.statusCode).toBe(200)
    expect(fs.lstatSync(own).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf-8')).toContain('# local fork')
  })

  it('rejects relative or non-existent project paths', async () => {
    const res = await sync('relative/path')
    expect(res.statusCode).toBe(400)
    const res2 = await sync(path.join(home, 'does-not-exist'))
    expect(res2.statusCode).toBe(400)
  })
})
