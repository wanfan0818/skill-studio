import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { setupSandbox, writeSkill } from './helpers'

const home = setupSandbox()

describe('GitHub import: install folder name', () => {
  it('derives the repo name from clone URLs', async () => {
    const { repoNameFromUrl } = await import('../server/routes/github')
    expect(repoNameFromUrl('https://github.com/acme/handdraw-style-prompter.git')).toBe('handdraw-style-prompter')
    expect(repoNameFromUrl('https://github.com/acme/handdraw-style-prompter/')).toBe('handdraw-style-prompter')
    expect(repoNameFromUrl('git@github.com:acme/tools.git')).toBe('tools')
  })

  it('a skill at the repository root uses its frontmatter name, not the temp dir name', async () => {
    const { resolveInstallFolderName } = await import('../server/routes/github')
    const clone = fs.mkdtempSync(path.join(home, 'skill-hub-git-'))
    fs.writeFileSync(path.join(clone, 'SKILL.md'), '---\nname: handdraw-style-prompter\ndescription: d\n---\n')
    expect(await resolveInstallFolderName(clone, clone, 'some-repo')).toBe('handdraw-style-prompter')
  })

  it('falls back to the repository name when the frontmatter name is missing or unsafe', async () => {
    const { resolveInstallFolderName } = await import('../server/routes/github')
    const noName = fs.mkdtempSync(path.join(home, 'skill-hub-git-'))
    fs.writeFileSync(path.join(noName, 'SKILL.md'), '# no frontmatter\n')
    expect(await resolveInstallFolderName(noName, noName, 'my-repo')).toBe('my-repo')

    const unsafe = fs.mkdtempSync(path.join(home, 'skill-hub-git-'))
    fs.writeFileSync(path.join(unsafe, 'SKILL.md'), '---\nname: ../../etc\n---\n')
    expect(await resolveInstallFolderName(unsafe, unsafe, 'my-repo')).toBe('my-repo')
    expect(await resolveInstallFolderName(unsafe, unsafe, '..')).toBeNull()
  })

  it('a skill in a subdirectory keeps the directory name', async () => {
    const { resolveInstallFolderName } = await import('../server/routes/github')
    const clone = fs.mkdtempSync(path.join(home, 'skill-hub-git-'))
    const sub = writeSkill(path.join(clone, 'skills'), 'pdf-tools')
    expect(await resolveInstallFolderName(sub, clone, 'repo')).toBe('pdf-tools')
  })
})

describe('GitHub import: clone URL normalization', () => {
  it('accepts browser URLs of subdirectories by cloning the repository root', async () => {
    const { normalizeCloneUrl } = await import('../server/routes/github')
    expect(normalizeCloneUrl('https://github.com/yanghui960/handdraw-style-prompter/tree/main/handdraw-style-prompter'))
      .toBe('https://github.com/yanghui960/handdraw-style-prompter.git')
    expect(normalizeCloneUrl('yanghui960/handdraw-style-prompter')).toBe('https://github.com/yanghui960/handdraw-style-prompter.git')
    expect(normalizeCloneUrl('https://gitlab.com/a/b')).toBe('https://gitlab.com/a/b')
    expect(normalizeCloneUrl('--upload-pack=x')).toBeNull()
  })
})

describe('GitHub import: pasted address forms', () => {
  it('parses every form people copy from the market, GitHub and skills.sh', async () => {
    const { parseRepoInput } = await import('../server/routes/github')
    const gh = 'https://github.com/acme/tools.git'
    expect(parseRepoInput('acme/tools')).toEqual({ cloneUrl: gh, repo: 'acme/tools' })
    expect(parseRepoInput('acme/tools.git')).toEqual({ cloneUrl: gh, repo: 'acme/tools' })
    expect(parseRepoInput('acme/my.tools/')).toMatchObject({ repo: 'acme/my.tools' })
    expect(parseRepoInput('acme/tools@pdf')).toEqual({ cloneUrl: gh, repo: 'acme/tools', skill: 'pdf' })
    expect(parseRepoInput('github.com/acme/tools')).toMatchObject({ cloneUrl: gh })
    expect(parseRepoInput('www.github.com/acme/tools/')).toMatchObject({ cloneUrl: gh })
    expect(parseRepoInput('https://github.com/acme/tools/tree/main/skills/pdf')).toMatchObject({ cloneUrl: gh, subPath: 'skills/pdf' })
    expect(parseRepoInput('https://github.com/acme/tools/blob/main/skills/pdf/SKILL.md')).toMatchObject({ subPath: 'skills/pdf' })
    expect(parseRepoInput('https://github.com/acme/tools?tab=readme-ov-file#x')).toEqual({ cloneUrl: gh, repo: 'acme/tools' })
    expect(parseRepoInput('https://skills.sh/acme/tools/pdf')).toEqual({ cloneUrl: gh, repo: 'acme/tools', skill: 'pdf' })
    expect(parseRepoInput('skills.sh/acme/tools')).toEqual({ cloneUrl: gh, repo: 'acme/tools' })
    expect(parseRepoInput('npx skills add acme/tools --skill pdf')).toEqual({ cloneUrl: gh, repo: 'acme/tools', skill: 'pdf' })
    expect(parseRepoInput('npx -y skills add https://github.com/acme/tools')).toMatchObject({ cloneUrl: gh })
    expect(parseRepoInput('  "acme/tools"  ')).toMatchObject({ cloneUrl: gh })
    expect(parseRepoInput('git@github.com:acme/tools.git')).toEqual({ cloneUrl: 'git@github.com:acme/tools.git' })
    for (const t of ['https://github.com/acme/tools/tree/main/../../x', 'https://github.com/acme/tools/tree/main/a/%2e%2e/%2e%2e/x']) {
      expect(parseRepoInput(t)?.subPath ?? '').not.toContain('..')
    }
    expect(parseRepoInput('file:///etc')).toBeNull()
    expect(parseRepoInput('just some words')).toBeNull()
    expect(parseRepoInput('-c core.x=y')).toBeNull()
  })
})
