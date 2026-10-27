# Agent Note: Daemon-scheduled dual-core RSI with consult-gated merges and a git ledger

Status: implemented

English | [中文](2026-10-28-dual-core-rsi-daemon-consult-merge.zh.md)

## Problem

The [dual-core RSI mode](2026-10-22-dual-core-rsi-mode.md) left its daemon idle until a human ran `/rsi run` or `rsi_run`, and its swap gate replaced the active policy the moment a candidate beat the benchmark threshold, archiving the replaced surface without asking. A requested design change asked for the opposite defaults: the daemon should run as a background service that distills on its own schedule, repairs its own failures and stuck attempts while the user keeps working, and summarizes the session's fix points and improvement points when the session exits; no policy replacement should happen without an explicit human merge decision; and each accepted replacement should be recorded in local git so every change point is reviewable and rollback is one command away.

## Decision

The daemon is a repeating timer inside the service (`daemonEnabled`, default on, `daemonIntervalMs` tick): a tick starts one scheduled cycle only when a live agent exists and session activity newer than the knowledge cutoff waits, so no tokens are spent without fresh evidence. Each scheduled attempt is timeboxed by `cycleTimeoutMs`; a timeout or failure records a durable incident (kind, detail, attempt, recovery) and retries with backoff up to `daemonMaxRetries` before deferring to the next interval, so a stuck or failing cycle never wedges the daemon. Incidents are the session's fix points: the exit summary lists them next to the pending candidate's improvement points.

The swap gate became a merge gate. Passing the threshold parks the candidate as a pointer-held pending id (cycle outcome `pending`); a later, better candidate replaces it, and the active policy never changes on its own. When the last live agent is disposed, the daemon asks one merge-or-keep question through the optional `ctx.userQuestions` seam; without an answerer the offer stays pending for `/rsi merge` and `/rsi decline`. The decision (`merged`/`declined`) is stamped onto the producing cycle record.

A merge archives the replaced generation, seeds the daemon from the merged copy when it is the better lineage, and records the adopted artifact set as a commit in a dedicated local git repository (`ledgerDir`, default under the harness home) that also records rollbacks. The ledger runs `git` through the `subprocess` seam; a missing git executable or failing commit never undoes the durable swap — the archive still covers rollback and the gap is reported — because the storage domain, not the ledger, is the source of truth. Delivery remains the switched-off optional bundle.

## Consequences

Enabling the bundle now spends model tokens on a schedule without a manual command; ticks without fresh evidence skip for free, and `daemonEnabled: false` restores manual-only cycles. Cycle records written from this change carry the `pending` outcome and decision fields; older `promoted` records still decode because the domain additions are optional fields under the same domain version. The exit consult depends on a user-questions answerer to be answerable in-place; headless compositions fall back to the commands, which is also the surface tests drive. The ledger directory is a new persistent location under `$DSH_HOME`/`~/.dsh`, separate from any project working tree.

## Alternatives considered

Auto-swap with an exit-time report only: rejected because it replaces the policy before the human decides, which the request explicitly gates. A merge queue with multiple pending candidates: rejected because the distiller improves on the best known lineage each cycle, so a single best pending candidate plus the daemon lineage covers the same space with one decision. Recording decisions only in the storage-domain archives without git: rejected because the request names a local git history as the review and rollback surface; the domain stays the source of truth and the ledger is a derived, re-creatable audit trail. A host-level session-exit event instead of the last-agent heuristic: deferred (see the package Dev Note).
