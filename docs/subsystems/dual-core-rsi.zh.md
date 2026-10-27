# 双核 RSI

[English](dual-core-rsi.md) | 中文

实验性双核 RSI 服务、其蒸馏与基准接缝以及 `/rsi` 命令共享的类型。[双核 RSI Agent Note](../../.agents/notes/implemented/architecture/2026-10-22-dual-core-rsi-mode.zh.md) 持有双核模型，[2026-10-28 的记录](../../.agents/notes/implemented/architecture/2026-10-28-dual-core-rsi-daemon-consult-merge.zh.md) 持有调度守护核、咨询制合入与 git 台账；本页记录来自 [`packages/experimental/dual-core-rsi/src/types.ts`](../../packages/experimental/dual-core-rsi/src/types.ts) 的持久化与客户端可见形式。

## Generations and archives

`RsiGenerationId`、`RsiArchiveId`、`RsiCycleId` 与 `RsiIncidentId` 是由服务持久计数器铸造的[品牌化](core.zh.md#branded-ids)字符串。一个世代携带一套完整产物及其最新基准证据；一份归档内嵌被替换代的完整快照，因此回滚从不依赖其他记录。

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

基准报告以通过权重占总权重之比为一套产物在 `[0, 1]` 内打分，并标明提供者。控制器以候选减活跃的分数差对照配置阈值门控晋升。

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

每个已结算的循环记录其触发来源、双方得分、提升幅度与蒸馏器的一行理由。候选超过阈值的循环以 `pending` 结算；人类的 `merged` 或 `declined` 决策在落定时盖章到记录上。回滚恢复一个归档世代、拒绝任何仍待决的提议，并以 `rollback` 原因归档被替换代，因此每次合入与回滚都可逆。

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

每次失败或超时的调度尝试都记录一条事件，说明哪里坏了、是第几次尝试、守护核如何恢复——退避重试或顺延到下一个间隔。退出合入咨询把上次决策之后结算的事件列为该会话的修复点。

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

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
async history(limit: number = 20): Promise<{ cycles: RsiCycleRecord[]; archives: RsiArchiveEntry[]; incidents: RsiIncidentRecord[] }>

/**
 * Start one daemon cycle as a background job the daemon core owns; the
 * job streams cycle narration and never blocks the caller's step.
 * @param trigger - what started the cycle.
 * @returns the registry-issued job id.
 */
startDaemonJob(trigger: RsiCycleTrigger): JobId
```

Types: [JobId](jobs.zh.md)

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
<!-- END GENERATED cordis-surface -->
