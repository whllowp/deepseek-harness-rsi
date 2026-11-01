/**
 * Activity store behind the sidebar panel: one authoritative Remote read,
 * repeated on a fixed cadence while the panel is mounted and immediately
 * after a connection reset.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { RsiActivityView } from '@deepseek-ai/dsh-experimental-dual-core-rsi/client'

/** Load phases the panel renders. */
export type ActivityStatus = 'loading' | 'ready' | 'error'

/**
 * Immutable snapshot the panel reads through `useSyncExternalStore`: the view
 * exists only once a read succeeded, and a failure always carries its report.
 */
export type ActivitySnapshot =
  | { readonly status: 'loading'; readonly view: null; readonly error: null }
  | { readonly status: 'ready'; readonly view: RsiActivityView; readonly error: null }
  | { readonly status: 'error'; readonly view: null; readonly error: string }

/** Host reads and refresh triggers the source binds to. */
export interface ActivitySourceDeps {
  /** One authoritative activity read; carrier and Host failures arrive in the error branch. */
  readonly read: () => Promise<RemoteResult<RsiActivityView>>
  /** Milliseconds between reads while at least one subscriber is mounted. */
  readonly intervalMs: number
  /** Subscribe to the client connection reset; returns the stop function. */
  readonly subscribeReset: (listener: () => void) => () => void
}

/**
 * Stable handle injected into the panel component. Every member is a bound
 * closure, so React may pass `subscribe` and `getSnapshot` around unbound.
 */
export interface ActivitySource {
  readonly getSnapshot: () => ActivitySnapshot
  readonly subscribe: (listener: () => void) => () => void
  /** Run one authoritative read; concurrent callers share the read in flight. */
  readonly refresh: () => Promise<void>
  /** Stop the cadence and the reset subscription and drop every listener. */
  readonly dispose: () => void
}

/** Snapshot shown before the first read settles. */
const LOADING: ActivitySnapshot = { status: 'loading', view: null, error: null }

/**
 * Create one activity source: it reads on first subscribe, rereads every
 * `intervalMs` and after every connection reset while subscribed, and shares
 * the read in flight so overlapping triggers issue one query.
 * @param deps - the Remote read, the cadence, and the reset subscription.
 * @returns the store handle the panel consumes.
 */
export function createActivitySource(deps: ActivitySourceDeps): ActivitySource {
  let snapshot = LOADING
  let stopReset: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let inflight: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const publish = (next: ActivitySnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  const refresh = (): Promise<void> => {
    inflight ??= deps.read()
      .then((result) => {
        publish(result.ok
          ? { status: 'ready', view: result.value, error: null }
          : { status: 'error', view: null, error: result.error.message })
      })
      .finally(() => {
        inflight = undefined
      })
    return inflight
  }
  const stop = (): void => {
    stopReset?.()
    stopReset = undefined
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (listeners.size === 0) {
        stopReset = deps.subscribeReset(() => { void refresh() })
        timer = setInterval(() => { void refresh() }, deps.intervalMs)
        void refresh()
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stop()
      }
    },
    refresh,
    dispose: () => {
      stop()
      listeners.clear()
    },
  }
}
