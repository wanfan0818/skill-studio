import { spawn } from 'child_process'
import fs from 'fs'
import fsp from 'fs/promises'
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
 * Run an executable with an argument ARRAY — never through a shell, so no
 * argument can be interpreted as shell syntax (`$(...)`, `;`, backticks…).
 *
 * stdout / stderr go to temp files passed as raw fds instead of pipes, which
 * keeps the original workaround for `spawn EBADF` on macOS environments whose
 * own stdio descriptors are broken.
 */
export async function execFileSafe(
  file: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const runId = randomUUID()
  const outPath = path.join(os.tmpdir(), `exec-out-${runId}.log`)
  const errPath = path.join(os.tmpdir(), `exec-err-${runId}.log`)
  const outFd = fs.openSync(outPath, 'w', 0o600)
  const errFd = fs.openSync(errPath, 'w', 0o600)

  const collect = async () => {
    try { fs.closeSync(outFd) } catch {}
    try { fs.closeSync(errFd) } catch {}
    const stdout = await fsp.readFile(outPath, 'utf8').catch(() => '')
    const stderr = await fsp.readFile(errPath, 'utf8').catch(() => '')
    await fsp.unlink(outPath).catch(() => {})
    await fsp.unlink(errPath).catch(() => {})
    return { stdout, stderr }
  }

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env || process.env,
        stdio: ['ignore', outFd, errFd],
        shell: false,
      })
    } catch (spawnError: any) {
      void collect()
      return reject(new Error(`Failed to spawn ${file}: ${spawnError.message}`))
    }

    let timedOut = false
    const timeoutMs = opts.timeoutMs ?? 60_000
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch {}
    }, timeoutMs)

    child.on('error', async (err: Error) => {
      clearTimeout(timer)
      const { stdout, stderr } = await collect()
      reject(new Error(`[skill-studio] spawn error: ${err.message}\n${stderr || stdout}`.trim()))
    })

    child.on('close', async (code: number | null) => {
      clearTimeout(timer)
      const { stdout, stderr } = await collect()
      if (timedOut) {
        return reject(new Error(`Command timed out after ${timeoutMs}ms: ${stderr}`))
      }
      if (code !== 0) {
        const err = new Error(stderr.trim() || stdout.trim() || `Command failed with exit code ${code}`)
        ;(err as any).code = code
        ;(err as any).stdout = stdout
        ;(err as any).stderr = stderr
        return reject(err)
      }
      resolve({ code: 0, stdout, stderr })
    })
  })
}
