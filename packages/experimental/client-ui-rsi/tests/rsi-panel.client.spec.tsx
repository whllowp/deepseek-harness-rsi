// @vitest-environment jsdom
/** The self-evolution panel: daemon state, evolutions, repairs, and the loading, error, and empty states. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { RsiActivityView } from '@deepseek-ai/dsh-experimental-dual-core-rsi/client'
import type { ActivitySnapshot, ActivitySource } from '../src/client/activity-source.ts'
import { en, zh } from '../src/client/locales.ts'
import { RsiPanel, type RsiPanelProps } from '../src/client/RsiPanel.tsx'
import { RsiPanelIcon } from '../src/client/RsiPanelIcon.tsx'

afterEach(() => { cleanup() })

function fakeSource(snapshot: ActivitySnapshot): ActivitySource & { refresh: ReturnType<typeof vi.fn> } {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    refresh: vi.fn().mockResolvedValue(undefined),
    dispose: () => {},
  }
}

function mount(snapshot: ActivitySnapshot, dictionary: typeof en | typeof zh = en) {
  const activity = fakeSource(snapshot)
  const props = { activity, t: makeTranslate(dictionary) } as RsiPanelProps
  return { view: render(<RsiPanel {...props} />), activity }
}

const POPULATED: RsiActivityView = {
  daemonEnabled: true,
  mergePolicy: 'auto',
  cycleRunning: false,
  knowledge: [
    { id: 'kn-2' as never, kind: 'rejection', text: 'kept the current policy over: drop the verify habit (candidate scored 0.000 against 0.600)', sourceCycleId: '2' as never, depositedAt: 1_700_000_200_000 },
    { id: 'kn-1' as never, kind: 'insight', text: 'adopted: verification habits repeated across sessions', sourceCycleId: '1' as never, depositedAt: 1_700_000_000_000 },
  ],
  evolutions: [
    {
      cycleId: '2' as never,
      generationId: 'gen-5' as never,
      trigger: 'schedule',
      adoptedAt: 1_700_000_000_000,
      baselineScore: 0.2,
      candidateScore: 0.9,
      improvement: 0.7,
      rationale: 'two verify habits repeated across sessions',
      guidance: ['verify each edit with focused tests'],
      skills: ['verify-before-done'],
    },
    {
      cycleId: '1' as never,
      generationId: 'gen-3' as never,
      trigger: 'command',
      adoptedAt: 1_699_000_000_000,
      baselineScore: 0.3,
      candidateScore: 0.3,
      improvement: 0,
      rationale: 'an empty policy merged by hand',
      guidance: [],
      skills: [],
    },
  ],
  repairs: [
    {
      id: 'inc-2' as never,
      startedAt: 1,
      settledAt: 1_700_000_100_000,
      kind: 'cycle-timeout',
      detail: 'the scheduled cycle exceeded cycleTimeoutMs (600000ms)',
      attempt: 2,
      recovery: 'deferred',
      retryAfterMs: 600_000,
    },
    {
      id: 'inc-1' as never,
      startedAt: 1,
      settledAt: 1_700_000_050_000,
      kind: 'cycle-error',
      detail: 'distiller offline',
      attempt: 1,
      recovery: 'retried',
      retryAfterMs: 30_000,
    },
  ],
}

describe('RsiPanel', () => {
  it('shows the loading notice before the first read settles', () => {
    mount({ status: 'loading', view: null, error: null })
    expect(screen.getByText('Loading self-evolution activity…')).toBeTruthy()
    expect(screen.queryByText('Evolutions')).toBeNull()
  })

  it('reports a failed read and retries on demand', () => {
    const { activity } = mount({ status: 'error', view: null, error: 'host offline' })
    expect(screen.getByText('Reading self-evolution activity failed: host offline')).toBeTruthy()
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })) })
    expect(activity.refresh).toHaveBeenCalledTimes(1)
  })

  it('renders the empty state with the manual-only consult policy line', () => {
    mount({ status: 'ready', view: { daemonEnabled: false, mergePolicy: 'consult', cycleRunning: false, evolutions: [], repairs: [], knowledge: [] }, error: null })
    expect(screen.getByText(/Daemon core disabled/)).toBeTruthy()
    expect(screen.getByText(/Qualifying candidates wait for your merge/)).toBeTruthy()
    expect(screen.getByText(/No background activity yet/)).toBeTruthy()
  })

  it('lists every evolution with its evidence and every repair with its recovery', () => {
    mount({ status: 'ready', view: POPULATED, error: null })
    expect(screen.getByText(/Daemon core cycles in the background on schedule/)).toBeTruthy()
    expect(screen.getByText(/Qualifying candidates merge in the background/)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Evolutions' })).toBeTruthy()
    expect(screen.getByText('two verify habits repeated across sessions')).toBeTruthy()
    expect(screen.getByText('benchmark improvement +70.0%')).toBeTruthy()
    expect(screen.getByText('benchmark improvement 0.0%')).toBeTruthy()
    expect(screen.getByText('scheduled cycle')).toBeTruthy()
    expect(screen.getByText('manual cycle')).toBeTruthy()
    expect(screen.getByText('Guidance (1 lines)')).toBeTruthy()
    expect(screen.getByText('Skills (1)')).toBeTruthy()
    expect(screen.getByText('verify each edit with focused tests')).toBeTruthy()
    expect(screen.getByText('verify-before-done')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Repairs' })).toBeTruthy()
    expect(screen.getByText('timed out')).toBeTruthy()
    expect(screen.getByText('error')).toBeTruthy()
    expect(screen.getByText('attempt 2')).toBeTruthy()
    expect(screen.getByText('deferred 600000 ms to the next interval')).toBeTruthy()
    expect(screen.getByText('retried after 30000 ms')).toBeTruthy()
    expect(screen.getByText('distiller offline')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Knowledge' })).toBeTruthy()
    expect(screen.getByText('Rejection lesson')).toBeTruthy()
    expect(screen.getByText('Insight')).toBeTruthy()
    expect(screen.getByText(/kept the current policy over: drop the verify habit/)).toBeTruthy()
    expect(screen.getByText('adopted: verification habits repeated across sessions')).toBeTruthy()
  })

  it('renders only the populated section when one list is empty', () => {
    mount({ status: 'ready', view: { ...POPULATED, repairs: [] }, error: null }, zh)
    expect(screen.getByRole('heading', { name: '进化' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '修复' })).toBeNull()
    cleanup()
    mount({ status: 'ready', view: { ...POPULATED, evolutions: [] }, error: null }, zh)
    expect(screen.queryByRole('heading', { name: '进化' })).toBeNull()
    expect(screen.getByRole('heading', { name: '修复' })).toBeTruthy()
    cleanup()
    mount({ status: 'ready', view: { ...POPULATED, knowledge: [] }, error: null }, zh)
    expect(screen.queryByRole('heading', { name: '知识库' })).toBeNull()
  })

  it('renders the decorative sparkle icon at the requested size', () => {
    const iconProps = { size: 18 } as Parameters<typeof RsiPanelIcon>[0]
    const { container } = render(<RsiPanelIcon {...iconProps} />)
    expect(container.querySelector('svg')).toBeTruthy()
  })
})
