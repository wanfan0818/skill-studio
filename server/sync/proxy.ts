import fsSync from 'fs'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const initialHttpProxy = process.env.HTTP_PROXY || process.env.http_proxy || null
const initialHttpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy || null

export function sanitizeFileDescriptors() {
  for (const fd of [0, 1, 2]) {
    try {
      fsSync.fstatSync(fd)
    } catch (err: any) {
      if (err.code === 'EBADF') {
        try {
          const mode = fd === 0 ? 'r' : 'w'
          const devNull = fsSync.openSync('/dev/null', mode)
          console.warn(`[system] 检测到损坏的标准文件描述符 FD ${fd}，已重定向至 /dev/null (新分配 FD: ${devNull})`)
        } catch (openErr: any) {
          console.error(`[system] 无法重定向损坏的 FD ${fd}:`, openErr.message)
        }
      }
    }
  }
}

// 自动在加载时修复受损的 FD，防止派生子进程时发生 EBADF 异常
sanitizeFileDescriptors()

export async function setupProxy(): Promise<string | null> {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir()
  const configPath = path.join(home, '.config', 'skill-studio', 'ide-settings.json')
  
  let configuredProxy: string | undefined
  try {
    const raw = await fs.readFile(configPath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.httpProxy === 'string' && parsed.httpProxy.trim() !== '') {
      configuredProxy = parsed.httpProxy.trim()
    }
  } catch {}

  let activeProxy: string | null = null

  if (configuredProxy) {
    activeProxy = configuredProxy
  } else {
    // 2. 自动检测 macOS 系统代理
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await execAsync('scutil --proxy')
        let socksEnable = false
        let socksProxy = ''
        let socksPort = ''
        
        let httpEnable = false
        let httpProxy = ''
        let httpPort = ''
        
        const lines = stdout.split('\n')
        for (const line of lines) {
          const match = line.match(/^\s*(\w+)\s*:\s*(.+)$/)
          if (match) {
            const key = match[1]
            const val = match[2].trim()
            
            if (key === 'SOCKSEnable') socksEnable = val === '1'
            if (key === 'SOCKSProxy') socksProxy = val
            if (key === 'SOCKSPort') socksPort = val
            
            if (key === 'HTTPEnable') httpEnable = val === '1'
            if (key === 'HTTPProxy') httpProxy = val
            if (key === 'HTTPPort') httpPort = val
          }
        }
        
        // 优先使用 socks5h (在代理端解析 DNS，更稳定，且避免 SSL_ERROR_SYSCALL)
        if (socksEnable && socksProxy && socksPort) {
          activeProxy = `socks5h://${socksProxy}:${socksPort}`
        } else if (httpEnable && httpProxy && httpPort) {
          activeProxy = `http://${httpProxy}:${httpPort}`
        }
      } catch (err: any) {
        console.warn('[proxy] 自动获取 macOS 系统代理失败:', err.message)
      }
    }
  }

  // 3. 注入/覆盖或还原环境变量
  if (activeProxy) {
    process.env.HTTP_PROXY = activeProxy
    process.env.http_proxy = activeProxy
    process.env.HTTPS_PROXY = activeProxy
    process.env.https_proxy = activeProxy
    console.log(`[proxy] 成功应用网络代理: ${activeProxy}`)
    return activeProxy
  } else {
    // 还原最初状态
    if (initialHttpProxy) {
      process.env.HTTP_PROXY = initialHttpProxy
      process.env.http_proxy = initialHttpProxy
    } else {
      delete process.env.HTTP_PROXY
      delete process.env.http_proxy
    }
    
    if (initialHttpsProxy) {
      process.env.HTTPS_PROXY = initialHttpsProxy
      process.env.https_proxy = initialHttpsProxy
    } else {
      delete process.env.HTTPS_PROXY
      delete process.env.https_proxy
    }
    console.log('[proxy] 未检测到活动代理，已还原/清理代理环境变量')
  }

  return null
}
