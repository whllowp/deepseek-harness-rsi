---
description: "Dual-core recursive self-improvement: a default-on daemon core distills the user core's sessions into bounded policy artifacts, a gate-passing candidate waits for the human's merge decision as the session exits, and each merge is recorded in a local git ledger for rollback, for users and maintainers evaluating self-improving harness modes."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-dual-core-rsi

English | [中文](README.zh.md)

## Summary

`dual-core-rsi` runs the harness with two cores. The user core is the interactive agent surface; the daemon core is a distillation loop that never talks to the human and runs by default, cycling on fresh session activity and self-repairing its failures. Each cycle distills a bounded artifact set through a fresh subagent; past the threshold it waits as a pending merge offer. At session exit the daemon asks a merge question with the session's fix and improvement points; merging replaces the policy and records the change in a local git ledger. The experimental mode scores policy conformance, not end-task quality.

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

Enable the [dual-core RSI bundle](../dual-core-rsi-bundle/README.md) in Plugins (it ships switched off), or compose this package directly after mounting one `ctx.rsiDistiller` provider and one `ctx.rsiBenchmark` provider. The service fails loud at load when either provider is absent, and it requires the `subprocess` service for the git ledger.

### The daemon runs by default

No command starts the loop: a tick every `daemonIntervalMs` starts one scheduled cycle whenever a live agent exists and session activity newer than the knowledge cutoff waits; ticks without fresh evidence skip without spending tokens. Every scheduled attempt is timeboxed by `cycleTimeoutMs`; a failed or timed-out attempt records a self-repair incident and retries with `daemonRetryBackoffMs` backoff up to `daemonMaxRetries` times, then defers to the next interval, so a stuck or failing cycle never wedges the daemon — it keeps iterating while you keep working. Set `daemonEnabled: false` to return to manual-only cycles.

`/rsi run` still starts one cycle immediately and waits for it (up to `runWaitMs`), so the outcome — pending, kept, failed, or still running — is reported directly; past the wait budget the cycle continues in the background and `/rsi` shows the result later. The model's `rsi_run` tool (guided to explicit human requests only) starts the same cycle as a background job. Every cycle runs one fresh model child and spends tokens. `/rsi` or `rsi_status` opens with a plain-language summary, the pending offer, recent self-repairs, and a next-step line; `/rsi history` or `rsi_history` lists cycles, archives, and incidents; `/rsi rollback [<archive id>]` or `rsi_rollback` restores an archived surface, archiving the replaced one in turn.

### What a cycle does

The daemon assembles a bounded digest of the newest live sessions plus — through `ctx.sessionQuery`, when composed — recent closed sessions filling any remaining slots, so knowledge from sessions you already closed still reaches the distiller. Within the per-session budget the digest keeps the MOST RECENT text (late-session corrections outrank early chatter), and every settled cycle stamps a knowledge cutoff. It then asks the distiller for one complete next artifact set with a rationale, decodes it against the configured budgets, benchmarks the candidate and the active core, and records the outcome. Improvement above the threshold parks the candidate as the pending merge offer (a later, better candidate replaces it; the active policy never changes on its own); otherwise the daemon keeps the better of its own lineage and the candidate for the next cycle. A failed or cancelled cycle changes nothing: durable writes settle after evaluation, and the final state-pointer write is the commit point.

### Merging at session exit

When the last live session exits with an offer pending, the daemon summarizes the session — improvement points from the pending candidate and fix points from its recorded self-repairs — and asks one question: merge, or keep the current policy. Answering Merge replaces the active policy, archives the replaced surface for `/rsi rollback`, seeds the daemon from the merged generation, and commits the adopted policy to the local git ledger. Answering Keep declines the candidate; nothing changes. `/rsi merge`, `/rsi decline`, and `/rsi summary` make the same decision and preview the same summary at any time. Without a user-questions answerer (headless compositions), the offer simply stays pending with a logged pointer to the commands — the daemon never replaces your policy without a human decision.

### The git ledger

Every merge and every rollback materializes the adopted artifact set as plain files (`policy/guidance.md`, `policy/skills/*.md`, `policy/meta.json`) inside a dedicated git repository at `ledgerDir` (default `~/.dsh/dual-core-rsi-ledger`) and commits it. `git log` names each change point with its generation, score, and rationale; `git show` diffs any two adopted policies. The repository belongs to the daemon and never touches your project working tree. A missing `git` executable or a failing commit never undoes the durable swap: the archive still covers rollback, and the gap is reported in the merge result and logs.

### Knowing when the policy went stale

`/rsi` and `rsi_status` show the knowledge cutoff (`Knowledge current as of: …`) and count live sessions with activity newer than that cutoff. When that count is nonzero the status says the activity is not in the current policy yet; the scheduled daemon folds it into its next tick, and `/rsi run` refreshes it immediately, so an aging policy is refreshed on evidence instead of drifting silently.

### Config

| Field | Default | Meaning |
|---|---|---|
| `threshold` | `0.05` | Benchmark improvement fraction that qualifies a candidate as a pending merge offer. |
| `maxGuidanceLines` | `16` | Maximum guidance lines in one artifact set. |
| `maxGuidanceLineChars` | `400` | Maximum characters in one guidance line. |
| `maxGuidanceChars` | `4000` | Maximum total guidance characters. |
| `maxSkills` | `8` | Maximum distilled skills in one artifact set. |
| `maxSkillDescriptionChars` | `300` | Maximum skill description characters. |
| `maxSkillContentChars` | `8000` | Maximum skill content characters. |
| `digestMaxSessions` | `8` | Maximum sessions in one distillation digest. |
| `digestMaxCharsPerSession` | `4000` | Maximum extracted digest characters per session. |
| `runWaitMs` | `120000` | How long `/rsi run` waits before reporting background continuation. |
| `digestIncludeStoredSessions` | `true` | Whether recent closed sessions join the digest through `ctx.sessionQuery`. |
| `daemonEnabled` | `true` | Whether the scheduled daemon ticks run cycles on their own. |
| `daemonIntervalMs` | `600000` | Milliseconds between scheduled daemon ticks. |
| `daemonMaxRetries` | `2` | Failed-attempt retries per scheduled round beyond the first attempt. |
| `daemonRetryBackoffMs` | `30000` | Backoff before a retried scheduled attempt. |
| `cycleTimeoutMs` | `600000` | Timebox for one scheduled daemon cycle attempt. |
| `consultTimeoutMs` | `300000` | How long the exit merge consult waits for the answer. |
| `ledgerDir` | `~/.dsh/dual-core-rsi-ledger` | Directory of the local git ledger recording merges and rollbacks. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-dual-core-rsi) is the exhaustive source for every accepted field. A distiller proposal that violates any budget fails its cycle instead of being truncated.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the two-core model, the seams, and the durability rules; observable behavior is fully covered in [Use this package](#use-this-package).

### Two cores over one harness

A core is a generation of the improvable surface, not an OS process: the user core is the artifact set applied to every live agent scope, and the daemon core is the artifact set the next distillation improves on. The daemon's work runs as one unowned background job per cycle over `ctx.jobs`, and its model work runs through one fresh structured-output subagent per distillation, so an out-of-process subagent provider makes the daemon's model work a separate process without changing this package. The service never touches `agent-loop`; it applies artifacts through scoped `ctx.systemPrompt.section` and `ctx.skills.register` registrations on `agent/created`, and re-applies them on every merge and rollback.

### Seams

`ctx.rsiDistiller` (Service Definition in this package) turns generations plus a digest into one complete next artifact set; the shipped `SubagentRsiDistiller` provider routes through a configured fresh structured-output subagent provider and defensively decodes the child's JSON against the budgets. `ctx.rsiBenchmark` scores one artifact set; the shipped `FixtureRsiBenchmark` provider scores configured cases (guidance keywords, skill presence, skill content, guidance brevity) as passed weight over total weight. Both providers mount as their own loader entries (`./distiller-subagent`, `./benchmark-fixture`), so composition selects them and alternative providers replace them without config branching. The exit consult consumes the optional `ctx.userQuestions` seam when an answerer is composed, and the git ledger spawns `git` through the `subprocess` seam.

### Durability, decisions, and rollback

All state lives in the `dual_core_rsi` storage domain: one singleton pointer record, every generation, every archive entry (the full pre-merge generation snapshot including its benchmark evidence), every cycle record, and every self-repair incident record. A gate-passing candidate parks as the pointer's pending id; the human decision (`merged` or `declined`) is stamped onto the producing cycle record. Inside one operation the pointer write is last, so an interrupted merge or rollback leaves the previous cores active with at most orphan records. Rollback re-publishes the archived generation as the active core, archives the replaced generation with reason `rollback`, declines any still-pending offer, and records itself in the git ledger, making every rollback reversible by another rollback.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, scheduled daemon, cycle/merge/rollback controller, tools, `/rsi` command |
| [`src/types.ts`](src/types.ts) | Domain types shared by every role |
| [`src/branding.ts`](src/branding.ts) | Branded generation, archive, cycle, and incident ids |
| [`src/domain.ts`](src/domain.ts) | Zod schemas and the `dual_core_rsi` storage domain |
| [`src/policy.ts`](src/policy.ts) | Artifact decode, budgets, section rendering, scoped application |
| [`src/digest.ts`](src/digest.ts) | Bounded live-session digest assembly |
| [`src/distiller.ts`](src/distiller.ts) | Distiller seam plus the subagent provider |
| [`src/benchmark.ts`](src/benchmark.ts) | Benchmark seam plus the fixture provider |
| [`src/ledger.ts`](src/ledger.ts) | Local git ledger recording merges and rollbacks |
| [`src/render.ts`](src/render.ts) | Plain-text renderings for tools, the command, and the consult |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the delivery layer to the seams the controller consumes and the research framing behind the mode.

- [Dual-core RSI bundle](../dual-core-rsi-bundle/README.md) — the switched-off delivery layer and its default fixture benchmark.
- [Storage domain](../../storage/storage-domain/README.md) — the durable form the generations, archives, cycles, and incidents live in.
- [Jobs seam](../../jobs/jobs/README.md) — the background-job registry the daemon cycle runs on.
- [subagent seam](../../subagent/subagent/README.md) — the fresh-child provider contract behind the shipped distiller.
- [user-questions seam](../../interaction/user-questions/README.md) — the answerer waterfall the exit merge consult asks through.
- [Skill registry](../../skill/skill/README.md) — the runtime registration distilled skills land in.
- [Harness² project summary](../../../RSi/HARNESS2_SUMMARY.md) — the Propose–Probe–Compose framing this mode's cycles follow.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

Agents in the active generation's scope receive one `rsi:distilled-policy` section only when the merged artifact set has content: the guidance lines as a list plus one routing line per distilled skill. An empty artifact set adds no section.

##### Distilled policy section (example)

```markdown
Distilled working policy for this workspace, extracted by the RSI daemon core from recent sessions.

Guidance:
- verify each edit with focused tests

Distilled skills (load by name through the skill tool):
- verify-before-done: Habit of verifying work before reporting completion
```

#### Token effect

The section costs its rendered characters per request while merged guidance exists; budgets cap it at `maxGuidanceChars` plus one line per skill.

#### KV Cache effect

Prefix-stable between merges. Every merge, rollback, or artifact change re-renders the section once and invalidates the cached request prefix from that section onward.

### Tool schemas

#### What the model sees

The generated [`rsi_status`, `rsi_run`, `rsi_history`, and `rsi_rollback` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-dual-core-rsi) expose read-only state (including the pending offer and recent self-repairs), an explicit-ask cycle trigger, bounded history, and rollback by optional archive id. Thresholds, budgets, providers, and storage are deployment-owned and absent from the schemas.

#### Token effect

Small fixed schema cost on each request where the tools are visible.

#### KV Cache effect

Prefix-stable while the definitions and visibility are unchanged.

### Daemon requests

#### What the model sees

Each distillation child sees its mission prompt only: the two generations, the budgets, the distillation discipline, and the session digest. It never receives the user's conversation, and its structured proposal is the only value that crosses back. Benchmark evaluation is deterministic and sends no model request in this cut.

#### Token effect

One fresh child context per cycle, bounded by the digest and artifact budgets; cycles start from the default-on schedule, an explicit human request, or never when `daemonEnabled: false`.

#### KV Cache effect

Each daemon child has an independent request cache; no user-core cache is affected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the mode does not yet support. They are current constraints, not a task backlog.

- **The shipped benchmark scores policy conformance, not end-task quality** — the fixture provider checks that the distilled surface carries the configured policy; an end-task benchmark lane (replayed sessions scored on deliverables) is deferred and is the mode's main evaluation gap.
- **The exit consult needs a `ctx.userQuestions` answerer** — without one the offer stays pending and the `/rsi merge` and `/rsi decline` commands carry the decision.
- **The git ledger needs a local `git` executable** — without it merges still settle and the archive covers rollback, but the ledger stays unwritten and the gap is reported.
- **Stored-session enrichment needs `ctx.sessionQuery`** — without it the digest covers live sessions only; the shipped base composition provides the seam.
- **One distiller child per cycle** — there is no candidate fan-out, probe isolation, or blind selection as in the Harness² method this mode borrows its discipline from.
- **Model-visible policy changes are prompt-scoped** — artifacts apply as a prompt section and runtime skills; the mode never edits profile rows, plugin configs, or files.
- **A merge is a generation-pointer promotion** — the two cores are artifact generations over one harness process, not two OS processes; only the distiller child can run out of process through its provider.
- **The distiller needs a live anchor agent** — a cycle fails loud with an actionable report when no live agent exists to anchor its child.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

Open directions: an end-task benchmark provider over deterministic session replay; candidate fan-out with probe isolation and blind selection; digesting persisted history through `ctx.sessionQuery`; promoting artifacts into durable preset rows through the plugin manager; and surfacing the exit consult through a session-exit Host event instead of the last-agent heuristic.

</details>
