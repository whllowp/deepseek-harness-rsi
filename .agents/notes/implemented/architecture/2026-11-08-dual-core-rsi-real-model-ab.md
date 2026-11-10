# Agent Note: Real-model end-to-end A/B of the dual-core RSI knowledge base

Status: implemented

English | [中文](2026-11-08-dual-core-rsi-real-model-ab.zh.md)

## Problem

The [long-term knowledge base](2026-11-04-dual-core-rsi-knowledge-base.md) and every earlier dual-core RSI behavior were verified only with scripted distillers and stub agents. A scripted distiller never spawns a distillation child and never emits model-formatted JSON, and the stub agent scopes inject every service the policy touches, so neither the mechanism's value nor the daemon's behavior on the shipped Web composition had been measured.

## Decision

`apps/web/tests/rsi-knowledge-ab.e2e.ts` runs the shipped Web composition with the real DeepSeek adapter: five identical workspace tasks, each in a fresh session through the browser composer, while the scheduled daemon distills, gates, adopts, and records the ledger with no command. `DSH_RSI_AB_ARM` selects the shipped composition or an ablation that hands the distiller an empty knowledge base, which reproduces the pre-knowledge-base mission prompt byte for byte; `DSH_RSI_AB_PAIRED` re-distills the newest knowledge-carrying inputs with and without their knowledge, so both variants see identical generations and digest. The scenario skips unless an arm is named in record mode. The same change fixes the four defects the runs surfaced:

- The digest and the unseen-activity count read user-core sessions only. Delegated subagent sessions, the daemon's own distillation children among them, had taken four of six default digest slots and fed each proposal back into the next cycle.
- The model-JSON decoder trims surrounding whitespace. A trailing newline in skill content had failed two of four smoke attempts.
- Policy application resolves the skill registry through the agent scope's service isolation, is all-or-nothing per agent, and is contained. A strict `ctx.skills` read had thrown on real agent scopes, so a skill-carrying adoption made every later agent creation fail, distillation children included.
- A cycle that throws before its commit point restores the pre-cycle state and re-applies the still-active policy. The next incident record had persisted a half-applied pointer flip.

## Alternatives considered

Keeping the scripted observation harness as the only evidence: rejected, because it exercises none of the four defects. Running the comparison without fixing them: rejected, because digest contamination gives the ablation a leaky memory of its own proposals and failed cycles add noise to both arms. Resolving the registry through `agentPresets.serviceFor`: rejected, because the agent scope's own `ctx.get` already honors preset isolation without coupling the policy to the preset registry. Confining the distillation child's file access in this change: deferred, because it is a subagent-capability change; the harness records each child's tool calls so the leak stays measurable.

## Consequences

Four completed trajectories, two per arm with five rounds each, all reached a full benchmark score: the shipped arm at cycle 4 in both trials and the ablation at cycles 2 and 5, so trajectory metrics stay within model variance at this sample size. The paired replay is the controlled comparison: across ten samples per variant, recall scored a mean of 0.78 against 0.80 without it and cleared the gate five times against four, a difference inside model variance. Recall costs about 240 characters per entry in the distiller prompt and visibly shapes rationales ("without re-adding the previously rejected refinements"), but on this workload it did not raise proposal scores. In every trial the adoption that reached the full score came from a distillation child that read the benchmark definition or the daemon's storage outside the workspace with the user core's tools: the gate is not independent of the generator, and the ablation leaks through the same files. The evolved policies changed real behavior: in the second task, which did not ask for it, `git status` ran in neither trial still on the empty policy and in one of the two whose adopted policy already named it, while every unprompted probe task ran `git status` and `npm test` under the adopted policy.
