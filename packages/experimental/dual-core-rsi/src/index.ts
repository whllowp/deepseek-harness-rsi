/**
 * Dual-core recursive self-improvement over the live harness: the user core
 * serves interactive agents, the daemon core distills the user core's recent
 * sessions into bounded policy artifacts on a default-on schedule, and a
 * candidate that beats the benchmark gate waits as a pending merge candidate
 * offered to the human when the session exits. Merging replaces the active
 * policy, archives the replaced surface for rollback, and records the adopted
 * generation in a dedicated local git ledger.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAbsolute } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { JobHandle, JobId } from '@deepseek-ai/dsh-jobs'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assembleDigest, countUnseenSessions, rsiDigestProjectionDefinition } from './digest.ts'
import { dualCoreRsiDomain, RSI_STATE_KEY } from './domain.ts'
import type { RsiStateRecord } from './domain.ts'
import { RsiArchiveId, RsiCycleId, RsiGenerationId, RsiIncidentId } from './branding.ts'
import { RsiLedger } from './ledger.ts'
import type { RsiLedgerOutcome } from './ledger.ts'
import { applyArtifacts } from './policy.ts'
import {
  RSI_CYCLE_COST_NOTE, renderCycleRecord, renderDeclineResult, renderExitSummary, renderHistory,
  renderMergeResult, renderRollback, renderStatus,
} from './render.ts'
import type {
  RsiArchiveEntry, RsiArtifactBudgets, RsiCycleRecord, RsiCycleTrigger, RsiGeneration,
  RsiIncidentRecord, RsiMergeDecision, RsiPendingCandidate, RsiStatusView,
} from './types.ts'

export type {
  RsiArchiveEntry, RsiArtifactBudgets, RsiArtifacts, RsiBenchmarkCaseResult,
  RsiBenchmarkReport, RsiBenchmarkRequest, RsiCycleOutcome, RsiCycleRecord,
  RsiCycleTrigger, RsiDistillInput, RsiDistillOutput, RsiGeneration,
  RsiGenerationOrigin, RsiIncidentKind, RsiIncidentRecord,
  RsiIncidentRecovery, RsiMergeDecision, RsiPendingCandidate, RsiSessionDigest,
  RsiSessionDigestEntry, RsiSkillArtifact, RsiStatusView,
} from './types.ts'
export { RsiArchiveId, RsiCycleId, RsiGenerationId, RsiIncidentId } from './branding.ts'
export { decodeArtifacts, renderPolicySection, applyArtifacts, formatPercent } from './policy.ts'
export { assembleDigest } from './digest.ts'
export { dualCoreRsiDomain, RSI_STATE_KEY } from './domain.ts'
export { RsiDistiller, SubagentRsiDistiller } from './distiller.ts'
export type { RsiDistillOptions, SubagentDistillerConfig } from './distiller.ts'
export { RsiBenchmark, FixtureRsiBenchmark, resolveFixtureCases } from './benchmark.ts'
export type { FixtureBenchmarkConfig, FixtureCase } from './benchmark.ts'
export { RsiLedger } from './ledger.ts'
export type { RsiLedgerEntry, RsiLedgerOutcome, RsiLedgerReason } from './ledger.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'dual-core-rsi': 'dual-core-rsi'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Dual-core RSI controller: scheduled cycles, the merge gate, archives, the git ledger, and rollback. */
    dualCoreRsi: DualCoreRsiService
  }
}

/** Stable failure codes for dual-core RSI operations. */
export type RsiErrorCode = 'cycle-in-progress' | 'no-anchor-agent' | 'unknown-archive' | 'no-pending-candidate'

/** Typed dual-core RSI failure carrying a stable code. */
export class RsiError extends Error {
  /** Stable machine-readable code naming the failed precondition. */
  readonly code: RsiErrorCode

  /**
   * @param code - stable failure code.
   * @param message - actionable human-readable report.
   */
  constructor(code: RsiErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** Plugin configuration. Every deployment-varying choice is a validated field. */
export interface Config {
  /** Benchmark improvement fraction that qualifies a candidate as pending merge (default `0.05` is +5%). */
  threshold?: number
  /** Maximum guidance lines in one artifact set (default 16). */
  maxGuidanceLines?: number
  /** Maximum characters in one guidance line (default 400). */
  maxGuidanceLineChars?: number
  /** Maximum total guidance characters (default 4000). */
  maxGuidanceChars?: number
  /** Maximum distilled skills in one artifact set (default 8). */
  maxSkills?: number
  /** Maximum skill description characters (default 300). */
  maxSkillDescriptionChars?: number
  /** Maximum skill content characters (default 8000). */
  maxSkillContentChars?: number
  /** Maximum sessions in one distillation digest (default 8). */
  digestMaxSessions?: number
  /** Maximum extracted digest characters per session (default 4000). */
  digestMaxCharsPerSession?: number
  /** How long `/rsi run` waits for the cycle before reporting background continuation, in milliseconds (default 120000). */
  runWaitMs?: number
  /** Whether recent closed sessions join the digest through `ctx.sessionQuery` (default true). */
  digestIncludeStoredSessions?: boolean
  /** Whether the scheduled daemon driver runs cycles without a manual command (default true). */
  daemonEnabled?: boolean
  /** Milliseconds between scheduled daemon ticks (default 600000). */
  daemonIntervalMs?: number
  /** Failed-attempt retries per scheduled daemon round beyond the first attempt (default 2, maximum 10). */
  daemonMaxRetries?: number
  /** Backoff before a retried scheduled attempt, in milliseconds (default 30000). */
  daemonRetryBackoffMs?: number
  /** Timebox for one scheduled daemon cycle attempt, in milliseconds (default 600000). */
  cycleTimeoutMs?: number
  /** How long the exit merge consult waits for the user's answer, in milliseconds (default 300000). */
  consultTimeoutMs?: number
  /** Directory of the local git ledger recording merged and rolled-back policies (default `~/.dsh/dual-core-rsi-ledger`). */
  ledgerDir?: string
}

/** Default swap threshold when configuration omits it. */
export const DEFAULT_SWAP_THRESHOLD = 0.05

/** Default bounded wait of `/rsi run` before reporting background continuation. */
export const DEFAULT_RUN_WAIT_MS = 120_000

/** Default scheduled daemon tick interval. */
export const DEFAULT_DAEMON_INTERVAL_MS = 600_000

/** Default failed-attempt retries per scheduled round beyond the first attempt. */
export const DEFAULT_DAEMON_RETRIES = 2

/** Default backoff before a retried scheduled attempt. */
export const DEFAULT_DAEMON_RETRY_BACKOFF_MS = 30_000

/** Default timebox for one scheduled daemon cycle attempt. */
export const DEFAULT_CYCLE_TIMEOUT_MS = 600_000

/** Default answer window for the exit merge consult. */
export const DEFAULT_CONSULT_TIMEOUT_MS = 300_000

/** Ledger directory name under the harness home. */
export const DEFAULT_LEDGER_DIR_NAME = 'dual-core-rsi-ledger'

/** Schemastery configuration. */
export const Config: z<Config> = z.object({
  threshold: z.number().min(0).max(1).default(0.05),
  maxGuidanceLines: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16),
  maxGuidanceLineChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(400),
  maxGuidanceChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(4000),
  maxSkills: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(8),
  maxSkillDescriptionChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(300),
  maxSkillContentChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8000),
  digestMaxSessions: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8),
  digestMaxCharsPerSession: z.number().step(1).max(Number.MAX_SAFE_INTEGER).default(4000),
  runWaitMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_RUN_WAIT_MS),
  digestIncludeStoredSessions: z.boolean().default(true),
  daemonEnabled: z.boolean().default(true),
  daemonIntervalMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_DAEMON_INTERVAL_MS),
  daemonMaxRetries: z.number().step(1).min(0).max(10).default(DEFAULT_DAEMON_RETRIES),
  daemonRetryBackoffMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_DAEMON_RETRY_BACKOFF_MS),
  cycleTimeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_CYCLE_TIMEOUT_MS),
  consultTimeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_CONSULT_TIMEOUT_MS),
  ledgerDir: z.string().default(dshHomePath(DEFAULT_LEDGER_DIR_NAME)),
})

/** Fully resolved configuration after defaulting and validation. */
export interface ResolvedConfig extends RsiArtifactBudgets {
  readonly threshold: number
  readonly digestMaxSessions: number
  readonly digestMaxCharsPerSession: number
  readonly runWaitMs: number
  readonly digestIncludeStoredSessions: boolean
  readonly daemonEnabled: boolean
  readonly daemonIntervalMs: number
  readonly daemonMaxRetries: number
  readonly daemonRetryBackoffMs: number
  readonly cycleTimeoutMs: number
  readonly consultTimeoutMs: number
  readonly ledgerDir: string
}

function positiveSafeInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${label} must be a positive safe integer`)
  }
  return resolved
}

function boundedRetries(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < 0 || resolved > 10) {
    throw new TypeError(`${label} must be a safe integer in [0, 10]`)
  }
  return resolved
}

function normalizedDirectory(value: string | undefined, fallback: string, label: string): string {
  const resolved = value ?? fallback
  if (resolved.length === 0 || resolved !== resolved.trim() || !isAbsolute(resolved)) {
    throw new TypeError(`${label} must be a non-empty normalized absolute directory path`)
  }
  return resolved
}

/**
 * Validate defaults even when a caller mounts the plugin without Loader normalization.
 * @param config - raw plugin configuration.
 * @returns the fully resolved configuration.
 * @throws TypeError naming the first invalid field.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const threshold = config.threshold ?? DEFAULT_SWAP_THRESHOLD
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new TypeError('threshold must be a fraction in (0, 1]')
  }
  return {
    threshold,
    maxGuidanceLines: positiveSafeInteger(config.maxGuidanceLines, 16, 'maxGuidanceLines'),
    maxGuidanceLineChars: positiveSafeInteger(config.maxGuidanceLineChars, 400, 'maxGuidanceLineChars'),
    maxGuidanceChars: positiveSafeInteger(config.maxGuidanceChars, 4000, 'maxGuidanceChars'),
    maxSkills: positiveSafeInteger(config.maxSkills, 8, 'maxSkills'),
    maxSkillDescriptionChars: positiveSafeInteger(config.maxSkillDescriptionChars, 300, 'maxSkillDescriptionChars'),
    maxSkillContentChars: positiveSafeInteger(config.maxSkillContentChars, 8000, 'maxSkillContentChars'),
    digestMaxSessions: positiveSafeInteger(config.digestMaxSessions, 8, 'digestMaxSessions'),
    digestMaxCharsPerSession: positiveSafeInteger(config.digestMaxCharsPerSession, 4000, 'digestMaxCharsPerSession'),
    runWaitMs: positiveSafeInteger(config.runWaitMs, DEFAULT_RUN_WAIT_MS, 'runWaitMs'),
    digestIncludeStoredSessions: config.digestIncludeStoredSessions ?? true,
    daemonEnabled: config.daemonEnabled ?? true,
    daemonIntervalMs: positiveSafeInteger(config.daemonIntervalMs, DEFAULT_DAEMON_INTERVAL_MS, 'daemonIntervalMs'),
    daemonMaxRetries: boundedRetries(config.daemonMaxRetries, DEFAULT_DAEMON_RETRIES, 'daemonMaxRetries'),
    daemonRetryBackoffMs: positiveSafeInteger(config.daemonRetryBackoffMs, DEFAULT_DAEMON_RETRY_BACKOFF_MS, 'daemonRetryBackoffMs'),
    cycleTimeoutMs: positiveSafeInteger(config.cycleTimeoutMs, DEFAULT_CYCLE_TIMEOUT_MS, 'cycleTimeoutMs'),
    consultTimeoutMs: positiveSafeInteger(config.consultTimeoutMs, DEFAULT_CONSULT_TIMEOUT_MS, 'consultTimeoutMs'),
    ledgerDir: normalizedDirectory(config.ledgerDir, dshHomePath(DEFAULT_LEDGER_DIR_NAME), 'ledgerDir'),
  }
}

const USAGE = 'Usage: /rsi [status|run|merge|decline|summary|history|rollback [<archive id>]]'

/** Where a human merge or decline decision came from. */
export type RsiDecisionSource = 'command' | 'consult'

/** Everything one settled merge decision produced. */
export interface RsiMergeResult {
  /** Generation that became the active policy. */
  readonly generation: RsiGeneration
  /** Cycle record that produced the merged generation. */
  readonly cycle: RsiCycleRecord
  /** Archive entry created for the replaced policy. */
  readonly archived: RsiArchiveEntry
  /** Whether the local git ledger recorded the adopted generation. */
  readonly ledger: RsiLedgerOutcome
  readonly source: RsiDecisionSource
}

/** Everything one settled decline decision produced. */
export interface RsiDeclineResult {
  /** Cycle record that carried the declined candidate. */
  readonly cycle: RsiCycleRecord
  readonly source: RsiDecisionSource
}

/** Read one tracked agent's applied-artifacts disposer. */
interface AppliedEntry {
  readonly agent: Agent
  dispose(): void
}

/** Outcome of one scheduled daemon round. */
type ScheduledRoundOutcome =
  | { readonly status: 'completed'; readonly record: RsiCycleRecord }
  | { readonly status: 'failed'; readonly detail: string }
  | { readonly status: 'killed'; readonly detail: string }

/**
 * The dual-core RSI controller. Owns the durable generation/archive/cycle
 * domain, applies the active generation's artifacts to every live agent
 * scope, runs scheduled daemon cycles with per-attempt timeboxing and retry
 * self-repair, parks gate-passing candidates as pending merge decisions,
 * consults the human when the session exits, executes merge and decline, and
 * records adopted generations in the local git ledger. Durable writes inside
 * one operation settle through one final state-pointer write, so an
 * interrupted operation leaves the previous pointer with at most orphan
 * records.
 */
export class DualCoreRsiService extends Service {
  static inject = ['agents', 'sessions', 'sessionProjections', 'systemPrompt', 'storageDomain', 'rsiDistiller', 'rsiBenchmark', 'tools', 'commands', 'jobs', 'subprocess']

  static Config: z<Config> = Config

  private readonly resolved: ResolvedConfig
  private readonly readyPromise: Promise<void>
  private readonly ledger: RsiLedger
  private domain!: Domain<typeof dualCoreRsiDomain>
  private state!: RsiStateRecord
  private readonly applied = new Map<SessionId, AppliedEntry>()
  private cycleRunning = false
  private daemonTimer: ReturnType<typeof setTimeout> | undefined
  private daemonDisposed = false
  private consultRunning = false

  /**
   * @param ctx - context with every injected seam present.
   * @param config - validated plugin configuration.
   */
  constructor(ctx: Context, config: Config) {
    const resolved = resolveConfig(config)
    super(ctx, 'dualCoreRsi')
    ctx.sessionProjections.register(rsiDigestProjectionDefinition)
    this.resolved = resolved
    this.ledger = new RsiLedger(ctx, resolved.ledgerDir)
    this.readyPromise = this.initialize()
    // Surface an initialization failure immediately; later callers still see the rejection.
    this.readyPromise.catch((error: unknown) => {
      /* v8 ignore next -- the non-Error arm needs a string rejection, which storage and validation never produce */
      ctx.logger.error(`dual-core RSI initialization failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    ctx.effect(() => () => {
      this.daemonDisposed = true
      if (this.daemonTimer !== undefined) {
        clearTimeout(this.daemonTimer)
        this.daemonTimer = undefined
      }
    }, 'dualCoreRsi: daemon timer')
    ctx.on('agent/created', async ({ agent }) => {
      await this.readyPromise
      this.attachNow(agent)
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const entry = this.applied.get(agent.id)
      /* v8 ignore next 3 -- an agent disposed before attach only occurs between load and domain readiness */
      if (entry !== undefined) {
        entry.dispose()
        this.applied.delete(agent.id)
      }
      this.maybeConsultOnExit()
    })
    ctx.effect(() => () => {
      for (const entry of this.applied.values()) entry.dispose()
      this.applied.clear()
    })
    this.registerTools()
    this.registerCommand()
  }

  /** Open the domain, seed the initial cores when absent, attach live agents, arm the daemon. */
  private async initialize(): Promise<void> {
    const domain = await this.ctx.storageDomain.open(dualCoreRsiDomain)
    try {
      this.ctx.effect(() => async () => { await domain.close() })
    } catch (error) {
      /* v8 ignore start -- only reachable when plugin teardown rejects the effect registration itself */
      await domain.close()
      throw error
      /* v8 ignore stop */
    }
    this.domain = domain
    const stateTable = domain.table('state')
    const stored = stateTable.get(RSI_STATE_KEY)
    if (stored === undefined) {
      const createdAt = Date.now()
      const initial: RsiGeneration = {
        id: RsiGenerationId('gen-1'),
        origin: 'initial',
        parent: null,
        createdAt,
        artifacts: { guidance: [], skills: [] },
      }
      const daemon: RsiGeneration = { ...initial, id: RsiGenerationId('gen-2'), parent: initial.id }
      await domain.table('generations').put(initial.id, initial)
      await domain.table('generations').put(daemon.id, daemon)
      this.state = {
        activeId: initial.id,
        daemonId: daemon.id,
        cycleCounter: 0,
        generationCounter: 2,
        archiveCounter: 0,
        knowledgeCutoffAt: createdAt,
      }
      await stateTable.put(RSI_STATE_KEY, this.state)
    } else {
      this.state = stored
    }
    this.requireGeneration(this.state.activeId, 'active')
    this.requireGeneration(this.state.daemonId, 'daemon')
    for (const agent of this.ctx.agents.list()) this.attachNow(agent)
    this.armDaemon()
  }

  /** Resolve after the domain is loaded, live agents are attached, and the daemon is armed. */
  async waitReady(): Promise<void> {
    await this.readyPromise
  }

  /** Read one generation or fail loud when durable state points at a missing record. */
  private requireGeneration(id: RsiGenerationId, role: string): RsiGeneration {
    const generation = this.domain.table('generations').get(id)
    if (generation === undefined) {
      throw new Error(`dual-core RSI ${role} generation "${id}" is missing from the storage domain`)
    }
    return generation
  }

  /** Current user-core generation. */
  private activeGeneration(): RsiGeneration {
    return this.requireGeneration(this.state.activeId, 'active')
  }

  /** Current daemon-core generation. */
  private daemonGeneration(): RsiGeneration {
    return this.requireGeneration(this.state.daemonId, 'daemon')
  }

  /** The pending merge candidate with its producing cycle record, when one waits. */
  private readPending(): RsiPendingCandidate | undefined {
    const id = this.state.pendingCandidateId
    if (id === undefined) return undefined
    const generation = this.requireGeneration(id, 'pending')
    let cycle: RsiCycleRecord | undefined
    for (const [, record] of this.domain.table('cycles').entries()) {
      if (record.candidateId === id) cycle = record
    }
    /* v8 ignore next -- every pending candidate was written together with its cycle record */
    if (cycle === undefined) {
      throw new Error(`dual-core RSI pending candidate "${id}" has no cycle record`)
    }
    return { generation, cycle }
  }

  /** Recorded incidents settled after the last merge or decline decision, newest first. */
  private incidentsSinceLastDecision(): RsiIncidentRecord[] {
    const since = this.state.lastDecisionAt ?? 0
    return [...this.domain.table('incidents').entries()]
      .filter(([, record]) => record.settledAt > since)
      .sort(([, a], [, b]) => suffixRank(b.id) - suffixRank(a.id))
      .map(([, record]) => record)
  }

  /** Advance the generation counter and mint the next generation id. */
  private mintGenerationId(): RsiGenerationId {
    this.state = { ...this.state, generationCounter: this.state.generationCounter + 1 }
    return RsiGenerationId(`gen-${this.state.generationCounter}`)
  }

  /** Apply the active generation's artifacts to one agent scope; only called with the domain ready. */
  private attachNow(agent: Agent): void {
    /* v8 ignore next -- duplicate agent/created delivery for one id is a registry invariant violation */
    if (this.applied.has(agent.id)) return
    const dispose = applyArtifacts(agent.ctx, this.activeGeneration().artifacts, this.ctx.systemPrompt.getSectionOrder('RSI_DISTILLED_POLICY'))
    this.applied.set(agent.id, { agent, dispose })
  }

  /** Re-apply the active generation's artifacts to every attached agent. */
  private reapplyActive(): void {
    const order = this.ctx.systemPrompt.getSectionOrder('RSI_DISTILLED_POLICY')
    for (const [id, entry] of [...this.applied.entries()]) {
      entry.dispose()
      const dispose = applyArtifacts(entry.agent.ctx, this.activeGeneration().artifacts, order)
      this.applied.set(id, { agent: entry.agent, dispose })
    }
  }

  /** Score one generation, persisting the report onto its record. */
  private async evaluate(generation: RsiGeneration, signal: AbortSignal): Promise<RsiGeneration> {
    const report = await this.ctx.rsiBenchmark.evaluate({ generation }, signal)
    const scored: RsiGeneration = { ...generation, benchmark: report }
    await this.domain.table('generations').put(scored.id, scored)
    return scored
  }

  /** Persist a new daemon-seed copy of one generation and point the daemon core at it. */
  private async seedDaemonFrom(source: RsiGeneration): Promise<RsiGeneration> {
    const seeded: RsiGeneration = {
      id: this.mintGenerationId(),
      origin: 'initial',
      parent: source.id,
      createdAt: Date.now(),
      artifacts: source.artifacts,
      // Every seeded source carries benchmark evidence; the spread keeps the field optional for future callers.
      /* v8 ignore next -- public flows always seed from evaluated generations */
      ...source.benchmark === undefined ? {} : { benchmark: source.benchmark },
    }
    await this.domain.table('generations').put(seeded.id, seeded)
    this.state = { ...this.state, daemonId: seeded.id }
    return seeded
  }

  /** Persist the mutated in-memory state as the operation's commit point. */
  private async commitState(): Promise<void> {
    await this.domain.table('state').put(RSI_STATE_KEY, this.state)
  }

  /**
   * Run one daemon distillation cycle: digest the user core's recent
   * sessions, distill a candidate artifact set, benchmark both cores, and
   * past the configured improvement threshold park the candidate as the
   * pending merge candidate offered to the human. All durable writes happen
   * after successful evaluation; the final state write is the commit point,
   * so an interrupted cycle leaves the previous cores in place.
   * @param trigger - what started the cycle.
   * @param signal - cancellation signal; aborting fails the cycle without state changes.
   * @returns the settled cycle record.
   * @throws RsiError when a cycle is already running or no live agent can anchor distillation.
   */
  async runCycle(trigger: RsiCycleTrigger, signal: AbortSignal): Promise<RsiCycleRecord> {
    await this.waitReady()
    if (this.cycleRunning) {
      throw new RsiError('cycle-in-progress', 'a dual-core RSI cycle is already running; wait for it to settle before starting another')
    }
    const anchor = this.ctx.agents.currentInitiator() ?? this.ctx.agents.list().at(-1)
    if (anchor === undefined) {
      throw new RsiError('no-anchor-agent', 'daemon distillation needs a live agent to anchor its child; open a user session first')
    }
    this.cycleRunning = true
    try {
      const startedAt = Date.now()
      const active = await this.ensureBenchmark(this.activeGeneration(), signal)
      const daemon = this.daemonGeneration()
      const digest = await assembleDigest(this.ctx, {
        maxSessions: this.resolved.digestMaxSessions,
        maxCharsPerSession: this.resolved.digestMaxCharsPerSession,
        includeStored: this.resolved.digestIncludeStoredSessions,
      })
      const output = await this.ctx.rsiDistiller.distill(
        { active, daemon, digest, budgets: this.resolved },
        { parent: anchor, signal },
      )
      const candidate = await this.evaluate({
        id: this.mintGenerationId(),
        origin: 'distilled',
        parent: daemon.id,
        createdAt: Date.now(),
        artifacts: output.artifacts,
      }, signal)
      const baselineScore = this.requiredScore(active)
      const candidateScore = this.requiredScore(candidate)
      const improvement = candidateScore - baselineScore
      let outcome: RsiCycleRecord['outcome'] = 'retained'
      if (improvement > this.resolved.threshold) {
        const currentPending = this.state.pendingCandidateId === undefined
          ? undefined
          : this.requireGeneration(this.state.pendingCandidateId, 'pending')
        const pendingScore = currentPending?.benchmark?.score ?? 0
        if (currentPending === undefined || candidateScore >= pendingScore) {
          this.state = { ...this.state, pendingCandidateId: candidate.id }
          outcome = 'pending'
        }
      }
      if (daemon.benchmark === undefined || candidateScore >= daemon.benchmark.score) {
        this.state = { ...this.state, daemonId: candidate.id }
      }
      // Every settled cycle, pending or retained, digests all live sessions
      // up to this point: this is the knowledge cutoff.
      this.state = { ...this.state, knowledgeCutoffAt: Date.now() }
      const record: RsiCycleRecord = {
        id: RsiCycleId(String(this.state.cycleCounter + 1)),
        trigger,
        startedAt,
        settledAt: Date.now(),
        outcome,
        baselineScore,
        candidateScore,
        improvement,
        threshold: this.resolved.threshold,
        candidateId: candidate.id,
        rationale: output.rationale,
      }
      this.state = { ...this.state, cycleCounter: this.state.cycleCounter + 1 }
      await this.domain.table('cycles').put(record.id, record)
      await this.commitState()
      return record
    } finally {
      this.cycleRunning = false
    }
  }

  /** Evaluate a generation without a benchmark report and persist the baseline. */
  private async ensureBenchmark(generation: RsiGeneration, signal: AbortSignal): Promise<RsiGeneration> {
    return generation.benchmark === undefined ? this.evaluate(generation, signal) : generation
  }

  /** Read a freshly evaluated generation's score, failing loud on a broken invariant. */
  private requiredScore(generation: RsiGeneration): number {
    /* v8 ignore next 2 -- evaluate() always attaches a report before this read */
    if (generation.benchmark === undefined) {
      throw new TypeError(`generation "${generation.id}" carries no benchmark report after evaluation`)
    }
    return generation.benchmark.score
  }

  /** Archive one replaced generation as a rollback target. */
  private async archive(replaced: RsiGeneration, supersededBy: RsiGenerationId, reason: RsiArchiveEntry['reason']): Promise<RsiArchiveEntry> {
    this.state = { ...this.state, archiveCounter: this.state.archiveCounter + 1 }
    const entry: RsiArchiveEntry = {
      id: RsiArchiveId(`arc-${this.state.archiveCounter}`),
      archivedAt: Date.now(),
      generation: replaced,
      supersededBy,
      reason,
    }
    await this.domain.table('archives').put(entry.id, entry)
    return entry
  }

  /** Stamp the pending candidate's cycle record with the human decision. */
  private async decideCycle(cycle: RsiCycleRecord, decision: RsiMergeDecision): Promise<void> {
    await this.domain.table('cycles').put(cycle.id, { ...cycle, decision, decidedAt: Date.now() })
  }

  /**
   * Merge the pending candidate: replace the active policy, archive the
   * replaced surface, keep the better daemon lineage, re-apply artifacts, and
   * record the adopted generation in the local git ledger.
   * @param source - where the human decision came from.
   * @returns the settled merge result, including the ledger outcome.
   * @throws RsiError when no candidate is pending.
   */
  async mergePending(source: RsiDecisionSource): Promise<RsiMergeResult> {
    await this.waitReady()
    const pending = this.readPending()
    if (pending === undefined) {
      throw new RsiError('no-pending-candidate', 'no dual-core RSI candidate is waiting for a merge decision; run a cycle first')
    }
    const archived = await this.archive(this.activeGeneration(), pending.generation.id, 'swap')
    this.state = { ...this.state, activeId: pending.generation.id, pendingCandidateId: undefined, lastDecisionAt: Date.now() }
    const daemon = this.daemonGeneration()
    const pendingScore = this.requiredScore(pending.generation)
    if (daemon.benchmark === undefined || pendingScore >= daemon.benchmark.score) {
      await this.seedDaemonFrom(pending.generation)
    }
    this.reapplyActive()
    await this.decideCycle(pending.cycle, 'merged')
    await this.commitState()
    const ledger = await this.ledger.record({
      reason: 'merge',
      generation: pending.generation,
      cycleId: pending.cycle.id,
      score: pendingScore,
      summary: pending.cycle.rationale,
    }, new AbortController().signal)
    return { generation: pending.generation, cycle: pending.cycle, archived, ledger, source }
  }

  /**
   * Decline the pending candidate: keep the active policy and clear the
   * pending decision; the daemon lineage already kept its better score.
   * @param source - where the human decision came from.
   * @returns the settled decline result.
   * @throws RsiError when no candidate is pending.
   */
  async declinePending(source: RsiDecisionSource): Promise<RsiDeclineResult> {
    await this.waitReady()
    const pending = this.readPending()
    if (pending === undefined) {
      throw new RsiError('no-pending-candidate', 'no dual-core RSI candidate is waiting for a merge decision; run a cycle first')
    }
    this.state = { ...this.state, pendingCandidateId: undefined, lastDecisionAt: Date.now() }
    await this.decideCycle(pending.cycle, 'declined')
    await this.commitState()
    return { cycle: pending.cycle, source }
  }

  /**
   * Roll the user core back to one archived generation. The replaced
   * generation is itself archived and recorded in the git ledger, so a
   * rollback is reversible by another rollback. A pending candidate does not
   * survive a rollback: the human chose the restored policy over it.
   * @param archiveId - archive to restore; omission restores the newest archive.
   * @returns the restored generation, the newly created archive entry, and the ledger outcome.
   * @throws RsiError when the archive does not exist.
   */
  async rollback(archiveId?: RsiArchiveId): Promise<{ restored: RsiGeneration; archived: RsiArchiveEntry; ledger: RsiLedgerOutcome }> {
    await this.waitReady()
    const archives = this.domain.table('archives')
    let target = archiveId === undefined ? undefined : archives.get(archiveId)
    if (target === undefined && archiveId === undefined) {
      const newest = [...archives.keys()].sort((a, b) => suffixRank(RsiArchiveId(b)) - suffixRank(RsiArchiveId(a))).at(0)
      target = newest === undefined ? undefined : archives.get(RsiArchiveId(newest))
    }
    if (target === undefined) {
      throw new RsiError('unknown-archive', archiveId === undefined
        ? 'no dual-core RSI archive exists yet; nothing to roll back to'
        : `dual-core RSI archive "${archiveId}" does not exist`)
    }
    const restored = target.generation
    const pending = this.readPending()
    await this.domain.table('generations').put(restored.id, restored)
    const archived = await this.archive(this.activeGeneration(), restored.id, 'rollback')
    this.state = pending === undefined
      ? { ...this.state, activeId: restored.id }
      : { ...this.state, activeId: restored.id, pendingCandidateId: undefined, lastDecisionAt: Date.now() }
    if (pending !== undefined) await this.decideCycle(pending.cycle, 'declined')
    await this.seedDaemonFrom(restored)
    this.reapplyActive()
    await this.commitState()
    const ledger = await this.ledger.record({
      reason: 'rollback',
      generation: restored,
      score: restored.benchmark?.score,
      summary: `restored by /rsi rollback${pending === undefined ? '' : `; declined pending ${pending.generation.id}`}`,
    }, new AbortController().signal)
    return { restored, archived, ledger }
  }

  /**
   * Project the current dual-core state for tools and the command.
   * @returns the status view.
   */
  async status(): Promise<RsiStatusView> {
    await this.waitReady()
    const newest = [...this.domain.table('cycles').keys()].sort((a, b) => Number(b) - Number(a)).at(0)
    const incidents = [...this.domain.table('incidents').entries()]
      .map(([, record]) => record)
      .sort((a, b) => suffixRank(b.id) - suffixRank(a.id))
      .slice(0, 5)
    const pending = this.readPending()
    return {
      active: this.activeGeneration(),
      daemon: this.daemonGeneration(),
      threshold: this.resolved.threshold,
      daemonEnabled: this.resolved.daemonEnabled,
      ...newest === undefined ? {} : { lastCycle: this.domain.table('cycles').get(RsiCycleId(newest)) },
      ...pending === undefined ? {} : { pending },
      cycleRunning: this.cycleRunning,
      archiveCount: this.domain.table('archives').size,
      incidents,
      ...this.state.knowledgeCutoffAt === undefined ? {} : { knowledgeCutoffAt: this.state.knowledgeCutoffAt },
      unseenSessionCount: this.state.knowledgeCutoffAt === undefined
        ? 0
        : countUnseenSessions(this.ctx, this.state.knowledgeCutoffAt),
    }
  }

  /**
   * List recent cycles, archives, and self-repair incidents, newest first.
   * @param limit - maximum entries of each kind (default 20).
   * @returns bounded history.
   */
  async history(limit: number = 20): Promise<{ cycles: RsiCycleRecord[]; archives: RsiArchiveEntry[]; incidents: RsiIncidentRecord[] }> {
    await this.waitReady()
    const cycles = [...this.domain.table('cycles').entries()]
      .sort(([a], [b]) => Number(b) - Number(a))
      .slice(0, limit)
      .map(([, record]) => record)
    const archives = [...this.domain.table('archives').entries()]
      .sort(([a], [b]) => suffixRank(b) - suffixRank(a))
      .slice(0, limit)
      .map(([, entry]) => entry)
    const incidents = [...this.domain.table('incidents').entries()]
      .map(([, record]) => record)
      .sort((a, b) => suffixRank(b.id) - suffixRank(a.id))
      .slice(0, limit)
    return { cycles, archives, incidents }
  }

  /** Arm the scheduled daemon tick; opportunistic daemon work never keeps a host alive. */
  private armDaemon(): void {
    if (this.daemonDisposed || !this.resolved.daemonEnabled) return
    /* v8 ignore next -- every caller arms after daemonTick cleared the pending timer, so the replace arm only guards re-entrant arming */
    if (this.daemonTimer !== undefined) clearTimeout(this.daemonTimer)
    this.daemonTimer = setTimeout(() => { void this.daemonTick() }, this.resolved.daemonIntervalMs)
    this.daemonTimer.unref()
  }

  /** One scheduled daemon tick: start a self-repairing cycle round when fresh evidence waits. */
  private async daemonTick(): Promise<void> {
    this.daemonTimer = undefined
    /* v8 ignore next -- a disposed or disabled daemon has no live timer, so this guard only covers teardown races */
    if (this.daemonDisposed || !this.resolved.daemonEnabled) return
    await this.waitReady()
    if (this.cycleRunning || this.consultRunning) {
      this.armDaemon()
      return
    }
    if (this.ctx.agents.list().length === 0) {
      this.armDaemon()
      return
    }
    if (this.state.knowledgeCutoffAt !== undefined
      && countUnseenSessions(this.ctx, this.state.knowledgeCutoffAt) === 0) {
      this.armDaemon()
      return
    }
    this.startScheduledRound()
  }

  /**
   * Start one scheduled daemon round as a background job: each attempt is
   * timeboxed by `cycleTimeoutMs`, failures record self-repair incidents and
   * retry with backoff up to `daemonMaxRetries`, and the round defers to the
   * next interval tick once the retry budget is spent.
   * @returns the registry-issued job id.
   */
  private startScheduledRound(): JobId {
    const controller = new AbortController()
    return this.ctx.jobs.start({
      kind: 'dual-core-rsi',
      label: 'RSI daemon scheduled cycle',
      run: (job: JobHandle) => {
        job.append('daemon core: scheduled tick with unseen session activity; distilling a candidate policy\n', { channel: 'log' })
        const done = this.scheduledRound(job, controller.signal)
          .then((outcome): { status: 'completed' | 'failed' | 'killed'; detail?: string; result?: string } => {
            if (outcome.status === 'completed') {
              job.append(`daemon core: ${renderCycleRecord(outcome.record)}\n`, { channel: 'log' })
              return { status: 'completed' as const, result: renderCycleRecord(outcome.record) }
            }
            return { status: outcome.status, detail: outcome.detail }
          })
          .finally(() => {
            this.armDaemon()
            this.maybeConsultOnExit()
          })
        return {
          cancel: (reason?: string) => { controller.abort(new Error(reason ?? 'daemon round cancelled')) },
          done,
        }
      },
    })
  }

  /**
   * Drive one scheduled round's attempts with timeboxing, incident records,
   * and backoff retries until one attempt settles, the round is cancelled,
   * or the retry budget is spent.
   */
  private async scheduledRound(job: JobHandle, signal: AbortSignal): Promise<ScheduledRoundOutcome> {
    const maxAttempts = 1 + this.resolved.daemonMaxRetries
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      /* v8 ignore next -- hitting it needs the kill to land between two attempts rather than inside one or its backoff */
      if (signal.aborted) return { status: 'killed', detail: 'the daemon round was cancelled before its attempt started' }
      const timeout = new AbortController()
      const timer = setTimeout(() => {
        timeout.abort(new Error(`the scheduled cycle exceeded cycleTimeoutMs (${this.resolved.cycleTimeoutMs}ms)`))
      }, this.resolved.cycleTimeoutMs)
      const startedAt = Date.now()
      try {
        const record = await this.runCycle('schedule', AbortSignal.any([signal, timeout.signal]))
        if (attempt > 1) job.append(`daemon core: attempt ${attempt} recovered the round\n`, { channel: 'log' })
        return { status: 'completed', record }
      } catch (error) {
        /* v8 ignore next -- the String arm needs a non-Error rejection, which the cycle never produces */
        const detail = error instanceof Error ? error.message : String(error)
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- jobs.kill aborts this signal mid-attempt
        if (signal.aborted) return { status: 'killed', detail }
        /* v8 ignore next 3 -- reaching the contention arm needs a manual cycle to start inside the tick's scheduling race */
        if (error instanceof RsiError && (error.code === 'cycle-in-progress' || error.code === 'no-anchor-agent')) {
          return { status: 'failed', detail: `the scheduled round skipped its attempt: ${detail}` }
        }
        const retried = attempt < maxAttempts
        const retryAfterMs = retried ? this.resolved.daemonRetryBackoffMs : this.resolved.daemonIntervalMs
        await this.recordIncident({
          startedAt,
          settledAt: Date.now(),
          kind: timeout.signal.aborted ? 'cycle-timeout' : 'cycle-error',
          detail,
          attempt,
          recovery: retried ? 'retried' : 'deferred',
          retryAfterMs,
        })
        job.append(`daemon core: attempt ${attempt} failed (${timeout.signal.aborted ? 'timed out' : 'error'}): ${detail}; ${retried ? `retrying in ${retryAfterMs}ms` : `deferring to the next interval in ${retryAfterMs}ms`}\n`, { channel: 'log' })
        if (!retried) return { status: 'failed', detail }
        const slept = await sleep(this.resolved.daemonRetryBackoffMs, signal)
        if (!slept) return { status: 'killed', detail: 'the daemon round was cancelled during its retry backoff' }
      } finally {
        clearTimeout(timer)
      }
    }
    /* v8 ignore next -- the loop returns from every arm; this line is unreachable */
    throw new Error('the daemon round exhausted its attempts without settling')
  }

  /** Persist one self-repair incident and advance the incident counter. */
  private async recordIncident(fields: Omit<RsiIncidentRecord, 'id'>): Promise<RsiIncidentRecord> {
    const counter = this.state.incidentCounter ?? 0
    const record: RsiIncidentRecord = { id: RsiIncidentId(`inc-${counter + 1}`), ...fields }
    this.state = { ...this.state, incidentCounter: counter + 1 }
    await this.domain.table('incidents').put(record.id, record)
    await this.commitState()
    return record
  }

  /** Consult the human about the pending candidate once the last live session exits. */
  private maybeConsultOnExit(): void {
    if (this.daemonDisposed || this.consultRunning || this.cycleRunning) return
    if (this.ctx.agents.list().length > 0) return
    void this.consultOnExit()
  }

  /**
   * Summarize the session's fix points and improvement points, ask the human
   * whether to merge the pending candidate, and settle the decision. Without
   * a user-questions answerer the candidate stays pending for `/rsi merge`
   * and `/rsi decline`.
   */
  private async consultOnExit(): Promise<void> {
    this.consultRunning = true
    try {
      await this.readyPromise
      /* v8 ignore next -- only reachable when the service disposes between the trigger and this await */
      if (this.daemonDisposed) return
      const pending = this.readPending()
      if (pending === undefined) return
      /* v8 ignore next -- only reachable when a new agent registers between the trigger's empty check and this read */
      if (this.ctx.agents.list().length > 0) return
      const userQuestions = this.ctx.get('userQuestions')
      if (userQuestions === undefined) {
        this.ctx.logger.info(`dual-core RSI: the session exited with pending policy ${pending.generation.id}; no user-questions service is composed, so decide with /rsi merge or /rsi decline`)
        return
      }
      const summary = renderExitSummary(pending, this.incidentsSinceLastDecision(), this.resolved.threshold)
      let answered = false
      try {
        this.ctx.logger.info(`dual-core RSI: offering pending policy ${pending.generation.id} for merge as the session exits`)
        const answer = await userQuestions.ask({
          questions: [{
            id: 'rsi-pending-merge',
            header: 'RSI',
            question: 'The RSI daemon distilled a clearly better working policy this session. Merge it into your agent?',
            detail: summary,
            options: [
              { label: 'Merge', description: 'Replace the current policy; the change is recorded in the local git ledger for rollback.' },
              { label: 'Keep current', description: 'Decline the candidate; the current policy stays in place.' },
            ],
          }],
          signal: AbortSignal.timeout(this.resolved.consultTimeoutMs),
        })
        answered = (answer.answers.at(0)?.selected ?? []).includes('Merge')
      } catch (error) {
        /* v8 ignore next -- the String arm needs a non-Error rejection, which the waterfall never produces */
        const detail = error instanceof Error ? error.message : String(error)
        this.ctx.logger.info(`dual-core RSI: the exit merge consult could not reach the user (${detail}); the candidate stays pending for /rsi merge or /rsi decline`)
        return
      }
      if (answered) {
        try {
          const merged = await this.mergePending('consult')
          const ledgerNote = merged.ledger.committed
            ? ` (ledger commit ${merged.ledger.revision})`
            : ` (ledger unavailable: ${merged.ledger.error})`
          this.ctx.logger.info(`dual-core RSI: merged ${merged.generation.id} after the exit consult${ledgerNote}`)
        } catch (error) {
          /* v8 ignore next -- the consult re-reads the pending state it just rendered, so settlement only fails on storage errors */
          this.ctx.logger.error(`dual-core RSI: settling the exit consult failed: ${errorDetail(error)}`)
        }
      } else {
        try {
          await this.declinePending('consult')
          this.ctx.logger.info('dual-core RSI: kept the current policy after the exit consult')
        } catch (error) {
          /* v8 ignore next -- the consult re-reads the pending state it just rendered, so settlement only fails on storage errors */
          this.ctx.logger.error(`dual-core RSI: settling the exit consult failed: ${errorDetail(error)}`)
        }
      }
    } finally {
      this.consultRunning = false
    }
  }

  /**
   * Start one daemon cycle as a background job the daemon core owns; the
   * job streams cycle narration and never blocks the caller's step.
   * @param trigger - what started the cycle.
   * @returns the registry-issued job id.
   */
  startDaemonJob(trigger: RsiCycleTrigger): JobId {
    const controller = new AbortController()
    return this.ctx.jobs.start({
      kind: 'dual-core-rsi',
      label: 'RSI daemon distillation cycle',
      run: (job: JobHandle) => {
        job.append('daemon core: assembling session digest and distilling a candidate policy\n', { channel: 'log' })
        const done = this.runCycle(trigger, controller.signal)
          .then((record) => {
            job.append(`daemon core: ${renderCycleRecord(record)}\n`, { channel: 'log' })
            return { status: 'completed' as const, result: renderCycleRecord(record) }
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            return controller.signal.aborted
              ? { status: 'killed' as const, detail: message }
              : { status: 'failed' as const, detail: message }
          })
        return {
          cancel: (reason?: string) => { controller.abort(new Error(reason ?? 'daemon cycle cancelled')) },
          done,
        }
      },
    })
  }

  /**
   * Run one daemon cycle for `/rsi`, waiting up to `runWaitMs` for its
   * outcome so a first-time user sees the result directly. A timeout never
   * cancels the cycle: the job keeps running and the user is told how to
   * check back. The invocation's own cancellation stays owned by the command
   * executor; the cycle is unaffected either way.
   * @returns the settled command result.
   */
  private async runCommandCycle(): Promise<CommandResult> {
    const jobId = this.startDaemonJob('command')
    /* v8 ignore next -- only service teardown rejects a live wait, and the cycle is cancelled then anyway */
    const job = await this.ctx.jobs.wait(jobId, this.resolved.runWaitMs)
      .catch(() => undefined)
    if (job === undefined || job.status === 'running' || job.status === 'stopping') {
      return {
        kind: 'success',
        text: `The self-improvement cycle ${jobId} is still running in the background; run /rsi again in a moment to see its result. ${RSI_CYCLE_COST_NOTE}`,
      }
    }
    if (job.status === 'completed') {
      const status = await this.status()
      if (status.pending !== undefined) {
        return { kind: 'success', text: `Cycle finished: ${renderCycleRecord(status.pending.cycle)} Decide with /rsi merge or /rsi decline; the offer also appears when the session exits.` }
      }
      /* v8 ignore next -- a completed cycle always persists its record before settling */
      const outcome = status.lastCycle === undefined ? 'completed' : renderCycleRecord(status.lastCycle)
      return { kind: 'success', text: `Cycle finished: ${outcome}` }
    }
    return {
      kind: 'error',
      /* v8 ignore next -- terminal statuses from this producer always carry a detail */
      text: `Cycle ${jobId} ended as ${job.status}${job.detail === undefined ? '' : `: ${job.detail}`}. Nothing was changed; run /rsi to inspect the current state.`,
    }
  }

  /** Register the model-facing rsi_status, rsi_run, rsi_history, and rsi_rollback tools. */
  private registerTools(): void {
    this.ctx.tools.register(defineTool({
      name: 'rsi_status',
      description: 'Show the dual-core RSI daemon state: the user-core and daemon-core generations, the scheduled daemon, the pending merge candidate, recent self-repair incidents, and the last distillation cycle. Read-only.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.status }],
      },
      execute: async () => ({ status: renderStatus(await this.status()) }),
      presentCall: () => ({ card: 'generic', title: 'rsi_status', rawInput: '' }),
      presentResult: () => ({ card: 'generic' }),
    }))
    this.ctx.tools.register(defineTool({
      name: 'rsi_run',
      description: 'Start one dual-core RSI daemon distillation cycle as a background job. Use ONLY when the direct human explicitly asks to run an RSI cycle or self-improvement round; the scheduled daemon already cycles on its own. Each cycle runs one fresh model child and spends tokens.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { jobId: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: `RSI daemon cycle job ${value.jobId} started.` }],
      },
      execute: () => Promise.resolve({ jobId: this.startDaemonJob('tool') }),
      presentCall: () => ({ card: 'generic', title: 'rsi_run', rawInput: '' }),
      presentResult: () => ({ card: 'generic' }),
    }))
    this.ctx.tools.register(defineTool({
      name: 'rsi_history',
      description: 'List recent dual-core RSI distillation cycles, rollback archives, and daemon self-repair incidents, newest first.',
      parameters: {
        limit: { type: 'number', description: 'Maximum cycles, archives, and incidents to list each (default 20).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { history: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.history }],
      },
      execute: async (args) => {
        const { cycles, archives, incidents } = await this.history(readLimit(args))
        return { history: renderHistory(cycles, archives, incidents) }
      },
      presentCall: args => ({ card: 'generic', title: 'rsi_history', rawInput: JSON.stringify(args) }),
      presentResult: () => ({ card: 'generic' }),
    }))
    this.ctx.tools.register(defineTool({
      name: 'rsi_rollback',
      description: 'Roll the dual-core RSI user core back to one archived generation (the newest archive when the id is omitted). The replaced generation is archived and recorded in the git ledger in turn, so a rollback is reversible.',
      parameters: {
        archiveId: { type: 'string', description: 'Archive id to restore; omit for the newest archive.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.result }],
      },
      execute: async (args) => {
        const { restored, archived, ledger } = await this.rollback(readArchiveId(args))
        return { result: renderRollback(restored, archived, ledger) }
      },
      presentCall: args => ({ card: 'generic', title: 'rsi_rollback', rawInput: JSON.stringify(args) }),
      presentResult: () => ({ card: 'generic' }),
    }))
  }

  /** Register the human-facing /rsi command. */
  private registerCommand(): void {
    this.ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-experimental-dual-core-rsi'),
      name: 'rsi',
      description: 'View or drive the dual-core RSI daemon',
      input: { hint: '[status|run|merge|decline|summary|history|rollback [<archive id>]]', attachments: false },
      handler: invocation => this.executeCommand(invocation),
    })
  }

  /** Dispatch the /rsi grammar. */
  private async executeCommand(invocation: CommandInvocation): Promise<CommandResult> {
    const input = invocation.rawInput.trim()
    const control = input.toLowerCase()
    if (input.length === 0 || control === 'status') {
      return { kind: 'success', text: renderStatus(await this.status()) }
    }
    if (control === 'run') {
      return this.runCommandCycle()
    }
    if (control === 'merge') {
      try {
        return { kind: 'success', text: renderMergeResult(await this.mergePending('command')) }
      } catch (error) {
        return { kind: 'error', text: `Merge failed: ${errorDetail(error)} ${USAGE}` }
      }
    }
    if (control === 'decline') {
      try {
        return { kind: 'success', text: renderDeclineResult(await this.declinePending('command')) }
      } catch (error) {
        return { kind: 'error', text: `Decline failed: ${errorDetail(error)} ${USAGE}` }
      }
    }
    if (control === 'summary') {
      const pending = this.readPending()
      if (pending === undefined) {
        return { kind: 'success', text: 'No dual-core RSI candidate is waiting for a decision. The scheduled daemon cycles on its own; /rsi run starts one immediately.' }
      }
      return { kind: 'success', text: renderExitSummary(pending, this.incidentsSinceLastDecision(), this.resolved.threshold) }
    }
    if (control === 'history') {
      const { cycles, archives, incidents } = await this.history(20)
      return { kind: 'success', text: renderHistory(cycles, archives, incidents) }
    }
    if (control === 'rollback' || /^rollback(?=\s)/iu.test(input)) {
      const explicit = /^rollback(?=\s)/iu.test(input) ? input.slice(8).trim() : ''
      try {
        const { restored, archived, ledger } = await this.rollback(explicit.length === 0 ? undefined : RsiArchiveId(explicit))
        return { kind: 'success', text: renderRollback(restored, archived, ledger) }
      } catch (error) {
        return { kind: 'error', text: `Rollback failed: ${errorDetail(error)} ${USAGE}` }
      }
    }
    return { kind: 'error', text: `Unknown /rsi input. ${USAGE}` }
  }
}

/** Rank one counter-derived archive or incident key newest-last by its numeric suffix (`arc-3`/`inc-3` → 3). */
function suffixRank(id: RsiArchiveId | RsiIncidentId): number {
  const suffix = Number(id.slice(4))
  /* v8 ignore next -- ids are always minted as <prefix>-<counter> */
  return Number.isFinite(suffix) ? suffix : -1
}

/** Render an unknown rejection as an actionable one-line detail. */
function errorDetail(error: unknown): string {
  /* v8 ignore next -- the String arm needs a non-Error rejection, which storage never produces */
  return error instanceof Error ? error.message : String(error)
}

/**
 * Wait one duration unless the signal aborts first.
 * @param ms - milliseconds to sleep.
 * @param signal - cancellation; aborting resolves early.
 * @returns whether the full duration elapsed.
 */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  /* v8 ignore next -- only reachable when a kill lands between the failed attempt and the backoff call */
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Read the validated optional limit argument of rsi_history.
 * @param args - schema-validated tool arguments.
 * @returns the requested limit, or the default 20.
 */
/* v8 ignore start -- the tool registry schema-validates limit to an optional number; the guards bound a trusted value */
function readLimit(args: unknown): number {
  const limit: unknown = (args as Record<string, unknown>)['limit']
  if (limit === undefined) return 20
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('rsi_history limit must be a safe integer in [1, 100]')
  }
  return limit
}
/* v8 ignore stop */

/** Read the validated optional archive id argument of rsi_rollback. */
function readArchiveId(args: unknown): RsiArchiveId | undefined {
  /* v8 ignore next -- the tool registry schema-validates the arguments object */
  if (typeof args !== 'object' || args === null) return undefined
  const id = (args as Record<string, unknown>)['archiveId']
  if (id === undefined) return undefined
  if (typeof id !== 'string' || id.length === 0 || id !== id.trim()) {
    throw new TypeError('rsi_rollback archiveId must be a non-empty normalized string')
  }
  return RsiArchiveId(id)
}

export default DualCoreRsiService
