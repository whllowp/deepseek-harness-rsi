/**
 * Replay distiller seam: a Dream-RSI-style `ctx.rsiDistiller` provider.
 * Before every distillation it dreams over the replay ledger — the offline
 * record of past proposals and the scores they earned — and injects the
 * realized outcomes as bounded lessons appended to the input's knowledge
 * base; after the inner distiller returns, it records the proposal so the
 * next benchmark score joins it. The expensive child runs exactly once per
 * cycle, exactly as the shipped provider ran it.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi-evolution/replay-distiller
 */

import { Context, Service } from '@deepseek-ai/cordis'

// Empty type import: carries the subagents Context merge this provider reads.
import type {} from '@deepseek-ai/dsh-subagent'
import z from '@deepseek-ai/schemastery'
import {
  RsiDistiller, SubagentRsiDistiller, RsiKnowledgeId,
} from '@deepseek-ai/dsh-experimental-dual-core-rsi'
import type {
  RsiArtifacts, RsiDistillInput, RsiDistillOptions, RsiDistillOutput,
  RsiKnowledgeEntry, RsiKnowledgeKind,
} from '@deepseek-ai/dsh-experimental-dual-core-rsi'
import { artifactsFingerprint } from './ledger.ts'
import type { RsiReplayProposal } from './domain.ts'

declare module '@deepseek-ai/cordis' {
  // `ctx.rsiDistiller` is declared by the dual-core RSI package; this module
  // only re-mounts a different provider for it, adding no context member.
}

/** Upper bound for one injected lesson, matching the controller's knowledge lines. */
const LESSON_MAX_CHARS = 240

/** Config of the replay distiller provider. */
export interface ReplayDistillerConfig {
  /** Fresh structured-output provider used for the daemon child (default `spawn`, forwarded to the inner subagent distiller). */
  subagentProvider?: string
  /** Maximum replay lessons injected into one distillation (default 3). */
  maxLessons?: number
  /** Minimum joined outcome rows before any lesson is injected (default 2). */
  minSamples?: number
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${field} must be an integer in [${String(min)}, ${String(max)}], got ${String(value)}`)
  }
  return value
}

function normalizedProviderName(config: ReplayDistillerConfig): string {
  const providerName = config.subagentProvider ?? 'spawn'
  if (providerName.length === 0 || providerName !== providerName.trim()) {
    throw new TypeError('subagentProvider must be a non-empty normalized string')
  }
  return providerName
}

function formatScore(score: number): string {
  return score.toFixed(3)
}

/**
 * Service Provider for `ctx.rsiDistiller`: delegates the child spawn to the
 * shipped subagent distiller started in an isolated scope, and wraps the
 * call with the replay world — dream (lessons from recorded outcomes) before,
 * record (the proposal for future joins) after.
 */
export class ReplayRsiDistiller extends RsiDistiller {
  static inject = ['rsiEvolutionLedger', 'subagents']

  static Config: z<ReplayDistillerConfig> = z.object({
    subagentProvider: z.string().default('spawn'),
    maxLessons: z.number().step(1).min(1).max(8).default(3),
    minSamples: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(2),
  })

  private readonly providerName: string
  private readonly maxLessons: number
  private readonly minSamples: number
  /** The inner distiller's distill, captured as a closure at construction or start. */
  private distillInner!: (input: RsiDistillInput, options: RsiDistillOptions) => Promise<RsiDistillOutput>
  private lessonCounter = 0
  /** Guards the start hook: init runs once per fiber. */
  private innerStarted = false

  /**
   * @param ctx - the mounting context; the decorator becomes `ctx.rsiDistiller` for its row.
   * @param config - provider routing and replay bounds.
   * @param inner - explicit inner distiller (tests); when absent, `[Service.init]` starts the shipped
   *   subagent distiller on a detached context that forwards the tree's subagents seam.
   */
  constructor(ctx: Context, config: ReplayDistillerConfig, inner?: RsiDistiller) {
    const providerName = normalizedProviderName(config)
    const maxLessons = boundedInteger(config.maxLessons, 3, 1, 8, 'maxLessons')
    const minSamples = boundedInteger(config.minSamples, 2, 1, Number.MAX_SAFE_INTEGER, 'minSamples')
    super(ctx)
    this.providerName = providerName
    this.maxLessons = maxLessons
    this.minSamples = minSamples
    if (inner !== undefined) {
      this.distillInner = (input, options) => inner.distill(input, options)
      // An injected inner is the unit-test seam: init must not replace it.
      this.innerStarted = true
    }
  }

  async [Service.init](): Promise<void> {
    if (this.innerStarted) return
    this.innerStarted = true
    // The shipped distiller provides under the same service name, so it
    // cannot mount beside this provider. A detached context carries it:
    // its only tree dependency, the subagents seam, is forwarded, and the
    // detached fiber disposes with this service.
    /* jscpd:ignore-start -- the two providers share the detached-inner bootstrap shape; each mounts a different inner */
    const detached = new Context()
    this.ctx.effect(() => () => { void detached.fiber.dispose() }, 'replay distiller: inner lifetime')
    detached.provide('subagents', this.ctx.subagents)
    await detached.plugin(SubagentRsiDistiller, { subagentProvider: this.providerName })
    const inner = detached.rsiDistiller
    this.distillInner = (input, options) => inner.distill(input, options)
    /* jscpd:ignore-end */
  }

  /**
   * Distill one complete next artifact set through the replay world: the
   * mission input carries the dream lessons after the controller's own
   * knowledge lines, and the returned proposal joins the ledger so its
   * future benchmark score lands on the same row.
   * @param input - distill input with generations, digest, and budgets.
   * @param options - anchor agent and cancellation signal.
   * @returns the inner distiller's decoded output, unmodified.
   */
  async distill(input: RsiDistillInput, options: RsiDistillOptions): Promise<RsiDistillOutput> {
    const lessons = await this.dreamLessons(input)
    const knowledge = lessons.length === 0 ? input.knowledge : [...input.knowledge, ...lessons]
    const output = await this.distillInner({ ...input, knowledge }, options)
    // Contained: the proposal is already in the caller's hands; a ledger
    // outage must not fail the cycle that carried it.
    try {
      await this.ctx.rsiEvolutionLedger.recordProposal(output.artifacts, {
        rationale: output.rationale,
        matchedActive: artifactsFingerprint(output.artifacts) === artifactsFingerprint(input.active.artifacts),
        ...(await this.baselineScore(input.active.artifacts)),
      })
    } catch (error) {
      /* v8 ignore next -- the String arm needs a non-Error rejection, which the ledger never produces */
      this.ctx.logger.warn(`Replay distiller: ledger proposal write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return output
  }

  /** The active policy's recorded score, when the ledger has one for its content. */
  private async baselineScore(artifacts: RsiArtifacts): Promise<{ baselineScore?: number }> {
    const fingerprint = artifactsFingerprint(artifacts)
    const row = (await this.ctx.rsiEvolutionLedger.entries()).find(proposal => proposal.fingerprint === fingerprint)
    return row?.score === undefined ? {} : { baselineScore: row.score }
  }

  /**
   * Dream over the recorded outcomes: derive at most `maxLessons` bounded
   * lessons from the joined proposal/score rows, deterministic in content
   * and order. An under-sampled world injects nothing, so the first cycles
   * behave exactly like the shipped provider.
   * @param input - the distill input about to be dispatched.
   * @returns the replay lessons to append to the input's knowledge base.
   */
  private async dreamLessons(input: RsiDistillInput): Promise<readonly RsiKnowledgeEntry[]> {
    const rows = await this.ctx.rsiEvolutionLedger.entries()
    const scored = rows.filter((row): row is RsiReplayProposal & { score: number; scoredAt: number } =>
      row.score !== undefined && row.scoredAt !== undefined)
    if (scored.length < this.minSamples) return []
    // Trust the minSamples gate: scored carries at least one row past it.
    const best = [...scored].sort((a, b) => b.score - a.score || b.scoredAt - a.scoredAt).at(0)
    const worst = [...scored].sort((a, b) => a.score - b.score || b.scoredAt - a.scoredAt).at(0)
    /* v8 ignore next 2 -- a settled gate guarantees both extremes exist */
    if (best === undefined || worst === undefined) return []
    const lessons: RsiKnowledgeEntry[] = []
    const mint = (kind: RsiKnowledgeKind, text: string): void => {
      this.lessonCounter += 1
      lessons.push({ id: RsiKnowledgeId(`rp-${String(this.lessonCounter)}`), kind, text: text.slice(0, LESSON_MAX_CHARS), depositedAt: Date.now() })
    }
    const repeats = scored.filter(row => row.fingerprint === artifactsFingerprint(input.active.artifacts))
    if (repeats.length > 0) {
      const times = repeats.reduce((sum, row) => sum + row.distilledCount, 0)
      mint('rejection', `replay: proposing the active policy's exact content was recorded ${String(times)}× and settled without improvement; distill structurally different guidance or skills.`)
    }
    mint('insight', best.baselineScore === undefined
      ? `replay: the strongest recorded proposal scored ${formatScore(best.score)} (active score unknown then); its opening guidance was: "${best.firstGuidance}"`
      : `replay: the strongest recorded proposal scored ${formatScore(best.score)} against active ${formatScore(best.baselineScore)}; its opening guidance was: "${best.firstGuidance}"`)
    if (worst !== best) {
      mint('rejection', worst.baselineScore === undefined
        ? `replay: the weakest recorded proposal scored ${formatScore(worst.score)} (active score unknown then); avoid repeating its direction: "${worst.firstGuidance}"`
        : `replay: the weakest recorded proposal scored ${formatScore(worst.score)} against active ${formatScore(worst.baselineScore)}; avoid repeating its direction: "${worst.firstGuidance}"`)
    }
    const improved = scored.filter(row => row.baselineScore !== undefined && row.score > row.baselineScore).length
    mint('insight', `replay: ${String(scored.length)} recorded proposals carry benchmark outcomes; ${String(improved)} scored above their then-active policy. Build on the frontier, not on repeats.`)
    return lessons.slice(0, this.maxLessons)
  }
}
