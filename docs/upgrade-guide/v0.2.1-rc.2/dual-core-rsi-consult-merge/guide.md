---
kind: upgrade-guide
description: "The dual-core RSI bundle now self-evolves in the background with no user input, records every adoption in a local git ledger, and shows every evolution and repair in a left-sidebar panel."
---

# Dual-core RSI self-evolves in the background and shows its work in the sidebar

English | [中文](guide.zh.md)

## Change

In v0.2.1-rc.2, the experimental dual-core RSI bundle ran a distillation cycle only when a human executed `/rsi run` or the `rsi_run` tool, and a candidate that beat the benchmark threshold swapped into the active policy immediately.

After upgrading, an enabled bundle self-evolves with no user input: a tick every 10 minutes starts a scheduled cycle whenever fresh session activity waits, each attempt is timeboxed, failures self-repair through recorded incidents with backoff retries, and a gate-passing candidate is adopted in the background — the replaced surface is archived, artifacts re-apply to live agents, and the adoption is committed to a dedicated local git repository under `~/.dsh/dual-core-rsi-ledger` (config `ledgerDir`). Every evolution and repair also appears in the new Self-evolution panel the bundle adds to the Web client's left sidebar. Compositions that mount the package directly now also require the `subprocess` service. New config keys: `daemonEnabled` (default `true`), `mergePolicy` (default `auto`; `consult` restores the exit-time merge question), `daemonIntervalMs`, `daemonMaxRetries`, `daemonRetryBackoffMs`, `cycleTimeoutMs`, `consultTimeoutMs`, `ledgerDir`. New `/rsi` verbs: `merge`, `decline`, `summary`.

## Migration

1. Nothing to enable: after the upgrade the daemon cycles, repairs, and adopts on its own while the bundle is on. If you want a human gate before adoption, set `mergePolicy: consult` on the `dual-core-rsi` entry in `cordis.yml` or your patch overlay; if you want fully manual cycles, set `daemonEnabled: false` — `/rsi run` and `rsi_run` keep working exactly as before.
2. Watch the Self-evolution panel in the Web client's left sidebar for each evolution and repair, or `/rsi history` for the full record. `/rsi rollback` restores any archived policy. Stored generations, archives, and cycle records remain readable; only records written by this upgrade add the `pending` outcome and decision fields.
3. Confirm the ledger: after the first automatic adoption, `git -C ~/.dsh/dual-core-rsi-ledger log` shows one `rsi merge:` commit, and `policy/guidance.md` holds the adopted guidance. Direct compositions must provide the `subprocess` service or the service fails loud at load.
