import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SubagentRsiDistiller, RsiDistiller } from '../src/distiller.ts'
import { FixtureRsiBenchmark, resolveFixtureCases } from '../src/benchmark.ts'
import { decodeArtifacts, formatPercent, normalizeRationale, renderPolicySection } from '../src/policy.ts'
import {
  renderCycleRecord, renderDeclineResult, renderExitSummary, renderGeneration, renderHistory,
  renderMergeResult, renderRollback, renderStatus,
} from '../src/render.ts'
import { assembleDigest, countUnseenSessions, rsiDigestProjectionDefinition, RSI_DIGEST_FOLD_TEXT_BUDGET } from '../src/digest.ts'
import type {
  RsiArtifactBudgets, RsiCycleRecord, RsiDistillInput, RsiGeneration, RsiPendingCandidate, RsiStatusView,
} from '../src/types.ts'
import { RsiArchiveId, RsiCycleId, RsiGenerationId, RsiIncidentId } from '../src/branding.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'rsi-test': { kind: 'rsi-test' } & ContextFormed
  }
}

const BUDGETS: RsiArtifactBudgets = {
  maxGuidanceLines: 4,
  maxGuidanceLineChars: 40,
  maxGuidanceChars: 100,
  maxSkills: 2,
  maxSkillDescriptionChars: 30,
  maxSkillContentChars: 60,
}

describe('decodeArtifacts', () => {
  it('decodes a valid proposal', () => {
    const artifacts = decodeArtifacts({
      guidance: ['run focused tests'],
      skills: [{ name: 'commit-check', description: 'checks commits', content: 'Read the diff before committing.' }],
    }, BUDGETS)
    expect(artifacts.guidance).toEqual(['run focused tests'])
    expect(artifacts.skills[0]!.name).toBe('commit-check')
  })

  it('rejects shape, normalization, name, and budget violations', () => {
    expect(() => decodeArtifacts(null, BUDGETS)).toThrow(/must be an object/)
    expect(() => decodeArtifacts({ guidance: 'x', skills: [] }, BUDGETS)).toThrow(/guidance and skills arrays/)
    expect(() => decodeArtifacts({ guidance: ['  '], skills: [] }, BUDGETS)).toThrow(/normalized/)
    expect(() => decodeArtifacts({ guidance: ['x'.repeat(41)], skills: [] }, BUDGETS)).toThrow(/maxGuidanceLineChars/)
    expect(() => decodeArtifacts({ guidance: ['a', 'b', 'c', 'd', 'e'], skills: [] }, BUDGETS)).toThrow(/maxGuidanceLines/)
    expect(() => decodeArtifacts({ guidance: ['x'.repeat(34), 'y'.repeat(34), 'z'.repeat(34)], skills: [] }, BUDGETS)).toThrow(/maxGuidanceChars/)
    expect(() => decodeArtifacts({ guidance: [], skills: [{ name: 'Bad_Name', description: 'd', content: 'c' }] }, BUDGETS)).toThrow(/kebab-case/)
    expect(() => decodeArtifacts({ guidance: [], skills: [{ name: 5, description: 'd', content: 'c' }] }, BUDGETS)).toThrow(/kebab-case/)
    expect(() => decodeArtifacts({ guidance: [], skills: [5] }, BUDGETS)).toThrow(/skill artifact must be an object/)
    expect(() => decodeArtifacts({ guidance: [], skills: [{ name: 'ok', description: 'd', content: 5 }] }, BUDGETS)).toThrow(/non-empty normalized/)
    expect(() => decodeArtifacts({ guidance: [], skills: [{ name: 'ok', description: '', content: 'c' }] }, BUDGETS)).toThrow(/non-empty normalized/)
    expect(() => decodeArtifacts({ guidance: [], skills: [{ name: 'ok', description: 'x'.repeat(31), content: 'c' }] }, BUDGETS)).toThrow(/maxSkillDescriptionChars/)
    expect(() => decodeArtifacts({ guidance: [], skills: [{ name: 'ok', description: 'd', content: 'x'.repeat(61) }] }, BUDGETS)).toThrow(/maxSkillContentChars/)
    expect(() => decodeArtifacts({ guidance: [], skills: [
      { name: 'ok', description: 'd', content: 'c' },
      { name: 'ok', description: 'd', content: 'c' },
    ] }, BUDGETS)).toThrow(/unique/)
    expect(() => decodeArtifacts({ guidance: [], skills: [
      { name: 'a', description: 'd', content: 'c' },
      { name: 'b', description: 'd', content: 'c' },
      { name: 'c', description: 'd', content: 'c' },
    ] }, BUDGETS)).toThrow(/maxSkills/)
    expect(() => decodeArtifacts({ guidance: [], skills: [{ name: 'ok', description: 'd', content: 'c', extra: 1 }] }, BUDGETS)).toThrow(/unexpected field/)
  })
})

describe('policy rendering', () => {
  it('renders nothing for empty artifacts and every partial section shape', () => {
    expect(renderPolicySection({ guidance: [], skills: [] })).toBeUndefined()
    const text = renderPolicySection({ guidance: ['be terse'], skills: [{ name: 'check', description: 'checks', content: 'body' }] })
    expect(text).toContain('- be terse')
    expect(text).toContain('check: checks')
    const guidanceOnly = renderPolicySection({ guidance: ['one rule'], skills: [] })
    expect(guidanceOnly).toContain('- one rule')
    expect(guidanceOnly).not.toContain('Distilled skills')
    const skillsOnly = renderPolicySection({ guidance: [], skills: [{ name: 'check', description: 'checks', content: 'body' }] })
    expect(skillsOnly).not.toContain('Guidance:')
    expect(skillsOnly).toContain('check: checks')
  })

  it('normalizes and bounds rationales and formats percentages', () => {
    expect(() => normalizeRationale('   ', 10)).toThrow(/non-empty/)
    expect(normalizeRationale('  keep  ', 10)).toBe('keep')
    expect(normalizeRationale('x'.repeat(20), 5)).toBe('xxxxx')
    expect(formatPercent(0.062)).toBe('+6.2%')
    expect(formatPercent(0)).toBe('0.0%')
    expect(formatPercent(-0.05)).toBe('-5.0%')
  })
})

describe('fixture benchmark', () => {
  const generation = (artifacts: RsiGeneration['artifacts']): RsiGeneration => ({
    id: RsiGenerationId('gen-t'),
    origin: 'distilled',
    parent: null,
    createdAt: 0,
    artifacts,
  })

  it('fails loud without cases and rejects duplicate or invalid definitions', () => {
    expect(() => resolveFixtureCases([])).toThrow(/at least one case/)
    expect(() => resolveFixtureCases([{ name: 'a', weight: Number('x') }])).toThrow(/positive finite/)
    expect(() => resolveFixtureCases([{ name: ' ', weight: 1 }])).toThrow(/normalized/)
    expect(() => resolveFixtureCases([{ name: 'a', weight: 1 }, { name: 'a', weight: 1 }])).toThrow(/unique/)
    expect(() => resolveFixtureCases([{ name: 'a', weight: 0 }])).toThrow(/positive/)
  })

  it('rejects construction without cases before registering the service', () => {
    const ctx = new Context()
    expect(() => new FixtureRsiBenchmark(ctx, {})).toThrow(/at least one case/)
  })

  it('scores passed weight over total weight with failure details', async () => {
    const ctx = new Context()
    const benchmark = new FixtureRsiBenchmark(ctx, {
      cases: [
        { name: 'tests-first', weight: 3, requiresGuidance: ['focused tests'] },
        { name: 'has-skill', weight: 1, requiresSkillNames: ['commit-check'] },
        { name: 'skill-body', weight: 1, requiresSkillContent: [{ skill: 'commit-check', contains: 'diff' }] },
        { name: 'brevity', weight: 1, maxGuidanceChars: 50 },
      ],
    })
    const empty = await benchmark.evaluate({ generation: generation({ guidance: [], skills: [] }) }, new AbortController().signal)
    // Only the brevity case passes for the empty set: 1 weight of 6 total.
    expect(empty.score).toBeCloseTo(1 / 6)
    expect(empty.cases.find(item => item.name === 'brevity')?.passed).toBe(true)

    const good = await benchmark.evaluate({
      generation: generation({
        guidance: ['run focused tests before done'],
        skills: [{ name: 'commit-check', description: 'd', content: 'Read the diff twice.' }],
      }),
    }, new AbortController().signal)
    expect(good.score).toBe(1)
    expect(good.provider).toBe('fixture')

    const partial = await benchmark.evaluate({
      generation: generation({
        guidance: ['run focused tests before done', 'and another line of guidance'],
        skills: [{ name: 'other', description: 'd', content: 'nope' }],
      }),
    }, new AbortController().signal)
    expect(partial.score).toBeCloseTo(3 / 6)
    const failed = partial.cases.find(item => !item.passed)
    expect(failed?.detail).toContain('"commit-check" is absent')

    const presentButShallow = await benchmark.evaluate({
      generation: generation({
        guidance: ['run focused tests before done'],
        skills: [{ name: 'commit-check', description: 'd', content: 'nothing relevant here' }],
      }),
    }, new AbortController().signal)
    expect(presentButShallow.cases.find(item => item.name === 'skill-body')?.detail)
      .toContain('content lacks "diff"')
    await ctx.fiber.dispose()
  })
})

/** Result value shape the distiller decodes from a daemon child. */
interface StubStructured {
  readonly stopReason: 'completed' | 'error'
  readonly structured?: unknown
  readonly diagnostic?: string
}

/** Activation stub matching the subagent seam's caller-delivery contract. */
interface StubActivation {
  childId: never
  result: Promise<StubStructured>
  dispose(): Promise<void>
}

function stubActivation(settled: StubStructured, disposed: string[]): StubActivation {
  return {
    childId: undefined as never,
    result: Promise.resolve(settled),
    dispose: () => {
      disposed.push('dispose')
      return Promise.resolve()
    },
  }
}

/** Provider stub shape the distiller validates before starting a child. */
interface StubProvider {
  name: string
  capabilities: { agentOptions: boolean; agentPreset: boolean; outputSchema: boolean; depthLimit: boolean }
  inheritsParentContext: boolean
}

/** Subagents stub exposing the provider lookup and activation surface the distiller uses. */
class StubSubagents extends Service {
  settled: StubStructured = { stopReason: 'completed', structured: undefined }
  readonly disposed: string[] = []
  provider: StubProvider | undefined

  constructor(ctx: Context) {
    super(ctx, 'subagents')
  }

  getProvider(_name: string) {
    return this.provider
  }

  startActivation(_spec: unknown): Promise<StubActivation> {
    return Promise.resolve(stubActivation(this.settled, this.disposed))
  }
}

const DISTILL_INPUT: RsiDistillInput = {
  active: {
    id: RsiGenerationId('gen-1'),
    origin: 'initial',
    parent: null,
    createdAt: 0,
    artifacts: {
      guidance: ['run focused tests'],
      skills: [{ name: 'commit-check', description: 'checks commits', content: 'Read the diff before committing.' }],
    },
  },
  daemon: {
    id: RsiGenerationId('gen-2'),
    origin: 'distilled',
    parent: RsiGenerationId('gen-1'),
    createdAt: 0,
    artifacts: {
      guidance: ['verify before done'],
      skills: [{ name: 'release-check', description: 'checks releases', content: 'Run the release checklist.' }],
    },
  },
  digest: { assembledAt: 0, sessions: [{ sessionId: 's1', eventCount: 3, eventCounts: [], texts: ['verify the migration'] }] },
  budgets: BUDGETS,
}

function freshProvider(): StubProvider {
  return {
    name: 'spawn',
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true },
    inheritsParentContext: false,
  }
}

/** Assert one distill routing failure through the shared stub anchor. */
async function expectDistillFailure(distiller: SubagentRsiDistiller, pattern: RegExp): Promise<void> {
  await expect(distiller.distill(DISTILL_INPUT, { parent: undefined as never, signal: new AbortController().signal }))
    .rejects.toThrow(pattern)
}

async function distillerHarness(): Promise<{ ctx: Context; subagents: StubSubagents; distiller: SubagentRsiDistiller }> {
  const ctx = new Context()
  const subagents = new StubSubagents(ctx)
  subagents.provider = freshProvider()
  const distiller = new SubagentRsiDistiller(ctx, { subagentProvider: 'spawn' })
  return { ctx, subagents, distiller }
}

describe('subagent distiller', () => {
  it('rejects provider routing problems and invalid provider names', async () => {
    const ctx = new Context()
    expect(() => new SubagentRsiDistiller(ctx, { subagentProvider: ' ' })).toThrow(/normalized/)
    expect(() => new SubagentRsiDistiller(ctx, { subagentProvider: '' })).toThrow(/normalized/)
    const subagents = new StubSubagents(ctx)
    const distiller = new SubagentRsiDistiller(ctx, { subagentProvider: 'spawn' })
    subagents.provider = undefined
    await expectDistillFailure(distiller, /is not registered/)

    const unstructured = freshProvider()
    unstructured.capabilities.outputSchema = false
    subagents.provider = unstructured
    await expectDistillFailure(distiller, /does not support structured output/)

    const inheriting = freshProvider()
    inheriting.inheritsParentContext = true
    subagents.provider = inheriting
    await expectDistillFailure(distiller, /inherits parent context/)
    await ctx.fiber.dispose()
  })

  it('distills one proposal through a fresh structured child and disposes it', async () => {
    const { ctx, subagents, distiller } = await distillerHarness()
    subagents.settled = {
      stopReason: 'completed',
      structured: {
        rationale: '  two repeated verify habits  ',
        guidance: ['run focused tests'],
        skills: [{ name: 'commit-check', description: 'checks commits', content: 'Read the diff before committing.' }],
      },
    }
    const output = await distiller.distill(DISTILL_INPUT, { parent: undefined as never, signal: new AbortController().signal })
    expect(output.rationale).toBe('two repeated verify habits')
    expect(output.artifacts.guidance).toEqual(['run focused tests'])
    expect(output.artifacts.skills[0]!.name).toBe('commit-check')
    expect(subagents.disposed).toEqual(['dispose'])
    await ctx.fiber.dispose()
  })

  it('rejects children without a structured proposal and malformed payloads', async () => {
    const { ctx, subagents, distiller } = await distillerHarness()
    subagents.settled = { stopReason: 'error' }
    await expect(distiller.distill(DISTILL_INPUT, { parent: undefined as never, signal: new AbortController().signal }))
      .rejects.toThrow(/stopReason error\)$/)

    subagents.settled = { stopReason: 'error', diagnostic: 'model unavailable' }
    await expect(distiller.distill(DISTILL_INPUT, { parent: undefined as never, signal: new AbortController().signal }))
      .rejects.toThrow(/stopReason error\): model unavailable/)

    subagents.settled = { stopReason: 'completed', structured: null }
    await expect(distiller.distill(DISTILL_INPUT, { parent: undefined as never, signal: new AbortController().signal }))
      .rejects.toThrow(/non-object structured proposal/)

    subagents.settled = { stopReason: 'completed', structured: { guidance: [], skills: [] } }
    await expect(distiller.distill(DISTILL_INPUT, { parent: undefined as never, signal: new AbortController().signal }))
      .rejects.toThrow(/rationale must be a string/)

    subagents.settled = { stopReason: 'completed', structured: { rationale: 'r', guidance: ['ok', 'x'.repeat(41)], skills: [] } }
    await expect(distiller.distill(DISTILL_INPUT, { parent: undefined as never, signal: new AbortController().signal }))
      .rejects.toThrow(/maxGuidanceLineChars/)
    await ctx.fiber.dispose()
  })

  it('defaults to the spawn provider when configuration omits it', async () => {
    const ctx = new Context()
    const subagents = new StubSubagents(ctx)
    subagents.provider = freshProvider()
    const distiller = new SubagentRsiDistiller(ctx, {})
    await expect(distiller.distill(DISTILL_INPUT, { parent: undefined as never, signal: new AbortController().signal }))
      .rejects.toThrow(/without a structured proposal/)
    await ctx.fiber.dispose()
  })

  it('declares the distiller service key', () => {
    const ctx = new Context()
    expect(ctx.rsiDistiller).toBeUndefined()
    void RsiDistiller
    void ctx
  })
})

describe('assembleDigest and freshness', () => {
  async function mount(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(rsiDigestProjectionDefinition)
    return ctx
  }

  function appendTurn(session: ReturnType<SessionStore['create']>, text: string, turn = 1): void {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'rsi-test' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }

  it('skips empty sessions, bounds text, and reports newest first', async () => {
    const ctx = await mount()
    const empty = ctx.sessions.create(SessionId('empty'))
    expect(ctx.sessionProjections.stateOf(empty, 'rsiDigest')?.eventCount).toBe(0)
    for (const id of ['first', 'second']) {
      const session = ctx.sessions.create(SessionId(id))
      appendTurn(session, `${id} asks to verify the migration thoroughly`)
    }
    const digest = await assembleDigest(ctx, { maxSessions: 8, maxCharsPerSession: 20, includeStored: true })
    expect(digest.sessions.map(entry => entry.sessionId)).toEqual(['second', 'first'])
    expect(digest.sessions[0]!.eventCounts).toContainEqual({ type: 'user/message', count: 1 })
    // The reader keeps the newest tail of the single over-budget text.
    expect(digest.sessions[0]!.texts).toEqual(['migration thoroughly'.slice(-20)])

    const single = await assembleDigest(ctx, { maxSessions: 1, maxCharsPerSession: 100, includeStored: false })
    expect(single.sessions).toHaveLength(1)
    expect(single.sessions[0]!.sessionId).toBe('second')
    await ctx.fiber.dispose()
  })

  it('keeps the newest texts under the fold budget, dropping or slicing the oldest', async () => {
    const ctx = await mount()
    const session = ctx.sessions.create(SessionId('chatty'))
    appendTurn(session, 'a'.repeat(RSI_DIGEST_FOLD_TEXT_BUDGET - 2), 1)
    appendTurn(session, 'b'.repeat(50), 2)
    appendTurn(session, 'c'.repeat(10), 3)
    const state = ctx.sessionProjections.stateOf(session, 'rsiDigest')
    // The huge early text is dropped for the newer ones; the fold keeps only what fits.
    expect(state?.texts).toEqual(['b'.repeat(50), 'c'.repeat(10)])
    expect(state?.textChars).toBe(60)
    expect(state?.lastEventAt).toBeGreaterThan(0)

    const digest = await assembleDigest(ctx, { maxSessions: 8, maxCharsPerSession: 15, includeStored: false })
    // The reader keeps the newest text whole and slices the tail of the oldest.
    expect(digest.sessions[0]!.texts).toEqual(['b'.repeat(5), 'c'.repeat(10)])

    const roomy = await assembleDigest(ctx, { maxSessions: 8, maxCharsPerSession: RSI_DIGEST_FOLD_TEXT_BUDGET, includeStored: false })
    expect(roomy.sessions[0]!.texts).toEqual(['b'.repeat(50), 'c'.repeat(10)])

    // An exactly-consumed budget leaves no room for a tail slice of the oldest text.
    const exact = await assembleDigest(ctx, { maxSessions: 8, maxCharsPerSession: 10, includeStored: false })
    expect(exact.sessions[0]!.texts).toEqual(['c'.repeat(10)])
    await ctx.fiber.dispose()
  })

  it('keeps the freshest tail when one text alone exceeds the fold budget', async () => {
    const ctx = await mount()
    const session = ctx.sessions.create(SessionId('huge'))
    appendTurn(session, 'x'.repeat(RSI_DIGEST_FOLD_TEXT_BUDGET + 10), 1)
    appendTurn(session, 'z'.repeat(5), 2)
    const state = ctx.sessionProjections.stateOf(session, 'rsiDigest')
    expect(state?.texts).toEqual(['z'.repeat(5)])
    await ctx.fiber.dispose()
  })

  it('joins recent closed sessions through sessionQuery without duplicating live ones', async () => {
    const ctx = await mount()
    const live = ctx.sessions.create(SessionId('live-now'))
    appendTurn(live, 'live session asks to verify the migration')
    // The closed session lives only in storage: its events come from a detached context.
    const storedCtx = await mount()
    const storedSession = storedCtx.sessions.create(SessionId('stored-old'))
    appendTurn(storedSession, 'closed session learned the deploy checklist')
    const storedEvents: unknown[] = [...storedSession.snapshotEvents()]
    await storedCtx.fiber.dispose()

    class StubQuery extends Service {
      constructor(ctx2: Context) {
        super(ctx2, 'sessionQuery')
      }

      listSessions(): Promise<{ header: { id: string }; live: boolean }[]> {
        return Promise.resolve([
          { header: { id: 'live-now' }, live: true },
          { header: { id: 'stored-old' }, live: false },
          { header: { id: 'stored-old' }, live: false },
          { header: { id: 'stored-empty' }, live: false },
          { header: { id: 'stored-unused' }, live: false },
        ])
      }

      readSession(id: string): Promise<{ events: unknown[] }> {
        if (id === 'stored-old') return Promise.resolve({ events: storedEvents })
        return Promise.resolve({ events: [] })
      }
    }
    void new StubQuery(ctx)

    // Live fills one slot, the closed session fills the second, and the remaining listings hit the cap break.
    const digest = await assembleDigest(ctx, { maxSessions: 2, maxCharsPerSession: 100, includeStored: true })
    expect(digest.sessions.map(entry => entry.sessionId)).toEqual(['live-now', 'stored-old'])
    expect(digest.sessions[1]!.texts.join()).toContain('deploy checklist')

    // With room to spare, empty stored sessions are read and skipped without joining.
    const roomyStored = await assembleDigest(ctx, { maxSessions: 3, maxCharsPerSession: 100, includeStored: true })
    expect(roomyStored.sessions.map(entry => entry.sessionId)).toEqual(['live-now', 'stored-old'])

    const capped = await assembleDigest(ctx, { maxSessions: 1, maxCharsPerSession: 100, includeStored: true })
    expect(capped.sessions.map(entry => entry.sessionId)).toEqual(['live-now'])

    const excluded = await assembleDigest(ctx, { maxSessions: 8, maxCharsPerSession: 100, includeStored: false })
    expect(excluded.sessions.map(entry => entry.sessionId)).toEqual(['live-now'])
    await ctx.fiber.dispose()
  })

  it('counts live sessions newer than the policy adoption', async () => {
    const ctx = await mount()
    const early = ctx.sessions.create(SessionId('early'))
    appendTurn(early, 'before adoption')
    // A policy adopted far in the past has not seen the session; one adopted in the future has.
    expect(countUnseenSessions(ctx, 1)).toBe(1)
    expect(countUnseenSessions(ctx, Date.now() + 60_000)).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 5))
    const adoptedAt = Date.now()
    await new Promise(resolve => setTimeout(resolve, 5))
    const late = ctx.sessions.create(SessionId('late'))
    appendTurn(late, 'after adoption')
    expect(countUnseenSessions(ctx, adoptedAt)).toBe(1)
    expect(countUnseenSessions(ctx, 0)).toBe(2)
    await ctx.fiber.dispose()
  })
})

describe('rendering', () => {
  const base = (over: Partial<RsiGeneration>): RsiGeneration => ({
    id: RsiGenerationId('gen-r'),
    origin: 'initial',
    parent: null,
    createdAt: 0,
    artifacts: { guidance: [], skills: [] },
    ...over,
  })

  it('renders every generation shape', () => {
    const bare = renderGeneration(base({}))
    expect(bare).toContain('no benchmark yet')
    expect(bare).toContain('no guidance')
    expect(bare).toContain('skills: none')
    const single = renderGeneration(base({
      artifacts: { guidance: ['one line'], skills: [{ name: 's', description: 'd', content: 'c' }] },
      benchmark: { provider: 'fixture', scoredAt: 1, score: 0.5, cases: [] },
    }))
    expect(single).toContain('benchmark fixture score 0.500')
    expect(single).toContain('1 guidance line')
    expect(single).toContain('skills: s')
    const plural = renderGeneration(base({
      artifacts: { guidance: ['a', 'b'], skills: [] },
      benchmark: { provider: 'fixture', scoredAt: 1, score: 1, cases: [] },
    }))
    expect(plural).toContain('2 guidance lines')
  })

  it('renders status, cycles, history, and rollback edges', () => {
    const lastCycle: RsiCycleRecord = {
      id: RsiCycleId('1'),
      trigger: 'command',
      startedAt: 1,
      settledAt: 2,
      outcome: 'promoted',
      baselineScore: 0.25,
      candidateScore: 0.75,
      improvement: 0.5,
      threshold: 0.05,
      candidateId: RsiGenerationId('gen-3'),
      rationale: 'r'.repeat(300),
    }
    const view: RsiStatusView = {
      active: base({}),
      daemon: base({ id: RsiGenerationId('gen-d') }),
      threshold: 0.05,
      daemonEnabled: true,
      cycleRunning: true,
      lastCycle,
      archiveCount: 2,
      incidents: [],
      knowledgeCutoffAt: 1_700_000_000_000,
      unseenSessionCount: 1,
    }
    const status = renderStatus(view)
    expect(status).toContain('guidance text and skills only')
    expect(status).toContain('User core: gen-r')
    expect(status).toContain('Swap gate: a merge is offered when benchmark improvement exceeds +5.0%')
    expect(status).toContain('Daemon: scheduled ticks armed')
    expect(status).toContain('Cycle: running')
    expect(status).toContain('Knowledge current as of: 2023-11-14T22:13:20.000Z')
    expect(status).toContain('1 live session changed since the last cycle.')
    expect(status).toContain('a cycle is running right now')
    expect(status).toContain('improvement +50.0%')
    expect(status).toContain('…')
    const disabled = renderStatus({ ...view, daemonEnabled: false })
    expect(disabled).toContain('Daemon: disabled (daemonEnabled: false)')
    const pluralFresh = renderStatus({ ...view, unseenSessionCount: 3 })
    expect(pluralFresh).toContain('3 live sessions changed since the last cycle.')

    const cycle = renderCycleRecord(lastCycle)
    expect(cycle).toContain('cycle 1 (command) adopted a new working policy')
    expect(cycle).toContain('records predate merge decisions')
    const retained = renderCycleRecord({ ...lastCycle, outcome: 'retained' })
    expect(retained).toContain('kept the current policy')
    const waiting = renderCycleRecord({ ...lastCycle, outcome: 'pending' })
    expect(waiting).toContain('waits for your merge decision')
    const merged = renderCycleRecord({ ...lastCycle, outcome: 'pending', decision: 'merged', decidedAt: 3 })
    expect(merged).toContain('the user merged it')
    const declined = renderCycleRecord({ ...lastCycle, outcome: 'pending', decision: 'declined', decidedAt: 3 })
    expect(declined).toContain('the user declined it')

    const empty = renderHistory([], [], [])
    expect(empty).toContain('No completed cycles yet.')
    expect(empty).not.toContain('Self-repair incidents')
    const withArchive = renderHistory([], [{
      id: RsiArchiveId('arc-1'),
      archivedAt: 1,
      generation: base({}),
      supersededBy: RsiGenerationId('gen-9'),
      reason: 'swap',
    }], [])
    expect(withArchive).toContain('archive arc-1 [swap]')
    expect(withArchive).toContain('score n/a')
    expect(withArchive).toContain('Restore one with /rsi rollback <archive id>')
    const withIncident = renderHistory([], [], [{
      id: RsiIncidentId('inc-2'),
      startedAt: 1,
      settledAt: 2,
      kind: 'cycle-timeout',
      detail: 'the scheduled cycle exceeded cycleTimeoutMs (10ms)',
      attempt: 1,
      recovery: 'deferred',
      retryAfterMs: 600_000,
    }])
    expect(withIncident).toContain('Self-repair incidents (newest first):')
    expect(withIncident).toContain('inc inc-2 [cycle-timeout] attempt 1 deferred 600000ms to the next interval')

    const rollback = renderRollback(base({}), {
      id: RsiArchiveId('arc-2'),
      archivedAt: 1,
      generation: base({ id: RsiGenerationId('gen-x') }),
      supersededBy: RsiGenerationId('gen-r'),
      reason: 'rollback',
    }, { committed: true, revision: 'abc123' })
    expect(rollback).toContain('Rolled back the user core to gen-r')
    expect(rollback).toContain('from its next request')
    expect(rollback).toContain('The local git ledger recorded the restore.')
    const ledgerless = renderRollback(base({}), {
      id: RsiArchiveId('arc-3'),
      archivedAt: 1,
      generation: base({ id: RsiGenerationId('gen-x') }),
      supersededBy: RsiGenerationId('gen-r'),
      reason: 'rollback',
    }, { committed: false, error: 'git is missing' })
    expect(ledgerless).toContain('could not record the restore (git is missing)')
  })

  it('renders the pending candidate, the exit summary, and the merge and decline decisions', () => {
    const cycle: RsiCycleRecord = {
      id: RsiCycleId('4'),
      trigger: 'schedule',
      startedAt: 1,
      settledAt: 2,
      outcome: 'pending',
      baselineScore: 0.2,
      candidateScore: 0.9,
      improvement: 0.7,
      threshold: 0.05,
      candidateId: RsiGenerationId('gen-7'),
      rationale: 'two verify habits repeated across sessions',
    }
    const pending: RsiPendingCandidate = {
      generation: base({
        id: RsiGenerationId('gen-7'),
        artifacts: {
          guidance: ['verify each edit with focused tests'],
          skills: [{ name: 'verify-before-done', description: 'd', content: 'c' }],
        },
        benchmark: { provider: 'fixture', scoredAt: 1, score: 0.9, cases: [] },
      }),
      cycle,
    }
    const view: RsiStatusView = {
      active: base({}),
      daemon: base({ id: RsiGenerationId('gen-d') }),
      threshold: 0.05,
      daemonEnabled: true,
      cycleRunning: false,
      lastCycle: cycle,
      pending,
      archiveCount: 1,
      incidents: [{
        id: RsiIncidentId('inc-1'),
        startedAt: 1,
        settledAt: 2,
        kind: 'cycle-error',
        detail: 'distiller offline',
        attempt: 1,
        recovery: 'retried',
        retryAfterMs: 30_000,
      }],
      unseenSessionCount: 0,
    }
    const status = renderStatus(view)
    expect(status).toContain('Pending merge: gen-7 from cycle 4 (scored 0.900 against 0.200)')
    expect(status).toContain('skills: verify-before-done')
    expect(status).toContain('Self-repair (newest first): inc inc-1 [cycle-error] attempt 1 retried after 30000ms')
    expect(status).toContain('Next: /rsi merge adopts the pending policy and records it in the local git ledger')
    const skillless = renderStatus({
      ...view,
      pending: {
        generation: base({ id: RsiGenerationId('gen-8'), artifacts: { guidance: ['one habit'], skills: [] } }),
        cycle: { ...cycle, candidateId: RsiGenerationId('gen-8') },
      },
    })
    expect(skillless).toContain('Pending merge: gen-8 from cycle 4 (scored 0.900 against 0.200): 1 guidance line\n')

    const summary = renderExitSummary(pending, view.incidents, 0.05)
    expect(summary).toContain('Dual-core RSI session summary')
    expect(summary).toContain('Improvement points — pending policy gen-7 from cycle 4')
    expect(summary).toContain('improvement +70.0% vs threshold +5.0%')
    expect(summary).toContain('rationale: two verify habits repeated across sessions')
    expect(summary).toContain('Fix points — daemon self-repairs since the last decision (newest first):')
    expect(summary).toContain('inc inc-1 [cycle-error] attempt 1 retried after 30000ms: distiller offline')
    expect(summary).toContain('records the change in the local git ledger for rollback')
    const clean = renderExitSummary(pending, [], 0.05)
    expect(clean).toContain('none; every scheduled attempt settled without repair')

    const merged = renderMergeResult({
      generation: pending.generation,
      cycle,
      archived: {
        id: RsiArchiveId('arc-1'),
        archivedAt: 3,
        generation: base({}),
        supersededBy: RsiGenerationId('gen-7'),
        reason: 'swap',
      },
      ledger: { committed: true, revision: 'abc123' },
      source: 'command',
    })
    expect(merged).toContain("Merged gen-7 into your agent's working policy via /rsi merge (cycle 4, score 0.900)")
    expect(merged).toContain('archived as arc-1')
    expect(merged).toContain('git ledger recorded commit abc123')
    const consulted = renderMergeResult({
      generation: pending.generation,
      cycle,
      archived: {
        id: RsiArchiveId('arc-1'),
        archivedAt: 3,
        generation: base({}),
        supersededBy: RsiGenerationId('gen-7'),
        reason: 'swap',
      },
      ledger: { committed: false, error: 'git is missing' },
      source: 'consult',
    })
    expect(consulted).toContain('via the exit consult')
    expect(consulted).toContain('could not record the change (git is missing)')
    const unevidenced = renderMergeResult({
      generation: base({ id: RsiGenerationId('gen-9') }),
      cycle,
      archived: {
        id: RsiArchiveId('arc-1'),
        archivedAt: 3,
        generation: base({}),
        supersededBy: RsiGenerationId('gen-9'),
        reason: 'swap',
      },
      ledger: { committed: true, revision: 'abc123' },
      source: 'command',
    })
    expect(unevidenced).toContain('cycle 4, score n/a')

    const declined = renderDeclineResult({ cycle, source: 'consult' })
    expect(declined).toContain('Kept the current policy via the exit consult')
    expect(declined).toContain('cycle 4')
  })

  it('guides a first-time user through the empty state and freshness nudges', () => {
    const view: RsiStatusView = {
      active: base({}),
      daemon: base({ id: RsiGenerationId('gen-d') }),
      threshold: 0.05,
      daemonEnabled: true,
      cycleRunning: false,
      archiveCount: 0,
      incidents: [],
      unseenSessionCount: 0,
    }
    const status = renderStatus(view)
    expect(status).toContain('nothing has been distilled yet')
    expect(status).toContain('The scheduled daemon starts cycling as you work; /rsi run starts one immediately.')
    expect(status).toContain('Each cycle runs one fresh model child and spends tokens.')
    expect(status).not.toContain('Knowledge current as of:')
    const manualOnly = renderStatus({ ...view, daemonEnabled: false })
    expect(manualOnly).toContain('Run /rsi run to start one.')

    const settledView: RsiStatusView = {
      ...view,
      knowledgeCutoffAt: 1,
      lastCycle: {
        id: RsiCycleId('1'),
        trigger: 'tool',
        startedAt: 1,
        settledAt: 2,
        outcome: 'retained',
        baselineScore: 0.5,
        candidateScore: 0.5,
        improvement: 0,
        threshold: 0.05,
        candidateId: RsiGenerationId('gen-3'),
        rationale: 'no change',
      },
    }
    const withoutArchives = renderStatus(settledView)
    expect(withoutArchives).toContain('Next: the daemon keeps cycling as new session activity arrives')
    expect(withoutArchives).not.toContain('/rsi rollback restores')

    const withArchives = renderStatus({ ...settledView, archiveCount: 1 })
    expect(withArchives).toContain('/rsi rollback restores the policy in place before the last merge')

    const unseenView: RsiStatusView = { ...settledView, unseenSessionCount: 2 }
    const unseen = renderStatus(unseenView)
    expect(unseen).toContain('2 live sessions changed since the last cycle.')
    expect(unseen).toContain('Next: that activity is not in the current policy yet; the scheduled daemon folds it into its next tick, and /rsi run refreshes it now (each cycle runs one fresh model child and spends tokens.).')
    const manualUnseen = renderStatus({ ...unseenView, daemonEnabled: false })
    expect(manualUnseen).toContain('Next: that activity is not in the current policy yet; /rsi run refreshes it (each cycle runs one fresh model child and spends tokens.).')
  })
})
