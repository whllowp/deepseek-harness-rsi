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
  /** World-model reliability assessment at round end; absent before the first assessment. */
  reliability: z.enum(['reliable', 'unreliable', 'insufficient']).optional(),
  /** Joined prediction–observation pairs behind the assessment. */
  reliabilityPairs: z.number().int().nonnegative().optional(),
  /** One-line round note (rationale, skip reason, or error). */
  note: z.string().min(1),
  /** Safe-integer epoch milliseconds at round settlement. */
  settledAt: instantSchema,
}).strict()

const predictionSchema = z.object({
  /** Structural fingerprint of the proposed artifact set; joins the proposal row. */
  fingerprint: z.string().min(1),
  /** Policy version (active generation id) the prediction is attributable to. */
  version: z.string().min(1),
  /** Predicted benchmark delta (score change) for the proposal. */
  predictedDelta: z.number(),
  /** Safe-integer epoch milliseconds at prediction. */
  predictedAt: instantSchema,
}).strict()

const adaptationSchema = z.object({
  /** Policy version whose unreliable predictions triggered the adaptation; the table key. */
  version: z.string().min(1),
  /** Mean absolute error of the joined pairs behind the trigger. */
  mae: z.number().min(0),
  /** Joined pairs behind the trigger. */
  pairs: z.number().int().positive(),
  /** Safe-integer epoch milliseconds at adaptation. */
  adaptedAt: instantSchema,
  /** Safe-integer epoch milliseconds when a reliable window ended the adaptation; absent while active. */
  recoveredAt: instantSchema.optional(),
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
    predictions: domainTable<string, RsiWorldModelPrediction>(predictionSchema),
    adaptations: domainTable<string, RsiWorldModelAdaptation>(adaptationSchema),
  },
})

/** One replay-ledger record: a distilled content and the score it earned. */
export type RsiReplayProposal = z.infer<typeof proposalSchema>

/** One recorded evolution round: the cycle outcome with its objective shape. */
export type RsiTrajectoryRound = z.infer<typeof trajectorySchema>

/** One world-model prediction: the replay model's expected delta for a proposal. */
export type RsiWorldModelPrediction = z.infer<typeof predictionSchema>

/** One conditional world-model adaptation event. */
export type RsiWorldModelAdaptation = z.infer<typeof adaptationSchema>
