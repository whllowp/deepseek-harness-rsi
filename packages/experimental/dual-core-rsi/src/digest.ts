/**
 * Digest assembly over a session projection plus stored sessions: the fold
 * maintains freshness-biased bounded text summaries per live session, the
 * reader adds recent closed sessions through `ctx.sessionQuery`, and the
 * daemon cycle reads the result instead of synchronously scanning event
 * history.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi/digest
 */

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { extractSessionEventText } from '@deepseek-ai/dsh-session-query'
import type { SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { RsiSessionDigest, RsiSessionDigestEntry } from './types.ts'

/**
 * Fold-side text budget as a fixed protocol constant: the fold stays
 * deterministic and config-independent, and readers apply the deployment's
 * smaller per-session budget on top. Within the budget the fold keeps the
 * MOST RECENT texts (late-session corrections outrank early chatter), so the
 * digest never goes stale by retaining only the head of a long session.
 */
export const RSI_DIGEST_FOLD_TEXT_BUDGET = 8192

/** Host-only fold state maintained per session by the digest projection. */
export interface RsiDigestFoldState {
  /** Total events committed to the session. */
  readonly eventCount: number
  /** Counts per durable event type, in first-observation order. */
  readonly eventCounts: readonly { readonly type: string; readonly count: number }[]
  /** Newest-biased bounded non-empty extracted texts, oldest kept first. */
  readonly texts: readonly string[]
  /** Characters currently used by {@link texts}. */
  readonly textChars: number
  /** Wall-clock time of the last committed event, for freshness signals. */
  readonly lastEventAt: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Dual-core RSI distillation digest maintained per session. */
    rsiDigest: RsiDigestFoldState
  }
}

const EMPTY_STATE: RsiDigestFoldState = { eventCount: 0, eventCounts: [], texts: [], textChars: 0, lastEventAt: 0 }

const foldStateSchema = z.object({
  eventCount: z.number().int().nonnegative(),
  eventCounts: z.array(z.object({ type: z.string(), count: z.number().int().positive() }).strict()),
  texts: z.array(z.string()),
  textChars: z.number().int().nonnegative(),
  lastEventAt: z.number().int().nonnegative(),
}).strict()

/**
 * Append one text to a bounded newest-first list, dropping or slicing the
 * OLDEST entries when the budget forces a choice, so the freshest content
 * always survives.
 * @param texts - currently kept texts, oldest first.
 * @param used - characters currently used by `texts`.
 * @param text - the newly extracted text.
 * @param budget - maximum total characters.
 * @returns the next kept texts and their character total.
 */
function appendNewestText(texts: readonly string[], used: number, text: string, budget: number): { texts: string[]; used: number } {
  if (text.length <= budget - used) {
    return { texts: [...texts, text], used: used + text.length }
  }
  const kept = [...texts]
  let total = used
  while (kept.length > 0 && total + text.length > budget) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- guarded by kept.length > 0
    total -= kept.shift()!.length
  }
  const room = budget - total
  const bounded = text.length <= room ? text : text.slice(text.length - room)
  kept.push(bounded)
  return { texts: kept, used: total + bounded.length }
}

/**
 * The digest projection unit: a pure synchronous fold over committed events
 * that counts event types and accumulates freshness-biased bounded text.
 * Deployment digest budgets are applied by the reader, never by the fold.
 * State version 2 keeps the newest texts under the fold budget and tracks
 * the last event time; persisted cache rows from version 1 are discarded.
 */
export const rsiDigestProjectionDefinition: ProjectionDefinition<'rsiDigest'> = {
  key: 'rsiDigest',
  stateSchema: foldStateSchema,
  stateVersion: 2,
  init(_header: SessionHeader, _inheritedEventCount: SessionLogOffset): RsiDigestFoldState {
    return EMPTY_STATE
  },
  apply(state: RsiDigestFoldState, event: SessionEvent): RsiDigestFoldState {
    const counts = new Map(state.eventCounts.map(entry => [entry.type, entry.count]))
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
    const text = extractSessionEventText(event)
    let texts = state.texts
    let used = state.textChars
    if (text.length > 0) {
      const next = appendNewestText(texts, used, text, RSI_DIGEST_FOLD_TEXT_BUDGET)
      texts = next.texts
      used = next.used
    }
    return {
      eventCount: state.eventCount + 1,
      eventCounts: [...counts.entries()].map(([type, count]) => ({ type, count })),
      texts,
      textChars: used,
      lastEventAt: Date.now(),
    }
  },
}

/** Digest read limits resolved from plugin config. */
export interface DigestLimits {
  /** Maximum sessions included across live and stored, newest first. */
  readonly maxSessions: number
  /** Maximum retained characters of extracted text per session. */
  readonly maxCharsPerSession: number
  /** Whether recent closed sessions join the digest through `ctx.sessionQuery`. */
  readonly includeStored: boolean
}

/** Structural subset of `ctx.sessionQuery` the digest reader consumes. */
export interface DigestSessionQuery {
  /** Newest-first session records across the live-preferred corpus. */
  listSessions(signal?: AbortSignal): Promise<readonly { readonly header: { readonly id: string }; readonly live: boolean }[]>
  /** Replay-validated snapshot of one session's complete event log. */
  readSession(id: string): Promise<{ readonly events: readonly SessionEvent[] }>
}

/**
 * Apply the per-session character budget, again keeping the newest text:
 * whole newest texts first, then the tail slice of the oldest one that
 * still fits.
 */
function boundedTexts(texts: readonly string[], maxChars: number): string[] {
  const remaining = [...texts]
  const bounded: string[] = []
  let used = 0
  while (remaining.length > 0) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- guarded by remaining.length > 0
    const text = remaining.pop()!
    if (used + text.length <= maxChars) {
      used += text.length
      bounded.unshift(text)
      continue
    }
    const room = maxChars - used
    if (room > 0) bounded.unshift(text.slice(text.length - room))
    break
  }
  return bounded
}

/** Build one digest entry from a detached event snapshot (a stored session). */
function entryFromSnapshot(sessionId: string, events: readonly SessionEvent[], maxChars: number): RsiSessionDigestEntry {
  const counts = new Map<string, number>()
  let texts: string[] = []
  let used = 0
  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
    const text = extractSessionEventText(event)
    if (text.length === 0) continue
    const next = appendNewestText(texts, used, text, RSI_DIGEST_FOLD_TEXT_BUDGET)
    texts = next.texts
    used = next.used
  }
  return {
    sessionId,
    eventCount: events.length,
    eventCounts: [...counts.entries()].map(([type, count]) => ({ type, count })),
    texts: boundedTexts(texts, maxChars),
  }
}

/**
 * Assemble the distillation digest: the newest live sessions with committed
 * events first, then — through `ctx.sessionQuery`, when composed — recent
 * closed sessions fill the remaining slots, so knowledge closed away in old
 * sessions still reaches the distiller. Live sessions always win their slot.
 * @param ctx - service context with `ctx.sessions` and `ctx.sessionProjections` present.
 * @param limits - digest limits resolved from config.
 * @returns the assembled digest; sessions without committed events are skipped.
 */
export async function assembleDigest(ctx: Context, limits: DigestLimits): Promise<RsiSessionDigest> {
  const liveEntries: RsiSessionDigestEntry[] = []
  const liveIds = new Set<string>()
  for (const session of ctx.sessions.list()) {
    const state = ctx.sessionProjections.stateOf(session, 'rsiDigest')
    if (state === undefined || state.eventCount === 0) continue
    liveIds.add(session.id)
    liveEntries.push({
      sessionId: session.id,
      eventCount: state.eventCount,
      eventCounts: state.eventCounts,
      texts: boundedTexts(state.texts, limits.maxCharsPerSession),
    })
  }
  const newestFirst = [...liveEntries].reverse().slice(0, limits.maxSessions)
  const entries = [...newestFirst]
  const storedIds: string[] = []
  if (limits.includeStored && entries.length < limits.maxSessions) {
    const query = ctx.get('sessionQuery')
    if (query !== undefined) {
      for (const record of await query.listSessions()) {
        if (entries.length >= limits.maxSessions) break
        const id = record.header.id
        if (record.live || liveIds.has(id) || storedIds.includes(id)) continue
        const snapshot = await query.readSession(id)
        if (snapshot.events.length === 0) continue
        storedIds.push(id)
        entries.push(entryFromSnapshot(id, snapshot.events, limits.maxCharsPerSession))
      }
    }
  }
  return { assembledAt: Date.now(), sessions: entries }
}

/**
 * Count live sessions whose latest committed event is newer than the given
 * knowledge cutoff: the current policy has not seen that activity, so its
 * knowledge may be stale.
 * @param ctx - service context with `ctx.sessions` and `ctx.sessionProjections` present.
 * @param cutoffAt - wall-clock knowledge cutoff of the last settled cycle.
 * @returns the number of live sessions with newer activity.
 */
export function countUnseenSessions(ctx: Context, cutoffAt: number): number {
  let unseen = 0
  for (const session of ctx.sessions.list()) {
    const state = ctx.sessionProjections.stateOf(session, 'rsiDigest')
    if (state === undefined || state.eventCount === 0) continue
    if (state.lastEventAt > cutoffAt) unseen += 1
  }
  return unseen
}
