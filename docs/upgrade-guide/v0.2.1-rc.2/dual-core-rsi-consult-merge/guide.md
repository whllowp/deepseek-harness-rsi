---
kind: upgrade-guide
description: "The dual-core RSI bundle cycles on a default-on schedule and no longer swaps cores automatically: gate-passing candidates wait for a human merge decision, recorded in a local git ledger."
---

# Dual-core RSI daemonizes and gates every swap on a human merge decision

English | [中文](guide.zh.md)

## Change

In v0.2.1-rc.2, the experimental dual-core RSI bundle ran a distillation cycle only when a human executed `/rsi run` or the `rsi_run` tool, and a candidate that beat the benchmark threshold swapped into the active policy immediately.

After upgrading, an enabled bundle runs cycles on its own: a tick every 10 minutes starts a scheduled cycle whenever fresh session activity waits, each attempt is timeboxed, and failures self-repair through recorded incidents with backoff retries. Passing the gate no longer swaps anything: the candidate parks as a pending merge offer, `/rsi` shows it, and when the last live session exits the daemon asks one merge-or-keep question through the user-questions surface. Only `/rsi merge` or a Merge answer replaces the policy; the merge and every `/rsi rollback` are committed to a dedicated local git repository under `~/.dsh/dual-core-rsi-ledger` (config `ledgerDir`). Compositions that mount the package directly now also require the `subprocess` service. New config keys: `daemonEnabled` (default `true`), `daemonIntervalMs`, `daemonMaxRetries`, `daemonRetryBackoffMs`, `cycleTimeoutMs`, `consultTimeoutMs`, `ledgerDir`. New `/rsi` verbs: `merge`, `decline`, `summary`.

## Migration

1. If you want the old manual-only behavior, set `daemonEnabled: false` on the `dual-core-rsi` entry in `cordis.yml` or your patch overlay; `/rsi run` and `rsi_run` keep working exactly as before.
2. Watch `/rsi` for the `Pending merge:` line after cycles. Decide with `/rsi merge` or `/rsi decline`, or answer the exit consult; `/rsi summary` previews the offer. Stored generations, archives, and cycle records remain readable; only records written by this upgrade add the `pending` outcome and decision fields.
3. Confirm the ledger: after your first merge, `git -C ~/.dsh/dual-core-rsi-ledger log` shows one `rsi merge:` commit, and `policy/guidance.md` holds the adopted guidance. Direct compositions must provide the `subprocess` service or the service fails loud at load.
