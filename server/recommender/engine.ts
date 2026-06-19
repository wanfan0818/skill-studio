import type { Skill } from '../types.js'

export interface Recommendation {
  name: string
  reason: string
  confidence: number
}

// 常见技术领域及其相关的关键字和推荐理由模板
interface DomainRule {
  id: string
  keywords: string[]
  reasonTemplate: string
  targetSkills: string[] // 优先推荐的技能名称/ID片段
}

const DOMAIN_RULES: DomainRule[] = [
  {
    id: 'frontend',
    keywords: ['前端', '界面', 'ui', 'ux', 'css', 'html', 'react', 'vue', 'nextjs', 'vite', 'tailwind', 'style', 'layout', 'design', 'components', '网页', '设计', '动效', '动画'],
    reasonTemplate: '检测到您的项目与前端/界面设计相关，推荐此 Skill 以帮助您构建高品质 UI 并保证视觉一致性。',
    targetSkills: ['impeccable', 'shadcn-ui', 'animate', 'adapt', 'arrange', 'colorize', 'typeset', 'distill', 'normalize', 'polish', 'delight', 'quieter', 'bolder', 'overdrive']
  },
  {
    id: 'ai-agents',
    keywords: ['ai', 'agent', '智能体', 'mcp', 'prompt', '提示词', 'llm', 'gpt', 'claude', 'gemini', 'suno', 'notebooklm', 'rag', '知识库', 'podcast', '播客'],
    reasonTemplate: '检测到您在开发 AI/Agent 相关的应用或需要高质量提示词工程，此 Skill 能提供专业的 AI 辅助与提示词构建支持。',
    targetSkills: ['prompt-engineer', 'image-prompt-architect', 'notebooklm', 'qiaomu-anything-to-notebooklm', 'anything-to-notebooklm', 'cangjie', 'content-research-writer', 'image-style-analyzer', 'visual-style-extractor']
  },
  {
    id: 'documentation',
    keywords: ['文档', '写作', '阅读', '文章', '公众号', '微信', '书', '论文', 'paper', 'writes', 'readme', 'pdf', 'docx', 'xlsx', 'office', '报告', 'ppt', '幻灯片', 'slide'],
    reasonTemplate: '检测到您的项目涉及大量文档编写、知识整理或媒介转换，此 Skill 能极大提高您的内容创作与输出效率。',
    targetSkills: ['content-research-writer', 'md2wechat', 'pdf', 'docx', 'xlsx', 'pptx', 'ljg-book', 'ljg-paper', 'ljg-writes', 'ljg-qa', 'ljg-read', 'baoyu-slide-deck', 'guizang-ppt-skill', 'infocard']
  },
  {
    id: 'visual-charts',
    keywords: ['图表', '架构', '流程', 'uml', 'diagram', 'chart', 'mermaid', 'graphviz', 'plantuml', '可视化', '拓扑', '数据流', 'iot', 'security'],
    reasonTemplate: '检测到您的项目需要架构设计或流程展示，此 Skill 可以通过简单的代码快速生成精美的 UML、Mermaid 架构图。',
    targetSkills: ['fireworks-tech-graph', 'mermaid', 'uml', 'architecture', 'cloud', 'data-analytics', 'network', 'security', 'bpmn', 'archimate', 'graphviz', 'vega']
  },
  {
    id: 'business',
    keywords: ['商业', '项目', '招投标', '商务', '投资', '分析', '模式', '诊断', 'benchmark', '对标', '概念', 'rfp'],
    reasonTemplate: '检测到该项目包含商业分析、投资决策或招投标相关事务，此 Skill 采用专业框架帮助您梳理商业模式与规避风险。',
    targetSkills: ['bid-assistant', 'solution-generator', 'sichuan-four-lists', 'dbs-diagnosis', 'dbs-deconstruct', 'dbs-benchmark', 'dbs-invest', 'ljg-invest', 'ljg-think', 'ljg-rank']
  },
  {
    id: 'children-education',
    keywords: ['早教', '宝宝', '绘本', '儿童', '教育', '启蒙', '亲子', '有声书', '故事'],
    reasonTemplate: '检测到您的项目面向儿童教育与绘本创作，此 Skill 提供了蒙特氏启蒙与一站式绘本内容生产引擎。',
    targetSkills: ['early-education-designer', 'ai-kids-coach', 'picture-book-creator-v4', 'picture-book-creative-engine-cn', 'picture-book-learning-engine-cn', 'english-picture-book-creator']
  }
]

// 停用词/常见无意义词，计算文本匹配时排除
const STOP_WORDS = new Set([
  '的', '了', '和', '是', '在', '我', '有', '个', '这', '那', '与', '及', '等', '之', '为', '地', '得',
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'about'
])

/**
 * 分词辅助函数：将中文/英文文本切分为词素
 */
function tokenize(text: string): string[] {
  const normalized = text.toLowerCase()
  // 匹配英文单词以及中文字符
  const rawTokens = normalized.match(/[a-z0-9-]+|[\u4e00-\u9fa5]/g) || []
  return rawTokens.filter(token => token.length > 0 && !STOP_WORDS.has(token))
}

/**
 * 计算两个词袋的重合度评分
 */
function calculateOverlap(tokens1: string[], tokens2: string[]): number {
  if (tokens1.length === 0 || tokens2.length === 0) return 0
  const set1 = new Set(tokens1)
  let matches = 0
  for (const t of tokens2) {
    if (set1.has(t)) {
      matches++
    }
  }
  return matches
}

export function recommendSkills(projectDescription: string, allSkills: Skill[]): Recommendation[] {
  if (!projectDescription || projectDescription.trim() === '') {
    // 没有描述时，默认推荐一些最通用的高频 Skill
    const defaultCommons = ['claude-code', 'impeccable', 'prompt-engineer', 'mermaid', 'pdf']
    return allSkills
      .filter(s => defaultCommons.some(c => s.name.toLowerCase().includes(c)))
      .map(s => ({
        name: s.name,
        reason: '这是 Skill Studio 最常用的通用型技能，适合作为任何新项目的初始配置。',
        confidence: 0.8
      }))
  }

  const descTokens = tokenize(projectDescription)
  const recommendations: Recommendation[] = []

  // 1. 判断项目描述匹配了哪些技术领域
  const matchedDomains = DOMAIN_RULES.map(rule => {
    let matchCount = 0
    for (const kw of rule.keywords) {
      if (projectDescription.toLowerCase().includes(kw)) {
        matchCount++
      }
    }
    return { rule, score: matchCount / rule.keywords.length, count: matchCount }
  }).filter(item => item.count > 0)

  // 2. 对所有已发现的 Skill 进行打分
  for (const skill of allSkills) {
    let score = 0
    let reason = ''
    
    const skillNameLower = skill.name.toLowerCase()
    const skillDescLower = skill.description.toLowerCase()
    const skillCategoryLower = (skill.category || '').toLowerCase()

    // 规则 A：Skill 名称直接出现在描述中 (极高权重)
    if (projectDescription.toLowerCase().includes(skillNameLower)) {
      score += 10
      reason = `项目描述中直接指名了 "${skill.name}" 技能。`
    }

    // 规则 B：技术领域匹配 (中高权重)
    for (const { rule, count } of matchedDomains) {
      // 检查当前 Skill 是否是该领域的推荐 Skill，或者它的名字/描述是否属于该领域
      const isTarget = rule.targetSkills.some(target => 
        skillNameLower === target || 
        skillNameLower.includes(target) || 
        target.includes(skillNameLower)
      )
      
      if (isTarget) {
        score += 5 + (count * 1.5)
        reason = reason || rule.reasonTemplate
      }
    }

    // 规则 C：文本词汇重叠度 (普通权重)
    const skillTokens = tokenize(`${skill.name} ${skill.description} ${skill.category}`)
    const overlap = calculateOverlap(descTokens, skillTokens)
    if (overlap > 0) {
      score += overlap * 1.0
      if (!reason) {
        reason = `技能描述中的关键词 (${skillTokens.filter(t => descTokens.includes(t)).slice(0, 3).join(', ')}) 与您的项目匹配。`
      }
    }

    // 如果总分大于 0，说明有相关度，生成推荐项
    if (score > 0) {
      // 置信度计算：归一化到一个 0.3 - 0.98 的区间
      const confidence = Math.min(0.98, 0.3 + (score / 25) * 0.68)
      
      recommendations.push({
        name: skill.name,
        reason: reason || `此技能可以为您的项目开发提供辅助支持。`,
        confidence: parseFloat(confidence.toFixed(2))
      })
    }
  }

  // 按置信度从高到低排序，且最多返回 15 个推荐技能
  return recommendations
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 15)
}
