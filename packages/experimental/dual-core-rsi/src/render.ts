/**
 * Plain-text renderings of dual-core RSI state for the model-facing tools,
 * the human-facing `/rsi` command, and the exit merge consult, led by
 * plain-language summaries so a first-time user can act on them without
 * knowing the domain vocabulary.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi/render
 */

import { formatPercent } from './policy.ts'
import type { RsiMergeResult, RsiDeclineResult } from './index.ts'
import type { RsiLedgerOutcome } from './ledger.ts'
import type {
  RsiArchiveEntry, RsiCycleRecord, RsiGeneration, RsiIncidentRecord, RsiPendingCandidate, RsiStatusView,
} from './types.ts'

const TRUNCATION_NOTICE = '…'

/** One-line statement of what the mode does, shown at the top of every status. */
export const RSI_MODE_SUMMARY = 'Dual-core RSI: the daemon core reviews your recent sessions on its own schedule, proposes a better working policy (guidance text and skills only), and offers it for your merge decision only when it clearly scores better.'

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
  if (record.outcome === 'pending') {
    return record.decision === 'merged'
      ? 'proposed a clearly better policy and the user merged it'
      : record.decision === 'declined'
        ? 'proposed a clearly better policy and the user declined it'
        : 'found a clearly better policy that waits for your merge decision'
  }
  return record.outcome === 'promoted'
    ? 'adopted a new working policy (records predate merge decisions)'
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
    `Swap gate: a merge is offered when benchmark improvement exceeds ${formatPercent(view.threshold)}`,
    `Daemon: ${view.daemonEnabled ? 'scheduled ticks armed; cycles run on their own when new session activity waits' : 'disabled (daemonEnabled: false); cycles run only through /rsi run or rsi_run'}`,
    `Cycle: ${view.cycleRunning ? 'running' : 'idle'}`,
  ]
  if (view.pending !== undefined) {
    lines.push(`Pending merge: ${renderPendingCandidate(view.pending)}`)
  }
  if (view.incidents.length > 0) {
    lines.push(`Self-repair (newest first): ${view.incidents.map(incident => renderIncident(incident)).join(' | ')}`)
  }
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

/** One-line identity and evidence of the pending merge candidate. */
function renderPendingCandidate(pending: RsiPendingCandidate): string {
  const skills = pending.generation.artifacts.skills.map(skill => skill.name).join(', ')
  return `${pending.generation.id} from cycle ${pending.cycle.id} (scored ${pending.cycle.candidateScore.toFixed(3)} against ${pending.cycle.baselineScore.toFixed(3)}): ${pending.generation.artifacts.guidance.length} guidance line${pending.generation.artifacts.guidance.length === 1 ? '' : 's'}${skills === '' ? '' : `, skills: ${skills}`}`
}

/** One compact line naming one recorded self-repair incident. */
function renderIncident(incident: RsiIncidentRecord): string {
  const recovery = incident.recovery === 'retried'
    ? `retried after ${incident.retryAfterMs}ms`
    : `deferred ${incident.retryAfterMs}ms to the next interval`
  return `inc ${incident.id} [${incident.kind}] attempt ${incident.attempt} ${recovery}`
}

/** What the user should do next, derived from the current state. */
function nextStepLines(view: RsiStatusView): string[] {
  if (view.cycleRunning) {
    return ['Next: a cycle is running right now; run /rsi again in a moment to see its result.']
  }
  if (view.pending !== undefined) {
    const lines = ['Next: /rsi merge adopts the pending policy and records it in the local git ledger; /rsi decline keeps the current one. The offer also appears when the session exits.']
    if (view.archiveCount > 0) lines.push('Next: /rsi rollback restores the policy in place before the last merge.')
    return lines
  }
  if (view.lastCycle === undefined) {
    return [
      `Next: nothing has been distilled yet. ${view.daemonEnabled ? 'The scheduled daemon starts cycling as you work; /rsi run starts one immediately.' : 'Run /rsi run to start one.'} ${RSI_CYCLE_COST_NOTE}`,
    ]
  }
  if (view.unseenSessionCount > 0) {
    return [`Next: that activity is not in the current policy yet; ${view.daemonEnabled ? 'the scheduled daemon folds it into its next tick, and /rsi run refreshes it now' : '/rsi run refreshes it'} (${RSI_CYCLE_COST_NOTE.toLowerCase()}).`]
  }
  if (view.archiveCount > 0) {
    return [`Next: the daemon keeps cycling as new session activity arrives (${RSI_CYCLE_COST_NOTE.toLowerCase()}); /rsi rollback restores the policy in place before the last merge.`]
  }
  return [`Next: the daemon keeps cycling as new session activity arrives (${RSI_CYCLE_COST_NOTE.toLowerCase()}).`]
}

/**
 * One-paragraph settlement summary of one cycle.
 * @param record - the cycle record to render.
 * @returns the rendered cycle summary.
 */
export function renderCycleRecord(record: RsiCycleRecord): string {
  const decision = record.decision === undefined
    ? ''
    : record.decision === 'merged'
      ? '; the user merged it'
      : '; the user declined it'
  return `cycle ${record.id} (${record.trigger}) ${cycleOutcomeLabel(record)}: candidate ${record.candidateId} scored ${record.candidateScore.toFixed(3)} against baseline ${record.baselineScore.toFixed(3)}, improvement ${formatPercent(record.improvement)} vs threshold ${formatPercent(record.threshold)}${decision}; ${bound(record.rationale, 200)}`
}

/**
 * Multi-line history of recent cycles, archives, and self-repair incidents.
 * @param cycles - recent cycle records, newest first.
 * @param archives - recent archive entries, newest first.
 * @param incidents - recent incident records, newest first.
 * @returns the rendered history text.
 */
export function renderHistory(
  cycles: readonly RsiCycleRecord[],
  archives: readonly RsiArchiveEntry[],
  incidents: readonly RsiIncidentRecord[],
): string {
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
  if (incidents.length > 0) {
    lines.push('Self-repair incidents (newest first):')
    lines.push(...incidents.map(incident => `${renderIncident(incident)}: ${bound(incident.detail, 160)}`))
  }
  return lines.join('\n')
}

/**
 * The exit-time session summary: improvement points from the pending
 * candidate and fix points from the daemon's recorded self-repairs.
 * @param pending - the pending merge candidate.
 * @param incidents - self-repair incidents settled since the last decision, newest first.
 * @param threshold - configured swap threshold in effect.
 * @returns the rendered summary shown with the merge question.
 */
export function renderExitSummary(
  pending: RsiPendingCandidate,
  incidents: readonly RsiIncidentRecord[],
  threshold: number,
): string {
  const lines = [
    'Dual-core RSI session summary',
    `Improvement points — pending policy ${pending.generation.id} from cycle ${pending.cycle.id}:`,
    `  scored ${pending.cycle.candidateScore.toFixed(3)} against the current ${pending.cycle.baselineScore.toFixed(3)} (improvement ${formatPercent(pending.cycle.improvement)} vs threshold ${formatPercent(threshold)}).`,
    `  rationale: ${bound(pending.cycle.rationale, 300)}`,
  ]
  if (incidents.length === 0) {
    lines.push('Fix points — daemon self-repairs since the last decision: none; every scheduled attempt settled without repair.')
  } else {
    lines.push('Fix points — daemon self-repairs since the last decision (newest first):')
    lines.push(...incidents.slice(0, 10).map(incident => `  ${renderIncident(incident)}: ${bound(incident.detail, 160)}`))
  }
  lines.push('Merging replaces the current policy for your agent and records the change in the local git ledger for rollback; keeping declines the candidate.')
  return lines.join('\n')
}

/**
 * Merge confirmation naming the swap, the restore point, and the ledger outcome.
 * @param result - the settled merge result.
 * @returns the rendered confirmation.
 */
export function renderMergeResult(result: RsiMergeResult): string {
  const via = result.source === 'consult' ? 'the exit consult' : '/rsi merge'
  const ledger = result.ledger.committed
    ? `The local git ledger recorded commit ${result.ledger.revision}.`
    : `The local git ledger could not record the change (${result.ledger.error}); the archive still covers rollback.`
  return `Merged ${result.generation.id} into your agent's working policy via ${via} (cycle ${result.cycle.id}, score ${result.generation.benchmark === undefined ? 'n/a' : result.generation.benchmark.score.toFixed(3)}). Your agent uses it from its next request. The replaced policy was archived as ${result.archived.id}; /rsi rollback restores it. ${ledger}`
}

/**
 * Decline confirmation naming the kept policy and the declined candidate.
 * @param result - the settled decline result.
 * @returns the rendered confirmation.
 */
export function renderDeclineResult(result: RsiDeclineResult): string {
  const via = result.source === 'consult' ? 'the exit consult' : '/rsi decline'
  return `Kept the current policy via ${via}; the pending candidate from cycle ${result.cycle.id} was declined and nothing changed. The daemon keeps distilling from its own lineage.`
}

/**
 * Rollback confirmation naming both archive edges and the ledger outcome.
 * @param restored - the generation the rollback restored.
 * @param archived - the archive entry created for the replaced generation.
 * @param ledger - whether the git ledger recorded the restored policy.
 * @returns the rendered rollback confirmation.
 */
export function renderRollback(restored: RsiGeneration, archived: RsiArchiveEntry, ledger: RsiLedgerOutcome): string {
  const ledgerNote = ledger.committed
    ? 'The local git ledger recorded the restore.'
    : `The local git ledger could not record the restore (${ledger.error}).`
  return `Rolled back the user core to ${restored.id} (score ${restored.benchmark === undefined ? 'n/a' : restored.benchmark.score.toFixed(3)}). Your agent uses the restored policy from its next request. The replaced generation was archived as ${archived.id}; run /rsi rollback again to undo this rollback. ${ledgerNote}`
}
