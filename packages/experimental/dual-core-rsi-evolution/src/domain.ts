/**
 * Durable evolution-plugin storage: the `rsi_evolution` domain over
 * `ctx.storageDomain`, holding the replay ledger that correlates distilled
 * proposals with the benchmark scores they later earned.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi-evolution/domain
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const instantSchema = z.number().int().nonnegative()

const proposalSchema = z.object({
  /** Structural fingerprint of the proposed artifact set; the table key. */
  fingerprint: z.string().min(1),
  /** Wall clock of the first distillation that produced this content. */
  firstDistilledAt: instantSchema,
  /** Wall clock of the most recent distillation producing this content. */
  lastDistilledAt: instantSchema,
  /** How many distillations produced this content, including repeats. */
  distilledCount: z.number().int().positive(),
  /** Distiller rationale of the most recent proposal. */
  rationale: z.string(),
  /** First guidance line of the most recent proposal; empty for guidance-less sets. */
  firstGuidance: z.string(),
  /** Total guidance characters and line count of the most recent proposal. */
  guidanceChars: z.number().int().nonnegative(),
  guidanceLines: z.number().int().nonnegative(),
  /** Skill count of the most recent proposal. */
  skillCount: z.number().int().nonnegative(),
  /** Whether the proposal equaled the then-active policy's content. */
  matchedActive: z.boolean(),
  /** Active policy's recorded score at distill time; absent when never scored. */
  baselineScore: z.number().min(0).max(1).optional(),
  /** Latest benchmark score this content earned; absent until first evaluated. */
  score: z.number().min(0).max(1).optional(),
  /** Wall clock of the latest score. */
  scoredAt: instantSchema.optional(),
}).strict()

const objectiveAttainmentSchema = z.object({
  /** Objective family name. */
  name: z.string().min(1),
  /** Family attainment in [0, 1]. */
  attainment: z.number().min(0).max(1),
  /** Family weight in the Tchebycheff scalarization. */
  weight: z.number().positive(),
}).strict()

/** One objective family attainment snapshot. */
export interface ObjectiveAttainment {
  /** Objective family name. */
  readonly name: string
  /** Family attainment in [0, 1]. */
  readonly attainment: number
  /** Family weight in the Tchebycheff scalarization. */
  readonly weight: number
}

const trajectorySchema = z.object({
  /** 1-based evolution round; the table key. */
  round: z.number().int().positive(),
  /** Cycle id this round settled, when the controller settled one. */
  cycleId: z.string().min(1).optional(),
  /** Active generation id at round start. */
  activeId: z.string().min(1),
  /** Candidate generation id the cycle produced, when one was evaluated. */
  candidateId: z.string().min(1).optional(),
  /** Round outcome: promoted, retained, pending, or a skip/failure reason. */
  outcome: z.string().min(1),
  /** Active policy's benchmark score at round start; absent when unscored. */
  baselineScore: z.number().min(0).max(1).optional(),
  /** Candidate score; absent for rounds that evaluated nothing. */
  candidateScore: z.number().min(0).max(1).optional(),
  /** Per-objective attainments of the active policy after the round. */
  objectives: z.array(objectiveAttainmentSchema),
  /** Objective with the largest weighted shortfall — the Tchebycheff pressure direction. */
  pressureObjective: z.string().min(1).optional(),
  /** Replay-ledger rows at round end. */
  ledgerRows: z.number().int().nonnegative(),
  /** Long-term knowledge entries at round end. */
  knowledgeRows: z.number().int().nonnegative(),
  /** One-line round note (rationale, skip reason, or error). */
  note: z.string().min(1),
  /** Safe-integer epoch milliseconds at round settlement. */
  settledAt: instantSchema,
}).strict()

/**
 * Authoritative evolution-plugin storage; malformed records reject opening
 * the domain. Fingerprints are structural artifact hashes, so re-proposing
 * identical content upserts the same row and its latest score survives.
 */
export const rsiEvolutionDomain = defineDomain({
  name: 'rsi_evolution',
  version: 1,
  tables: {
    proposals: domainTable<string, RsiReplayProposal>(proposalSchema),
    trajectory: domainTable<string, RsiTrajectoryRound>(trajectorySchema),
  },
})

/** One replay-ledger record: a distilled content and the score it earned. */
export type RsiReplayProposal = z.infer<typeof proposalSchema>

/** One recorded evolution round: the cycle outcome with its objective shape. */
export type RsiTrajectoryRound = z.infer<typeof trajectorySchema>
