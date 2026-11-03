/** The activity store: one Remote read on first subscribe, reread on cadence and connection reset. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RsiActivityView } from '@deepseek-ai/dsh-experimental-dual-core-rsi/client'
import { createActivitySource } from '../src/client/activity-source.ts'

const VIEW: RsiActivityView = {
  daemonEnabled: true,
  mergePolicy: 'auto',
  cycleRunning: false,
  evolutions: [],
  repairs: [],
  knowledge: [],
}

afterEach(() => { vi.useRealTimers() })

function harness(read: () => Promise<unknown>, intervalMs = 1_000) {
  let onReset: (() => void) | undefined
  const stop = vi.fn()
  const subscribeReset = vi.fn((listener: () => void) => {
    onReset = listener
    return stop
  })
  const source = createActivitySource({ read: read as never, intervalMs, subscribeReset })
  return { source, subscribeReset, stop, reset: () => { onReset?.() } }
}

describe('activity source', () => {
  it('starts loading, reads on first subscribe, and publishes the ready view', async () => {
    const read = vi.fn().mockResolvedValue({ ok: true, value: VIEW })
    const test = harness(read)
    expect(test.source.getSnapshot()).toEqual({ status: 'loading', view: null, error: null })
    const listener = vi.fn()
    const unsubscribe = test.source.subscribe(listener)
    await vi.waitFor(() => { expect(test.source.getSnapshot().status).toBe('ready') })
    expect(test.source.getSnapshot().view).toBe(VIEW)
    expect(listener).toHaveBeenCalled()
    expect(test.subscribeReset).toHaveBeenCalledTimes(1)
    unsubscribe()
    expect(test.stop).toHaveBeenCalledTimes(1)
  })

  it('reports a failed read and recovers on the next connection reset', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: new Error('host offline') })
      .mockResolvedValueOnce({ ok: true, value: VIEW })
    const test = harness(read)
    const unsubscribe = test.source.subscribe(vi.fn())
    await vi.waitFor(() => { expect(test.source.getSnapshot().status).toBe('error') })
    expect(test.source.getSnapshot().error).toBe('host offline')
    test.reset()
    await vi.waitFor(() => { expect(test.source.getSnapshot().status).toBe('ready') })
    expect(read).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('rereads on its cadence only while subscribed', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockResolvedValue({ ok: true, value: VIEW })
    const test = harness(read, 500)
    const unsubscribe = test.source.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(500)
    expect(read).toHaveBeenCalledTimes(3)
    unsubscribe()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('shares the read in flight and keeps one trigger set for many listeners', async () => {
    let settle: (value: unknown) => void = () => {}
    const read = vi.fn(() => new Promise((resolve) => { settle = resolve }))
    const test = harness(read)
    const first = test.source.subscribe(vi.fn())
    const second = test.source.subscribe(vi.fn())
    const pending = test.source.refresh()
    expect(read).toHaveBeenCalledTimes(1)
    expect(test.subscribeReset).toHaveBeenCalledTimes(1)
    settle({ ok: true, value: VIEW })
    await pending
    first()
    expect(test.stop).not.toHaveBeenCalled()
    second()
    expect(test.stop).toHaveBeenCalledTimes(1)
  })

  it('stops every trigger on dispose', () => {
    const test = harness(vi.fn().mockResolvedValue({ ok: true, value: VIEW }))
    test.source.subscribe(vi.fn())
    test.source.dispose()
    expect(test.stop).toHaveBeenCalledTimes(1)
    // A dispose without live triggers is a no-op.
    test.source.dispose()
    expect(test.stop).toHaveBeenCalledTimes(1)
  })
})
