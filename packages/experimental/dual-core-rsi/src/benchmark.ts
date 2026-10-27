/**
 * Benchmark seam: the Service Definition `ctx.rsiBenchmark` plus the shipped
 * deterministic fixture provider that gates core swaps.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi/benchmark
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RsiBenchmarkCaseResult, RsiBenchmarkReport, RsiBenchmarkRequest } from './types.ts'
import type { RsiArtifacts } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Daemon-core benchmark seam consumed by the dual-core RSI service. */
    rsiBenchmark: RsiBenchmark
  }
}

/**
 * Service Definition of the benchmark seam. One `evaluate` call scores one
 * generation's artifact set and returns deterministic evidence; the score
 * feeds the swap gate, so implementations must be reproducible for the same
 * request.
 */
export abstract class RsiBenchmark extends Service {
  constructor(ctx: Context) {
    super(ctx, 'rsiBenchmark')
  }

  /**
   * Score one generation's artifact set.
   * @param request - the generation under evaluation.
   * @param signal - cancellation signal owned by the cycle trigger.
   * @returns the deterministic benchmark report.
   */
  abstract evaluate(request: RsiBenchmarkRequest, signal: AbortSignal): Promise<RsiBenchmarkReport>
}

/** One case in the fixture benchmark definition. */
export interface FixtureCase {
  /** Unique case name rendered in reports. */
  name: string
  /** Positive case weight; the score is passed weight over total weight. */
  weight: number
  /** Every substring that must appear in some guidance line. */
  requiresGuidance?: string[]
  /** Every skill name that must exist in the artifact set. */
  requiresSkillNames?: string[]
  /** Every substring that must appear in the named skill's content. */
  requiresSkillContent?: { skill: string; contains: string }[]
  /** Maximum total guidance characters the artifact set may carry. */
  maxGuidanceChars?: number
}

/** Fixture benchmark configuration. */
export interface FixtureBenchmarkConfig {
  /** At least one case is required; an empty benchmark fails loud at load. */
  cases?: FixtureCase[]
}

/**
 * Defensively validate the fixture definition at load: unique names,
 * positive weights, normalized text requirements.
 * @param cases - configured cases after schemastery defaults.
 * @returns the validated cases.
 * @throws TypeError naming the first violated rule.
 */
export function resolveFixtureCases(cases: readonly FixtureCase[]): readonly FixtureCase[] {
  if (cases.length === 0) {
    throw new TypeError('the fixture benchmark requires at least one case; configure benchmark cases or mount a different rsiBenchmark provider')
  }
  const names = new Set<string>()
  for (const item of cases) {
    if (typeof item.name !== 'string' || item.name.trim() !== item.name || item.name.length === 0) {
      throw new TypeError('every fixture case name must be non-empty normalized text')
    }
    if (names.has(item.name)) {
      throw new TypeError(`fixture case name "${item.name}" is not unique`)
    }
    names.add(item.name)
    if (!Number.isFinite(item.weight) || item.weight <= 0) {
      throw new TypeError(`fixture case "${item.name}" weight must be a positive finite number`)
    }
  }
  return cases
}

/** Evaluate one case against one artifact set. */
function evaluateCase(item: FixtureCase, artifacts: RsiArtifacts): RsiBenchmarkCaseResult {
  const problems: string[] = []
  for (const needle of item.requiresGuidance ?? []) {
    if (!artifacts.guidance.some(line => line.includes(needle))) {
      problems.push(`no guidance line contains "${needle}"`)
    }
  }
  for (const name of item.requiresSkillNames ?? []) {
    if (!artifacts.skills.some(skill => skill.name === name)) {
      problems.push(`skill "${name}" is absent`)
    }
  }
  for (const requirement of item.requiresSkillContent ?? []) {
    const skill = artifacts.skills.find(candidate => candidate.name === requirement.skill)
    if (skill === undefined) {
      problems.push(`skill "${requirement.skill}" is absent`)
    } else if (!skill.content.includes(requirement.contains)) {
      problems.push(`skill "${requirement.skill}" content lacks "${requirement.contains}"`)
    }
  }
  if (item.maxGuidanceChars !== undefined) {
    const total = artifacts.guidance.reduce((sum, line) => sum + line.length, 0)
    if (total > item.maxGuidanceChars) {
      problems.push(`guidance carries ${total} characters, above the ${item.maxGuidanceChars} ceiling`)
    }
  }
  return {
    name: item.name,
    passed: problems.length === 0,
    weight: item.weight,
    detail: problems.length === 0 ? 'passed' : problems.join('; '),
  }
}

/**
 * Service Provider for `ctx.rsiBenchmark`: a deterministic policy-conformance
 * benchmark over the configured cases. It measures whether the distilled
 * surface actually carries the deployment's required policy, not end-task
 * quality; mount a different provider for model-scored evaluation.
 */
export class FixtureRsiBenchmark extends RsiBenchmark {
  static Config: z<FixtureBenchmarkConfig> = z.object({
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
  })

  private readonly cases: readonly FixtureCase[]

  /**
   * @param ctx - provider context.
   * @param config - case definition configuration.
   */
  constructor(ctx: Context, config: FixtureBenchmarkConfig) {
    const cases = resolveFixtureCases(config.cases ?? [])
    super(ctx)
    this.cases = cases
  }

  /**
   * Score one artifact set as passed weight over total weight.
   * @param request - the generation under evaluation.
   * @param _signal - cancellation signal; the deterministic evaluation never awaits.
   * @returns the deterministic report.
   */
  evaluate(request: RsiBenchmarkRequest, _signal: AbortSignal): Promise<RsiBenchmarkReport> {
    const cases: RsiBenchmarkCaseResult[] = this.cases.map(item => evaluateCase(item, request.generation.artifacts))
    // resolveFixtureCases guarantees at least one positive-weight case.
    const total = cases.reduce((sum, item) => sum + item.weight, 0)
    const passed = cases.filter(item => item.passed).reduce((sum, item) => sum + item.weight, 0)
    return Promise.resolve({
      provider: 'fixture',
      scoredAt: Date.now(),
      score: passed / total,
      cases,
    })
  }
}
