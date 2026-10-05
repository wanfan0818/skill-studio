import fs from 'fs/promises'
import path from 'path'
import matter from 'gray-matter'
import type { SkillFrontmatter } from '../types.js'

export interface ParsedSkill {
  frontmatter: SkillFrontmatter
  content: string
  rawContent: string
  /** Set when the YAML frontmatter is malformed; frontmatter is then {}. */
  parseError?: string
}

export async function parseSkillMd(skillMdPath: string): Promise<ParsedSkill> {
  const raw = await fs.readFile(skillMdPath, 'utf-8')
  try {
    // Passing an options object bypasses gray-matter's global cache. That
    // cache stores an entry BEFORE parsing, so a malformed file throws once
    // and then "parses" fine forever after (empty data) — and it never
    // evicts, holding every SKILL.md version ever read in memory.
    const { data, content } = matter(raw, {})
    return { frontmatter: data as SkillFrontmatter, content: content.trim(), rawContent: raw }
  } catch (err: any) {
    return { frontmatter: {}, content: raw.trim(), rawContent: raw, parseError: err?.message || String(err) }
  }
}

export async function listSkillFiles(skillDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(skillDir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
  } catch {
    return []
  }
}

export function getSkillMdPath(skillDir: string): string {
  return path.join(skillDir, 'SKILL.md')
}
