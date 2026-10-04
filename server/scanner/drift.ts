import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'

/**
 * Computes a combined recursive MD5 hash of all files in a skill directory for content drift comparison.
 */
export async function getSkillFolderHash(skillDir: string): Promise<string | null> {
  try {
    const files: string[] = []
    
    async function walk(dir: string, baseDir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        const fullPath = path.join(dir, entry.name)
        const relPath = path.relative(baseDir, fullPath)
        
        if (entry.isFile()) {
          try {
            const buf = await fs.readFile(fullPath)
            const fileHash = crypto.createHash('md5').update(buf).digest('hex')
            files.push(`${relPath}:${fileHash}`)
          } catch {}
        } else if (entry.isDirectory()) {
          await walk(fullPath, baseDir)
        }
      }
    }

    await walk(skillDir, skillDir)
    if (files.length === 0) return null
    files.sort()
    return crypto.createHash('md5').update(files.join('\n')).digest('hex')
  } catch {
    return null
  }
}

/**
 * Compares master skill directory with copy skill directory.
 * Returns true if the copy has drifted (outdated or content modified).
 */
export async function checkSkillDrift(masterDir: string, copyDir: string): Promise<boolean> {
  const masterHash = await getSkillFolderHash(masterDir)
  const copyHash = await getSkillFolderHash(copyDir)
  if (!masterHash || !copyHash) return false
  return masterHash !== copyHash
}
