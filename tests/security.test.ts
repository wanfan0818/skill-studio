import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { setupSandbox, writeSkill, settle } from './helpers'

const home = setupSandbox()

// Stub `npx` on PATH: records its argv instead of hitting the network.
const binDir = path.join(home, 'bin')
fs.mkdirSync(binDir)
fs.writeFileSync(path.join(binDir, 'npx'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/npx-args.txt"\n', { mode: 0o755 })
process.env.PATH = `${binDir}:${process.env.PATH}`

const configDir = path.join(home, '.config', 'skill-studio')
const ideSettingsPath = path.join(configDir, 'ide-settings.json')
const victim = path.join(home, 'victim')

let app: FastifyInstance

beforeAll(async () => {
  const { skillRoutes } = await import('../server/routes/skills')
  const { manageRoutes } = await import('../server/routes/manage')
  const { marketRoutes } = await import('../server/routes/market')
  const { githubRoutes } = await import('../server/routes/github')
  const { trashRoutes } = await import('../server/routes/trash')
  app = Fastify()
  for (const r of [skillRoutes, manageRoutes, marketRoutes, githubRoutes, trashRoutes]) await app.register(r)
})

afterAll(async () => {
  await settle()
  await app.close()
})

beforeEach(() => {
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(
    ideSettingsPath,
    JSON.stringify({
      enabledAgentIds: [],
      githubToken: 'ghp_SANDBOX_TOKEN',
      skillOverrides: { foo: { disabledIdes: ['cursor'] } },
    }),
  )
  fs.mkdirSync(victim, { recursive: true })
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'keep')
})

describe('request guard', () => {
  let guarded: FastifyInstance
  beforeAll(async () => {
    const { registerGuard } = await import('../server/security/guard')
    guarded = Fastify()
    registerGuard(guarded, 'tok123')
    guarded.get('/api/ping', async () => ({ ok: true }))
    guarded.get('/', async () => 'page')
  })
  afterAll(() => guarded.close())

  const req = (url: string, headers: Record<string, string>) => guarded.inject({ method: 'GET', url, headers })

  it('rejects a foreign Host (DNS rebinding)', async () => {
    expect((await req('/api/ping', { host: 'evil.example:3456', 'x-skill-studio-token': 'tok123' })).statusCode).toBe(403)
    expect((await req('/', { host: 'evil.example:3456' })).statusCode).toBe(403)
  })
  it('rejects a foreign Origin', async () => {
    const r = await req('/api/ping', { host: 'localhost:3456', origin: 'https://evil.example', 'x-skill-studio-token': 'tok123' })
    expect(r.statusCode).toBe(403)
  })
  it('rejects API calls without the session token', async () => {
    expect((await req('/api/ping', { host: '127.0.0.1:3456' })).statusCode).toBe(401)
    expect((await req('/api/ping', { host: '127.0.0.1:3456', 'x-skill-studio-token': 'wrong' })).statusCode).toBe(401)
  })
  it('accepts the token via header or cookie, and the page sets the cookie', async () => {
    expect((await req('/api/ping', { host: 'localhost:3456', 'x-skill-studio-token': 'tok123' })).statusCode).toBe(200)
    expect((await req('/api/ping', { host: 'localhost:3456', cookie: 'ss_token=tok123' })).statusCode).toBe(200)
    const page = await req('/', { host: 'localhost:3456' })
    expect(page.statusCode).toBe(200)
    expect(String(page.headers['set-cookie'])).toMatch(/ss_token=tok123;.*SameSite=Strict/)
  })
})

describe('no shell injection', () => {
  it('market search passes the query as a literal argument', async () => {
    const proof = path.join(home, 'pwned')
    const q = `$(touch ${proof})`
    await app.inject({ method: 'GET', url: '/api/skills/market/search?q=' + encodeURIComponent(q) })
    expect(fs.existsSync(proof)).toBe(false)
    expect(fs.readFileSync(path.join(home, 'npx-args.txt'), 'utf-8').split('\n')).toContain(q)
  })
  it('market install rejects option-like / malformed targets', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/skills/market/install', payload: { target: '--help; id', scope: 'global' } })
    expect(r.statusCode).toBe(400)
  })
  it('github clone rejects malformed repo URLs', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/skills/market/github-clone', payload: { repoUrl: '--upload-pack=touch /tmp/x' } })
    expect(r.statusCode).toBe(400)
  })
})

describe('settings', () => {
  it('GET never returns the GitHub token', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/settings' })
    const body = JSON.parse(r.body)
    expect(body.settings.githubToken).toBeUndefined()
    expect(body.settings.hasGithubToken).toBe(true)
    expect(r.body).not.toContain('ghp_SANDBOX_TOKEN')
  })
  it('POST keeps skillOverrides and the stored token, and writes the file 0600', async () => {
    await app.inject({ method: 'POST', url: '/api/settings', payload: { httpProxy: '' } })
    const saved = JSON.parse(fs.readFileSync(ideSettingsPath, 'utf-8'))
    expect(saved.skillOverrides).toEqual({ foo: { disabledIdes: ['cursor'] } })
    expect(saved.githubToken).toBe('ghp_SANDBOX_TOKEN')
    expect(fs.statSync(ideSettingsPath).mode & 0o777).toBe(0o600)
  })
  it('clearing the token is explicit', async () => {
    await app.inject({ method: 'POST', url: '/api/settings', payload: { clearGithubToken: true } })
    expect(JSON.parse(fs.readFileSync(ideSettingsPath, 'utf-8')).githubToken).toBeUndefined()
  })
  it('a malformed settings file is reported, never overwritten', async () => {
    fs.writeFileSync(ideSettingsPath, '{ "githubToken": "ghp_x", broken')
    const r = await app.inject({ method: 'POST', url: '/api/settings', payload: { httpProxy: '' } })
    expect(r.statusCode).toBe(500)
    expect(fs.readFileSync(ideSettingsPath, 'utf-8')).toBe('{ "githubToken": "ghp_x", broken')
  })
  it('a malformed ~/.claude/settings.json is not clobbered by the skill toggle', async () => {
    const claudeSettings = path.join(home, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(claudeSettings), { recursive: true })
    const original = '{ "hooks": { "Stop": [] }, // a comment makes this invalid JSON\n}'
    fs.writeFileSync(claudeSettings, original)
    const r = await app.inject({ method: 'PUT', url: '/api/skills/x/toggle', payload: { enabled: false, skillName: 'foo' } })
    expect(r.statusCode).toBe(500)
    expect(fs.readFileSync(claudeSettings, 'utf-8')).toBe(original)
  })
})

describe('path confinement', () => {
  it('github-install refuses a tempPath it did not create (was rm -rf)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/skills/market/github-install',
      payload: { tempPath: victim, skillPath: victim, scope: 'global' },
    })
    expect(r.statusCode).toBe(403)
    expect(fs.existsSync(path.join(victim, 'keep.txt'))).toBe(true)
  })
  it('content PUT writes the scanned skill, ignoring a client-supplied realPath', async () => {
    const skillDir = writeSkill(path.join(home, '.agents', 'skills'), 'editable')
    fs.writeFileSync(path.join(victim, 'SKILL.md'), 'original')
    const list = JSON.parse((await app.inject({ method: 'GET', url: '/api/scan' })).body)
    const skill = list.skills.find((s: any) => s.name === 'editable')
    const r = await app.inject({
      method: 'PUT',
      url: `/api/skills/${skill.id}/content`,
      payload: { realPath: victim, content: 'updated' },
    })
    expect(JSON.parse(r.body).ok).toBe(true)
    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8')).toBe('updated')
    expect(fs.readFileSync(path.join(victim, 'SKILL.md'), 'utf-8')).toBe('original')
  })
  it('delete refuses paths that are not discovered skills', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/api/skills/x', payload: { path: victim } })
    expect(r.statusCode).toBe(404)
    expect(fs.existsSync(path.join(victim, 'keep.txt'))).toBe(true)
  })
  it('trash purge refuses traversal ids', async () => {
    await app.inject({ method: 'DELETE', url: '/api/trash/' + encodeURIComponent('../../victim') })
    expect(fs.existsSync(path.join(victim, 'keep.txt'))).toBe(true)
  })
})
