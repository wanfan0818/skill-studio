import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Point HOME and cwd at a fresh temp directory. MUST run before any server
 * module is imported (they read os.homedir() at import time), so test files
 * import server code dynamically after calling this.
 */
export function setupSandbox(): string {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-test-')))
  process.env.HOME = home
  process.chdir(home)
  return home
}

export function writeSkill(dir: string, name: string, body = '# content\n'): string {
  const skillDir = path.join(dir, name)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill ${name}\n---\n${body}`)
  return skillDir
}

export function writeProfile(projectPath: string, skills: string[], targetIde: string) {
  fs.writeFileSync(
    path.join(projectPath, '.skills-profile.json'),
    JSON.stringify({ version: 1, name: path.basename(projectPath), description: '', skills, targetIde }, null, 2),
  )
}

/** Wait out the 1.5s isSyncingSymlinks lock timers so they don't leak between tests. */
export const settle = () => new Promise((r) => setTimeout(r, 1600))
