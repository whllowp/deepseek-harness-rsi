/** The hero state fold: reactions come from the diff between consecutive activity views. */
import { describe, expect, it } from 'vitest'
import type { RsiActivityView } from '@deepseek-ai/dsh-experimental-dual-core-rsi/client'
import { foldHeroState } from '../src/client/pet-state.ts'
import type { ActivitySnapshot } from '@deepseek-ai/dsh-experimental-client-ui-rsi/client'

const format = {
  evolution: (rationale: string) => `E: ${rationale}`,
  repair: (detail: string) => `R: ${detail}`,
  empty: () => 'nothing yet',
}

function view(over: Partial<RsiActivityView>): RsiActivityView {
  return { daemonEnabled: true, mergePolicy: 'auto', cycleRunning: false, evolutions: [], repairs: [], ...over }
}

function ready(value: RsiActivityView): ActivitySnapshot {
  return { status: 'ready', view: value, error: null }
}

const EVOLUTION = { cycleId: '2' as never, generationId: 'gen-5' as never, trigger: 'schedule' as const, adoptedAt: 1, baselineScore: 0.2, candidateScore: 0.9, improvement: 0.7, rationale: 'verify habits', guidance: ['verify each edit'], skills: [] }
const REPAIR = { id: 'inc-1' as never, startedAt: 1, settledAt: 2, kind: 'cycle-error' as const, detail: 'distiller offline', attempt: 1, recovery: 'retried' as const, retryAfterMs: 30_000 }

describe('foldHeroState', () => {
  it('stays quiet while loading or errored', () => {
    const loading = foldHeroState(view({}), { status: 'loading', view: null, error: null }, format)
    expect(loading).toEqual({ pose: 'idle', bubble: { kind: 'empty', text: 'nothing yet' }, active: true })
    const errored = foldHeroState(view({}), { status: 'error', view: null, error: 'host offline' }, format)
    expect(errored.pose).toBe('idle')
  })

  it('mutes every reaction when the daemon driver is disabled', () => {
    const state = foldHeroState(view({}), ready(view({ daemonEnabled: false, repairs: [REPAIR] })), format)
    expect(state.active).toBe(false)
    expect(state.pose).toBe('idle')
  })

  it('reacts to a fresh repair before anything else', () => {
    const previous = view({})
    const state = foldHeroState(previous, ready(view({ repairs: [REPAIR] })), format)
    expect(state.pose).toBe('hurt')
    expect(state.bubble).toEqual({ kind: 'repair', text: 'R: distiller offline' })
  })

  it('reacts to a fresh evolution with a heart and the rationale', () => {
    const previous = view({})
    const state = foldHeroState(previous, ready(view({ evolutions: [EVOLUTION] })), format)
    expect(state.pose).toBe('levelUp')
    expect(state.bubble).toEqual({ kind: 'evolution', text: 'E: verify habits' })
  })

  it('prefers the repair reaction when both are fresh', () => {
    const state = foldHeroState(view({}), ready(view({ evolutions: [EVOLUTION], repairs: [REPAIR] })), format)
    expect(state.pose).toBe('hurt')
  })

  it('does not re-react to the same newest entries on the next read', () => {
    const seen = view({ evolutions: [EVOLUTION], repairs: [REPAIR] })
    const steady = foldHeroState(seen, ready(view({ evolutions: [EVOLUTION], repairs: [REPAIR], cycleRunning: true })), format)
    expect(steady.pose).toBe('distilling')
    expect(steady.bubble.kind).toBe('empty')
  })

  it('walks idle when nothing is fresh and no cycle runs', () => {
    const seen = view({ evolutions: [EVOLUTION] })
    const state = foldHeroState(seen, ready(view({ evolutions: [EVOLUTION] })), format)
    expect(state.pose).toBe('idle')
  })
})
