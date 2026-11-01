# Agent Note: Background self-evolution by default with a sidebar activity panel

Status: implemented

English | [中文](2026-11-02-dual-core-rsi-background-evolution-panel.zh.md)

## Problem

The [consult-gated design](2026-10-28-dual-core-rsi-daemon-consult-merge.md) ran the daemon on its own schedule but still needed a human answer, or `/rsi merge`, before any gate-passing candidate replaced the policy, and the only views of the daemon's work were the `/rsi` command and the model tools. The requested behavior asked for self-evolution with no user input at all — background evolution and repair — and for every evolution and every repair to be visible in the Web client's left sidebar.

## Decision

`mergePolicy` selects adoption. The default `auto` adopts a gate-passing candidate inside the cycle that produced it: one shared adoption core archives the replaced policy, flips the active pointer, keeps the better daemon lineage, and re-applies artifacts to live agents; the cycle record is stamped `promoted` with decision `merged`, and the git ledger commits the adopted generation. `consult` keeps the parked-candidate flow, the exit consult, and the `/rsi merge` and `/rsi decline` decisions; the exit consult never runs under `auto`. Every adoption, decline, rollback, and recorded incident emits `dual-core-rsi/changed` after its durable commit.

The service became a Typert Remote service exposing one read, `activity`: the newest 20 adopted evolutions (rationale, scores, trigger, adoption time, guidance lines, skill names) and the newest 20 self-repair incidents. The experimental client package `@deepseek-ai/dsh-experimental-client-ui-rsi` mounts that generated Remote itself and registers a `sidebar.panellist` entry with a keyed `main` panel listing both. The bundle inserts the client row beside the Host rows, so enabling the bundle adds the panel and disabling it removes both.

## Consequences

An enabled bundle now replaces the working policy without review whenever the benchmark gate passes; the archive, `/rsi rollback`, and the git ledger are the recovery path, and `mergePolicy: consult` restores the human gate. Because the default Remote assembly and its forwarded-event allowlist must not reference experimental packages (`verify-default-product-isolation`), the client mounts the Remote from its own entry and refreshes on a configured cadence (`refreshIntervalMs`, default 15 s) and on `connection/reset` instead of on the Host change event; background work therefore appears within one cadence while the panel is open.

## Alternatives considered

Forwarding `dual-core-rsi/changed` through the default allowlist for push updates: rejected because the default product must not include experimental packages, and the allowlist is part of that product. A notification badge on the sidebar toggle instead of a panel: rejected because the request asked for the content of each evolution and repair, which needs a list, not a count. Keeping `consult` as the default: rejected because it requires a human action before adoption, which the request removes; it stays available as configuration.
