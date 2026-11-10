# Agent Note: Dual-core RSI evolution plugins over paper mechanisms

Status: implemented

English | [中文](2026-11-11-dual-core-rsi-evolution-plugins.zh.md)

## Problem

The dual-core RSI mode had exactly one distiller strategy and one scalar benchmark, both built into [`dual-core-rsi`](2026-11-04-dual-core-rsi-knowledge-base.md). Two mechanisms from the current self-evolution literature were missing: Dream-RSI (arXiv 2609.14858, §3) evaluates exploration policies offline by replaying accumulated discovery history instead of paying for new rollouts, and Harmony Harness (arXiv 2610.15150) keeps multi-objective gate pressure on the worst-attaining objective instead of letting single-objective optimization quietly sacrifice the rest. Adding either to the dual-core RSI source would couple one research mechanism to the mode's core and contradict the seams the mode already advertises ("alternative providers replace them without config branching").

## Decision

`dual-core-rsi-evolution` is a pure plugin package: three providers over the existing seams, zero changes to dual-core RSI source.

- `DomainReplayLedger` (new `ctx.rsiEvolutionLedger` seam, its own `rsi_evolution` storage domain) records every distilled proposal keyed by the structural fingerprint of its artifact set and joins each benchmark score onto that row — the replay world. Writes are contained: an outage is logged and the cycle still lands.
- `ReplayRsiDistiller` provides `ctx.rsiDistiller`: before delegating it dreams — derives at most `maxLessons` bounded lessons from the joined outcomes (repeated identical content, the strongest and weakest recorded proposals with their score deltas, a frontier summary) and appends them to the mission's knowledge lines; after the child answers it records the proposal. An under-sampled world injects nothing, so early cycles equal the shipped provider.
- `HarmonyRsiBenchmark` provides `ctx.rsiBenchmark`: it delegates case scoring to the shipped fixture evaluator started on a detached context, partitions the cases into configured objective families, and re-scores the report as `1 − max_j λ_j·(1 − attainment_j)` — the weighted Tchebycheff scalarization against the utopia point, deterministic and stateless because attainments are rates in [0, 1]. The gate cannot be cleared by optimizing one family alone.

Mounting shape: each decorator is the row's class, exactly like the shipped rows; the inner provider cannot mount beside its decorator under the same service name, so it is constructed on a detached context whose only tree dependency — the subagents seam for the distiller child — is forwarded, and whose fiber disposes with the decorator. The [evolution bundle](../../../../packages/experimental/dual-core-rsi-evolution-bundle/README.md) composes the three rows as an alternative to the dual-core RSI bundle.

## Alternatives considered

Decorating by re-providing the wrapped service on the same context: rejected, cordis throws on a second `provide` of one name, and reading the inner through the decorator's own fiber resolves the decorator itself (same-name fiber-store entries are last-writer-wins and wiped on inject-driven reloads). `ctx.isolate(name)` scopes: rejected after measurement — the isolated scope's entries are invisible to upward walks from outside, so the consumer on the root context never sees the decorator. Patching the shipped row's `name`: rejected, patch names are assertions, not replacements. Adding the mechanisms to dual-core RSI source: rejected, it would couple research churn to the mode and violate the plugin seam the mode documents.

## Consequences

The mechanisms stay swappable research plugins: replacing either seam needs no dual-core RSI change, and deployments compose the evolution bundle or plain rows. The Tchebycheff gate directly answers the observed failure mode from the real-model A/B, where distiller children optimized the concise-policy case to the detriment of the rest. The replay lessons cost at most `maxLessons` bounded lines per distillation child and nothing on the user core. What does not transfer from the papers: Dream-RSI's online rollout, parallel workers, and replay objective (quality–cost hypervolume minus a parallelism penalty) need a discovery loop with many candidate attempts per round — the dual-core RSI cycle settles one proposal per round — and Harmony's factorized general/environment-specific scopes and composition agent have no counterpart at this seam. The ledger evicts FIFO by insertion, so a rejected direction that later becomes right is forgotten only by age, not by relevance.
