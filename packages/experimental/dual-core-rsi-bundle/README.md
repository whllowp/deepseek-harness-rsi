---
description: "Dual-core RSI mode: a default-on daemon core distills the user core, benchmarks candidates, and offers gate-passing candidates for a human merge decision recorded in a local git ledger."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-dual-core-rsi-bundle

English | [中文](README.zh.md)

## Summary

Add the experimental dual-core RSI mode to the harness as a switched-off optional layer. When enabled, a daemon core distills the user core's live sessions into bounded policy artifacts on its own schedule, benchmarks candidates, and past a 5% improvement threshold parks the candidate as a pending merge offer; a human merge replaces the policy, archives the replaced surface, and records the change in a local git ledger.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

In Web or Desktop, open Plugins and enable **Dual-core RSI** in Official. Switch it off to remove its profile layer.

Enabling the bundle mounts the subagent distiller, a fixture benchmark, and the dual-core RSI service with its tools and `/rsi` command in the running Host. The scheduled daemon cycles on fresh session activity — `/rsi run` only forces one immediately; the shipped fixture benchmark checks that the distilled policy carries verification guidance and stays inside the guidance budget, so it demonstrates the merge gate rather than end-task quality.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the subagent distiller (`spawn` provider), the fixture benchmark with its default cases, and the dual-core RSI service at the default 5% threshold. Later profile patches can replace any row's configuration or disable it by row id; an override alone does not select the bundle. The [profile composer](../../boot/app-boot/README.md) owns patch ordering and errors.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Capability implementation](../dual-core-rsi/README.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [capability implementation](../dual-core-rsi/README.md), which owns model context and results.

#### KV Cache effect

The layer adds no request content directly; the capability implementation owns cache effects from tools, prompts, and results. Toggling the bundle changes the tool list of live Sessions, which invalidates their cached request prefix once.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The mode is experimental and its shipped benchmark scores policy conformance, not end-task quality; the capability implementation owns the full limitation list.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context — click to expand</summary>

None.

</details>
