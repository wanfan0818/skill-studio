import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { setupSandbox, writeSkill } from './helpers'

const home = setupSandbox()
const warehouse = path.join(home, 'warehouse')
fs.mkdirSync(path.join(home, '.config', 'skill-studio'), { recursive: true })
fs.writeFileSync(path.join(home, '.config', 'skill-studio', 'ide-settings.json'), JSON.stringify({ customGlobalSkillsDir: warehouse }))
// A skill with many deep files: must not cost one descriptor per file.
const big = writeSkill(warehouse, 'big')
fs.mkdirSync(path.join(big, 'scripts'))
for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(big, 'scripts', `f${i}.py`), 'x')

const watcher = await import('../server/scanner/watcher')
afterAll(() => watcher.stopWatcher())

const openFds = () => Number(execSync(`lsof -p ${process.pid} | wc -l`).toString().trim())
const settle = (ms = 1200) => new Promise((r) => setTimeout(r, ms))

describe('file watcher', () => {
  it('filters to events that change scan results', () => {
    expect(watcher.isRelevant('new-skill')).toBe(true)
    expect(watcher.isRelevant('new-skill/SKILL.md')).toBe(true)
    expect(watcher.isRelevant('big/scripts/f1.py')).toBe(false)
    expect(watcher.isRelevant('big/node_modules/x/SKILL.md')).toBe(false)
    expect(watcher.isRelevant('.DS_Store')).toBe(false)
  })

  it('does not hold a descriptor per watched file, and reports skill changes', async () => {
    const before = openFds()
    const events: string[] = []
    await watcher.startWatcher((e) => events.push(path.relative(fs.realpathSync(warehouse), e.path)))
    await settle()
    expect(openFds() - before).toBeLessThan(20) // was one per file with chokidar

    writeSkill(warehouse, 'added-later')
    fs.writeFileSync(path.join(big, 'SKILL.md'), '---\nname: big\ndescription: edited\n---\n')
    fs.writeFileSync(path.join(big, 'scripts', 'f1.py'), 'changed')
    await settle(2500)
    expect(events.some((e) => e.startsWith('added-later'))).toBe(true)
    expect(events).toContain(path.join('big', 'SKILL.md'))
    expect(events).not.toContain(path.join('big', 'scripts', 'f1.py'))
  })
})
