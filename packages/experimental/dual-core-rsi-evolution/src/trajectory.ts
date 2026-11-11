/**
 * Evolution trajectory seam: the Service Definition
 * `ctx.rsiEvolutionTrajectory`. It drives N daemon rounds through the
 * dual-core RSI controller, records each round's outcome with its objective
 * attainments and Tchebycheff pressure direction into the trajectory table
 * and a JSONL log, and renders the evolution topology — the proposal
 * lineage graph — as a mermaid flowchart.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi-evolution/trajectory
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Empty type import: carries the dualCoreRsi Context merge this service drives.
import type {} from '@deepseek-ai/dsh-experimental-dual-core-rsi'
import type { DualCoreRsiService, RsiCycleRecord } from '@deepseek-ai/dsh-experimental-dual-core-rsi'
import { HarmonyRsiBenchmark } from './harmony-benchmark.ts'
import type { ObjectiveAttainment, RsiTrajectoryRound } from './domain.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Evolution trajectory runner, topology renderer, and trajectory log. */
    rsiEvolutionTrajectory: EvolutionTrajectory
  }
}

const NOTE_MAX_CHARS = 200
/** Trajectory log file inside the configured directory. */
const LOG_FILE_NAME = 'trajectory.jsonl'

/** Config of the trajectory service. */
export interface TrajectoryConfig {
  /** Default round count for `runRounds` (default 10). */
  rounds?: number
  /** Directory of the JSONL trajectory log (default `~/.dsh/dual-core-rsi-evolution-trajectory`). */
  trajectoryDir?: string
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer, got ${String(value)}`)
  }
  return value
}

function normalizedDirectory(value: string | undefined, fallback: string, field: string): string {
  const dir = value ?? fallback
  if (dir.length === 0 || dir.trim() !== dir) {
    throw new TypeError(`${field} must be a non-empty normalized directory`)
  }
  return dir
}

function boundedNote(text: string): string {
  return text.trim().slice(0, NOTE_MAX_CHARS)
}

/** Mermaid node ids accept word characters; everything else becomes an underscore. */
function sanitize(id: string): string {
  return id.replaceAll(/[^A-Za-z0-9_]/gu, '_')
}

function formatScore(score: number): string {
  return score.toFixed(3)
}

function formatDelta(delta: number): string {
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`
}

interface SettledRound {
  readonly row: RsiTrajectoryRound
  readonly record: RsiCycleRecord | undefined
  readonly cycleError: string | undefined
}

/**
 * Service Definition of the evolution trajectory. Every round runs one
 * daemon cycle through the controller, snapshots the objective shape and
 * the Tchebycheff pressure direction, and settles one durable trajectory
 * row plus one JSONL line, so a ten-round evolution leaves a replayable
 * log and a renderable topology.
 */
export abstract class EvolutionTrajectory extends Service {
  constructor(ctx: Context) {
    super(ctx, 'rsiEvolutionTrajectory')
  }

  /**
   * Run `count` evolution rounds, recording each as one trajectory row.
   * A failed round is recorded and the remaining rounds continue.
   * @param count - rounds to run; omission uses the configured default.
   * @param signal - cancellation signal owned by the caller.
   * @returns the rounds recorded by this invocation.
   */
  abstract runRounds(count?: number, signal?: AbortSignal): Promise<readonly RsiTrajectoryRound[]>

  /**
   * Render the evolution topology: one node per generation the rounds
   * touched, one edge per round's active→candidate proposal, labeled with
   * the round, outcome, and score delta.
   * @returns a mermaid `flowchart TD` block.
   */
  abstract renderTopology(): Promise<string>

  /**
   * Render the trajectory log: one line per round with scores, objective
   * attainments, and the pressure direction.
   * @returns the plain-text trajectory log.
   */
  abstract renderLog(): Promise<string>

  /** Every recorded round, oldest first. */
  abstract rounds(): Promise<readonly RsiTrajectoryRound[]>
}

/**
 * Service Provider for `ctx.rsiEvolutionTrajectory`: drives the controller,
 * snapshots the Harmony objective attainments, computes the Tchebycheff
 * pressure direction, and settles each round into the ledger's trajectory
 * table, the JSONL log, and the rendered topology.
 */
export class DomainEvolutionTrajectory extends EvolutionTrajectory {
  static inject = ['dualCoreRsi', 'rsiEvolutionLedger', 'rsiBenchmark', 'tools']

  static Config: z<TrajectoryConfig> = z.object({
    rounds: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(10),
    trajectoryDir: z.string().default(dshHomePath('dual-core-rsi-evolution-trajectory')),
  })

  private readonly defaultRounds: number
  private readonly trajectoryDir: string
  private readonly readyPromise: Promise<void>
  private roundsCache: readonly RsiTrajectoryRound[] = []
  private logDirectory: Promise<void> | undefined

  /**
   * @param ctx - context with the dual-core RSI controller, the replay ledger, the composed benchmark, and the tool registry injected.
   * @param config - default rounds and log directory.
   */
  constructor(ctx: Context, config: TrajectoryConfig) {
    const defaultRounds = positiveInteger(config.rounds, 10, 'rounds')
    const trajectoryDir = normalizedDirectory(config.trajectoryDir, dshHomePath('dual-core-rsi-evolution-trajectory'), 'trajectoryDir')
    super(ctx)
    this.defaultRounds = defaultRounds
    this.trajectoryDir = trajectoryDir
    this.readyPromise = this.initialize()
    this.readyPromise.catch((error: unknown) => {
      /* v8 ignore next -- the String arm needs a non-Error rejection, which the ledger never produces */
      this.ctx.logger.error(`rsi evolution trajectory initialization failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Await domain readiness and the tool registration. */
  async waitReady(): Promise<void> {
    await this.readyPromise
  }

  private async initialize(): Promise<void> {
    this.roundsCache = [...await this.ctx.rsiEvolutionLedger.trajectoryRounds()]
    this.registerTools()
  }

  private registerTools(): void {
    this.ctx.tools.register(defineTool({
      name: 'rsi_evolve',
      description: 'Run a batch of dual-core RSI evolution rounds (default 10): each round distills a candidate, gates it on the multi-objective benchmark, and records the trajectory with its objective attainments and pressure direction. Use ONLY when the direct human explicitly asks to run an evolution batch or iterative self-improvement; the scheduled daemon already cycles on its own. Every round runs one fresh model child and spends tokens.',
      parameters: {
        rounds: { type: 'number', description: 'Rounds to run (default the configured 10).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { report: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },
      execute: async (args) => {
        const rounds = typeof args.rounds === 'number' && Number.isInteger(args.rounds) && args.rounds >= 1
          ? args.rounds
          : undefined
        const recorded = await this.runRounds(rounds)
        return { report: `Evolved ${String(recorded.length)} round(s); the trajectory log and topology follow.\n\n${await this.renderLog()}\n\n${await this.renderTopology()}` }
      },
      presentCall: args => ({ card: 'generic', title: 'rsi_evolve', rawInput: JSON.stringify(args) }),
      presentResult: () => ({ card: 'generic' }),
    }))
    this.ctx.tools.register(defineTool({
      name: 'rsi_trajectory',
      description: 'Show the dual-core RSI evolution trajectory read-only: the per-round log with objective attainments and pressure direction, and the proposal-lineage topology graph.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { report: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },
      execute: async () => ({ report: `${await this.renderLog()}\n\n${await this.renderTopology()}` }),
      presentCall: () => ({ card: 'generic', title: 'rsi_trajectory', rawInput: '' }),
      presentResult: () => ({ card: 'generic' }),
    }))
  }

  /** @inheritdoc */
  async runRounds(count?: number, signal?: AbortSignal): Promise<readonly RsiTrajectoryRound[]> {
    await this.readyPromise
    const total = positiveInteger(count, this.defaultRounds, 'count')
    const recorded: RsiTrajectoryRound[] = []
    for (let index = 0; index < total; index += 1) {
      if (signal?.aborted === true) break
      const settled = await this.runOneRound(this.roundsCache.length + 1, signal)
      this.roundsCache = [...this.roundsCache, settled.row]
      recorded.push(settled.row)
    }
    return recorded
  }

  /** Run and settle one round: cycle, snapshot, persist, and log. */
  private async runOneRound(round: number, signal: AbortSignal | undefined): Promise<SettledRound> {
    const before = await this.ctx.dualCoreRsi.status()
    const baselineScore = before.active.benchmark?.score
    let record: RsiCycleRecord | undefined
    let cycleError: string | undefined
    try {
      record = await this.ctx.dualCoreRsi.runCycle('command', signal ?? new AbortController().signal)
    } catch (error) {
      /* v8 ignore next -- the String arm needs a non-Error rejection, which the controller never produces */
      cycleError = error instanceof Error ? error.message : String(error)
    }
    // The pressure direction is the shape the round responded to: the
    // starting objective attainments, not the post-round state.
    const objectives = this.activeAttainments(before)
    const pressureObjective = this.pressure(objectives)
    const ledgerRows = (await this.ctx.rsiEvolutionLedger.entries()).length
    const knowledgeRows = (await this.ctx.dualCoreRsi.history(20)).knowledge.length
    let outcome: string
    let note: string
    if (record === undefined) {
      outcome = 'failed'
      note = boundedNote(`failed: ${cycleError}`)
    } else {
      outcome = record.outcome
      note = boundedNote(`${record.outcome}: ${record.rationale}`)
    }
    const row: RsiTrajectoryRound = {
      round,
      activeId: before.active.id,
      ...(record === undefined ? {} : { cycleId: record.id }),
      ...(record === undefined ? {} : { candidateId: record.candidateId }),
      outcome,
      ...baselineScore === undefined ? {} : { baselineScore },
      ...(record === undefined ? {} : { candidateScore: record.candidateScore }),
      objectives: [...objectives],
      ...pressureObjective === undefined ? {} : { pressureObjective },
      ledgerRows,
      knowledgeRows,
      note,
      settledAt: Date.now(),
    }
    const settled: SettledRound = { row, record, cycleError }
    // Contained: the round happened; a durability or log outage is logged
    // and the remaining rounds continue.
    try {
      await this.ctx.rsiEvolutionLedger.recordRound(row)
    } catch (error) {
      /* v8 ignore next -- the String arm needs a non-Error rejection, which the ledger never produces */
      this.ctx.logger.warn(`rsi evolution trajectory: round ${String(round)} persistence failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      await this.writeLogLine(row)
    } catch (error) {
      /* v8 ignore next -- the String arm needs a non-Error rejection, which appendFile never produces */
      this.ctx.logger.warn(`rsi evolution trajectory: log write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return settled
  }

  /** The active generation's objective attainments, from Harmony when composed. */
  private activeAttainments(status: Awaited<ReturnType<DualCoreRsiService['status']>>): readonly ObjectiveAttainment[] {
    const report = status.active.benchmark
    if (report === undefined) return []
    if (this.ctx.rsiBenchmark instanceof HarmonyRsiBenchmark) {
      return this.ctx.rsiBenchmark.objectiveAttainments(report)
    }
    // A non-Harmony benchmark exposes one overall objective.
    return [{ name: 'overall', attainment: report.score, weight: 1 }]
  }

  /** The objective with the largest weighted shortfall from the ideal point. */
  private pressure(objectives: readonly ObjectiveAttainment[]): string | undefined {
    let worst: ObjectiveAttainment | undefined
    let worstShortfall = -1
    for (const objective of objectives) {
      const shortfall = objective.weight * (1 - objective.attainment)
      if (shortfall > worstShortfall) {
        worst = objective
        worstShortfall = shortfall
      }
    }
    return worst?.name
  }

  /** Append one round to the JSONL trajectory log, creating the directory once. */
  private async writeLogLine(row: RsiTrajectoryRound): Promise<void> {
    this.logDirectory ??= mkdir(this.trajectoryDir, { recursive: true }).then(() => undefined)
    await this.logDirectory
    // appendFile creates the file on first write and continues it afterwards,
    // so a restart keeps one log across runs.
    await appendFile(join(this.trajectoryDir, LOG_FILE_NAME), `${JSON.stringify(row)}\n`)
  }

  /** @inheritdoc */
  async rounds(): Promise<readonly RsiTrajectoryRound[]> {
    await this.readyPromise
    return [...this.roundsCache]
  }

  /** @inheritdoc */
  async renderLog(): Promise<string> {
    await this.readyPromise
    if (this.roundsCache.length === 0) {
      return 'No evolution rounds recorded yet. Run rsi_evolve to drive a batch.'
    }
    const lines = ['Evolution trajectory (oldest first):']
    for (const row of this.roundsCache) {
      const objectives = row.objectives
        .map(objective => `${objective.name} ${(objective.attainment * 100).toFixed(0)}%`)
        .join(', ')
      const scores = row.baselineScore === undefined || row.candidateScore === undefined
        ? ''
        : ` ${formatScore(row.baselineScore)}→${formatScore(row.candidateScore)}`
      const pressure = row.pressureObjective === undefined ? '' : ` pressure=${row.pressureObjective}`
      lines.push(`r${String(row.round)} ${row.outcome}${scores} [${objectives}]${pressure} — ${row.note}`)
    }
    lines.push(`Trajectory log: ${join(this.trajectoryDir, LOG_FILE_NAME)}`)
    return lines.join('\n')
  }

  /** @inheritdoc */
  async renderTopology(): Promise<string> {
    await this.readyPromise
    if (this.roundsCache.length === 0) {
      return 'No evolution topology yet: the graph renders after the first recorded round.'
    }
    const scores = new Map<string, number | undefined>()
    const edges: string[] = []
    for (const row of this.roundsCache) {
      const from = `gen_${sanitize(row.activeId)}`
      const to = `gen_${sanitize(row.candidateId ?? row.activeId)}`
      const delta = row.baselineScore !== undefined && row.candidateScore !== undefined
        ? ` ${formatDelta(row.candidateScore - row.baselineScore)}`
        : ''
      scores.set(from, row.baselineScore)
      if (row.candidateScore !== undefined) scores.set(to, row.candidateScore)
      edges.push(`  ${from} -->|"r${String(row.round)} ${row.outcome}${delta}"| ${to}`)
    }
    const lines = ['flowchart TD']
    for (const [id, score] of scores) {
      lines.push(`  ${id}["${score === undefined ? id : `${id} · ${formatScore(score)}`}"]`)
    }
    lines.push(...edges)
    return ['```mermaid', ...lines, '```'].join('\n')
  }
}
