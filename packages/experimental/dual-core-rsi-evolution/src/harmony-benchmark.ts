/**
 * Harmony benchmark seam: a multi-objective `ctx.rsiBenchmark` provider in
 * the Harmony Harness style. The configured case families are objectives;
 * the score is the weighted Tchebycheff scalarization against the utopia
 * point, so the gate keeps its pressure on whichever objective attains
 * worst and a candidate cannot clear it by optimizing one family alone.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi-evolution/harmony-benchmark
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  FixtureRsiBenchmark, RsiBenchmark, resolveFixtureCases,
} from '@deepseek-ai/dsh-experimental-dual-core-rsi'
import type {
  FixtureCase, RsiBenchmarkCaseResult, RsiBenchmarkReport, RsiBenchmarkRequest,
} from '@deepseek-ai/dsh-experimental-dual-core-rsi'
import type { ObjectiveAttainment } from './domain.ts'

/** One configured objective: a named family of benchmark cases with its weight. */
export interface HarmonyObjectiveConfig {
  /** Unique objective name rendered in case details. */
  name: string
  /** Positive Tchebycheff weight; objectives with larger weight exert more gate pressure. */
  weight: number
  /** Benchmark case names (from `cases`) belonging to this objective. */
  cases: string[]
}

/** Config of the Harmony benchmark provider. */
export interface HarmonyBenchmarkConfig {
  /** Case definition forwarded to the inner fixture evaluator (same shape as the fixture benchmark's). */
  cases?: FixtureCase[]
  /** Objective families over the case set; empty means one `general` objective covering every case. */
  objectives?: HarmonyObjectiveConfig[]
}

interface ResolvedObjective {
  readonly name: string
  readonly weight: number
  readonly caseNames: ReadonlySet<string>
}

function resolveObjectives(
  configCases: readonly FixtureCase[],
  objectives: readonly HarmonyObjectiveConfig[],
): readonly ResolvedObjective[] {
  if (objectives.length === 0) {
    return [{ name: 'general', weight: 1, caseNames: new Set(configCases.map(item => item.name)) }]

  }
  const caseNames = new Set(configCases.map(item => item.name))
  const names = new Set<string>()
  const assigned = new Set<string>()
  const resolved: ResolvedObjective[] = []
  for (const objective of objectives) {
    if (typeof objective.name !== 'string' || objective.name.trim() !== objective.name || objective.name.length === 0) {
      throw new TypeError('every Harmony objective name must be non-empty normalized text')
    }
    if (names.has(objective.name)) {
      throw new TypeError(`Harmony objective name "${objective.name}" is not unique`)
    }
    names.add(objective.name)
    if (!Number.isFinite(objective.weight) || objective.weight <= 0) {
      throw new TypeError(`Harmony objective "${objective.name}" weight must be a positive finite number`)
    }
    if (!Array.isArray(objective.cases) || objective.cases.length === 0) {
      throw new TypeError(`Harmony objective "${objective.name}" must list at least one case`)
    }
    for (const caseName of objective.cases) {
      if (!caseNames.has(caseName)) {
        throw new TypeError(`Harmony objective "${objective.name}" references case "${caseName}", which the case set does not define`)
      }
      if (assigned.has(caseName)) {
        throw new TypeError(`benchmark case "${caseName}" is assigned to more than one Harmony objective`)
      }
      assigned.add(caseName)
    }
    resolved.push({ name: objective.name, weight: objective.weight, caseNames: new Set(objective.cases) })
  }
  return resolved
}

/**
 * Service Provider for `ctx.rsiBenchmark`: delegates case scoring to an
 * inner fixture evaluator started in an isolated scope, then re-scores the
 * report as the weighted Tchebycheff scalarization
 * `score = 1 − max_j λ_j · (1 − attainment_j)` over the configured objective
 * families. Attainments are pass-rate rates in [0, 1], so the utopia point
 * is (1, …, 1) and no state is needed; a proposal strong on one objective
 * but weak on another scores below a balanced one, which is the Harmony
 * gate's whole point.
 */
export class HarmonyRsiBenchmark extends RsiBenchmark {
  static inject = ['rsiEvolutionLedger']

  static Config: z<HarmonyBenchmarkConfig> = z.object({
    /* jscpd:ignore-start -- mirrors the shipped fixture benchmark's case schema; the fixture entry cannot be reused as a sub-schema */
    cases: z.array(z.object({
      name: z.string().required(),
      weight: z.number().default(1),
      requiresGuidance: z.array(z.string()).default([]),
      requiresSkillNames: z.array(z.string()).default([]),
      requiresSkillContent: z.array(z.object({
        skill: z.string().required(),
        contains: z.string().required(),
      })).default([]),
      maxGuidanceChars: z.number(),
    })).default([]),
    /* jscpd:ignore-end */
    objectives: z.array(z.object({
      name: z.string().required(),
      weight: z.number(),
      cases: z.array(z.string()).default([]),
    })).default([]),
  })

  private readonly cases: readonly FixtureCase[]
  private readonly objectives: readonly ResolvedObjective[]
  /** The inner evaluator's evaluate, captured as a closure at construction or start. */
  private evaluateInner!: (request: RsiBenchmarkRequest, signal: AbortSignal) => Promise<RsiBenchmarkReport>
  /** Guards the start hook: init runs once per fiber. */
  private innerStarted = false

  /**
   * @param ctx - the mounting context; the decorator becomes `ctx.rsiBenchmark` for its row.
   * @param config - case set and objective families.
   * @param inner - explicit inner evaluator (tests); when absent, `[Service.init]` starts the shipped fixture
   *   provider on a detached context.
   */
  constructor(ctx: Context, config: HarmonyBenchmarkConfig, inner?: RsiBenchmark) {
    const cases = resolveFixtureCases(config.cases ?? [])
    const objectives = resolveObjectives(cases, config.objectives ?? [])
    super(ctx)
    this.cases = cases
    this.objectives = objectives
    if (inner !== undefined) {
      this.evaluateInner = (request, signal) => inner.evaluate(request, signal)
      // An injected inner is the unit-test seam: init must not replace it.
      this.innerStarted = true
    }
  }

  async [Service.init](): Promise<void> {
    if (this.innerStarted) return
    this.innerStarted = true
    // The shipped fixture provides under the same service name, so it cannot
    // mount beside this provider; its evaluation touches no tree service, so
    // a detached context carries it and disposes with this service.
    /* jscpd:ignore-start -- the two providers share the detached-inner bootstrap shape; each mounts a different inner */
    const detached = new Context()
    this.ctx.effect(() => () => { void detached.fiber.dispose() }, 'Harmony benchmark: inner lifetime')
    await detached.plugin(FixtureRsiBenchmark, { cases: [...this.cases] })
    const inner = detached.rsiBenchmark
    this.evaluateInner = (request, signal) => inner.evaluate(request, signal)
    /* jscpd:ignore-end */
  }

  /**
   * Score one artifact set: the inner report's per-case results regrouped
   * into objective attainments and scalarized by weighted Tchebycheff.
   * @param request - the generation under evaluation.
   * @param signal - cancellation signal owned by the cycle trigger.
   * @returns the multi-objective report, with one synthetic case per objective.
   */
  async evaluate(request: RsiBenchmarkRequest, signal: AbortSignal): Promise<RsiBenchmarkReport> {
    const innerReport = await this.evaluateInner(request, signal)
    const byName = new Map(innerReport.cases.map(item => [item.name, item]))
    const summaries: RsiBenchmarkCaseResult[] = []
    let shortfall = 0
    for (const objective of this.objectives) {
      const attainment = this.attainment(objective, byName)
      shortfall = Math.max(shortfall, objective.weight * (1 - attainment))
      const totalWeight = this.familyWeight(objective, byName)
      summaries.push({
        name: `objective:${objective.name}`,
        passed: attainment === 1,
        weight: objective.weight,
        detail: totalWeight === 0
          ? `no cases of objective "${objective.name}" appeared in this evaluation; attainment defaults to 100%`
          : `${Math.round(totalWeight * attainment)}/${totalWeight} weight passed; attainment ${(attainment * 100).toFixed(1)}%, weight ${objective.weight}`,
      })
    }
    const score = Math.min(1, Math.max(0, 1 - shortfall))
    const report: RsiBenchmarkReport = {
      provider: `harmony:${innerReport.provider}`,
      scoredAt: Date.now(),
      score,
      cases: [...innerReport.cases, ...summaries],
    }
    // Contained: the gate's verdict is already decided; a ledger outage must
    // not fail the cycle that carries the report.
    try {
      await this.ctx.rsiEvolutionLedger.recordScore(request.generation.artifacts, score)
    } catch (error) {
      /* v8 ignore next -- the String arm needs a non-Error rejection, which the ledger never produces */
      this.ctx.logger.warn(`Harmony benchmark: replay ledger score write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return report
  }

  /**
   * The objective attainments of one persisted report: the families this
   * provider was configured with, recomputed from the report's own cases.
   * Trajectory consumers read the evolution direction from here.
   * @param report - a report this provider (or a composition-equal one) produced.
   * @returns one attainment per configured objective, in configuration order.
   */
  objectiveAttainments(report: RsiBenchmarkReport): readonly ObjectiveAttainment[] {
    const byName = new Map(report.cases.map(item => [item.name, item]))
    return this.objectives.map(objective => ({
      name: objective.name,
      attainment: this.attainment(objective, byName),
      weight: objective.weight,
    }))
  }

  /** One family's attainment: passed weight over total weight among the family's present cases. */
  private attainment(objective: ResolvedObjective, byName: Map<string, RsiBenchmarkCaseResult>): number {
    const totalWeight = this.familyWeight(objective, byName)
    if (totalWeight === 0) return 1
    let passedWeight = 0
    for (const name of objective.caseNames) {
      const item = byName.get(name)
      if (item !== undefined && item.passed) passedWeight += item.weight
    }
    return passedWeight / totalWeight
  }

  /** One family's total case weight among its present cases. */
  private familyWeight(objective: ResolvedObjective, byName: Map<string, RsiBenchmarkCaseResult>): number {
    let totalWeight = 0
    for (const name of objective.caseNames) {
      const item = byName.get(name)
      if (item !== undefined) totalWeight += item.weight
    }
    return totalWeight
  }
}
