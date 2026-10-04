import { spawn } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface ExecOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/**
 * Safely execute a shell command avoiding `spawn EBADF` on macOS / Node environments
 * where standard I/O file descriptors (0, 1, 2) or pipe streams are broken/invalid.
 * It redirects stdout and stderr to temporary files and executes via `spawn('sh', ['-c', ...], { stdio: 'ignore' })`.
 */
export async function execSafeCmd(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const runId = randomUUID()
  const outPath = path.join(os.tmpdir(), `exec-out-${runId}.log`)
  const errPath = path.join(os.tmpdir(), `exec-err-${runId}.log`)

  const escapeShellArg = (arg: string): string => {
    return `'${arg.replace(/'/g, "'\\''")}'`
  }

  // Wrap command to redirect stdout and stderr to temp files
  const shellCmd = `${cmd} > ${escapeShellArg(outPath)} 2> ${escapeShellArg(errPath)}`

  return new Promise((resolve, reject) => {
    let child: any
    try {
      child = spawn('sh', ['-c', shellCmd], {
        cwd: opts.cwd,
        env: opts.env || process.env,
        stdio: 'ignore',
      })
    } catch (spawnError: any) {
      return reject(new Error(`Failed to spawn command: ${spawnError.message}`))
    }

    let timedOut = false
    const timeoutMs = opts.timeoutMs ?? 60_000
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {}
    }, timeoutMs)

    child.on('error', async (err: any) => {
      clearTimeout(timer)
      let stdout = ''
      let stderr = `[skill-studio] spawn error: ${err.message}`
      try {
        stdout = await fs.readFile(outPath, 'utf8')
        stderr += '\n' + (await fs.readFile(errPath, 'utf8'))
        await fs.unlink(outPath).catch(() => {})
        await fs.unlink(errPath).catch(() => {})
      } catch {}
      reject(new Error(stderr || stdout || err.message))
    })

    child.on('close', async (code: number) => {
      clearTimeout(timer)
      let stdout = ''
      let stderr = ''
      try {
        stdout = await fs.readFile(outPath, 'utf8')
        stderr = await fs.readFile(errPath, 'utf8')
        await fs.unlink(outPath).catch(() => {})
        await fs.unlink(errPath).catch(() => {})
      } catch {}

      if (timedOut) {
        return reject(new Error(`Command timed out after ${timeoutMs}ms: ${stderr}`))
      }

      if (code !== 0) {
        const errMsg = stderr.trim() || stdout.trim() || `Command failed with exit code ${code}`
        const err = new Error(errMsg)
        ;(err as any).code = code
        ;(err as any).stdout = stdout
        ;(err as any).stderr = stderr
        return reject(err)
      }

      resolve({
        code: 0,
        stdout,
        stderr,
      })
    })
  })
}
