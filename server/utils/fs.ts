import fs from 'fs/promises'
import path from 'path'

/**
 * Recursively copy a directory. Symlinks inside it are recreated as symlinks
 * (never followed, so a link to a large or sensitive tree is not inlined);
 * entries for which `skip(name)` returns true are left out.
 */
export async function copyDir(src: string, dest: string, opts: { skip?: (name: string) => boolean } = {}): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    if (opts.skip?.(entry.name)) continue
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isSymbolicLink()) {
      await fs.rm(d, { force: true, recursive: true })
      await fs.symlink(await fs.readlink(s), d)
    } else if (entry.isDirectory()) {
      await copyDir(s, d, opts)
    } else if (entry.isFile()) {
      await fs.copyFile(s, d)
    }
  }
}
