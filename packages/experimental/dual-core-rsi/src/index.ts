/**
 * Dual-core recursive self-improvement over the live harness: the user core
 * serves interactive agents, the daemon core distills the user core's recent
 * sessions into bounded policy artifacts, benchmarks candidates, and past a
 * configured improvement threshold swaps the cores while archiving the
 * replaced surface for rollback.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import type { JobHandle, JobId } from '@deepseek-ai/dsh-jobs'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assembleDigest, countUnseenSessions, rsiDigestProjectionDefinition } from './digest.ts'
import { dualCoreRsiDomain, RSI_STATE_KEY } from './domain.ts'
import type { RsiStateRecord } from './domain.ts'
import { RsiArchiveId, RsiCycleId, RsiGenerationId } from './branding.ts'
import { applyArtifacts } from './policy.ts'
import { RSI_CYCLE_COST_NOTE, renderCycleRecord, renderHistory, renderRollback, renderStatus } from './render.ts'
import type {
  RsiArchiveEntry, RsiArtifactBudgets, RsiCycleRecord, RsiCycleTrigger,
  RsiGeneration, RsiStatusView,
} from './types.ts'

export type {
  RsiArchiveEntry, RsiArtifactBudgets, RsiArtifacts, RsiBenchmarkCaseResult,
  RsiBenchmarkReport, RsiBenchmarkRequest, RsiCycleOutcome, RsiCycleRecord,
  RsiCycleTrigger, RsiDistillInput, RsiDistillOutput, RsiGeneration,
  RsiGenerationOrigin, RsiSessionDigest, RsiSessionDigestEntry,
  RsiSkillArtifact, RsiStatusView,
} from './types.ts'
export { RsiArchiveId, RsiCycleId, RsiGenerationId } from './branding.ts'
export { decodeArtifacts, renderPolicySection, applyArtifacts, formatPercent } from './policy.ts'
export { assembleDigest } from './digest.ts'
export { dualCoreRsiDomain, RSI_STATE_KEY } from './domain.ts'
export { RsiDistiller, SubagentRsiDistiller } from './distiller.ts'
export type { RsiDistillOptions, SubagentDistillerConfig } from './distiller.ts'
export { RsiBenchmark, FixtureRsiBenchmark, resolveFixtureCases } from './benchmark.ts'
export type { FixtureBenchmarkConfig, FixtureCase } from './benchmark.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'dual-core-rsi': 'dual-core-rsi'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Dual-core RSI controller: cycles, swap gate, archives, and rollback. */
    dualCoreRsi: DualCoreRsiService
  }
}

/** Stable failure codes for dual-core RSI operations. */
export type RsiErrorCode = 'cycle-in-progress' | 'no-anchor-agent' | 'unknown-archive'

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
  /** Benchmark improvement fraction that triggers a core swap (default `0.05` is +5%). */
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
}

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
  digestMaxCharsPerSession: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(4000),
  runWaitMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(120_000),
  digestIncludeStoredSessions: z.boolean().default(true),
})

/** Fully resolved configuration after defaulting and validation. */
export interface ResolvedConfig extends RsiArtifactBudgets {
  readonly threshold: number
  readonly digestMaxSessions: number
  readonly digestMaxCharsPerSession: number
  readonly runWaitMs: number
  readonly digestIncludeStoredSessions: boolean
}

/** Default swap threshold when configuration omits it. */
export const DEFAULT_SWAP_THRESHOLD = 0.05

/** Default bounded wait of `/rsi run` before reporting background continuation. */
export const DEFAULT_RUN_WAIT_MS = 120_000

function positiveSafeInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${label} must be a positive safe integer`)
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
  }
}

const USAGE = 'Usage: /rsi [status|run|history|rollback [<archive id>]]'

/** Read one tracked agent's applied-artifacts disposer. */
interface AppliedEntry {
  readonly agent: Agent
  dispose(): void
}

/**
 * The dual-core RSI controller. Owns the durable generation/archive/cycle
 * domain, applies the active generation's artifacts to every live agent
 * scope, runs daemon cycles, gates swaps on benchmark improvement, and
 * executes rollback. Durable writes inside one operation settle through one
 * final state-pointer write, so an interrupted operation leaves the previous
 * pointer with at most orphan records.
 */
export class DualCoreRsiService extends Service {
  static inject = ['agents', 'sessions', 'sessionProjections', 'systemPrompt', 'storageDomain', 'rsiDistiller', 'rsiBenchmark', 'tools', 'commands', 'jobs']

  static Config: z<Config> = Config

  private readonly resolved: ResolvedConfig
  private readonly readyPromise: Promise<void>
  private domain!: Domain<typeof dualCoreRsiDomain>
  private state!: RsiStateRecord
  private readonly applied = new Map<SessionId, AppliedEntry>()
  private cycleRunning = false

  /**
   * @param ctx - context with every injected seam present.
   * @param config - validated plugin configuration.
   */
  constructor(ctx: Context, config: Config) {
    const resolved = resolveConfig(config)
    super(ctx, 'dualCoreRsi')
    ctx.sessionProjections.register(rsiDigestProjectionDefinition)
    this.resolved = resolved
    this.readyPromise = this.initialize()
    // Surface an initialization failure immediately; later callers still see the rejection.
    this.readyPromise.catch((error: unknown) => {
      /* v8 ignore next -- the non-Error arm needs a string rejection, which storage and validation never produce */
      ctx.logger.error(`dual-core RSI initialization failed: ${error instanceof Error ? error.message : String(error)}`)
    })
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
    })
    ctx.effect(() => () => {
      for (const entry of this.applied.values()) entry.dispose()
      this.applied.clear()
    })
    this.registerTools()
    this.registerCommand()
  }

  /** Open the domain, seed the initial cores when absent, attach live agents. */
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
  }

  /** Resolve after the domain is loaded and live agents are attached. */
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
   * swap past the configured improvement threshold. All durable writes
   * happen after successful evaluation; the final state write is the commit
   * point, so an interrupted cycle leaves the previous cores in place.
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
      const promoted = improvement > this.resolved.threshold
      if (promoted) {
        await this.archive(this.activeGeneration(), candidate.id, 'swap')
        this.state = { ...this.state, activeId: candidate.id }
        await this.seedDaemonFrom(candidate)
        this.reapplyActive()
      } else if (daemon.benchmark === undefined || candidateScore >= daemon.benchmark.score) {
        this.state = { ...this.state, daemonId: candidate.id }
      }
      // Every settled cycle, promoted or retained, digests all live sessions
      // up to this point: this is the knowledge cutoff.
      this.state = { ...this.state, knowledgeCutoffAt: Date.now() }
      const record: RsiCycleRecord = {
        id: RsiCycleId(String(this.state.cycleCounter + 1)),
        trigger,
        startedAt,
        settledAt: Date.now(),
        outcome: promoted ? 'promoted' : 'retained',
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

  /**
   * Roll the user core back to one archived generation. The replaced
   * generation is itself archived, so a rollback is reversible by another
   * rollback.
   * @param archiveId - archive to restore; omission restores the newest archive.
   * @returns the restored generation and the newly created archive entry.
   * @throws RsiError when the archive does not exist.
   */
  async rollback(archiveId?: RsiArchiveId): Promise<{ restored: RsiGeneration; archived: RsiArchiveEntry }> {
    await this.waitReady()
    const archives = this.domain.table('archives')
    let target = archiveId === undefined ? undefined : archives.get(archiveId)
    if (target === undefined && archiveId === undefined) {
      const newest = [...archives.keys()].sort((a, b) => archiveRank(RsiArchiveId(b)) - archiveRank(RsiArchiveId(a))).at(0)
      target = newest === undefined ? undefined : archives.get(RsiArchiveId(newest))
    }
    if (target === undefined) {
      throw new RsiError('unknown-archive', archiveId === undefined
        ? 'no dual-core RSI archive exists yet; nothing to roll back to'
        : `dual-core RSI archive "${archiveId}" does not exist`)
    }
    const restored = target.generation
    await this.domain.table('generations').put(restored.id, restored)
    const archived = await this.archive(this.activeGeneration(), restored.id, 'rollback')
    this.state = { ...this.state, activeId: restored.id }
    await this.seedDaemonFrom(restored)
    this.reapplyActive()
    await this.commitState()
    return { restored, archived }
  }

  /**
   * Project the current dual-core state for tools and the command.
   * @returns the status view.
   */
  async status(): Promise<RsiStatusView> {
    await this.waitReady()
    const newest = [...this.domain.table('cycles').keys()].sort((a, b) => Number(b) - Number(a)).at(0)
    return {
      active: this.activeGeneration(),
      daemon: this.daemonGeneration(),
      threshold: this.resolved.threshold,
      ...newest === undefined ? {} : { lastCycle: this.domain.table('cycles').get(RsiCycleId(newest)) },
      cycleRunning: this.cycleRunning,
      archiveCount: this.domain.table('archives').size,
      ...this.state.knowledgeCutoffAt === undefined ? {} : { knowledgeCutoffAt: this.state.knowledgeCutoffAt },
      unseenSessionCount: this.state.knowledgeCutoffAt === undefined
        ? 0
        : countUnseenSessions(this.ctx, this.state.knowledgeCutoffAt),
    }
  }

  /**
   * List recent cycles and archives, newest first.
   * @param limit - maximum entries of each kind (default 20).
   * @returns bounded history.
   */
  async history(limit: number = 20): Promise<{ cycles: RsiCycleRecord[]; archives: RsiArchiveEntry[] }> {
    await this.waitReady()
    const cycles = [...this.domain.table('cycles').entries()]
      .sort(([a], [b]) => Number(b) - Number(a))
      .slice(0, limit)
      .map(([, record]) => record)
    const archives = [...this.domain.table('archives').entries()]
      .sort(([a], [b]) => archiveRank(b) - archiveRank(a))
      .slice(0, limit)
      .map(([, entry]) => entry)
    return { cycles, archives }
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
      description: 'Show the dual-core RSI daemon state: the user-core and daemon-core generations, the swap threshold, and the last distillation cycle. Read-only.',
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
      description: 'Start one dual-core RSI daemon distillation cycle as a background job. Use ONLY when the direct human explicitly asks to run an RSI cycle or self-improvement round; read the job output through the job tools. Each cycle runs one fresh model child and spends tokens.',
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
      description: 'List recent dual-core RSI distillation cycles and rollback archives, newest first.',
      parameters: {
        limit: { type: 'number', description: 'Maximum cycles and archives to list each (default 20).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { history: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.history }],
      },
      execute: async (args) => {
        const { cycles, archives } = await this.history(readLimit(args))
        return { history: renderHistory(cycles, archives) }
      },
      presentCall: args => ({ card: 'generic', title: 'rsi_history', rawInput: JSON.stringify(args) }),
      presentResult: () => ({ card: 'generic' }),
    }))
    this.ctx.tools.register(defineTool({
      name: 'rsi_rollback',
      description: 'Roll the dual-core RSI user core back to one archived generation (the newest archive when the id is omitted). The replaced generation is archived in turn, so a rollback is reversible.',
      parameters: {
        archiveId: { type: 'string', description: 'Archive id to restore; omit for the newest archive.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.result }],
      },
      execute: async (args) => {
        const { restored, archived } = await this.rollback(readArchiveId(args))
        return { result: renderRollback(restored, archived) }
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
      input: { hint: '[status|run|history|rollback [<archive id>]]', attachments: false },
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
    if (control === 'history') {
      const { cycles, archives } = await this.history(20)
      return { kind: 'success', text: renderHistory(cycles, archives) }
    }
    if (control === 'rollback' || /^rollback(?=\s)/iu.test(input)) {
      const explicit = /^rollback(?=\s)/iu.test(input) ? input.slice(8).trim() : ''
      try {
        const { restored, archived } = await this.rollback(explicit.length === 0 ? undefined : RsiArchiveId(explicit))
        return { kind: 'success', text: renderRollback(restored, archived) }
      } catch (error) {
        /* v8 ignore next -- the String arm needs a non-Error rollback rejection, which storage never produces */
        const detail = error instanceof Error ? error.message : String(error)
        return { kind: 'error', text: `Rollback failed: ${detail} ${USAGE}` }
      }
    }
    return { kind: 'error', text: `Unknown /rsi input. ${USAGE}` }
  }
}

/** Rank one archive key newest-last by its numeric suffix (`arc-3` → 3). */
function archiveRank(id: RsiArchiveId): number {
  const suffix = Number(id.slice(4))
  /* v8 ignore next -- archive ids are always minted as arc-<counter> */
  return Number.isFinite(suffix) ? suffix : -1
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
