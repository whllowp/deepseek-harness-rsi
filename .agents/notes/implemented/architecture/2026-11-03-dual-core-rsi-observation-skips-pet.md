# Agent Note: Observation-driven cycle skips and the pixel-hero companion

Status: implemented

English | [中文](2026-11-03-dual-core-rsi-observation-skips-pet.zh.md)

## Problem

The [background self-evolution design](2026-11-02-dual-core-rsi-background-evolution-panel.md) spent a full distillation child on every scheduled cycle, including cycles that mathematics had already doomed: once the active policy sits within the threshold of the benchmark ceiling (scores are bounded by 1), no candidate can clear the gate, and a candidate carrying the active policy's exact content scores identically on a deterministic benchmark. A requested demonstration also asked for a desktop companion that visibly reacts to the daemon's background work, turning the sidebar's activity projection into a living surface.

## Decision

An observation harness (`tests/observation.spec.ts`) drives the scheduled daemon through a scripted quality ramp — backend failure, incremental wins, a regression, a duplicate, saturation — and measures adoption outcomes, per-cycle wall time, incident counts, and distiller calls. Its data named the two doomed-cycle classes above, and `runCycle` now settles both without the wasted work: the saturation skip returns a retained cycle before the digest or distiller runs, and the content-dedup skip (a structural `artifactsEqual`) returns a retained cycle before the benchmark evaluation. Both skips share one `settleRetained` record path with the ordinary retained outcome.

The companion is `@deepseek-ai/dsh-experimental-client-ui-zelda-pet`: an original hand-drawn pixel hero rendered into a fixed stage the plugin appends synchronously, whose pose and bubble are a pure fold over consecutive activity views (fresh repair → flash, fresh evolution → heart and rationale, running cycle → hum, otherwise walk; disabled daemon grays out). It reads the same `dualCoreRsi` namespace the Self-evolution panel mounts — a second `$mount` of one namespace contribution is rejected by the gateway, so the hero waits on `remote.dualCoreRsi` instead — and takes the shared `createActivitySource` through the sanctioned `dsh.client.external` wire layer. The connection-reset dispatch registers eagerly with the plugin context because React's first store subscription can fire long after the mounting context could have been retired.

## Consequences

The observation harness pins the optimization's effect: its ramp carries 8 distillation-worthy steps, and the asserts hold 7 distiller calls with the duplicate cycle and every post-saturation cycle spending none; free cycles settle in ~0ms against 3–16ms for evaluated ones, and 3 of 6 ramp cycles adopted. The skips are behavior-preserving on every promotable candidate — they only shortcut outcomes the gate already forced. The hero adds a second consumer of the activity Remote that the panel's e2e now covers end to end: with a keyless scripted distiller, the sidebar lists the repair and evolution and the hero flashes and opens the panel, all with zero user input.

## Alternatives considered

Skipping cycles at the scheduler instead of inside `runCycle`: rejected because the saturation fact is only durable after `ensureBenchmark` resolves the active score, which lives in the cycle. Capping distiller calls per interval: rejected as a budget that hides the cause; the skips remove provably wasted work instead of rationing all work. Mounting a second Remote contribution in the companion: rejected because namespace contributions are single-mount; sharing the panel's mount keeps one wire owner. An OS-level desktop overlay window: deferred; the Web stage is the shippable surface this harness owns, and an overlay would cross into the Desktop app's window ownership.
