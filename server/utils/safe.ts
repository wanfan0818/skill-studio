import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'

/** A single path segment: no separators, no `.`/`..`, no NUL, not empty. */
export function isPlainSegment(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !/[\\/\0]/.test(name)
  )
}

async function realOrResolved(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    return path.resolve(p)
  }
}

/** True when `child` is `parent` itself or lives below it (symlinks resolved). */
export async function isInside(child: string, parent: string): Promise<boolean> {
  const c = await realOrResolved(child)
  const p = await realOrResolved(parent)
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

/**
 * Write a file atomically: temp file in the same directory, then rename.
 * A crash or a concurrent reader can never observe a half-written file.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string,
  opts: { mode?: number } = {},
): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  try {
    await fs.writeFile(tmp, data, { encoding: 'utf-8', mode: opts.mode ?? 0o644 })
    await fs.rename(tmp, filePath)
    if (opts.mode !== undefined) await fs.chmod(filePath, opts.mode).catch(() => {})
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

/**
 * Read and parse a JSON file.
 *   - missing file → `undefined` (caller decides the default)
 *   - unreadable / malformed file → throws
 *
 * Callers must NOT treat a parse failure as "empty" and write a fresh object
 * back — that silently destroys the user's real configuration.
 */
export async function readJsonFile<T = any>(filePath: string): Promise<T | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (err: any) {
    if (err?.code === 'ENOENT') return undefined
    throw new Error(`无法读取 ${filePath}: ${err?.message || err}`)
  }
  try {
    return JSON.parse(raw) as T
  } catch (err: any) {
    throw new Error(`${filePath} 不是合法 JSON，已停止写入以免覆盖你的配置: ${err?.message || err}`)
  }
}

/** GitHub owner / repo name: letters, digits, `-`, `_`, `.`; never starts with `-`. */
export function isSafeGithubName(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}$/.test(s) && s !== '.' && s !== '..'
}

/** Git branch / ref name safe to pass as an argument (no leading `-`, no `..`). */
export function isSafeGitRef(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9_.][A-Za-z0-9_./-]{0,199}$/.test(s) && !s.includes('..')
}

/** Repo-relative sub path: no absolute paths, no `..` segments. */
export function isSafeSubPath(s: unknown): s is string {
  if (typeof s !== 'string') return false
  if (s === '') return true
  if (s.startsWith('/') || s.startsWith('-') || s.includes('\0')) return false
  return s.split('/').every((seg) => seg !== '..' && seg !== '')
}
