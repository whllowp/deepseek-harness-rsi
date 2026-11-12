---
description: "Dual-core RSI evolution plugins: a Dream-RSI-style replay distiller that dreams over recorded proposal/score outcomes, a Harmony-Harness-style multi-objective benchmark whose Tchebycheff gate keeps pressure on the worst objective, and their shared replay ledger, a world model that gates the dream on prediction reliability (arXiv 2610.13912), and a trajectory runner that settles each round into a JSONL log and topology graph, all mounted through the existing dual-core RSI seams without changing dual-core RSI source."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-dual-core-rsi-evolution

English | [中文](README.zh.md)

## Summary

`dual-core-rsi-evolution` evolves the [dual-core RSI mode](../dual-core-rsi/README.md) through its provider seams instead of its source: a replay distiller in the Dream-RSI style (arXiv 2609.14858) treats every recorded proposal and its later benchmark score as a replay world, dreams over that history before each distillation, and injects the realized outcomes as lessons; a Harmony benchmark in the Harmony-Harness style (arXiv 2610.15150) scores the case families as objectives and scalarizes them by weighted Tchebycheff, so the gate keeps its pressure on whichever objective attains worst. A world model in the RSI-Anything style (arXiv 2610.13912) judges the replay model itself — every distillation records a prediction, every joined score is its observation, and a sliding window of prediction–observation pairs classifies reliability and gates the dream behind a conditional adaptation; a trajectory runner drives bounded rounds of the composed cycle and settles each into a durable row, a JSONL log, and a topology graph. All mount exactly where the shipped providers mount; the [evolution bundle](../dual-core-rsi-evolution-bundle/README.md) composes them.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Enable the [dual-core RSI evolution bundle](../dual-core-rsi-evolution-bundle/README.md) in place of the dual-core RSI bundle (mount one or the other, never both), or compose this package directly: mount `./evolution-ledger`, then `./harmony-benchmark` in place of the fixture benchmark row, then `./replay-distiller` in place of the distiller-subagent row, then `./world-model` beside the ledger, and the dual-core RSI service after them; `./trajectory` is optional and drives its own rounds instead of the daemon. The ledger and world model require the `storageDomain` service; the providers require the ledger. Everything else — sessions, projections, storage, jobs — is the same composition the dual-core RSI mode already needs.

### The replay ledger

Every distillation the replay distiller performs records one proposal row keyed by the structural fingerprint of its artifact set: the rationale, the first guidance line, the shape of the set, whether the content equaled the then-active policy, and the active policy's recorded score at that moment. Every evaluation the Harmony benchmark performs joins its score onto the row of the evaluated content. Repeats of the same content upsert the same row, the oldest rows are evicted past `maxProposals`, and the ledger settles in its own `rsi_evolution` storage domain — never inside a cycle commit.

### Dreaming before distilling

Before each distillation the replay distiller replays the world: rows whose scores joined become outcomes, and from them it derives at most `maxLessons` lessons appended after the controller's own knowledge lines — a rejection lesson when the active policy's exact content keeps being reproposed, an insight naming the strongest recorded proposal with its score against the active policy, a rejection naming the weakest recorded direction, and a frontier summary counting how many proposals scored above their contemporaries. An under-sampled world injects nothing, so the first cycles behave exactly like the shipped provider. After the child answers, the proposal joins the ledger for the scores that follow.

### The trajectory record

`./trajectory` mounts `ctx.rsiEvolutionTrajectory`: each `runRounds` round starts one daemon cycle through the composed controller, snapshots the active policy's objective attainments and the largest weighted shortfall (the Tchebycheff pressure direction), and settles one durable row plus one JSONL line. A failed round is recorded and the remaining rounds continue, so ten rounds leave a replayable log and a topology of promotions and retentions.

### The world-model gate

`./world-model` mounts `ctx.rsiWorldModel`: a sliding window over the prediction–observation pairs attributable to the current policy version classifies as `reliable`, `unreliable`, or `insufficient` — pairs below `minPairs` are insufficient and never count as evidence of reliability, and a sufficient window is unreliable once its mean absolute error passes `errorThreshold`. An unreliable window triggers a conditional adaptation: the dream runs conservative admission, suppressing its own directional lessons and minting a world-model warning instead, until a later reliable window ends the adaptation.

### The Tchebycheff gate

The Harmony benchmark delegates case scoring to the shipped fixture evaluator and re-scores the report: the configured `objectives` partition the case set into named families, each family's attainment is its passed weight over total weight, and the score is `1 − max_j λ_j · (1 − attainment_j)` — the weighted Tchebycheff scalarization against the utopia point. Attainments are rates in [0, 1], so no state is needed and the score stays deterministic. A proposal strong on one objective and weak on another scores below a balanced one: the gate cannot be cleared by optimizing a single family, which is the Harmony result this plugin borrows. With no `objectives` configured, one `general` family covers every case and the score equals the fixture's own. Each objective also appears in the report as a synthetic case carrying its attainment, so `/rsi` output and any benchmark consumer see the families.

### Config

| Field | Default | Meaning |
|---|---|---|
| `maxProposals` | `200` | Maximum replay-ledger rows retained (oldest evicted). |
| `subagentProvider` | `spawn` | Fresh structured-output provider for the daemon child (forwarded to the shipped distiller). |
| `maxLessons` | `3` | Maximum replay lessons injected into one distillation. |
| `minSamples` | `2` | Minimum joined outcome rows before any lesson is injected. |
| `cases` | — | Case definition forwarded to the shipped fixture evaluator (same shape as the fixture benchmark's). |
| `objectives` | `[]` | Objective families over the case set: unique names, positive weights, and case lists that partition a subset of the cases. Empty means one `general` objective. |
| `rounds` | `10` | Default round count for the trajectory runner. |
| `window` | `5` | Joined prediction–observation pairs per world-model assessment window. |
| `minPairs` | `3` | Minimum joined pairs for a non-insufficient reliability assessment. |
| `errorThreshold` | `0.2` | Mean absolute error above which a sufficient window is unreliable. |

### Model Experience audit note

The replay lessons and the distilled policy are model-visible by design; see [Model Experience](#model-experience).

<a id="understand-the-implementation"></a>
## Understand the implementation

| Path | Role |
|---|---|
| [`src/ledger.ts`](src/ledger.ts) | `ctx.rsiEvolutionLedger` seam and the durable per-content proposal/score join |
| [`src/replay-distiller.ts`](src/replay-distiller.ts) | `ctx.rsiDistiller` provider: dream, delegate, record |
| [`src/harmony-benchmark.ts`](src/harmony-benchmark.ts) | `ctx.rsiBenchmark` provider: family attainments and the Tchebycheff score |
| [`src/world-model.ts`](src/world-model.ts) | `ctx.rsiWorldModel` seam: prediction reliability and conditional adaptation |
| [`src/trajectory.ts`](src/trajectory.ts) | `ctx.rsiEvolutionTrajectory` seam: bounded rounds, the JSONL log, and the topology |
| [`src/domain.ts`](src/domain.ts) | The `rsi_evolution` storage domain |

The decorators cannot mount the shipped providers beside themselves under the same service name, so each starts its inner on a detached context: the fixture evaluator touches no tree service, and the subagent distiller receives the tree's `subagents` seam forwarded onto its detached context. Both inner lifetimes dispose with the decorator. Ledger writes from the providers are contained: an outage is logged and the verdict or proposal still lands.

<a id="further-exploration"></a>
## Further Exploration

- [`dual-core-rsi`](../dual-core-rsi/README.md) — the mode these plugins evolve.
- [`dual-core-rsi-evolution-bundle`](../dual-core-rsi-evolution-bundle/README.md) — the composed profile layer.
- Dream-RSI: [arXiv 2609.14858](https://arxiv.org/abs/2609.14858) — discovery history as a replay simulator.
- Harmony Harness: [arXiv 2610.15150](https://arxiv.org/abs/2610.15150) — multi-objective, compositional harness evolution.
- RSI-Anything: [arXiv 2610.13912](https://arxiv.org/abs/2610.13912) — world models that gate recursive self-improvement on prediction reliability.

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

The replay distiller adds nothing to the system prompt. Its lessons travel inside the distillation child's mission prompt as extra `knowledge` lines after the controller's own — the child is a fresh subagent that receives the mission only. The Harmony benchmark adds nothing model-visible: scoring feeds the swap gate, not the prompt.

##### Replay lessons (in the distiller child's mission only)

```markdown
- [rejection] replay: proposing the active policy's exact content was recorded 1× and settled without improvement; distill structurally different guidance or skills.
- [insight] replay: the strongest recorded proposal scored 0.900 against active 0.200; its opening guidance was: "run npm test before declaring done"
- [rejection] world model: replay predictions are unreliable over the current window (mean error 0.400); treat replay-derived guidance as weak evidence and require fresh benchmark outcomes before trusting a direction.
```

#### Token effect

At most `maxLessons` bounded lines (240 characters each) per distillation, inside the child mission only; the user core's requests never see them.

#### KV Cache effect

None on the user core. Each distillation child is a fresh context, so the lessons cost their characters once per child.

### Tool schemas

#### What the model sees

No new schemas. The package registers no tools; the [dual-core RSI tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-dual-core-rsi) are unchanged, and the benchmark score they display is now the Tchebycheff score.

#### Token effect

Unchanged from the dual-core RSI mode.

#### KV Cache effect

Unchanged from the dual-core RSI mode.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Scores measure the deployment benchmark, not end-task quality** — the replay lessons optimize conformance with whatever benchmark is composed, exactly as the shipped mode does.
- **No candidate fan-out or budget sweep** — Dream-RSI's online rollout, parallel workers, and replay objective (quality–cost hypervolume minus a parallelism penalty) need a discovery loop with many candidate attempts per round; the dual-core RSI cycle settles one proposal per round, so only the offline-replay lesson half of the framework applies today.
- **Factorized evolution is not modeled** — Harmony's general/environment-specific component scopes and its composition agent have no counterpart here; the objective axis is what transfers to this seam.
- **The ledger never forgets a rejected direction that later becomes right** — eviction is FIFO by insertion, not by relevance; a relevance-ranked world is deferred until a workload shows the need.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Open directions: candidate fan-out with a replay objective over many attempts per round (the Dream-RSI half that needs a discovery loop); a relevance-ranked replay world; scope-factorized evolution and a composition agent in the Harmony style; and benchmark-family weights learned from outcomes instead of configured.
</details>
