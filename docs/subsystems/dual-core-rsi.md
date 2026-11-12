# Dual-core RSI

English | [中文](dual-core-rsi.zh.md)

Types shared by the experimental dual-core RSI service, its distiller and benchmark seams, and the `/rsi` command. The [dual-core RSI Agent Note](../../.agents/notes/implemented/architecture/2026-10-22-dual-core-rsi-mode.md) owns the two-core model and the [2026-10-28 note](../../.agents/notes/implemented/architecture/2026-10-28-dual-core-rsi-daemon-consult-merge.md) owns the scheduled daemon, the consult-gated merge, and the git ledger; this page records the durable and client-visible forms from [`packages/experimental/dual-core-rsi/src/types.ts`](../../packages/experimental/dual-core-rsi/src/types.ts). The [evolution plugins](../../packages/experimental/dual-core-rsi-evolution/README.md) mount a Dream-RSI-style replay distiller and a Harmony-Harness-style multi-objective benchmark over these same seams without changing this package.

## Generations and archives

`RsiGenerationId`, `RsiArchiveId`, `RsiCycleId`, and `RsiIncidentId` are [branded](core.md#branded-ids) strings minted by the service's durable counters. A generation carries one complete artifact set plus its latest benchmark evidence; an archive embeds the full pre-merge generation so rollback never depends on another record.

```ts type-equiv
/** One distilled skill document in the improvable surface. */
interface RsiSkillArtifact {
  /** Kebab-case skill name, unique within one artifact set. */
  readonly name: string
  /** Short routing description shown in skill discovery. */
  readonly description: string
  /** Markdown instruction body. */
  readonly content: string
}
```

```ts type-equiv
/**
 * The improvable surface owned by this package: system-prompt guidance lines
 * plus runtime skill documents. Applying one artifact set to an agent scope
 * is a pure registration step; the set itself is plain validated data.
 */
interface RsiArtifacts {
  /** Ordered guidance lines rendered into one distilled-policy prompt section. */
  readonly guidance: readonly string[]
  /** Distilled skill documents. */
  readonly skills: readonly RsiSkillArtifact[]
}
```

```ts type-equiv
/** One generation of the improvable surface with its evaluation evidence. */
interface RsiGeneration {
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
```

## Benchmark evidence

A benchmark report scores one artifact set in `[0, 1]` as passed weight over total weight and names its provider. The controller gates promotion on the candidate-minus-active score difference against the configured threshold.

```ts type-equiv
/** Deterministic evaluation evidence for one artifact set. */
interface RsiBenchmarkReport {
  /** Benchmark provider that produced the report. */
  readonly provider: string
  /** Safe-integer epoch milliseconds at scoring time. */
  readonly scoredAt: number
  /** Aggregate score in `[0, 1]`: passed weight over total weight. */
  readonly score: number
  /** Every case outcome, in definition order. */
  readonly cases: readonly RsiBenchmarkCaseResult[]
}
```

## Cycles, decisions, and rollback

Each settled cycle records its trigger, both scores, the improvement, and the distiller's one-line rationale. A cycle whose candidate beats the threshold settles as `promoted` with decision `merged` under the default `auto` policy, because the daemon adopts it in the background; under `consult` it settles as `pending`, and the human `merged` or `declined` decision is stamped onto the record when it settles. Rollback restores an archived generation, declines any still-pending offer, and archives the replaced one with reason `rollback`, so every merge and rollback is reversible.

```ts type-equiv
/** Durable record of one completed daemon distillation cycle. */
interface RsiCycleRecord {
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
  /** Human decision that settled a pending candidate; absent until decided. */
  readonly decision?: RsiMergeDecision | undefined
  /** Safe-integer epoch milliseconds of the decision; absent until decided. */
  readonly decidedAt?: number | undefined
}
```

## Self-repair incidents

Every failed or timed-out scheduled attempt records one incident naming what broke, which attempt it was, and how the daemon recovered — retried with backoff or deferred to the next interval tick. The exit merge consult lists the incidents settled since the last decision as the session's fix points.

```ts type-equiv
/**
 * Durable record of one scheduled daemon cycle attempt that failed and was
 * recovered in-process: the daemon timeboxes every scheduled attempt, records
 * what broke, retries with backoff, and defers to the next interval once the
 * retry budget is spent, so a failing cycle never wedges the daemon.
 */
interface RsiIncidentRecord {
  readonly id: RsiIncidentId
  /** Safe-integer epoch milliseconds at the failed attempt's start. */
  readonly startedAt: number
  /** Safe-integer epoch milliseconds at failure settlement. */
  readonly settledAt: number
  readonly kind: RsiIncidentKind
  /** Actionable failure report of the aborted or rejected attempt. */
  readonly detail: string
  /** 1-based attempt number inside the daemon round. */
  readonly attempt: number
  readonly recovery: RsiIncidentRecovery
  /** Milliseconds the daemon waits before its next attempt or interval tick. */
  readonly retryAfterMs: number
}
```

## Activity view

The `activity` Remote query projects what the daemon did in the background for client surfaces such as the Self-evolution sidebar panel: the newest 20 adopted evolutions and the newest 20 self-repair incidents, newest first.

```ts type-equiv
/**
 * One background evolution shown to the user: a policy the daemon adopted
 * (automatically under `auto`, or through a human merge under `consult`).
 */
interface RsiEvolutionEntry {
  readonly cycleId: RsiCycleId
  /** Generation that became the active policy. */
  readonly generationId: RsiGenerationId
  readonly trigger: RsiCycleTrigger
  /** Safe-integer epoch milliseconds of adoption. */
  readonly adoptedAt: number
  readonly baselineScore: number
  readonly candidateScore: number
  readonly improvement: number
  readonly rationale: string
  /** Adopted guidance lines, in order. */
  readonly guidance: readonly string[]
  /** Names of the adopted skill documents. */
  readonly skills: readonly string[]
}
```

## Long-term knowledge base

Each settled cycle and each recorded self-repair deposits one-line lessons into a durable knowledge table; every later distillation reads the newest entries so lessons outlive the policy generations that learned them.

```ts type-equiv
/**
 * One entry of the daemon's long-term knowledge base: a single normalized
 * line deposited when a cycle settles or a self-repair recovers, recalled by
 * every later distillation so lessons outlive the policy generations that
 * learned them. Exact duplicates are never deposited twice.
 */
interface RsiKnowledgeEntry {
  readonly id: RsiKnowledgeId
  readonly kind: RsiKnowledgeKind
  /** One normalized knowledge line, bounded at deposit time. */
  readonly text: string
  /** Cycle whose settlement deposited the entry; absent for repair lessons, which incidents deposit between cycles. */
  readonly sourceCycleId?: RsiCycleId | undefined
  /** Safe-integer epoch milliseconds at deposit. */
  readonly depositedAt: number
}
```


<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdualcorersi--dualcorersiservice"></a>

### `ctx.dualCoreRsi` — `DualCoreRsiService`

The dual-core RSI controller. Owns the durable generation/archive/cycle domain, applies the active generation's artifacts to every live agent scope, runs scheduled daemon cycles with per-attempt timeboxing and retry self-repair, parks gate-passing candidates as pending merge decisions, consults the human when the session exits, executes merge and decline, and records adopted generations in the local git ledger. Durable writes inside one operation settle through one final state-pointer write, so an interrupted operation leaves the previous pointer with at most orphan records.

```ts cordis-catalog
/** Resolve after the domain is loaded, live agents are attached, and the daemon is armed. */
async waitReady(): Promise<void>

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
async runCycle(trigger: RsiCycleTrigger, signal: AbortSignal): Promise<RsiCycleRecord>

/**
 * Merge the pending candidate: replace the active policy, archive the
 * replaced surface, keep the better daemon lineage, re-apply artifacts, and
 * record the adopted generation in the local git ledger.
 * @param source - where the human decision came from.
 * @returns the settled merge result, including the ledger outcome.
 * @throws RsiError when no candidate is pending.
 */
async mergePending(source: RsiDecisionSource): Promise<RsiMergeResult>

/**
 * Decline the pending candidate: keep the active policy and clear the
 * pending decision; the daemon lineage already kept its better score.
 * @param source - where the human decision came from.
 * @returns the settled decline result.
 * @throws RsiError when no candidate is pending.
 */
async declinePending(source: RsiDecisionSource): Promise<RsiDeclineResult>

/**
 * Roll the user core back to one archived generation. The replaced
 * generation is itself archived and recorded in the git ledger, so a
 * rollback is reversible by another rollback. A pending candidate does not
 * survive a rollback: the human chose the restored policy over it.
 * @param archiveId - archive to restore; omission restores the newest archive.
 * @returns the restored generation, the newly created archive entry, and the ledger outcome.
 * @throws RsiError when the archive does not exist.
 */
async rollback(archiveId?: RsiArchiveId): Promise<{ restored: RsiGeneration; archived: RsiArchiveEntry; ledger: RsiLedgerOutcome }>

/**
 * Project the current dual-core state for tools and the command.
 * @returns the status view.
 */
async status(): Promise<RsiStatusView>

/**
 * List recent cycles, archives, and self-repair incidents, newest first.
 * @param limit - maximum entries of each kind (default 20).
 * @returns bounded history.
 */
async history(limit: number = 20): Promise<{ cycles: RsiCycleRecord[] archives: RsiArchiveEntry[] incidents: RsiIncidentRecord[] knowledge: RsiKnowledgeEntry[] }>

/**
 * Read the daemon's recent background evolutions and self-repairs for
 * client surfaces (the sidebar panel), bounded and newest first.
 * @returns the activity view.
 */
@Remote('activity') async activity(): Promise<RsiActivityView>

/**
 * Start one human-requested daemon cycle as a background job; the job
 * streams cycle narration and never blocks the caller's step. An owning
 * session places the job under that agent's job controller, which the Web
 * composition mounts per agent; without one the job is unowned and needs a
 * context-global controller.
 * @param trigger - what started the cycle.
 * @param owner - session whose live agent owns the job, when one requested it.
 * @returns the registry-issued job id.
 */
startDaemonJob(trigger: RsiCycleTrigger, owner?: SessionId): JobId
```

Types: [JobId](jobs.md) · [SessionId](core.md)

Source: [`packages/experimental/dual-core-rsi/src/index.ts`](../../packages/experimental/dual-core-rsi/src/index.ts)

<a id="ctxrsibenchmark--rsibenchmark-abstract-seam"></a>

### `ctx.rsiBenchmark` — `RsiBenchmark` (abstract seam)

Service Definition of the benchmark seam. One `evaluate` call scores one generation's artifact set and returns deterministic evidence; the score feeds the swap gate, so implementations must be reproducible for the same request.

```ts cordis-catalog
/**
 * Score one generation's artifact set.
 * @param request - the generation under evaluation.
 * @param signal - cancellation signal owned by the cycle trigger.
 * @returns the deterministic benchmark report.
 */
abstract evaluate(request: RsiBenchmarkRequest, signal: AbortSignal): Promise<RsiBenchmarkReport>
```

Source: [`packages/experimental/dual-core-rsi/src/benchmark.ts`](../../packages/experimental/dual-core-rsi/src/benchmark.ts)

<a id="ctxrsidistiller--rsidistiller-abstract-seam"></a>

### `ctx.rsiDistiller` — `RsiDistiller` (abstract seam)

Service Definition of the distiller seam. One `distill` call produces the complete next artifact set for the daemon core from the digest of the user core's recent sessions. Implementations are trusted same-process providers; artifact budgets are validated by the consumer after return.

```ts cordis-catalog
/**
 * Distill one complete next artifact set.
 * @param input - current generations, session digest, and artifact budgets.
 * @param options - anchor agent and cancellation signal.
 * @returns the distiller's rationale and complete next artifact set.
 */
abstract distill(input: RsiDistillInput, options: RsiDistillOptions): Promise<RsiDistillOutput>
```

Source: [`packages/experimental/dual-core-rsi/src/distiller.ts`](../../packages/experimental/dual-core-rsi/src/distiller.ts)

<a id="ctxrsievolutionledger--rsievolutionledger-abstract-seam"></a>

### `ctx.rsiEvolutionLedger` — `RsiEvolutionLedger` (abstract seam)

Service Definition of the replay ledger. One row per distinct proposal content; benchmark scores join by fingerprint. Ledger writes settle on their own domain and never join a cycle commit.

```ts cordis-catalog
/**
 * Record one distilled proposal, upserting its content row: repeats bump
 * the count and refresh the proposal facts; the score side is untouched.
 * @param artifacts - the proposed artifact set.
 * @param observation - the proposal facts to store.
 * @param observation.rationale - distiller rationale (bounded at rest).
 * @param observation.matchedActive - whether the content equaled the then-active policy.
 * @param observation.baselineScore - active policy's recorded score at distill time, when known.
 * @returns resolution when the row is durable.
 */
abstract recordProposal(artifacts: RsiArtifacts, observation: { rationale: string matchedActive: boolean baselineScore?: number }): Promise<void>

/**
 * Record the latest benchmark score for one artifact set's content.
 * @param artifacts - the evaluated artifact set.
 * @param score - the earned score.
 * @returns resolution when the row is durable; content never proposed resolves too (no row to join).
 */
abstract recordScore(artifacts: RsiArtifacts, score: number): Promise<void>

/**
 * Snapshot every recorded proposal, oldest by first distillation first.
 * @returns the bounded ledger rows.
 */
abstract entries(): Promise<readonly RsiReplayProposal[]>

/**
 * Settle one evolution trajectory round.
 * @param round - the settled round record.
 * @returns resolution when the row is durable.
 */
abstract recordRound(round: RsiTrajectoryRound): Promise<void>

/**
 * Every recorded trajectory round, oldest first.
 * @returns the bounded round rows.
 */
abstract trajectoryRounds(): Promise<readonly RsiTrajectoryRound[]>

/**
 * Record one world-model prediction for a proposal under a policy version.
 * Re-predicting the same content under the same version upserts the row.
 * @param version - the policy version the prediction is attributable to.
 * @param fingerprint - the proposed artifact set's fingerprint.
 * @param predictedDelta - the replay model's expected benchmark delta.
 * @returns resolution when the row is durable.
 */
abstract recordPrediction(version: string, fingerprint: string, predictedDelta: number): Promise<void>

/**
 * Every prediction recorded under one policy version, as a fingerprint to
 * predicted-delta map.
 * @param version - the policy version to read.
 * @returns the fingerprint to predicted-delta map.
 */
abstract predictionsFor(version: string): Promise<ReadonlyMap<string, number>>

/**
 * Record or refresh the conditional world-model adaptation for a policy
 * version (upsert keyed by version; clears any recovery).
 * @param version - the policy version whose predictions are unreliable.
 * @param mae - the mean absolute error behind the trigger.
 * @param pairs - the joined pairs behind the trigger.
 * @returns resolution when the row is durable.
 */
abstract recordAdaptationFor(version: string, mae: number, pairs: number): Promise<void>

/**
 * Mark a version's conditional adaptation as recovered (a reliable window
 * ended it).
 * @param version - the policy version to clear.
 * @returns resolution when the row is durable; versions without an adaptation resolve too.
 */
abstract markAdaptationRecoveredFor(version: string): Promise<void>

/**
 * Whether a conditional adaptation is active for one policy version.
 * @param version - the policy version to check.
 * @returns true while an adaptation exists without a recovery.
 */
abstract isAdaptedFor(version: string): Promise<boolean>
```

Source: [`packages/experimental/dual-core-rsi-evolution/src/ledger.ts`](../../packages/experimental/dual-core-rsi-evolution/src/ledger.ts)

<a id="ctxrsievolutiontrajectory--evolutiontrajectory-abstract-seam"></a>

### `ctx.rsiEvolutionTrajectory` — `EvolutionTrajectory` (abstract seam)

Service Definition of the evolution trajectory. Every round runs one daemon cycle through the controller, snapshots the objective shape and the Tchebycheff pressure direction, and settles one durable trajectory row plus one JSONL line, so a ten-round evolution leaves a replayable log and a renderable topology.

```ts cordis-catalog
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

/**
 * Every recorded trajectory round, oldest first.
 * @returns the round rows in round order.
 */
abstract rounds(): Promise<readonly RsiTrajectoryRound[]>
```

Source: [`packages/experimental/dual-core-rsi-evolution/src/trajectory.ts`](../../packages/experimental/dual-core-rsi-evolution/src/trajectory.ts)

<a id="ctxrsiworldmodel--worldmodel-abstract-seam"></a>

### `ctx.rsiWorldModel` — `WorldModel` (abstract seam)

Service Definition of the prediction-reliability world model. Reliability follows the version rule: only predictions recorded under the assessed policy version join the window, so proposals distilled under earlier policies never contaminate the current error estimate.

```ts cordis-catalog
/**
 * Assess prediction reliability for one policy version from the replay
 * ledger's joined prediction–observation pairs. An insufficient window
 * (fewer joined pairs than `minPairs`) is reported as insufficient rather
 * than treated as evidence of reliability. An unreliable sufficient window
 * triggers a conditional adaptation; a later reliable window ends it.
 * @param version - the policy version (active generation id) to assess.
 * @returns the classification with its supporting pairs and mean absolute error.
 */
abstract assess(version: string): Promise<ReliabilityAssessment>

/**
 * Whether the conservative dream admission is active for one policy
 * version (a conditional adaptation fired and no reliable window has
 * ended it).
 * @param version - the policy version to check.
 * @returns true while the adaptation is active.
 */
abstract isAdapted(version: string): Promise<boolean>
```

Source: [`packages/experimental/dual-core-rsi-evolution/src/world-model.ts`](../../packages/experimental/dual-core-rsi-evolution/src/world-model.ts)

<a id="dual-core-rsi-events"></a>

### `dual-core-rsi/*` events

<a id="dual-core-rsichanged--emit"></a>

#### `dual-core-rsi/changed` — emit

Durable dual-core RSI activity changed: a cycle settled, a candidate was adopted or declined, an incident landed, or a rollback ran; clients refetch the activity view.

```ts cordis-catalog
/**
 * Durable dual-core RSI activity changed: a cycle settled, a candidate was
 * adopted or declined, an incident landed, or a rollback ran; clients
 * refetch the activity view.
 * @mode emit
 */
'dual-core-rsi/changed'(): void
```

Source: [`packages/experimental/dual-core-rsi/src/types.ts`](../../packages/experimental/dual-core-rsi/src/types.ts)
<!-- END GENERATED cordis-surface -->
