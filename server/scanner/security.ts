/**
 * Static Prompt Security Analyzer for Skill Studio
 * Detects potentially dangerous CLI commands and credential leakage tendencies.
 */

export interface SecurityStatus {
  level: 'safe' | 'warning' | 'danger'
  flags: string[]
}

const DANGER_PATTERNS = [
  { regex: /rm\s+-rf?\s/i, desc: '检测到破坏性文件删除指令 (rm -rf)' },
  { regex: /mkfs\./i, desc: '检测到格式化磁盘指令 (mkfs)' },
  { regex: /dd\s+if=/i, desc: '检测到可能覆盖磁盘的底层写入指令 (dd)' },
  { regex: /sudo\s/i, desc: '检测到提权管理员指令 (sudo)' },
  { regex: /chmod\s+([+x\d]+)\s/i, desc: '检测到权限修改指令 (chmod)' },
  { regex: /chown\s/i, desc: '检测到所有者所有权修改指令 (chown)' },
  { regex: /(curl|wget)\s+.+?\|\s*(sh|bash)/i, desc: '检测到外部脚本直接下载并执行倾向 (curl/wget | sh)' },
  { regex: /id_rsa|id_dsa|id_ed25519/i, desc: '检测到读取/导出 SSH 私钥倾向' },
  { regex: /\.git-credentials|credentials\.json/i, desc: '检测到读取凭证倾向' }
]

const WARNING_PATTERNS = [
  { regex: /\.env(\.local|\.development|\.production)?\b/i, desc: '检测到读取或操作环境变量文件 (.env)' },
  { regex: /ssh\s+-i\s/i, desc: '检测到包含 SSH 私钥认证连接倾向' },
  { regex: /shadow\b/i, desc: '检测到操作系统 shadow 用户密码文件读取' },
  { regex: /passwd\b/i, desc: '检测到操作系统 passwd 文件读取' }
]

export function analyzeSecurity(content: string): SecurityStatus {
  const flags: string[] = []

  // Run danger checks
  for (const pattern of DANGER_PATTERNS) {
    if (pattern.regex.test(content)) {
      flags.push(pattern.desc)
    }
  }

  // Run warning checks
  for (const pattern of WARNING_PATTERNS) {
    if (pattern.regex.test(content)) {
      flags.push(pattern.desc)
    }
  }

  let level: 'safe' | 'warning' | 'danger' = 'safe'
  if (flags.some(f => f.includes('检测到破坏性') || f.includes('提权') || f.includes('下载并执行') || f.includes('私钥') || f.includes('凭证'))) {
    level = 'danger'
  } else if (flags.length > 0) {
    level = 'warning'
  }

  return {
    level,
    flags
  }
}
