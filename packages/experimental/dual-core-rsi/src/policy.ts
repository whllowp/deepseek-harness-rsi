/**
 * Artifact policy: budget validation, prompt-section rendering, and scoped
 * application of one artifact set to an agent context.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi/policy
 */

import type { Context } from '@deepseek-ai/cordis'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { RsiArtifactBudgets, RsiArtifacts, RsiSkillArtifact } from './types.ts'

/** Prompt-section name for the distilled policy applied to user-core agents. */
export const RSI_DISTILLED_POLICY_SECTION = 'rsi:distilled-policy'

function isNormalizedText(value: string): boolean {
  return value.length > 0 && value === value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Defensively decode one unknown value into a validated skill artifact. */
function readSkillArtifact(value: unknown, budgets: RsiArtifactBudgets): RsiSkillArtifact {
  if (!isRecord(value)) {
    throw new TypeError('RSI skill artifact must be an object')
  }
  const { name, description, content } = value
  if (typeof name !== 'string' || !isSkillName(name)) {
    throw new TypeError(`RSI skill name "${String(name)}" is not a valid kebab-case skill name`)
  }
  if (typeof description !== 'string' || !isNormalizedText(description)) {
    throw new TypeError(`RSI skill "${name}" description must be non-empty normalized text`)
  }
  if (typeof content !== 'string' || !isNormalizedText(content)) {
    throw new TypeError(`RSI skill "${name}" content must be non-empty normalized text`)
  }
  if (description.length > budgets.maxSkillDescriptionChars) {
    throw new TypeError(`RSI skill "${name}" description exceeds maxSkillDescriptionChars (${description.length} > ${budgets.maxSkillDescriptionChars})`)
  }
  if (content.length > budgets.maxSkillContentChars) {
    throw new TypeError(`RSI skill "${name}" content exceeds maxSkillContentChars (${content.length} > ${budgets.maxSkillContentChars})`)
  }
  for (const key of Object.keys(value)) {
    if (key !== 'name' && key !== 'description' && key !== 'content') {
      throw new TypeError(`RSI skill artifact carries unexpected field "${key}"`)
    }
  }
  return { name, description, content }
}

/**
 * Decode one artifact set crossing a model JSON boundary against the
 * configured budgets. Every field is checked here before the set is stored
 * or applied; typed same-process callers trust their values instead.
 * @param value - raw artifact value from a distiller output.
 * @param budgets - configured artifact budgets.
 * @returns the validated artifact set.
 * @throws TypeError naming the first violated budget or shape rule.
 */
export function decodeArtifacts(value: unknown, budgets: RsiArtifactBudgets): RsiArtifacts {
  if (!isRecord(value)) {
    throw new TypeError('RSI artifacts must be an object')
  }
  const { guidance, skills } = value
  if (!Array.isArray(guidance) || !Array.isArray(skills)) {
    throw new TypeError('RSI artifacts need guidance and skills arrays')
  }
  if (guidance.length > budgets.maxGuidanceLines) {
    throw new TypeError(`RSI guidance exceeds maxGuidanceLines (${guidance.length} > ${budgets.maxGuidanceLines})`)
  }
  const guidanceLines = guidance.map((line): string => {
    if (typeof line !== 'string' || !isNormalizedText(line)) {
      throw new TypeError('every RSI guidance line must be non-empty normalized text')
    }
    if (line.length > budgets.maxGuidanceLineChars) {
      throw new TypeError(`RSI guidance line exceeds maxGuidanceLineChars (${line.length} > ${budgets.maxGuidanceLineChars})`)
    }
    return line
  })
  const totalChars = guidanceLines.reduce((sum, line) => sum + line.length, 0)
  if (totalChars > budgets.maxGuidanceChars) {
    throw new TypeError(`RSI guidance exceeds maxGuidanceChars (${totalChars} > ${budgets.maxGuidanceChars})`)
  }
  if (skills.length > budgets.maxSkills) {
    throw new TypeError(`RSI skills exceed maxSkills (${skills.length} > ${budgets.maxSkills})`)
  }
  const validated = skills.map(skill => readSkillArtifact(skill, budgets))
  const names = new Set(validated.map(skill => skill.name))
  if (names.size !== validated.length) {
    throw new TypeError('RSI skill names must be unique within one artifact set')
  }
  return { guidance: guidanceLines, skills: validated }
}

/**
 * Report whether an artifact set renders no prompt content at all.
 * @param artifacts - the artifact set to inspect.
 * @returns whether both the guidance and skills lists are empty.
 */
export function isEmptyArtifacts(artifacts: RsiArtifacts): boolean {
  return artifacts.guidance.length === 0 && artifacts.skills.length === 0
}

/**
 * Render one artifact set's guidance as the distilled-policy prompt-section
 * text. Skills are listed as one routing line each; their bodies live in the
 * skill registry, not the prompt.
 * @param artifacts - validated artifact set.
 * @returns the section text, or `undefined` when the set has no content.
 */
export function renderPolicySection(artifacts: RsiArtifacts): string | undefined {
  if (isEmptyArtifacts(artifacts)) return undefined
  const lines: string[] = ['Distilled working policy for this workspace, extracted by the RSI daemon core from recent sessions.']
  if (artifacts.guidance.length > 0) {
    lines.push('', 'Guidance:')
    for (const line of artifacts.guidance) lines.push(`- ${line}`)
  }
  if (artifacts.skills.length > 0) {
    lines.push('', 'Distilled skills (load by name through the skill tool):')
    for (const skill of artifacts.skills) lines.push(`- ${skill.name}: ${skill.description}`)
  }
  return lines.join('\n')
}

/**
 * Apply one artifact set to an agent-scoped context: the distilled-policy
 * prompt section plus one runtime skill registration per skill artifact. The
 * caller owns the returned disposer; disposing it removes every registration
 * this call made.
 * @param agentCtx - the agent's scoped context.
 * @param artifacts - validated artifact set to apply.
 * @param order - prompt-section sort order for the distilled policy.
 * @returns the combined disposer, disposing registrations in reverse order.
 */
export function applyArtifacts(agentCtx: Context, artifacts: RsiArtifacts, order: number): () => void {
  const disposers: (() => void)[] = []
  const text = renderPolicySection(artifacts)
  if (text !== undefined) {
    disposers.push(agentCtx.systemPrompt.section({ name: RSI_DISTILLED_POLICY_SECTION, order, text }))
  }
  for (const skill of artifacts.skills) {
    disposers.push(agentCtx.skills.register({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      source: 'runtime',
    }))
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/**
 * Bound one distiller rationale to a single normalized line.
 * @param value - raw rationale from a distiller output.
 * @param maxChars - maximum retained characters.
 * @returns the normalized bounded rationale.
 * @throws TypeError when the rationale is empty.
 */
export function normalizeRationale(value: string, maxChars: number): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new TypeError('RSI distiller rationale must be non-empty')
  }
  return trimmed.length <= maxChars ? trimmed : trimmed.slice(0, maxChars)
}

/**
 * Format one fraction as a signed percentage for human-facing surfaces.
 * @param fraction - fraction value (`0.062` is +6.2%).
 * @returns the formatted percentage string.
 */
export function formatPercent(fraction: number): string {
  const label = (fraction * 100).toFixed(1)
  return fraction > 0 ? `+${label}%` : `${label}%`
}
