import { exec } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import type { SkillGithubSource } from '../types.js'
import { writeSkillSource } from './source.js'

const execAsync = promisify(exec)

async function execSafe(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] })
}

export async function updateSkillFromGithub(
  skillRealPath: string,
  source: SkillGithubSource,
  latestCommit?: string
): Promise<void> {
  const { owner, repo, branch, subPath } = source
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-hub-update-'))

  try {
    const cloneUrl = `https://github.com/${owner}/${repo}.git`
    const targetBranch = branch || 'main'

    if (subPath) {
      // Use sparse checkout to only download the subPath
      await execSafe(`git init "${tempDir}"`)
      await execSafe(`git -C "${tempDir}" remote add origin "${cloneUrl}"`)
      await execSafe(`git -C "${tempDir}" config core.sparseCheckout true`)
      
      const sparseCheckoutFile = path.join(tempDir, '.git', 'info', 'sparse-checkout')
      await fs.writeFile(sparseCheckoutFile, `${subPath}\n`, 'utf-8')
      
      await execSafe(`git -C "${tempDir}" pull --depth=1 origin ${targetBranch}`)
    } else {
      await execSafe(`git clone --depth 1 --branch ${targetBranch} "${cloneUrl}" "${tempDir}"`)
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
        const { stdout } = await execSafe(`git -C "${tempDir}" rev-parse HEAD`)
        commitHash = stdout.trim()
      } catch {
        commitHash = 'unknown'
      }
    }

    // Overwrite the files
    await copyDirectoryContents(srcDir, skillRealPath)

    // Update .skill-source file with updated commit
    const updatedSource: SkillGithubSource = {
      ...source,
      installedCommit: commitHash,
      installedAt: new Date().toISOString(),
      updateAvailable: false,
      lastChecked: new Date().toISOString(),
    }
    await writeSkillSource(skillRealPath, updatedSource)

  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {}
  }
}

async function copyDirectoryContents(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true })
  await fs.mkdir(dest, { recursive: true })

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.skill-source') {
      continue
    }

    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      await copyDirectoryContents(srcPath, destPath)
    } else {
      await fs.copyFile(srcPath, destPath)
    }
  }
}
