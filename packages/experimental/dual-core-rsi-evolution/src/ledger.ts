/**
 * Replay ledger seam: the Service Definition `ctx.rsiEvolutionLedger` — the
 * shared proposal/score record the replay distiller dreams over and the
 * Harmony benchmark feeds. Implements Dream-RSI's "discovery history as a
 * replay simulator": every distilled proposal is one recorded node and every
 * benchmark score is its stored observation, so later distillations replay
 * the realized outcomes offline instead of spending new cycles.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi-evolution/ledger
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RsiArtifacts } from '@deepseek-ai/dsh-experimental-dual-core-rsi'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { rsiEvolutionDomain } from './domain.ts'
import type { RsiReplayProposal, RsiTrajectoryRound } from './domain.ts'

export type { RsiReplayProposal }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shared replay ledger correlating distilled proposals with earned scores. */
    rsiEvolutionLedger: RsiEvolutionLedger
  }
}

/** Upper bound for one stored text field (rationale, first guidance line). */
const TEXT_MAX_CHARS = 240

/** Config of the replay ledger service. */
export interface ReplayLedgerConfig {
  /** Maximum retained proposals; the oldest by first distillation is evicted past the cap (default 200). */
  maxProposals?: number
}

function positiveSafeInteger(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer, got ${String(value)}`)
  }
  return value
}

/**
 * Structural fingerprint of one artifact set: a stable JSON encoding of the
 * content, so structurally equal sets join to one ledger row regardless of
 * object identity.
 * @param artifacts - the validated artifact set to fingerprint.
 * @returns the stable fingerprint string.
 */
export function artifactsFingerprint(artifacts: RsiArtifacts): string {
  return JSON.stringify({
    guidance: artifacts.guidance,
    skills: artifacts.skills.map(skill => ({ name: skill.name, description: skill.description, content: skill.content })),
  })
}

function boundedText(text: string): string {
  const trimmed = text.trim()
  return trimmed.slice(0, TEXT_MAX_CHARS)
}

/**
 * Service Definition of the replay ledger. One row per distinct proposal
 * content; benchmark scores join by fingerprint. Ledger writes settle on
 * their own domain and never join a cycle commit.
 */
export abstract class RsiEvolutionLedger extends Service {
  constructor(ctx: Context) {
    super(ctx, 'rsiEvolutionLedger')
  }

  /**
   * Record one distilled proposal, upserting its content row: repeats bump
   * the count and refresh the proposal facts; the score side is untouched.
   * @param artifacts - the proposed artifact set.
   * @param observation - the proposal facts to store.
   * @param observation.rationale - distiller rationale (bounded at rest).
   * @param observation.matchedActive - whether the content equaled the then-active policy.
   * @param observation.baselineScore - active policy's recorded score at distill time, when known.
   * @returns resolution when the row is durable.
   */
  abstract recordProposal(artifacts: RsiArtifacts, observation: {
    rationale: string
    matchedActive: boolean
    baselineScore?: number
  }): Promise<void>

  /**
   * Record the latest benchmark score for one artifact set's content.
   * @param artifacts - the evaluated artifact set.
   * @param score - the earned score.
   * @returns resolution when the row is durable; content never proposed resolves too (no row to join).
   */
  abstract recordScore(artifacts: RsiArtifacts, score: number): Promise<void>

  /**
   * Snapshot every recorded proposal, oldest by first distillation first.
   * @returns the bounded ledger rows.
   */
  abstract entries(): Promise<readonly RsiReplayProposal[]>

  /**
   * Settle one evolution trajectory round.
   * @param round - the settled round record.
   * @returns resolution when the row is durable.
   */
  abstract recordRound(round: RsiTrajectoryRound): Promise<void>

  /**
   * Every recorded trajectory round, oldest first.
   * @returns the bounded round rows.
   */
  abstract trajectoryRounds(): Promise<readonly RsiTrajectoryRound[]>

  /**
   * Record one world-model prediction for a proposal under a policy version.
   * Re-predicting the same content under the same version upserts the row.
   * @param version - the policy version the prediction is attributable to.
   * @param fingerprint - the proposed artifact set's fingerprint.
   * @param predictedDelta - the replay model's expected benchmark delta.
   * @returns resolution when the row is durable.
   */
  abstract recordPrediction(version: string, fingerprint: string, predictedDelta: number): Promise<void>

  /**
   * Every prediction recorded under one policy version, as a fingerprint to
   * predicted-delta map.
   * @param version - the policy version to read.
   * @returns the fingerprint to predicted-delta map.
   */
  abstract predictionsFor(version: string): Promise<ReadonlyMap<string, number>>

  /**
   * Record or refresh the conditional world-model adaptation for a policy
   * version (upsert keyed by version; clears any recovery).
   * @param version - the policy version whose predictions are unreliable.
   * @param mae - the mean absolute error behind the trigger.
   * @param pairs - the joined pairs behind the trigger.
   * @returns resolution when the row is durable.
   */
  abstract recordAdaptationFor(version: string, mae: number, pairs: number): Promise<void>

  /**
   * Mark a version's conditional adaptation as recovered (a reliable window
   * ended it).
   * @param version - the policy version to clear.
   * @returns resolution when the row is durable; versions without an adaptation resolve too.
   */
  abstract markAdaptationRecoveredFor(version: string): Promise<void>

  /**
   * Whether a conditional adaptation is active for one policy version.
   * @param version - the policy version to check.
   * @returns true while an adaptation exists without a recovery.
   */
  abstract isAdaptedFor(version: string): Promise<boolean>
}

function proposalFacts(artifacts: RsiArtifacts, observation: {
  rationale: string
  matchedActive: boolean
  baselineScore?: number
}): Pick<RsiReplayProposal, 'rationale' | 'firstGuidance' | 'guidanceChars' | 'guidanceLines' | 'skillCount' | 'matchedActive' | 'baselineScore'> {
  return {
    rationale: boundedText(observation.rationale),
    firstGuidance: boundedText(artifacts.guidance[0] ?? ''),
    guidanceChars: artifacts.guidance.reduce((sum, line) => sum + line.length, 0),
    guidanceLines: artifacts.guidance.length,
    skillCount: artifacts.skills.length,
    matchedActive: observation.matchedActive,
    ...observation.baselineScore === undefined ? {} : { baselineScore: observation.baselineScore },
  }
}

/**
 * Service Provider for `ctx.rsiEvolutionLedger`: a durable per-content
 * proposal/score join over the `rsi_evolution` storage domain, FIFO-bounded.
 */
export class DomainReplayLedger extends RsiEvolutionLedger {
  static inject = ['storageDomain']

  static Config: z<ReplayLedgerConfig> = z.object({
    maxProposals: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(200),
  })

  private readonly maxProposals: number
  private readonly readyPromise: Promise<void>
  private domain: Domain<typeof rsiEvolutionDomain> | undefined

  /**
   * @param ctx - context with `ctx.storageDomain` injected.
   * @param config - ledger bounds configuration.
   */
  constructor(ctx: Context, config: ReplayLedgerConfig) {
    const maxProposals = positiveSafeInteger(config.maxProposals, 200, 'maxProposals')
    super(ctx)
    this.maxProposals = maxProposals
    this.readyPromise = this.initialize()
    this.readyPromise.catch((error: unknown) => {
      /* v8 ignore next -- the String arm needs a non-Error rejection, which storage-domain never produces */
      this.ctx.logger.error(`rsi evolution ledger initialization failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Await domain readiness; every ledger method waits on this first. */
  async waitReady(): Promise<void> {
    await this.readyPromise
  }

  private async initialize(): Promise<void> {
    const domain = await this.ctx.storageDomain.open(rsiEvolutionDomain)
    this.domain = domain
    this.ctx.effect(() => () => { void domain.close() }, 'rsiEvolutionLedger: domain lifetime')
  }

  /** The opened proposals table; every caller has awaited readiness. */
  private proposalsTable() {
    /* v8 ignore next -- initialize() always assigns before waitReady() resolves */
    if (this.domain === undefined) throw new TypeError('the replay ledger domain is not open')
    return this.domain.table('proposals')
  }

  /** @inheritdoc */
  async recordProposal(artifacts: RsiArtifacts, observation: {
    rationale: string
    matchedActive: boolean
    baselineScore?: number
  }): Promise<void> {
    await this.readyPromise
    const fingerprint = artifactsFingerprint(artifacts)
    const now = Date.now()
    const table = this.proposalsTable()
    const existing = table.get(fingerprint)
    const facts = proposalFacts(artifacts, observation)
    if (existing !== undefined) {
      await table.put(fingerprint, {
        ...existing,
        lastDistilledAt: now,
        distilledCount: existing.distilledCount + 1,
        ...facts,
      })
      return
    }
    const rows = [...table.entries()]
    const doomed = rows.slice(0, Math.max(0, rows.length + 1 - this.maxProposals))
    for (const [key] of doomed) await table.delete(key)
    await table.put(fingerprint, {
      fingerprint,
      firstDistilledAt: now,
      lastDistilledAt: now,
      distilledCount: 1,
      ...facts,
    })
  }

  /** @inheritdoc */
  async recordScore(artifacts: RsiArtifacts, score: number): Promise<void> {
    await this.readyPromise
    const existing = this.proposalsTable().get(artifactsFingerprint(artifacts))
    // Content never proposed (the initial generation's first evaluation) has
    // no proposal row; the score side only joins distilled proposals.
    if (existing === undefined) return
    await this.proposalsTable().put(artifactsFingerprint(artifacts), { ...existing, score, scoredAt: Date.now() })
  }

  /** @inheritdoc */
  async entries(): Promise<readonly RsiReplayProposal[]> {
    await this.readyPromise
    return [...this.proposalsTable().entries()].map(([, proposal]) => proposal)
      .sort((a, b) => a.firstDistilledAt - b.firstDistilledAt)
  }

  /** The opened trajectory table; every caller has awaited readiness. */
  private trajectoryTable() {
    /* v8 ignore next -- initialize() always assigns before waitReady() resolves */
    if (this.domain === undefined) throw new TypeError('the replay ledger domain is not open')
    return this.domain.table('trajectory')
  }

  /** The opened prediction table; every caller has awaited readiness. */
  private predictionsTable() {
    /* v8 ignore next -- initialize() always assigns before waitReady() resolves */
    if (this.domain === undefined) throw new TypeError('the replay ledger domain is not open')
    return this.domain.table('predictions')
  }

  /** The opened adaptation table; every caller has awaited readiness. */
  private adaptationsTable() {
    /* v8 ignore next -- initialize() always assigns before waitReady() resolves */
    if (this.domain === undefined) throw new TypeError('the replay ledger domain is not open')
    return this.domain.table('adaptations')
  }

  /** @inheritdoc */
  async recordRound(round: RsiTrajectoryRound): Promise<void> {
    await this.readyPromise
    await this.trajectoryTable().put(String(round.round), round)
  }

  /** @inheritdoc */
  async trajectoryRounds(): Promise<readonly RsiTrajectoryRound[]> {
    await this.readyPromise
    return [...this.trajectoryTable().entries()].map(([, round]) => round)
      .sort((a, b) => a.round - b.round)
  }

  /** @inheritdoc */
  async recordPrediction(version: string, fingerprint: string, predictedDelta: number): Promise<void> {
    await this.readyPromise
    await this.predictionsTable().put(`${version}::${fingerprint}`, {
      fingerprint,
      version,
      predictedDelta,
      predictedAt: Date.now(),
    })
  }

  /** @inheritdoc */
  async predictionsFor(version: string): Promise<ReadonlyMap<string, number>> {
    await this.readyPromise
    const map = new Map<string, number>()
    for (const [, row] of this.predictionsTable().entries()) {
      if (row.version !== version) continue
      map.set(row.fingerprint, row.predictedDelta)
    }
    return map
  }

  /** @inheritdoc */
  async recordAdaptationFor(version: string, mae: number, pairs: number): Promise<void> {
    await this.readyPromise
    const adaptedAt = Date.now()
    await this.adaptationsTable().put(version, { version, mae, pairs, adaptedAt })
  }

  /** @inheritdoc */
  async markAdaptationRecoveredFor(version: string): Promise<void> {
    await this.readyPromise
    const existing = this.adaptationsTable().get(version)
    if (existing === undefined) return
    await this.adaptationsTable().put(version, { ...existing, recoveredAt: Date.now() })
  }

  /** @inheritdoc */
  async isAdaptedFor(version: string): Promise<boolean> {
    await this.readyPromise
    const existing = this.adaptationsTable().get(version)
    return existing !== undefined && existing.recoveredAt === undefined
  }
}
