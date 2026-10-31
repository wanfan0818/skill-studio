import fs from 'fs/promises'
import path from 'path'
import { parseSkillMd } from '../scanner/parser.js'

/**
 * Package checks for one skill directory: the minimum a skill needs to be
 * routed correctly and load cleanly in every IDE.
 *
 * Sources: the Agent Skills spec (name format and length, name = folder,
 * description ≤ 1024 chars, SKILL.md ≤ 500 lines, one entrypoint per skill)
 * and the Scaffold gate of qiaomu-meta-skill (a description that says when to
 * use the skill and when not to, references that resolve).
 *
 * error – an IDE may reject, truncate or mis-route the skill
 * warn  – works, but routing or loading is likely worse than it should be
 * info  – suggestion; not counted as a problem
 */

export type Severity = 'error' | 'warn' | 'info'

export interface LintIssue {
  code: string
  severity: Severity
  message: string
  hint?: string
}

export interface LintResult {
  name: string
  description: string
  /** Rough token cost of name + description, which every session loads. */
  routingTokens: number
  skillMdLines: number
  issues: LintIssue[]
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const NAME_MAX = 64
const DESC_MAX = 1024
// Measured in estimated tokens so Chinese (denser per character) isn't penalized.
const DESC_MIN_TOKENS = 10
const LINES_MAX = 500
// "When NOT to use" phrasing, Chinese and English.
const EXCLUSION_RE = /不用于|不适用|不要用|不负责|不处理|不包括|排除|Not for|Do not use|Don't use|Exclude|not (?:for|meant|intended)|Skip (?:for|when)/i
// "When to use" phrasing.
const TRIGGER_RE = /用于|适用|当.{0,20}时|触发|使用场景|Use (?:when|for|this)|Trigger|when the user|whenever/i

/**
 * Rough token estimate: CJK characters ≈ 1 token each, other text ≈ 4
 * characters per token. Good enough to compare skills; not billing-grade.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[　-鿿가-힯＀-￯]/g) ?? []).length
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** SKILL.md files below the root: extra entrypoints the IDE may load as separate skills. */
async function nestedEntrypoints(dir: string, rel = '', depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > 4 || out.length >= 5) return out
  const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const child = path.join(rel, e.name)
    if (e.isDirectory()) await nestedEntrypoints(dir, child, depth + 1, out)
    else if (depth > 0 && e.name === 'SKILL.md') out.push(child)
  }
  return out
}

/** Relative links in SKILL.md whose target file doesn't exist. */
async function brokenLinks(dir: string, body: string): Promise<string[]> {
  const broken: string[] = []
  const seen = new Set<string>()
  // [text](target) — skip images' remote URLs, anchors, mailto, absolute URLs.
  for (const m of body.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    let target = m[1]
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue
    target = target.split('#')[0].split('?')[0]
    if (!target || seen.has(target)) continue
    seen.add(target)
    let decoded = target
    try {
      decoded = decodeURIComponent(target)
    } catch {}
    const abs = path.resolve(dir, decoded)
    // Links outside the skill folder (e.g. "../other") can't be checked meaningfully
    // and won't travel with the skill anyway.
    if (!abs.startsWith(dir + path.sep)) {
      broken.push(`${target}（指向 Skill 目录以外，复制或安装到别处后会失效）`)
    } else if (!(await exists(abs))) {
      broken.push(target)
    }
    if (broken.length >= 5) break
  }
  return broken
}

export async function lintSkill(dir: string): Promise<LintResult> {
  const issues: LintIssue[] = []
  const folder = path.basename(dir)
  const add = (severity: Severity, code: string, message: string, hint?: string) => issues.push({ severity, code, message, hint })

  // Exact names from the listing: on case-insensitive file systems (macOS)
  // a lookup of SKILL.md would also find skill.md.
  const listing = new Set(await fs.readdir(dir).catch(() => [] as string[]))
  let mdPath = path.join(dir, 'SKILL.md')
  if (!listing.has('SKILL.md')) {
    const lowerName = [...listing].find((n) => n.toLowerCase() === 'skill.md')
    if (lowerName) {
      mdPath = path.join(dir, lowerName)
      add('warn', 'lowercase-skill-md', `入口文件名是 ${lowerName}，不是 SKILL.md`, '改名为 SKILL.md。区分大小写的系统（Linux、部分 IDE）只认大写的 SKILL.md')
    } else {
      add('error', 'missing-skill-md', '没有 SKILL.md', 'IDE 不会把这个目录当作 Skill 加载')
      return { name: folder, description: '', routingTokens: 0, skillMdLines: 0, issues }
    }
  }

  const parsed = await parseSkillMd(mdPath)
  const fm = parsed.frontmatter ?? {}
  if (parsed.parseError) {
    add('error', 'bad-frontmatter', 'SKILL.md 开头的 YAML 标头格式错误', `IDE 读不到 name 和 description。解析错误：${parsed.parseError.split('\n')[0]}`)
  }

  const name = typeof fm.name === 'string' ? fm.name.trim() : ''
  const description = typeof fm.description === 'string' ? fm.description.trim() : ''

  if (!parsed.parseError) {
    if (!name) {
      add('error', 'missing-name', '标头里没有 name', `加上 name: ${folder}`)
    } else {
      if (name !== folder) add('warn', 'name-folder-mismatch', `name「${name}」和目录名「${folder}」不一致`, '规范要求两者相同；不一致时有的 IDE 用目录名、有的用 name，链接和更新容易对不上')
      if (name.length > NAME_MAX) add('error', 'name-too-long', `name 超过 ${NAME_MAX} 个字符`, '缩短名称')
      else if (!NAME_RE.test(name)) add('warn', 'name-format', `name「${name}」不符合命名规范`, '只用小写字母、数字和连字符，例如 my-skill')
    }

    if (!description) {
      add('error', 'missing-description', '标头里没有 description', 'Agent 靠 description 决定什么时候用这个 Skill；没有它基本不会被触发')
    } else {
      if (description.length > DESC_MAX) add('error', 'description-too-long', `description 有 ${description.length} 个字符，超过规范上限 ${DESC_MAX}`, '有的 IDE 会截断或拒绝加载。把细节挪进正文，description 只写做什么、什么时候用、什么时候不用')
      else if (estimateTokens(description) < DESC_MIN_TOKENS) add('warn', 'description-too-short', `description 只有 ${description.length} 个字符`, '写清楚做什么、在什么情况下用，否则 Agent 很难判断该不该触发')
      if (estimateTokens(description) >= DESC_MIN_TOKENS && !TRIGGER_RE.test(description)) add('info', 'no-trigger-cue', 'description 没写什么时候用', '加一句「用于……」或 "Use when …"，触发更准')
      if (estimateTokens(description) >= DESC_MIN_TOKENS && !EXCLUSION_RE.test(description)) add('info', 'no-exclusion', 'description 没写不适用的场景', '加一句「不用于……」，减少和相近 Skill 抢触发')
    }
  }

  const raw = parsed.rawContent ?? ''
  const skillMdLines = raw.split('\n').length
  if (skillMdLines > LINES_MAX) add('warn', 'skill-md-too-long', `SKILL.md 有 ${skillMdLines} 行，超过建议的 ${LINES_MAX} 行`, '触发后整份 SKILL.md 都会进上下文。把细节拆到 references/ 里，正文只留流程和指引')

  const nested = await nestedEntrypoints(dir)
  if (nested.length) add('warn', 'nested-skill-md', `子目录里还有 ${nested.length} 个 SKILL.md：${nested.slice(0, 3).join('、')}`, '一个 Skill 只应有一个入口。示例改名为 SKILL.example.md，测试夹具改名为 SKILL.fixture.md')

  const broken = await brokenLinks(dir, parsed.content ?? '')
  if (broken.length) add('warn', 'broken-links', `SKILL.md 里有 ${broken.length} 个引用找不到：${broken.slice(0, 3).join('、')}`, 'Agent 按引用去读文件时会失败')

  return {
    name: name || folder,
    description,
    routingTokens: estimateTokens(`${name || folder}: ${description}`),
    skillMdLines,
    issues,
  }
}
