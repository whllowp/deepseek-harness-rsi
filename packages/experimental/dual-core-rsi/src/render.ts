/**
 * Plain-text renderings of dual-core RSI state for the model-facing tools
 * and the human-facing `/rsi` command, led by plain-language summaries so a
 * first-time user can act on them without knowing the domain vocabulary.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi/render
 */

import { formatPercent } from './policy.ts'
import type {
  RsiArchiveEntry, RsiCycleRecord, RsiGeneration, RsiStatusView,
} from './types.ts'

const TRUNCATION_NOTICE = '…'

/** One-line statement of what the mode does, shown at the top of every status. */
export const RSI_MODE_SUMMARY = 'Dual-core RSI: the daemon core reviews your recent sessions, proposes a better working policy (guidance text and skills only), and adopts it only when it clearly scores better.'

/** Cost disclosure shown wherever a cycle can be started. */
export const RSI_CYCLE_COST_NOTE = 'Each cycle runs one fresh model child and spends tokens.'

/** Bound one text field for display. */
function bound(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`
}

/**
 * One-line summary of a generation's identity and evidence.
 * @param generation - the generation to summarize.
 * @returns the rendered one-line summary.
 */
export function renderGeneration(generation: RsiGeneration): string {
  const score = generation.benchmark === undefined
    ? 'no benchmark yet'
    : `benchmark ${generation.benchmark.provider} score ${generation.benchmark.score.toFixed(3)}`
  const guidance = generation.artifacts.guidance.length === 0
    ? 'no guidance'
    : `${generation.artifacts.guidance.length} guidance line${generation.artifacts.guidance.length === 1 ? '' : 's'}`
  const skills = generation.artifacts.skills.map(skill => skill.name).join(', ')
  return `${generation.id} (${generation.origin}, parent ${generation.parent ?? 'none'}): ${score}; ${guidance}; skills: ${skills === '' ? 'none' : skills}`
}

/**
 * Plain-language outcome label for one settled cycle.
 * @param record - the cycle record to label.
 * @returns the human-readable outcome sentence.
 */
export function cycleOutcomeLabel(record: RsiCycleRecord): string {
  return record.outcome === 'promoted'
    ? 'adopted a new working policy; your agent uses it from its next request'
    : 'kept the current policy; the candidate did not score clearly better'
}

/**
 * Multi-line daemon status for tools and the command.
 * @param view - the status view to render.
 * @returns the rendered status text.
 */
export function renderStatus(view: RsiStatusView): string {
  const lines = [
    RSI_MODE_SUMMARY,
    `User core: ${renderGeneration(view.active)}`,
    `Daemon core: ${renderGeneration(view.daemon)}`,
    `Swap gate: promotion when benchmark improvement exceeds ${formatPercent(view.threshold)}`,
    `Cycle: ${view.cycleRunning ? 'running' : 'idle'}`,
  ]
  if (view.knowledgeCutoffAt !== undefined) {
    lines.push(`Knowledge current as of: ${new Date(view.knowledgeCutoffAt).toISOString()}`)
  }
  if (view.unseenSessionCount > 0) {
    lines.push(`${view.unseenSessionCount} live session${view.unseenSessionCount === 1 ? '' : 's'} changed since the last cycle.`)
  }
  if (view.lastCycle !== undefined) {
    lines.push(`Last cycle: ${renderCycleRecord(view.lastCycle)}`)
  }
  lines.push(...nextStepLines(view))
  return lines.join('\n')
}

/** What the user should do next, derived from the current state. */
function nextStepLines(view: RsiStatusView): string[] {
  if (view.cycleRunning) {
    return ['Next: a cycle is running right now; run /rsi again in a moment to see its result.']
  }
  if (view.lastCycle === undefined) {
    return [
      'Next: nothing has been distilled yet. Work with your agent normally for a while, then run /rsi run to let the daemon learn from those sessions.',
      RSI_CYCLE_COST_NOTE,
    ]
  }
  if (view.unseenSessionCount > 0) {
    return [`Next: that activity is not in the current policy yet; /rsi run refreshes it (${RSI_CYCLE_COST_NOTE.toLowerCase()}).`]
  }
  if (view.archiveCount > 0) {
    return [`Next: /rsi run starts another cycle (${RSI_CYCLE_COST_NOTE.toLowerCase()}); /rsi rollback restores the policy in place before the last adoption.`]
  }
  return [`Next: /rsi run starts another cycle (${RSI_CYCLE_COST_NOTE.toLowerCase()}).`]
}

/**
 * One-paragraph settlement summary of one cycle.
 * @param record - the cycle record to render.
 * @returns the rendered cycle summary.
 */
export function renderCycleRecord(record: RsiCycleRecord): string {
  return `cycle ${record.id} (${record.trigger}) ${cycleOutcomeLabel(record)}: candidate ${record.candidateId} scored ${record.candidateScore.toFixed(3)} against baseline ${record.baselineScore.toFixed(3)}, improvement ${formatPercent(record.improvement)} vs threshold ${formatPercent(record.threshold)}; ${bound(record.rationale, 200)}`
}

/**
 * Multi-line history of recent cycles and archives.
 * @param cycles - recent cycle records, newest first.
 * @param archives - recent archive entries, newest first.
 * @returns the rendered history text.
 */
export function renderHistory(cycles: readonly RsiCycleRecord[], archives: readonly RsiArchiveEntry[]): string {
  const lines = ['Dual-core RSI history:']
  if (cycles.length === 0) {
    lines.push('No completed cycles yet.')
  } else {
    lines.push(...cycles.map(record => renderCycleRecord(record)))
  }
  if (archives.length > 0) {
    lines.push('Archives (newest first; each is a restore point):')
    lines.push(...archives.map(archive => `archive ${archive.id} [${archive.reason}] archived ${archive.generation.id} (score ${archive.generation.benchmark === undefined ? 'n/a' : archive.generation.benchmark.score.toFixed(3)}), superseded by ${archive.supersededBy}`))
    lines.push('Restore one with /rsi rollback <archive id>, or /rsi rollback for the newest.')
  }
  return lines.join('\n')
}

/**
 * Rollback confirmation naming both archive edges.
 * @param restored - the generation the rollback restored.
 * @param archived - the archive entry created for the replaced generation.
 * @returns the rendered rollback confirmation.
 */
export function renderRollback(restored: RsiGeneration, archived: RsiArchiveEntry): string {
  return `Rolled back the user core to ${restored.id} (score ${restored.benchmark === undefined ? 'n/a' : restored.benchmark.score.toFixed(3)}). Your agent uses the restored policy from its next request. The replaced generation was archived as ${archived.id}; run /rsi rollback again to undo this rollback.`
}
