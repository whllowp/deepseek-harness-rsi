---
description: "Dual-core RSI evolution profile: the dual-core RSI service composed with a Dream-RSI-style replay distiller and a Harmony-Harness-style multi-objective benchmark, plus the Self-evolution sidebar panel and pixel-hero companion."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-dual-core-rsi-evolution-bundle

English | [中文](README.zh.md)

## Summary

Add the dual-core RSI mode in its evolved composition: the same default-on daemon, sidebar panel, and pixel-hero companion as the dual-core RSI bundle, with the distiller and benchmark rows replaced by the [evolution plugins](../dual-core-rsi-evolution/README.md) — a replay distiller that dreams over recorded proposal/score outcomes before each distillation, and a multi-objective benchmark whose Tchebycheff gate keeps pressure on the worst-attaining objective family, a world model that gates the dream behind prediction reliability, and a trajectory runner over the composed cycle. An alternative to the dual-core RSI bundle: mount one or the other, never both.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

In Web or Desktop, open Plugins and enable **Dual-core RSI Evolution** in place of **Dual-core RSI** (mount one or the other, never both). Switch it off to remove its profile layer.

Enabling the bundle mounts the replay ledger, the world model over it, the Harmony benchmark over the shipped fixture case evaluator, the replay distiller over the shipped subagent distiller, the trajectory runner, the dual-core RSI service with its tools and `/rsi` command, the Self-evolution sidebar panel, and the pixel-hero companion. The scheduled daemon cycles on fresh session activity and adopts qualifying candidates by itself. The shipped objective split rewards policies that carry `npm test`, `git status`, and `CHANGELOG` guidance within a 1200-character budget, weighted 0.75 verification against 0.25 economy, so the gate demonstrates balanced multi-objective adoption rather than end-task quality.

<a id="understand-the-implementation"></a>
## Understand the implementation

The patch inserts eight rows over the base composition: `dual-core-rsi-evolution-ledger`, `dual-core-rsi-evolution-world-model`, `dual-core-rsi-benchmark` (the Harmony provider), `dual-core-rsi-distiller` (the replay provider), `dual-core-rsi-evolution-trajectory`, `dual-core-rsi` (the service), and the two client rows. Provider selection is composition, not configuration branching; swap the bundle to swap the strategy. The case set and objective weights in `cordis.patch.yml` are deployment choices, editable like any row config.

<a id="further-exploration"></a>
## Further Exploration

- [`dual-core-rsi-evolution`](../dual-core-rsi-evolution/README.md) — the capability implementation.
- [`dual-core-rsi-bundle`](../dual-core-rsi-bundle/README.md) — the plain composition this bundle alternatives against.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [capability implementation](../dual-core-rsi-evolution/README.md), which owns model context and results.

#### KV Cache effect

The layer adds no request content directly; the capability implementation owns cache effects from tools, prompts, and results. Toggling the bundle changes the tool list of live Sessions, which invalidates their cached request prefix once.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The mode is experimental and its benchmark scores policy conformance, not end-task quality; the capability implementation owns the full limitation list.

-----

<a id="dev-note"></a>
### Dev Note

The bundle carries no source of its own: `src/index.ts` is a marker module, and the runtime rows live in [`cordis.patch.yml`](cordis.patch.yml).
