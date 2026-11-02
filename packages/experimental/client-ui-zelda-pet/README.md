---
description: "A pixel-hero desktop companion for dual-core RSI: an original sprite that walks the Web client, hums while the daemon distills, flashes when a repair lands, and raises a heart when an evolution is adopted."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-zelda-pet

English | [中文](README.zh.md)

## Summary

`dsh-experimental-client-ui-zelda-pet` adds a pixel-hero companion to the Web client's bottom-right corner. The hero is a pure projection of the daemon's activity: it walks while idle, hums while a distillation cycle runs, flashes when a self-repair is recorded, and raises a heart with the rationale when an evolution is adopted. Its speech bubble names the latest evolution or repair, and its button opens the Self-evolution sidebar panel.

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

The [dual-core RSI bundle](../dual-core-rsi-bundle/README.md) mounts this plugin beside the Self-evolution panel; enabling the bundle adds the hero, and disabling it removes both. The hero waits for the `dualCoreRsi` Remote namespace the panel plugin mounts, so the two rows travel together.

### What the hero shows

The hero reacts to the diff between consecutive activity reads: a fresh incident (newest repair id changed) flashes the sprite for 2.5 seconds with the repair detail in its bubble; a fresh evolution (newest cycle id changed) glows with a heart and the distiller's rationale; otherwise a running cycle hums the sprite and the hero walks idle. When the daemon driver is disabled the sprite grays out and every reaction mutes.

### Config

| Field | Default | Meaning |
|---|---|---|
| `refreshIntervalMs` | `15000` | Milliseconds between activity reads while mounted; at least 1000. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The mount renders into a stage element the plugin appends synchronously (so presence never races React's first commit) and reacts through one shared activity source from [`client-ui-rsi`](../client-ui-rsi/README.md) — declared in `dsh.client.external` as the sanctioned cross-plugin wire layer. The connection-reset dispatch registers eagerly with the plugin context; a late React commit can never touch a retired context. The pose fold is a pure function over consecutive views, and the transient reactions settle back to idle on a timer that any newer snapshot cancels.

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Browser entry binding the mount |
| [`src/client/mount.tsx`](src/client/mount.tsx) | Stage lifecycle, Remote namespace wait, Config |
| [`src/client/pet-state.ts`](src/client/pet-state.ts) | Pure pose-and-bubble fold over activity views |
| [`src/client/ZeldaPet.tsx`](src/client/ZeldaPet.tsx) | The hero component and its pixel-art sprite |
| [`src/client/locales.ts`](src/client/locales.ts) | The `zeldaPet` namespace copy (zh source of truth) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-experimental-dual-core-rsi`](../dual-core-rsi/README.md) — the daemon whose evolutions and repairs the hero mirrors.
- [`dsh-experimental-client-ui-rsi`](../client-ui-rsi/README.md) — the shared activity source and the panel the hero opens.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders Host-recorded daemon activity for a human and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define current package constraints, not a task backlog.

- **The sprite is an original homage** — a hand-drawn pixel hero in the adventure-RPG tradition, not any trademarked character asset.
- **Reactions derive from cadence reads** — background work appears within `refreshIntervalMs`; the panel's pushed-change limitation applies here too.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
