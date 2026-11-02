// @vitest-environment jsdom
/** The hero component: poses, bubbles, and the reaction settling back to idle. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ActivitySnapshot, ActivitySource } from '@deepseek-ai/dsh-experimental-client-ui-rsi/client'
import { en } from '../src/client/locales.ts'
import { ZeldaPet, type ZeldaPetInjected } from '../src/client/ZeldaPet.tsx'

afterEach(() => { cleanup(); vi.useRealTimers() })

const EVOLUTION = { cycleId: '2' as never, generationId: 'gen-5' as never, trigger: 'schedule' as const, adoptedAt: 1, baselineScore: 0.2, candidateScore: 0.9, improvement: 0.7, rationale: 'verify habits', guidance: ['verify each edit'], skills: [] }
const REPAIR = { id: 'inc-1' as never, startedAt: 1, settledAt: 2, kind: 'cycle-error' as const, detail: 'distiller offline', attempt: 1, recovery: 'retried' as const, retryAfterMs: 30_000 }

/** Snapshot-driven source stub the tests retarget between reads. */
function fakeSource(initial: ActivitySnapshot): ActivitySource & { push: (next: ActivitySnapshot) => void } {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh: vi.fn().mockResolvedValue(undefined),
    dispose: () => { listeners.clear() },
    push: (next) => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function mount(source: ActivitySource) {
  const openSelfEvolution = vi.fn()
  const props = { inject: { activity: source, openSelfEvolution } as ZeldaPetInjected, t: makeTranslate(en) }
  return { view: render(<ZeldaPet {...props} />), openSelfEvolution }
}

const IDLE_VIEW = { daemonEnabled: true, mergePolicy: 'auto' as const, cycleRunning: false, evolutions: [], repairs: [] }

describe('ZeldaPet', () => {
  it('walks idle with the empty hint while nothing happened', () => {
    mount(fakeSource({ status: 'ready', view: IDLE_VIEW, error: null }))
    expect(document.querySelector('[data-hero-pose]')!.getAttribute('data-hero-pose')).toBe('idle')
    expect(screen.getByText('No background activity yet; work in a session normally')).toBeTruthy()
    expect(screen.getByText('Waiting for fresh session evidence')).toBeTruthy()
  })

  it('hums while a daemon cycle runs', () => {
    const source = fakeSource({ status: 'ready', view: IDLE_VIEW, error: null })
    mount(source)
    act(() => { source.push({ status: 'ready', view: { ...IDLE_VIEW, cycleRunning: true }, error: null }) })
    expect(document.querySelector('[data-hero-pose]')!.getAttribute('data-hero-pose')).toBe('distilling')
    expect(screen.getByText('The daemon core is distilling a new policy…')).toBeTruthy()
    // The empty hint hides while the hero is busy reacting or distilling.
    expect(screen.queryByText('No background activity yet; work in a session normally')).toBeNull()
  })

  it('flashes for a fresh repair with its detail, then settles back to idle', () => {
    vi.useFakeTimers()
    const source = fakeSource({ status: 'ready', view: IDLE_VIEW, error: null })
    mount(source)
    act(() => { source.push({ status: 'ready', view: { ...IDLE_VIEW, repairs: [REPAIR] }, error: null }) })
    expect(document.querySelector('[data-hero-pose]')!.getAttribute('data-hero-pose')).toBe('hurt')
    expect(screen.getByText('Repair: distiller offline')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(2_600) })
    expect(document.querySelector('[data-hero-pose]')!.getAttribute('data-hero-pose')).toBe('idle')
  })

  it('keeps a newer pose when the reaction timer settles late', () => {
    vi.useFakeTimers()
    const source = fakeSource({ status: 'ready', view: IDLE_VIEW, error: null })
    mount(source)
    act(() => { source.push({ status: 'ready', view: { ...IDLE_VIEW, evolutions: [EVOLUTION] }, error: null }) })
    act(() => { source.push({ status: 'ready', view: { ...IDLE_VIEW, evolutions: [EVOLUTION], cycleRunning: true }, error: null }) })
    act(() => { vi.advanceTimersByTime(2_600) })
    // The level-up settled, but the distilling pose that replaced it survives.
    expect(document.querySelector('[data-hero-pose]')!.getAttribute('data-hero-pose')).toBe('distilling')
  })

  it('raises a heart for a fresh evolution with its rationale', () => {
    const source = fakeSource({ status: 'ready', view: IDLE_VIEW, error: null })
    mount(source)
    act(() => { source.push({ status: 'ready', view: { ...IDLE_VIEW, evolutions: [EVOLUTION] }, error: null }) })
    expect(document.querySelector('[data-hero-pose]')!.getAttribute('data-hero-pose')).toBe('levelUp')
    expect(screen.getByText('Evolution: verify habits')).toBeTruthy()
  })

  it('grays out when the daemon driver is disabled and opens the panel on click', () => {
    const source = fakeSource({ status: 'ready', view: { ...IDLE_VIEW, daemonEnabled: false }, error: null })
    const test = mount(source)
    expect(document.querySelector('[data-hero-active]')!.getAttribute('data-hero-active')).toBe('false')
    expect(screen.getByText('Daemon core not running')).toBeTruthy()
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Open the Self-evolution panel' })) })
    expect(test.openSelfEvolution).toHaveBeenCalledOnce()
  })
})
