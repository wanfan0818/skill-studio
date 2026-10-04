import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { mapLimit } from '../utils/concurrency.js'

interface FileStat {
  rel: string
  full: string
  size: number
  mtimeMs: number
}

/**
 * Content hashes keyed by directory, valid while the directory's stat
 * signature (relative path + size + mtime of every file) is unchanged.
 * Re-scans then cost a stat walk instead of reading and hashing every file.
 */
const hashCache = new Map<string, { signature: string; hash: string | null }>()
const MAX_CACHE = 2000

async function statWalk(dir: string, baseDir: string, out: FileStat[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  await mapLimit(entries, 8, async (entry) => {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') return
    const full = path.join(dir, entry.name)
    if (entry.isFile()) {
      try {
        const st = await fs.stat(full)
        out.push({ rel: path.relative(baseDir, full), full, size: st.size, mtimeMs: st.mtimeMs })
      } catch {}
    } else if (entry.isDirectory()) {
      await statWalk(full, baseDir, out)
    }
  })
}

/**
 * Combined MD5 of all non-hidden files in a skill directory, for drift
 * comparison between a master skill and a materialized copy.
 */
export async function getSkillFolderHash(skillDir: string): Promise<string | null> {
  try {
    const files: FileStat[] = []
    await statWalk(skillDir, skillDir, files)
    files.sort((a, b) => a.rel.localeCompare(b.rel))
    const signature = files.map((f) => `${f.rel}:${f.size}:${f.mtimeMs}`).join('\n')

    const cached = hashCache.get(skillDir)
    if (cached && cached.signature === signature) return cached.hash

    let hash: string | null = null
    if (files.length > 0) {
      const parts = await mapLimit(files, 8, async (f) => {
        try {
          return `${f.rel}:${crypto.createHash('md5').update(await fs.readFile(f.full)).digest('hex')}`
        } catch {
          return null
        }
      })
      const lines = parts.filter((p): p is string => p !== null)
      hash = lines.length ? crypto.createHash('md5').update(lines.join('\n')).digest('hex') : null
    }

    if (hashCache.size >= MAX_CACHE) hashCache.delete(hashCache.keys().next().value!)
    hashCache.set(skillDir, { signature, hash })
    return hash
  } catch {
    return null
  }
}

/**
 * Compares master skill directory with copy skill directory.
 * Returns true if the copy has drifted (outdated or content modified).
 */
export async function checkSkillDrift(masterDir: string, copyDir: string): Promise<boolean> {
  const [masterHash, copyHash] = await Promise.all([getSkillFolderHash(masterDir), getSkillFolderHash(copyDir)])
  if (!masterHash || !copyHash) return false
  return masterHash !== copyHash
}
