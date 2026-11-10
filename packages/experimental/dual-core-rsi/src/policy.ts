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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Defensively decode one unknown value into a validated skill artifact. */
function readSkillArtifact(value: unknown, budgets: RsiArtifactBudgets): RsiSkillArtifact {
  if (!isRecord(value)) {
    throw new TypeError('RSI skill artifact must be an object')
  }
  // Models routinely wrap structured string fields in leading or trailing
  // whitespace that carries no policy, so the decoder trims it before
  // validating; whitespace-only text still fails.
  const name = typeof value['name'] === 'string' ? value['name'].trim() : value['name']
  const description = typeof value['description'] === 'string' ? value['description'].trim() : value['description']
  const content = typeof value['content'] === 'string' ? value['content'].trim() : value['content']
  if (typeof name !== 'string' || !isSkillName(name)) {
    throw new TypeError(`RSI skill name "${String(name)}" is not a valid kebab-case skill name`)
  }
  if (typeof description !== 'string' || description.length === 0) {
    throw new TypeError(`RSI skill "${name}" description must be non-empty text`)
  }
  if (typeof content !== 'string' || content.length === 0) {
    throw new TypeError(`RSI skill "${name}" content must be non-empty text`)
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
 * configured budgets. String fields are trimmed of leading and trailing
 * whitespace, then every field is checked here before the set is stored or
 * applied; typed same-process callers trust their values instead.
 * @param value - raw artifact value from a distiller output.
 * @param budgets - configured artifact budgets.
 * @returns the validated, trimmed artifact set.
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
  const guidanceLines = guidance.map((raw: unknown): string => {
    const line = typeof raw === 'string' ? raw.trim() : raw
    if (typeof line !== 'string' || line.length === 0) {
      throw new TypeError('every RSI guidance line must be non-empty text')
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
 * Compare two artifact sets by content: same guidance lines in order and the
 * same skills by every field. Artifact sets are plain validated data, so a
 * structural compare decides equality without hashing or ordering games.
 * @param left - one validated artifact set.
 * @param right - the other validated artifact set.
 * @returns whether the two sets carry identical content.
 */
export function artifactsEqual(left: RsiArtifacts, right: RsiArtifacts): boolean {
  if (left === right) return true
  if (left.guidance.length !== right.guidance.length || left.skills.length !== right.skills.length) return false
  for (let index = 0; index < left.guidance.length; index += 1) {
    if (left.guidance[index] !== right.guidance[index]) return false
  }
  for (let index = 0; index < left.skills.length; index += 1) {
    const a = left.skills[index]
    const b = right.skills[index]
    if (a === undefined || b === undefined
      || a.name !== b.name || a.description !== b.description || a.content !== b.content) return false
  }
  return true
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
 * skill registry resolves through the agent scope's own service isolation, so
 * a preset-scoped registry receives the skills. Application is all-or-nothing:
 * a failure disposes every registration this call already made before the
 * error propagates. The caller owns the returned disposer; disposing it
 * removes every registration this call made.
 * @param agentCtx - the agent's scoped context.
 * @param artifacts - validated artifact set to apply.
 * @param order - prompt-section sort order for the distilled policy.
 * @returns the combined disposer, disposing registrations in reverse order.
 * @throws Error when the set carries skills but the agent scope composes no skill registry, or when a registration fails.
 */
export function applyArtifacts(agentCtx: Context, artifacts: RsiArtifacts, order: number): () => void {
  const registry = agentCtx.get('skills')
  const first = artifacts.skills[0]
  if (first !== undefined && registry === undefined) {
    throw new Error(`dual-core RSI cannot apply distilled skill "${first.name}": the agent scope composes no skill registry; mount @deepseek-ai/dsh-skill or set maxSkills: 0`)
  }
  const disposers: (() => void)[] = []
  const disposeAll = (): void => {
    for (const dispose of disposers.reverse()) dispose()
  }
  try {
    const text = renderPolicySection(artifacts)
    if (text !== undefined) {
      disposers.push(agentCtx.systemPrompt.section({ name: RSI_DISTILLED_POLICY_SECTION, order, text }))
    }
    if (registry !== undefined) {
      for (const skill of artifacts.skills) {
        disposers.push(registry.register({
          name: skill.name,
          description: skill.description,
          content: skill.content,
          source: 'runtime',
        }))
      }
    }
  } catch (error) {
    disposeAll()
    throw error
  }
  return disposeAll
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
