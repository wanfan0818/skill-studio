import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import crypto from 'crypto'
import type { SkillGithubSource } from '../types.js'
import { writeSkillSource } from './source.js'
import { moveToTrash } from '../trash/store.js'
import { execFileSafe } from '../utils/exec.js'
import { copyDir } from '../utils/fs.js'
import { isSafeGithubName, isSafeGitRef, isSafeSubPath } from '../utils/safe.js'

function git(args: string[]) {
  return execFileSafe('git', args)
}

/**
 * Replace a skill with the upstream version. The new content is assembled
 * next to the skill and swapped in with renames, so files removed upstream
 * don't linger and links into the skill never see a half-written state.
 * With `trashOld`, the replaced version goes to the recycle bin (used when it
 * had local edits).
 */
export async function updateSkillFromGithub(
  skillRealPath: string,
  source: SkillGithubSource,
  latestCommit?: string,
  opts: { trashOld?: boolean } = {},
): Promise<void> {
  const { owner, repo, branch, subPath } = source
  // owner/repo/branch/subPath come from SKILL.md frontmatter or a .skill-source
  // file, i.e. from third-party content. Validate before they reach git.
  if (!isSafeGithubName(owner) || !isSafeGithubName(repo)) {
    throw new Error(`非法的 GitHub 仓库标识: ${owner}/${repo}`)
  }
  if (branch && !isSafeGitRef(branch)) throw new Error(`非法的分支名: ${branch}`)
  if (subPath && !isSafeSubPath(subPath)) throw new Error(`非法的子目录: ${subPath}`)
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-hub-update-'))

  try {
    const cloneUrl = `https://github.com/${owner}/${repo}.git`
    const targetBranch = branch || 'main'

    if (subPath) {
      // Use sparse checkout to only download the subPath
      await git(['init', '--', tempDir])
      await git(['-C', tempDir, 'remote', 'add', 'origin', cloneUrl])
      await git(['-C', tempDir, 'config', 'core.sparseCheckout', 'true'])
      
      const sparseCheckoutFile = path.join(tempDir, '.git', 'info', 'sparse-checkout')
      await fs.writeFile(sparseCheckoutFile, `${subPath}\n`, 'utf-8')
      
      await git(['-C', tempDir, 'pull', '--depth=1', 'origin', targetBranch])
    } else {
      await git(['clone', '--depth', '1', '--branch', targetBranch, '--', cloneUrl, tempDir])
    }

    const srcDir = subPath ? path.join(tempDir, subPath) : tempDir
    
    try {
      await fs.access(srcDir)
    } catch {
      throw new Error(`在大仓库中未找到子目录: ${subPath}`)
    }

    let commitHash = latestCommit
    if (!commitHash) {
      try {
        const { stdout } = await git(['-C', tempDir, 'rev-parse', 'HEAD'])
        commitHash = stdout.trim()
      } catch {
        commitHash = 'unknown'
      }
    }

    let tree: string | undefined
    try {
      tree = (await git(['-C', tempDir, 'rev-parse', subPath ? `HEAD:${subPath}` : 'HEAD^{tree}'])).stdout.trim() || undefined
    } catch {}

    const updatedSource: SkillGithubSource = {
      ...source,
      installedCommit: commitHash,
      latestCommit: commitHash,
      installedTree: tree,
      latestTree: tree,
      upstreamMissing: false,
      installedAt: new Date().toISOString(),
      updateAvailable: false,
      lastChecked: new Date().toISOString(),
    }
    delete updatedSource.ignoredCommit
    delete updatedSource.ignoredTree

    const parent = path.dirname(skillRealPath)
    const base = path.basename(skillRealPath)
    const tag = crypto.randomBytes(4).toString('hex')
    const staged = path.join(parent, `.${base}.ss-update-${tag}`)
    const old = path.join(parent, `.${base}.ss-old-${tag}`)
    try {
      await copyDir(srcDir, staged, { skip: (name) => name === '.git' || name === '.skill-source' })
      await writeSkillSource(staged, updatedSource)
      if (opts.trashOld) {
        // Recycle bin records the original path, so move it from where it is.
        await moveToTrash(skillRealPath, base)
        await fs.rename(staged, skillRealPath)
      } else {
        await fs.rename(skillRealPath, old)
        try {
          await fs.rename(staged, skillRealPath)
        } catch (err) {
          await fs.rename(old, skillRealPath) // put the original back
          throw err
        }
        await fs.rm(old, { recursive: true, force: true })
      }
    } catch (err) {
      await fs.rm(staged, { recursive: true, force: true }).catch(() => {})
      throw err
    }

  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {}
  }
}

