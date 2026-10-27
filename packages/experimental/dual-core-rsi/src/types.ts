/**
 * Domain types for the dual-core RSI mode: generations of the improvable
 * surface, benchmark evidence, cycle records, and rollback archives.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi/types
 */

import type { RsiArchiveId, RsiCycleId, RsiGenerationId } from './branding.ts'

export type { RsiArchiveId, RsiCycleId, RsiGenerationId }

/**
 * How one generation's artifacts came to exist. `initial` generations are
 * seeded baselines (including post-swap daemon copies); `distilled`
 * generations were produced by a daemon distillation cycle.
 */
export type RsiGenerationOrigin = 'initial' | 'distilled'

/** One distilled skill document in the improvable surface. */
export interface RsiSkillArtifact {
  /** Kebab-case skill name, unique within one artifact set. */
  readonly name: string
  /** Short routing description shown in skill discovery. */
  readonly description: string
  /** Markdown instruction body. */
  readonly content: string
}

/**
 * The improvable surface owned by this package: system-prompt guidance lines
 * plus runtime skill documents. Applying one artifact set to an agent scope
 * is a pure registration step; the set itself is plain validated data.
 */
export interface RsiArtifacts {
  /** Ordered guidance lines rendered into one distilled-policy prompt section. */
  readonly guidance: readonly string[]
  /** Distilled skill documents. */
  readonly skills: readonly RsiSkillArtifact[]
}

/** One case outcome inside a benchmark report. */
export interface RsiBenchmarkCaseResult {
  /** Case name from the benchmark definition. */
  readonly name: string
  /** Whether the case passed for the evaluated artifact set. */
  readonly passed: boolean
  /** Case weight from the benchmark definition. */
  readonly weight: number
  /** Human-readable pass or failure explanation. */
  readonly detail: string
}

/** Deterministic evaluation evidence for one artifact set. */
export interface RsiBenchmarkReport {
  /** Benchmark provider that produced the report. */
  readonly provider: string
  /** Safe-integer epoch milliseconds at scoring time. */
  readonly scoredAt: number
  /** Aggregate score in `[0, 1]`: passed weight over total weight. */
  readonly score: number
  /** Every case outcome, in definition order. */
  readonly cases: readonly RsiBenchmarkCaseResult[]
}

/** One generation of the improvable surface with its evaluation evidence. */
export interface RsiGeneration {
  readonly id: RsiGenerationId
  readonly origin: RsiGenerationOrigin
  /** Parent generation this one was distilled or seeded from; `null` for the first baseline. */
  readonly parent: RsiGenerationId | null
  /** Safe-integer epoch milliseconds at creation. */
  readonly createdAt: number
  readonly artifacts: RsiArtifacts
  /** Latest benchmark evidence; absent until the generation is first evaluated. */
  readonly benchmark?: RsiBenchmarkReport | undefined
}

/** What triggered one daemon distillation cycle. */
export type RsiCycleTrigger = 'command' | 'tool' | 'schedule'

/** Terminal outcome of one daemon distillation cycle. */
export type RsiCycleOutcome = 'promoted' | 'retained'

/** Durable record of one completed daemon distillation cycle. */
export interface RsiCycleRecord {
  readonly id: RsiCycleId
  readonly trigger: RsiCycleTrigger
  /** Safe-integer epoch milliseconds at cycle start. */
  readonly startedAt: number
  /** Safe-integer epoch milliseconds at cycle settlement. */
  readonly settledAt: number
  readonly outcome: RsiCycleOutcome
  /** Active-core score the candidate was gated against. */
  readonly baselineScore: number
  /** Candidate score produced by this cycle's distillation. */
  readonly candidateScore: number
  /** Candidate score minus baseline score, as a fraction (`0.06` is +6%). */
  readonly improvement: number
  /** Configured promotion threshold in effect for this cycle. */
  readonly threshold: number
  /** Generation this cycle produced. */
  readonly candidateId: RsiGenerationId
  /** One-line distiller rationale for the candidate artifact set. */
  readonly rationale: string
}

/**
 * One archived generation retained for rollback. Archives are created at
 * every core swap (and manual rollback); the archived generation is the
 * complete pre-swap user-core surface including its benchmark evidence, so a
 * rollback restores both the artifacts and the score baseline.
 */
export interface RsiArchiveEntry {
  readonly id: RsiArchiveId
  /** Safe-integer epoch milliseconds at archive time. */
  readonly archivedAt: number
  /** Full pre-swap generation snapshot. */
  readonly generation: RsiGeneration
  /** Generation that replaced the archived one as the active core. */
  readonly supersededBy: RsiGenerationId
  /** Why the generation left the active role. */
  readonly reason: 'swap' | 'rollback'
}

/** Bounded digest of recent user-core sessions fed to a distillation cycle. */
export interface RsiSessionDigest {
  /** Safe-integer epoch milliseconds at digest assembly. */
  readonly assembledAt: number
  /** Digest entries, newest session first. */
  readonly sessions: readonly RsiSessionDigestEntry[]
}

/** One session's bounded contribution to a distillation digest. */
export interface RsiSessionDigestEntry {
  readonly sessionId: string
  /** Total event count of the session at digest time. */
  readonly eventCount: number
  /** Counts per durable event type, in first-observation order. */
  readonly eventCounts: readonly { readonly type: string; readonly count: number }[]
  /** Bounded extracted texts in event order (user and assistant messages). */
  readonly texts: readonly string[]
}

/** Artifact budgets validated at every distillation boundary. */
export interface RsiArtifactBudgets {
  readonly maxGuidanceLines: number
  readonly maxGuidanceLineChars: number
  readonly maxGuidanceChars: number
  readonly maxSkills: number
  readonly maxSkillDescriptionChars: number
  readonly maxSkillContentChars: number
}

/** Request the controller hands to the distiller seam. */
export interface RsiDistillInput {
  /** Current user-core generation. */
  readonly active: RsiGeneration
  /** Current daemon-core generation the candidate improves on. */
  readonly daemon: RsiGeneration
  readonly digest: RsiSessionDigest
  readonly budgets: RsiArtifactBudgets
}

/** Distiller output for one cycle: the complete next artifact set. */
export interface RsiDistillOutput {
  /** Non-empty one-line rationale naming what changed and why. */
  readonly rationale: string
  /** The complete next artifact set; validated against the budgets before use. */
  readonly artifacts: RsiArtifacts
}

/** Request the controller hands to the benchmark seam. */
export interface RsiBenchmarkRequest {
  /** Generation whose artifact set is under evaluation. */
  readonly generation: RsiGeneration
}

/** Read-side projection of the whole dual-core state for tools and command. */
export interface RsiStatusView {
  /** Current user-core generation. */
  readonly active: RsiGeneration
  /** Current daemon-core generation. */
  readonly daemon: RsiGeneration
  /** Configured promotion threshold as a fraction. */
  readonly threshold: number
  /** Most recent completed cycle, when one exists. */
  readonly lastCycle?: RsiCycleRecord | undefined
  /** Whether a daemon cycle is currently running. */
  readonly cycleRunning: boolean
  /** Total rollback archives currently stored. */
  readonly archiveCount: number
  /** Wall-clock knowledge cutoff of the last settled cycle; absent for legacy state. */
  readonly knowledgeCutoffAt?: number | undefined
  /** Live sessions with activity newer than the knowledge cutoff. */
  readonly unseenSessionCount: number
}
