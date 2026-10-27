/**
 * Durable dual-core RSI storage: the `dual-core-rsi` domain over
 * `ctx.storageDomain`, holding generations, archives, cycle records, and the
 * singleton pointer state.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi/domain
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { RsiArchiveId, RsiCycleId, RsiGenerationId } from './branding.ts'
import type {
  RsiArchiveEntry, RsiBenchmarkCaseResult, RsiBenchmarkReport, RsiCycleRecord,
  RsiGeneration, RsiSkillArtifact,
} from './types.ts'

const instantSchema = z.number().int().nonnegative()

const skillSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  content: z.string().min(1),
}).strict()

const artifactsSchema = z.object({
  guidance: z.array(z.string().min(1)),
  skills: z.array(skillSchema),
}).strict()

const caseResultSchema = z.object({
  name: z.string().min(1),
  passed: z.boolean(),
  weight: z.number().positive(),
  detail: z.string(),
}).strict()

const benchmarkSchema = z.object({
  provider: z.string().min(1),
  scoredAt: instantSchema,
  score: z.number().min(0).max(1),
  cases: z.array(caseResultSchema),
}).strict()

const generationSchema = z.object({
  id: z.string().min(1).transform(RsiGenerationId),
  origin: z.enum(['initial', 'distilled']),
  parent: z.string().min(1).transform(RsiGenerationId).nullable(),
  createdAt: instantSchema,
  artifacts: artifactsSchema,
  benchmark: benchmarkSchema.optional(),
}).strict()

const archiveSchema = z.object({
  id: z.string().min(1).transform(RsiArchiveId),
  archivedAt: instantSchema,
  generation: generationSchema,
  supersededBy: z.string().min(1).transform(RsiGenerationId),
  reason: z.enum(['swap', 'rollback']),
}).strict()

const cycleSchema = z.object({
  id: z.string().min(1).transform(RsiCycleId),
  trigger: z.enum(['command', 'tool', 'schedule']),
  startedAt: instantSchema,
  settledAt: instantSchema,
  outcome: z.enum(['promoted', 'retained']),
  baselineScore: z.number().min(0).max(1),
  candidateScore: z.number().min(0).max(1),
  improvement: z.number().min(-1).max(1),
  threshold: z.number().min(0).max(1),
  candidateId: z.string().min(1).transform(RsiGenerationId),
  rationale: z.string(),
}).strict()

const stateSchema = z.object({
  activeId: z.string().min(1).transform(RsiGenerationId),
  daemonId: z.string().min(1).transform(RsiGenerationId),
  cycleCounter: z.number().int().nonnegative(),
  generationCounter: z.number().int().nonnegative(),
  archiveCounter: z.number().int().nonnegative(),
  /** Wall-clock knowledge cutoff of the last settled cycle; absent in pre-freshness records. */
  knowledgeCutoffAt: z.number().int().nonnegative().optional(),
}).strict()

/**
 * Singleton pointer record key: which generations currently serve the user
 * and daemon cores, plus the durable id counters.
 */
export const RSI_STATE_KEY = 'main'

/** Authoritative dual-core RSI storage; malformed records reject opening the domain. */
export const dualCoreRsiDomain = defineDomain({
  name: 'dual_core_rsi',
  version: 1,
  tables: {
    state: domainTable<typeof RSI_STATE_KEY, RsiStateRecord>(stateSchema),
    generations: domainTable<RsiGenerationId, RsiGeneration>(generationSchema),
    archives: domainTable<RsiArchiveId, RsiArchiveEntry>(archiveSchema),
    cycles: domainTable<RsiCycleId, RsiCycleRecord>(cycleSchema),
  },
})

/** Decoded singleton state record type. */
export type RsiStateRecord = z.infer<typeof stateSchema>

export type {
  RsiArchiveEntry,
  RsiBenchmarkCaseResult,
  RsiBenchmarkReport,
  RsiCycleRecord,
  RsiGeneration,
  RsiSkillArtifact,
}
