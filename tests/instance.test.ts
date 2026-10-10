import { describe, it, expect } from 'vitest'
import { setupSandbox } from './helpers'

setupSandbox()

describe('single-instance startup', () => {
  it('recognizes only production Skill Studio server processes', async () => {
    const { isSkillStudioServerCommand } = await import('../server/instance')
    expect(isSkillStudioServerCommand('/usr/local/bin/node /Users/x/skill-studio/dist/server/index.js')).toBe(true)
    expect(isSkillStudioServerCommand('node /Users/x/.npm-global/lib/node_modules/claude-skill-studio/dist/server/index.js')).toBe(true)
    expect(isSkillStudioServerCommand('node /Users/x/skill-studio/node_modules/.bin/tsx watch server/index.ts')).toBe(false)
    expect(isSkillStudioServerCommand('node /Users/x/other-app/dist/server/index.js')).toBe(false)
    expect(isSkillStudioServerCommand('vite --port 5173')).toBe(false)
  })

  it('with nothing running on the candidate ports, starts on the base port', async () => {
    const { resolveStartup } = await import('../server/instance')
    const d = await resolveStartup(3591, 'test@1', 2)
    expect(d).toEqual({ action: 'start', port: 3591, stopped: [] })
  })
})
