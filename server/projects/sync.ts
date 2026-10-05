import fs from 'fs/promises'
import path from 'path'
import { AGENTS } from '../scanner/agents.js'
import { moveToTrash } from '../trash/store.js'
import { copyDir } from '../utils/fs.js'
import { isInside, isPlainSegment } from '../utils/safe.js'

/** A physical copy Skill Studio materialized (Antigravity mode) carries this marker. */
async function isManagedCopy(dir: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(dir, '.skill-source'), 'utf-8'))
    return typeof marker?.originPath === 'string' && marker.originPath.length > 0
  } catch {
    return false
  }
}

export interface ProjectSyncResult {
  /** Entries left untouched because a real, user-owned directory is in the way. */
  conflicts: string[]
}

/**
 * Bring a project's agent skill directories in line with its .skills-profile.json.
 *
 * Safety rules (each one was a real data-loss bug before):
 *   - A real directory is NEVER deleted or overwritten. Only symlinks and
 *     physical copies carrying our `.skill-source` marker are "managed".
 *   - A skill that physically lives inside the target directory is left alone
 *     (it used to be rm'd and then "copied from itself" → gone).
 *   - Managed entries that are removed go to the recycle bin, not `rm -rf`.
 */
export async function syncProjectSkills(
  projectPath: string,
  skillsMap: Map<string, any>,
): Promise<ProjectSyncResult> {
  const result: ProjectSyncResult = { conflicts: [] }
  const profilePath = path.join(projectPath, '.skills-profile.json')
  let profile: any
  try {
    profile = JSON.parse(await fs.readFile(profilePath, 'utf-8'))
  } catch {
    return result
  }

  const skillsList: string[] = Array.isArray(profile.skills) ? profile.skills.filter(isPlainSegment) : []
  const targetIde = profile.targetIde || 'claude-code'
  const agent = AGENTS.find((a) => a.id === targetIde)
  const relPaths = agent && agent.projectPaths.length > 0 ? agent.projectPaths : ['.agents/skills']
  const isAntigravity = targetIde === 'antigravity'

  for (const relPath of relPaths) {
    const targetDir = path.join(projectPath, relPath)

    // A dangling symlink in place of the skills dir would make mkdir throw.
    try {
      const lstat = await fs.lstat(targetDir)
      if (lstat.isSymbolicLink()) {
        try {
          await fs.stat(targetDir)
        } catch {
          await fs.unlink(targetDir).catch(() => {})
        }
      }
    } catch {}

    await fs.mkdir(targetDir, { recursive: true })

    // Only managed entries are candidates for removal.
    const existingEntries = await fs.readdir(targetDir, { withFileTypes: true }).catch(() => [])
    const toDelete = new Set<string>()
    for (const entry of existingEntries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isSymbolicLink()) {
        toDelete.add(entry.name)
      } else if (isAntigravity && entry.isDirectory() && (await isManagedCopy(path.join(targetDir, entry.name)))) {
        toDelete.add(entry.name)
      }
    }

    for (const skillName of skillsList) {
      const skill = skillsMap.get(skillName)
      if (!skill || !isPlainSegment(skill.name)) continue

      const targetLinkPath = path.join(targetDir, skill.name)
      let resolvedRealPath: string
      try {
        resolvedRealPath = await fs.realpath(skill.realPath)
      } catch {
        resolvedRealPath = path.resolve(skill.realPath)
      }

      // The skill's only home is this very directory — nothing to do.
      if (await isInside(resolvedRealPath, targetDir)) {
        toDelete.delete(skill.name)
        continue
      }

      let lstat: import('fs').Stats | null = null
      try {
        lstat = await fs.lstat(targetLinkPath)
      } catch {}

      if (lstat && !lstat.isSymbolicLink() && lstat.isDirectory()) {
        const managed = isAntigravity && (await isManagedCopy(targetLinkPath))
        if (!managed) {
          // User-owned directory with the same name: keep it, report it.
          toDelete.delete(skill.name)
          result.conflicts.push(targetLinkPath)
          continue
        }
      } else if (lstat && !lstat.isSymbolicLink()) {
        toDelete.delete(skill.name)
        result.conflicts.push(targetLinkPath)
        continue
      }

      if (isAntigravity) {
        // Antigravity mode: materialized physical copy + .skill-source marker.
        try {
          if (lstat?.isSymbolicLink()) {
            await fs.unlink(targetLinkPath)
          } else if (lstat) {
            await fs.rm(targetLinkPath, { recursive: true, force: true }) // managed copy only
          }
          await copyDir(resolvedRealPath, targetLinkPath)

          const sourceMarkerFile = path.join(targetLinkPath, '.skill-source')
          let markerData: any = {}
          try {
            markerData = JSON.parse(await fs.readFile(sourceMarkerFile, 'utf-8'))
          } catch {}
          markerData.name = skill.name
          markerData.originPath = resolvedRealPath
          markerData.copiedAt = new Date().toISOString()
          await fs.writeFile(sourceMarkerFile, JSON.stringify(markerData, null, 2), 'utf-8')
          toDelete.delete(skill.name)
        } catch (err: any) {
          console.error(`[syncProjectSkills] Failed physical copy for ${skill.name}:`, err.message)
        }
        continue
      }

      // Symlink mode for Claude Code & other IDEs.
      if (lstat?.isSymbolicLink()) {
        let resolvedTarget: string
        try {
          resolvedTarget = await fs.realpath(targetLinkPath)
        } catch {
          resolvedTarget = path.resolve(targetDir, await fs.readlink(targetLinkPath))
        }
        if (resolvedTarget === resolvedRealPath) {
          toDelete.delete(skill.name)
          continue
        }
        await fs.unlink(targetLinkPath).catch(() => {})
      }

      try {
        await fs.symlink(resolvedRealPath, targetLinkPath, 'dir')
        toDelete.delete(skill.name)
      } catch (err: any) {
        console.error(`[syncProjectSkills] Failed to symlink ${skill.name} to ${targetLinkPath}:`, err.message)
      }
    }

    for (const nameToDelete of toDelete) {
      const entryPath = path.join(targetDir, nameToDelete)
      try {
        const st = await fs.lstat(entryPath)
        if (st.isSymbolicLink()) {
          await fs.unlink(entryPath)
        } else {
          await moveToTrash(entryPath, nameToDelete)
        }
      } catch (err: any) {
        console.error(`[syncProjectSkills] Failed to remove ${entryPath}:`, err.message)
      }
    }
  }

  // Claude Code entry link: .claude/skills -> .agents/skills, but ONLY when
  // .claude/skills does not exist yet. A real .claude/skills directory holds
  // the user's own project skills and used to be `rm -rf`'d here.
  const agentsSkillsDir = path.join(projectPath, '.agents', 'skills')
  try {
    const s = await fs.stat(agentsSkillsDir)
    if (s.isDirectory() && (targetIde === 'claude-code' || relPaths.includes('.claude/skills'))) {
      const claudeSkillsDir = path.join(projectPath, '.claude', 'skills')
      let exists = true
      try {
        await fs.lstat(claudeSkillsDir)
      } catch {
        exists = false
      }
      if (!exists) {
        await fs.mkdir(path.join(projectPath, '.claude'), { recursive: true })
        await fs.symlink(agentsSkillsDir, claudeSkillsDir, 'dir').catch(() => {})
      }
    }
  } catch {}

  return result
}
