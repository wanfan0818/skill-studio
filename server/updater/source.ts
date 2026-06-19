import fs from 'fs/promises'
import path from 'path'
import type { SkillGithubSource } from '../types.js'

/**
 * Parses various GitHub URL formats into structured source info.
 * Supports:
 * - https://github.com/owner/repo/tree/branch/sub/path
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 * - owner/repo
 * - owner/repo/tree/branch/sub/path
 */
export function parseGithubUrl(url: string): { owner: string; repo: string; branch: string; subPath: string } | null {
  if (!url) return null
  let cleanUrl = url.trim()

  if (cleanUrl.endsWith('.git')) {
    cleanUrl = cleanUrl.slice(0, -4)
  }

  // Handle SSH format git@github.com:owner/repo
  if (cleanUrl.startsWith('git@github.com:')) {
    const parts = cleanUrl.slice('git@github.com:'.length).split('/')
    if (parts.length >= 2) {
      return {
        owner: parts[0],
        repo: parts[1],
        branch: 'main',
        subPath: '',
      }
    }
  }

  // Handle HTTP/HTTPS URL
  try {
    if (cleanUrl.startsWith('http://') || cleanUrl.startsWith('https://')) {
      const parsed = new URL(cleanUrl)
      if (parsed.hostname === 'github.com') {
        const pathParts = parsed.pathname.split('/').filter(Boolean)
        if (pathParts.length >= 2) {
          const owner = pathParts[0]
          const repo = pathParts[1]
          let branch = 'main'
          let subPath = ''

          if (pathParts[2] === 'tree' && pathParts.length >= 4) {
            branch = pathParts[3]
            subPath = pathParts.slice(4).join('/')
          }

          return { owner, repo, branch, subPath }
        }
      }
    }
  } catch (e) {
    // Ignore URL parse error
  }

  // Handle owner/repo format
  const parts = cleanUrl.split('/').filter(Boolean)
  if (parts.length >= 2) {
    const owner = parts[0]
    const repo = parts[1]
    let branch = 'main'
    let subPath = ''

    if (parts[2] === 'tree' && parts.length >= 4) {
      branch = parts[3]
      subPath = parts.slice(4).join('/')
    } else if (parts.length > 2) {
      subPath = parts.slice(2).join('/')
    }

    return { owner, repo, branch, subPath }
  }

  return null
}

export async function readSkillSource(skillRealPath: string): Promise<SkillGithubSource | null> {
  const sourceFilePath = path.join(skillRealPath, '.skill-source')
  try {
    const content = await fs.readFile(sourceFilePath, 'utf-8')
    return JSON.parse(content) as SkillGithubSource
  } catch {
    return null
  }
}

import os from 'os'

export async function writeSkillSource(skillRealPath: string, source: SkillGithubSource): Promise<void> {
  const sourceFilePath = path.join(skillRealPath, '.skill-source')
  await fs.writeFile(sourceFilePath, JSON.stringify(source, null, 2), 'utf-8')
}

export async function findSourceInManifests(
  skillName: string,
  skillRealPath: string,
  projectPath?: string
): Promise<{ owner: string; repo: string; branch: string; subPath: string; installedCommit?: string } | null> {
  const searchDirs = new Set<string>()

  // 1. Skill folder's parent directories (go up 3 levels to find root of repo/project)
  let current = path.dirname(skillRealPath)
  for (let i = 0; i < 3; i++) {
    searchDirs.add(current)
    searchDirs.add(path.join(current, '.agents'))
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  // 2. If projectPath is provided, add it
  if (projectPath) {
    searchDirs.add(projectPath)
    searchDirs.add(path.join(projectPath, '.agents'))
  }

  // 3. User's home directory and subdirectories
  searchDirs.add(os.homedir())
  searchDirs.add(path.join(os.homedir(), '.agents'))
  searchDirs.add(path.join(os.homedir(), '.gemini'))

  for (const dir of searchDirs) {
    // Check lock files: skills-lock.json, .skill-lock.json, .skills-lock.json
    const lockFiles = ['skills-lock.json', '.skill-lock.json', '.skills-lock.json']
    for (const file of lockFiles) {
      const lockPath = path.join(dir, file)
      try {
        const lockContent = await fs.readFile(lockPath, 'utf-8')
        const lockData = JSON.parse(lockContent)
        if (lockData && lockData.skills && lockData.skills[skillName]) {
          const entry = lockData.skills[skillName]
          if (entry.sourceType === 'github' || !entry.sourceType) {
            const source = entry.source || entry.sourceUrl || ''
            const skillPath = entry.skillPath || ''
            
            const parsed = parseGithubUrl(source)
            if (parsed) {
              let subPath = parsed.subPath
              if (!subPath && skillPath) {
                const dirOfSkill = path.dirname(skillPath)
                if (dirOfSkill && dirOfSkill !== '.' && dirOfSkill !== '/') {
                  subPath = dirOfSkill
                }
              }
              return {
                owner: parsed.owner,
                repo: parsed.repo,
                branch: parsed.branch || 'main',
                subPath: subPath || '',
                installedCommit: entry.computedHash || entry.skillFolderHash || undefined,
              }
            }
          }
        }
      } catch {}
    }

    // Check manifest files: skills.json, .skills.json
    const manifestFiles = ['skills.json', '.skills.json']
    for (const file of manifestFiles) {
      const manifestPath = path.join(dir, file)
      try {
        const manifestContent = await fs.readFile(manifestPath, 'utf-8')
        const manifestData = JSON.parse(manifestContent)
        if (manifestData && Array.isArray(manifestData.skills)) {
          const entry = manifestData.skills.find((s: any) => s.name === skillName)
          if (entry && (entry.source || entry.sourceUrl)) {
            const parsed = parseGithubUrl(entry.source || entry.sourceUrl)
            if (parsed) {
              return {
                owner: parsed.owner,
                repo: parsed.repo,
                branch: parsed.branch || 'main',
                subPath: parsed.subPath || '',
              }
            }
          }
        } else if (manifestData && manifestData.skills && typeof manifestData.skills === 'object') {
          const entry = manifestData.skills[skillName]
          if (entry && (entry.source || entry.sourceUrl)) {
            const parsed = parseGithubUrl(entry.source || entry.sourceUrl)
            if (parsed) {
              return {
                owner: parsed.owner,
                repo: parsed.repo,
                branch: parsed.branch || 'main',
                subPath: parsed.subPath || '',
              }
            }
          }
        }
      } catch {}
    }
  }

  return null
}
