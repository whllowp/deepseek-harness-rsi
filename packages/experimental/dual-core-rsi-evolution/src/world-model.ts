/**
 * World-model seam: the Service Definition `ctx.rsiWorldModel`. Implements
 * RSI-Anything's prediction–reliability protocol and conditional world-model
 * adaptation (arXiv 2610.13912, §2.4): the replay distiller's expectations
 * are predictions, realized benchmark deltas are observations, and a sliding
 * window over pairs attributable to the current policy version classifies
 * reliability as reliable, unreliable, or insufficient. Unreliability with
 * sufficient data triggers a conditional adaptation of the dream's admission
 * policy; a later reliable assessment ends it.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi-evolution/world-model
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { positiveInteger } from './bounds.ts'
import z from '@deepseek-ai/schemastery'
import type { RsiReplayProposal } from './ledger.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Prediction-reliability tracker and conditional-adaptation state. */
    rsiWorldModel: WorldModel
  }
}

/** Reliability classification of the current assessment window. */
export type ReliabilityStatus = 'reliable' | 'unreliable' | 'insufficient'

/** One joined prediction–observation pair. */
export interface PredictionPair {
  readonly fingerprint: string
  readonly predictedDelta: number
  readonly observedDelta: number
}

/** The reliability assessment over one policy version. */
export interface ReliabilityAssessment {
  readonly status: ReliabilityStatus
  /** The joined pairs in the assessment window, oldest first. */
  readonly pairs: readonly PredictionPair[]
  /** Mean absolute error over the window's pairs. */
  readonly mae: number
  /** Whether the conservative dream admission is active for this version. */
  readonly adapted: boolean
}

/** Config of the world-model service. */
export interface WorldModelConfig {
  /** Joined prediction–observation pairs per assessment window (default 5). */
  window?: number
  /** Minimum joined pairs for a non-insufficient assessment (default 3). */
  minPairs?: number
  /** Mean absolute error above which a sufficient window is unreliable (default 0.2). */
  errorThreshold?: number
}

function boundedFraction(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${field} must be a fraction in [0, 1], got ${String(value)}`)
  }
  return value
}

/**
 * Service Definition of the prediction-reliability world model. Reliability
 * follows the version rule: only predictions recorded under the assessed
 * policy version join the window, so proposals distilled under earlier
 * policies never contaminate the current error estimate.
 */
export abstract class WorldModel extends Service {
  constructor(ctx: Context) {
    super(ctx, 'rsiWorldModel')
  }

  /**
   * Assess prediction reliability for one policy version from the replay
   * ledger's joined prediction–observation pairs. An insufficient window
   * (fewer joined pairs than `minPairs`) is reported as insufficient rather
   * than treated as evidence of reliability. An unreliable sufficient window
   * triggers a conditional adaptation; a later reliable window ends it.
   * @param version - the policy version (active generation id) to assess.
   * @returns the classification with its supporting pairs and mean absolute error.
   */
  abstract assess(version: string): Promise<ReliabilityAssessment>

  /**
   * Whether the conservative dream admission is active for one policy
   * version (a conditional adaptation fired and no reliable window has
   * ended it).
   * @param version - the policy version to check.
   * @returns true while the adaptation is active.
   */
  abstract isAdapted(version: string): Promise<boolean>
}

/** Join proposal rows with their recorded predictions into observation pairs. */
function joinPairs(
  proposals: readonly RsiReplayProposal[],
  predictions: ReadonlyMap<string, number>,
): PredictionPair[] {
  const pairs: PredictionPair[] = []
  for (const proposal of proposals) {
    const predicted = predictions.get(proposal.fingerprint)
    if (predicted === undefined || proposal.score === undefined || proposal.baselineScore === undefined) continue
    pairs.push({
      fingerprint: proposal.fingerprint,
      predictedDelta: predicted - proposal.baselineScore,
      observedDelta: proposal.score - proposal.baselineScore,
    })
  }
  return pairs
}

/**
 * Service Provider for `ctx.rsiWorldModel`: joins the replay ledger's
 * proposals with the per-version prediction rows it persists, classifies the
 * sliding window, and tracks the conditional adaptation state. All state
 * derives from the ledger domain, so assessments survive restarts.
 */
export class LedgerWorldModel extends WorldModel {
  static inject = ['rsiEvolutionLedger']

  static Config: z<WorldModelConfig> = z.object({
    window: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(5),
    minPairs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(3),
    errorThreshold: z.number().min(0).max(1).default(0.2),
  })

  private readonly window: number
  private readonly minPairs: number
  private readonly errorThreshold: number

  /**
   * @param ctx - context with `ctx.rsiEvolutionLedger` injected.
   * @param config - window and threshold configuration.
   */
  constructor(ctx: Context, config: WorldModelConfig) {
    const window = positiveInteger(config.window, 5, 'window')
    const minPairs = positiveInteger(config.minPairs, 3, 'minPairs')
    const errorThreshold = boundedFraction(config.errorThreshold, 0.2, 'errorThreshold')
    super(ctx)
    this.window = window
    this.minPairs = minPairs
    this.errorThreshold = errorThreshold
  }

  /** @inheritdoc */
  async assess(version: string): Promise<ReliabilityAssessment> {
    const proposals = await this.ctx.rsiEvolutionLedger.entries()
    const predictedByFingerprint = await this.ctx.rsiEvolutionLedger.predictionsFor(version)
    const joined = joinPairs(proposals, predictedByFingerprint)
    const pairs = joined.slice(-this.window)
    const sufficient = pairs.length >= this.minPairs
    const mae = pairs.length === 0
      ? 0
      : pairs.reduce((sum, pair) => sum + Math.abs(pair.predictedDelta - pair.observedDelta), 0) / pairs.length
    const status: ReliabilityStatus = !sufficient ? 'insufficient' : mae > this.errorThreshold ? 'unreliable' : 'reliable'
    if (status === 'unreliable') {
      await this.ctx.rsiEvolutionLedger.recordAdaptationFor(version, mae, pairs.length)
    }
    if (status === 'reliable') {
      await this.ctx.rsiEvolutionLedger.markAdaptationRecoveredFor(version)
    }
    const adapted = await this.ctx.rsiEvolutionLedger.isAdaptedFor(version)
    return { status, pairs, mae, adapted }
  }

  /** @inheritdoc */
  async isAdapted(version: string): Promise<boolean> {
    return await this.ctx.rsiEvolutionLedger.isAdaptedFor(version)
  }
}
