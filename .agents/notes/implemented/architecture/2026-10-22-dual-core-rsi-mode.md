# Agent Note: Dual-core RSI mode over generations of the improvable surface

Status: implemented

English | [中文](2026-10-22-dual-core-rsi-mode.zh.md)

## Problem

The repository's `RSi/` research notes (the Harness² Propose–Probe–Compose summary and the RSI reading list) describe recursive self-improvement by optimizing the harness around a fixed model, with evidence from execution comparisons and adoption gated on measured improvement. The harness had no mode that distilled its own live behavior into policy artifacts, gated adoption on a benchmark delta, or archived replaced policy for rollback. A requested design also named two cores — a user-serving core and a non-interactive daemon core — with a swap when benchmark improvement exceeds a threshold.

## Decision

A core is a generation of the improvable surface, not an OS process. `@deepseek-ai/dsh-experimental-dual-core-rsi` stores generations, archives, and cycle records in the `dual_core_rsi` storage domain; the user core is the artifact set applied to every live agent scope through `agent/created` scoped `ctx.systemPrompt.section` and `ctx.skills.register` registrations, re-applied on every swap and rollback. The daemon core is the artifact set the next cycle distills from, driven as one unowned `ctx.jobs` background job per cycle with model work delegated to one fresh structured-output subagent through the `ctx.subagents` seam; an out-of-process subagent provider therefore moves the daemon's model work to a separate process without new plumbing.

Distillation input is a bounded digest of the newest live sessions (event-type counts plus capped `extractSessionEventText` text). Distiller output crosses a model JSON boundary and is decoded defensively against configured budgets; a violation fails the cycle instead of truncating. Two service seams carry the pluggable roles, each shipped with one provider mounted as its own loader entry: `ctx.rsiDistiller` (`./distiller-subagent`) and `ctx.rsiBenchmark` (`./benchmark-fixture`). The fixture benchmark scores configured policy-conformance cases as passed weight over total weight; it demonstrates the gate mechanics and is explicitly not an end-task quality measure.

A cycle benchmarks the active and candidate generations, promotes only when improvement strictly exceeds the threshold (default 0.05), and on promotion archives the replaced generation in full (artifacts plus benchmark evidence), advances the state pointer, seeds the next daemon generation from the promoted copy, and re-applies artifacts to live agents. On retention the daemon keeps the better-scoring lineage. Inside one operation every durable write precedes the final state-pointer write, so an interrupted swap or rollback leaves the previous cores active with at most orphan records. Rollback restores an archived generation and archives the replaced one with reason `rollback`, so promotion and rollback are both reversible. Delivery is the switched-off optional bundle `@deepseek-ai/dsh-experimental-dual-core-rsi-bundle` ([admission](2026-09-21-experimental-capabilities-as-optional-bundles.md)); cycles run only on explicit human request through `/rsi run` or `rsi_run`.

## Alternatives considered

**Two harness processes exchanging improvements.** The requested wording names two processes, but the harness's unit of user-visible behavior is a scoped agent surface over one composition; a second OS process adds transport and identity machinery without changing what can be improved. The distiller subagent seam already offers out-of-process execution where it matters, and the README states the mapping explicitly.

**Persistent self-modification through the plugin manager.** Editing profile rows or preset revisions makes promotion durable across restarts but couples an experimental loop to installation state and makes rollback a configuration migration. Prompt-scoped artifacts keep every swap instant and reversible while remaining model-visible and therefore session-logged as `system/message` history.

**Score candidates with an LLM judge.** The gate needs reproducible evidence; a model-scored benchmark is nondeterministic and key-dependent. The benchmark seam leaves that to a future provider over deterministic session replay.

## Consequences

The mode is experimental and ships switched off, so default compositions are unchanged; enabling it adds one prompt section and four model tools. End-task evaluation quality is the accepted gap: the shipped benchmark checks policy conformance only, and the README's limitation list states it first. The distiller, benchmark, and digest are seams, so later work can add an end-task benchmark provider or scheduled cycles without touching the controller. Model-visible policy changes travel only through scoped prompt and skill registrations, so every promoted artifact remains reconstructable from session history and no persistent configuration is mutated.
