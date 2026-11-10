/**
 * Dual-core RSI evolution plugins: a Dream-RSI-style replay distiller, a
 * Harmony-Harness-style multi-objective benchmark, and their shared replay
 * ledger. All three mount through the existing dual-core RSI seams; this
 * package changes no dual-core RSI source.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi-evolution
 */

export { RsiEvolutionLedger, DomainReplayLedger, artifactsFingerprint } from './ledger.ts'
export type { ReplayLedgerConfig } from './ledger.ts'
export { HarmonyRsiBenchmark } from './harmony-benchmark.ts'
export type { HarmonyBenchmarkConfig, HarmonyObjectiveConfig } from './harmony-benchmark.ts'
export { ReplayRsiDistiller } from './replay-distiller.ts'
export type { ReplayDistillerConfig } from './replay-distiller.ts'
export { rsiEvolutionDomain } from './domain.ts'
export type { RsiReplayProposal } from './domain.ts'
