---
description: "Left-sidebar Self-evolution panel for dual-core RSI: every policy the daemon evolved in the background and every self-repair it recorded."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-rsi

English | [中文](README.zh.md)

## Summary

`dsh-experimental-client-ui-rsi` adds a Self-evolution entry to the left sidebar. Its panel lists what the dual-core RSI daemon did in the background without being asked: each evolution (the adopted guidance and skills, the benchmark improvement, the rationale, and when it landed) and each self-repair (what broke, which attempt, and how the daemon recovered). The panel rereads the Host on a fixed cadence while it is open, so new background work appears without a manual refresh.

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

The [dual-core RSI bundle](../dual-core-rsi-bundle/README.md) mounts this plugin beside the Host service; enabling the bundle in Plugins adds the sparkle icon to the sidebar's global panel list, and disabling it removes both. Selecting the entry opens the panel in the main area.

### What the panel shows

The header states whether the daemon runs on its schedule and how qualifying candidates are adopted (in the background, or waiting for a merge under the `consult` policy). The Evolutions section lists adopted policies newest first; each row names the distiller's rationale, the adoption time, the benchmark improvement, the trigger (scheduled, manual, or tool), and the adopted guidance lines and skill names. The Repairs section lists self-repair incidents newest first; each row names the failure kind (timed out or error), the attempt number, the recovery (retried after a backoff, or deferred to the next interval), and the failure detail. An empty Host shows a one-line explanation, a failed read shows its report with a Retry button, and the first read shows a loading line.

### Config

| Field | Default | Meaning |
|---|---|---|
| `refreshIntervalMs` | `15000` | Milliseconds between activity reads while the panel is open; at least 1000. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser entry mounts the generated `dualCoreRsi` Remote contribution itself, because the default Remote assembly never carries experimental namespaces, then registers the dictionaries, the keyed `main` panel, and the `sidebar.panellist` entry under one id; disposal withdraws the panel before the Remote it reads. One shared activity source owns all transport: it reads `dualCoreRsi.activity` on first subscribe, rereads every `refreshIntervalMs` and after each `connection/reset` while subscribed, shares an in-flight read across overlapping triggers, and stops every trigger when the last subscriber leaves. The panel reads the source through `useSyncExternalStore` and holds no other state.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Browser entry binding the generated Remote contribution |
| [`src/client/mount.ts`](src/client/mount.ts) | Remote mount, panel and sidebar registrations, Config |
| [`src/client/activity-source.ts`](src/client/activity-source.ts) | Cadenced activity reads shared by the panel |
| [`src/client/RsiPanel.tsx`](src/client/RsiPanel.tsx) | The evolutions and repairs panel |
| [`src/client/RsiPanelIcon.tsx`](src/client/RsiPanelIcon.tsx) | The decorative sidebar glyph |
| [`src/client/locales.ts`](src/client/locales.ts) | The `rsi.panel` namespace copy (zh source of truth) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-experimental-dual-core-rsi`](../dual-core-rsi/README.md) — the daemon, its background evolutions and self-repairs, and the `activity` Remote this panel reads.
- [`dsh-client-ui-sidebar`](../../client/ui-sidebar/README.md) — the `sidebar.panellist` seat and the main-panel contract.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders Host-recorded daemon activity for a human and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define current package constraints, not a task backlog.

- **Updates arrive on a cadence, not a push** — background activity appears within `refreshIntervalMs` while the panel is open; the Host's change event is not forwarded to clients, because the default forwarded-event allowlist excludes experimental packages.
- **Bounded history** — the panel shows the newest 20 evolutions and 20 repairs the Host projects; the full record stays in `/rsi history`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
