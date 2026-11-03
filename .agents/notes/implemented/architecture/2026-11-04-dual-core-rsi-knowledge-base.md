# Agent Note: Long-term knowledge base for the self-evolving daemon

Status: implemented

English | [中文](2026-11-04-dual-core-rsi-knowledge-base.zh.md)

## Problem

The [background self-evolution design](2026-11-02-dual-core-rsi-background-evolution-panel.md) fed every distillation only a bounded digest of the newest sessions plus the two current generations: when a policy generation was replaced, the lessons that produced it left the distiller's input with the archived generation, so the daemon could re-learn — or re-propose — what an earlier cycle had already established or rejected. Sessions closed, digests scrolled, and nothing durable recorded why a candidate had failed.

## Decision

A `knowledge` table in the `dual_core_rsi` storage domain accumulates one-line entries with three kinds: `insight` deposited when a policy is adopted (auto or by a human merge, carrying the rationale and scores), `rejection` when an evaluated candidate fails the gate or a human declines it (carrying what was proposed and why the current policy won), and `repair-lesson` when a self-repair incident settles (carrying what broke and how the daemon recovered). Deposition normalizes and bounds each line, skips exact (kind, text) duplicates, and evicts the oldest entries past `knowledgeMaxEntries`; the deposit joins the caller's existing durable commit, so knowledge never settles alone. `RsiDistillInput` gains the newest `knowledgePromptLines` entries, oldest first, and the distiller mission carries them with the instruction to build on them and never re-propose a rejected direction without new session evidence. The `activity` Remote, the Self-evolution panel's Knowledge section, and `/rsi knowledge` surface the same entries newest first.

## Consequences

Knowledge now compounds across generations: the observation harness's quality ramp deposits six entries — three insights, one rejection lesson, and two repair lessons — in deposit order, and every later distillation reads them. The saturation and content-dedup skips deposit nothing (their outcomes are facts of arithmetic, not lessons), which keeps the base signal-dense; the eviction keeps it bounded. Human decisions under `consult` leave the same kind of lesson as automatic ones, differing only in text, so a composition can switch policies without losing memory. The distiller prompt grows by one section bounded to `knowledgePromptLines`, and the storage domain stays at version 1 because the knowledge table and counter are additive optional state.

## Alternatives considered

Feeding archived generations instead of a knowledge table: rejected because archives carry whole artifact sets, so prompt size would grow with history instead of with useful lessons, and rejection reasons — the most valuable lessons — live in cycle records, not artifacts. Reusing the incident table as the distiller input: rejected because incidents are operational records with counters and recoveries, and recall needs curated one-line lessons with dedup and eviction the incident schema should not grow. Deposition inside the benchmark or ledger: rejected because knowledge must exist even when no policy is adopted (pure-failure sessions still teach), so it belongs to cycle settlement itself.
