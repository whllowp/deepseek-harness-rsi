# 双核 RSI

[English](dual-core-rsi.md) | 中文

实验性双核 RSI 服务、其蒸馏与基准接缝以及 `/rsi` 命令共享的类型。[双核 RSI Agent Note](../../.agents/notes/implemented/architecture/2026-10-22-dual-core-rsi-mode.zh.md) 持有双核模型、互换门控与回滚决策；本页记录来自 [`packages/experimental/dual-core-rsi/src/types.ts`](../../packages/experimental/dual-core-rsi/src/types.ts) 的持久化与客户端可见形式。

## Generations and archives

`RsiGenerationId`、`RsiArchiveId` 与 `RsiCycleId` 是由服务持久计数器铸造的[品牌化](core.zh.md#branded-ids)字符串。一个世代携带一套完整产物及其最新基准证据；一份归档内嵌被替换代的完整快照，因此回滚从不依赖其他记录。

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

## Cycles and rollback

每个已结算的循环记录其触发来源、双方得分、提升幅度与蒸馏器的一行理由。回滚恢复一个归档世代，并以 `rollback` 原因归档被替换代，因此每次晋升与回滚都可逆。

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
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdualcorersi--dualcorersiservice"></a>

### `ctx.dualCoreRsi` — `DualCoreRsiService`

The dual-core RSI controller. Owns the durable generation/archive/cycle domain, applies the active generation's artifacts to every live agent scope, runs daemon cycles, gates swaps on benchmark improvement, and executes rollback. Durable writes inside one operation settle through one final state-pointer write, so an interrupted operation leaves the previous pointer with at most orphan records.

```ts cordis-catalog
/** Resolve after the domain is loaded and live agents are attached. */
async waitReady(): Promise<void>

/**
 * Run one daemon distillation cycle: digest the user core's recent
 * sessions, distill a candidate artifact set, benchmark both cores, and
 * swap past the configured improvement threshold. All durable writes
 * happen after successful evaluation; the final state write is the commit
 * point, so an interrupted cycle leaves the previous cores in place.
 * @param trigger - what started the cycle.
 * @param signal - cancellation signal; aborting fails the cycle without state changes.
 * @returns the settled cycle record.
 * @throws RsiError when a cycle is already running or no live agent can anchor distillation.
 */
async runCycle(trigger: RsiCycleTrigger, signal: AbortSignal): Promise<RsiCycleRecord>

/**
 * Roll the user core back to one archived generation. The replaced
 * generation is itself archived, so a rollback is reversible by another
 * rollback.
 * @param archiveId - archive to restore; omission restores the newest archive.
 * @returns the restored generation and the newly created archive entry.
 * @throws RsiError when the archive does not exist.
 */
async rollback(archiveId?: RsiArchiveId): Promise<{ restored: RsiGeneration; archived: RsiArchiveEntry }>

/**
 * Project the current dual-core state for tools and the command.
 * @returns the status view.
 */
async status(): Promise<RsiStatusView>

/**
 * List recent cycles and archives, newest first.
 * @param limit - maximum entries of each kind (default 20).
 * @returns bounded history.
 */
async history(limit: number = 20): Promise<{ cycles: RsiCycleRecord[]; archives: RsiArchiveEntry[] }>

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
