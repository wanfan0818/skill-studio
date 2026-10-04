import fs from 'fs/promises'

export interface SymlinkInfo {
  isSymlink: boolean
  target?: string
  realPath: string
}

export async function resolveSymlink(filePath: string): Promise<SymlinkInfo> {
  try {
    const stat = await fs.lstat(filePath)
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(filePath)
      const realPath = await fs.realpath(filePath)
      return { isSymlink: true, target, realPath }
    }
    let realPath = filePath
    try {
      realPath = await fs.realpath(filePath)
    } catch {}
    return { isSymlink: false, realPath }
  } catch {
    return { isSymlink: false, realPath: filePath }
  }
}

export function identifySource(realPath: string, homedir: string): 'newmax' | 'agents' | 'local' | 'unknown' {
  if (realPath.includes('.newmax/skills')) return 'newmax'
  if (realPath.includes('.agents/skills')) return 'agents'
  if (realPath.startsWith(homedir)) return 'local'
  return 'unknown'
}
