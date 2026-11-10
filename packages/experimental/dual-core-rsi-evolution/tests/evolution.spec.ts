import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope, ScopeKey } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import {
  RsiBenchmark, RsiDistiller, RsiGenerationId, RsiKnowledgeId,
} from '@deepseek-ai/dsh-experimental-dual-core-rsi'
import type {
  RsiArtifacts, RsiBenchmarkReport, RsiBenchmarkRequest, RsiDistillInput, RsiDistillOptions,
  RsiDistillOutput, RsiGeneration,
} from '@deepseek-ai/dsh-experimental-dual-core-rsi'
import type { HarmonyBenchmarkConfig, ReplayDistillerConfig } from '@deepseek-ai/dsh-experimental-dual-core-rsi-evolution'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DomainReplayLedger, HarmonyRsiBenchmark, ReplayRsiDistiller, RsiEvolutionLedger,
  artifactsFingerprint, rsiEvolutionDomain,
} from '../src/index.ts'
import * as ledgerEntry from '../src/plugin-evolution-ledger.ts'
import * as harmonyEntry from '../src/plugin-harmony-benchmark.ts'
import * as replayEntry from '../src/plugin-replay-distiller.ts'

const BUDGETS = {
  maxGuidanceLines: 8,
  maxGuidanceLineChars: 200,
  maxGuidanceChars: 800,
  maxSkills: 4,
  maxSkillDescriptionChars: 120,
  maxSkillContentChars: 400,
}

const EMPTY: RsiArtifacts = { guidance: [], skills: [] }

function artifacts(guidance: readonly string[]): RsiArtifacts {
  return { guidance: [...guidance], skills: [] }
}

function generation(id: string, art: RsiArtifacts, score?: number): RsiGeneration {
  return {
    id: RsiGenerationId(id),
    origin: 'distilled',
    parent: null,
    createdAt: 1,
    artifacts: art,
    ...score === undefined ? {} : { benchmark: { provider: 'stub', scoredAt: 1, score, cases: [] } },
  }
}

function request(gen: RsiGeneration): RsiBenchmarkRequest {
  return { generation: gen }
}

function distillInput(active: RsiArtifacts, knowledge: readonly string[] = []): RsiDistillInput {
  return {
    active: generation('gen-1', active),
    daemon: generation('gen-2', EMPTY),
    digest: { assembledAt: 1, sessions: [] },
    knowledge: knowledge.map((text, index) => ({
      id: RsiKnowledgeId(`kn-${String(index + 1)}`),
      kind: 'insight',
      text,
      depositedAt: 1,
    })),
    budgets: BUDGETS,
  }
}

/** Anchor session ids stay unique across the stub agents one harness creates. */
let anchorCounter = 0

/** Build a minimal idle agent to anchor distillation options; never driven. */
async function stubAgent(ctx: Context): Promise<Agent> {
  anchorCounter += 1
  const session = ctx.sessions.create(SessionId(`anchor-${String(anchorCounter)}`))
  let injected!: Context
  await ctx.plugin(Object.assign((inner: Context) => {
    injected = inner
  }, { inject: [] }))
  const scopeKey: ScopeKey = {}
  const scope: Scope = createScope(injected, scopeKey)
  let status = 'idle' as const
  return {
    id: session.id,
    options: {},
    session,
    inbox: createInboxStub(),
    ctx: scope.ctx,
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject() { /* not driven in these tests */ },
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
}

/** Inner distiller stub: returns queued outputs and captures every mission input. */
class StubInnerDistiller extends RsiDistiller {
  readonly inputs: RsiDistillInput[] = []

  constructor(ctx: Context, private readonly outputs: readonly RsiDistillOutput[]) {
    super(ctx)
  }

  async distill(input: RsiDistillInput, _options: RsiDistillOptions): Promise<RsiDistillOutput> {
    this.inputs.push(input)
    const output = this.outputs[this.inputs.length - 1]
    if (output === undefined) throw new Error('StubInnerDistiller has no output left')
    return output
  }
}

/** Inner benchmark stub: returns a fixed report and captures requests. */
class StubInnerBenchmark extends RsiBenchmark {
  readonly requests: RsiBenchmarkRequest[] = []

  constructor(ctx: Context, private readonly report: RsiBenchmarkReport) {
    super(ctx)
  }

  async evaluate(request: RsiBenchmarkRequest, _signal: AbortSignal): Promise<RsiBenchmarkReport> {
    this.requests.push(request)
    return this.report
  }
}

/** Ledger stub with throwing writes, for containment coverage. */
class ThrowingLedger extends RsiEvolutionLedger {
  async recordProposal(): Promise<void> {
    throw new Error('ledger proposal write down')
  }

  async recordScore(): Promise<void> {
    throw new Error('ledger score write down')
  }

  async entries(): Promise<readonly never[]> {
    return []
  }
}

interface Harness {
  readonly ctx: Context
  readonly ledger: DomainReplayLedger
  readonly root: string
}

async function harness(config?: { maxProposals?: number }): Promise<Harness> {
  const ctx = new Context()
  const root = await mkdtemp(join(tmpdir(), 'rsi-evolution-'))
  await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root })
  await ctx.plugin(storageDomainPlugin, { backend: 'json' })
  await ctx.plugin(SessionStore)
  const ledger = new DomainReplayLedger(ctx, config ?? {})
  await ledger.waitReady()
  return { ctx, ledger, root }
}

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  const waitingContexts = [...contexts]
  const waitingRoots = [...roots]
  contexts.length = 0
  roots.length = 0
  for (const ctx of waitingContexts) await ctx.fiber.dispose().catch(() => undefined)
  for (const root of waitingRoots) await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

function tracked(ctx: Context, root: string): void {
  contexts.push(ctx)
  roots.push(root)
}

describe('artifactsFingerprint', () => {
  it('joins structurally equal sets and separates different content', () => {
    const left = { guidance: ['a', 'b'], skills: [{ name: 's', description: 'd', content: 'c' }] }
    expect(artifactsFingerprint(left)).toBe(artifactsFingerprint({
      guidance: ['a', 'b'],
      skills: [{ name: 's', description: 'd', content: 'c' }],
    }))
    expect(artifactsFingerprint(left)).not.toBe(artifactsFingerprint({ guidance: ['a'], skills: left.skills }))
    expect(artifactsFingerprint(EMPTY)).not.toBe(artifactsFingerprint({ guidance: ['x'], skills: [] }))
  })
})

describe('DomainReplayLedger', () => {
  it('rejects invalid bounds at construction', () => {
    const ctx = new Context()
    tracked(ctx, '')
    expect(() => new DomainReplayLedger(ctx, { maxProposals: 0 })).toThrow(/maxProposals/)
    expect(() => new DomainReplayLedger(ctx, { maxProposals: 2.5 })).toThrow(/maxProposals/)
  })

  it('upserts proposals by content and joins scores', async () => {
    const test = await harness()
    tracked(test.ctx, test.root)
    const first = artifacts(['verify everything'])
    const second = artifacts(['run npm test first'])
    await test.ledger.recordProposal(first, { rationale: 'first cut', matchedActive: false })
    await test.ledger.recordProposal(first, { rationale: 'second cut', matchedActive: true, baselineScore: 0.2 })
    await test.ledger.recordScore(first, 0.8)
    await test.ledger.recordProposal(second, { rationale: 'other', matchedActive: false })

    const rows = await test.ledger.entries()
    expect(rows).toHaveLength(2)
    const joined = rows.find(row => row.fingerprint === artifactsFingerprint(first))
    expect(joined).toMatchObject({
      distilledCount: 2,
      rationale: 'second cut',
      matchedActive: true,
      baselineScore: 0.2,
      score: 0.8,
    })
    // The score side survives a later proposal refresh of the same content.
    await test.ledger.recordProposal(first, { rationale: 'third cut', matchedActive: false })
    expect((await test.ledger.entries()).find(row => row.fingerprint === artifactsFingerprint(first))?.score).toBe(0.8)

    // A guidance-less proposal stores an empty first line.
    await test.ledger.recordProposal(EMPTY, { rationale: 'quiet', matchedActive: false })
    expect((await test.ledger.entries()).find(row => row.fingerprint === artifactsFingerprint(EMPTY)))
      .toMatchObject({ firstGuidance: '', guidanceLines: 0 })

    // Score content that was never proposed: no row to join, resolves quietly.
    await test.ledger.recordScore(artifacts(['never proposed']), 0.9)
    expect(await test.ledger.entries()).toHaveLength(3)
  })

  it('evicts the oldest proposal past the configured cap', async () => {
    const test = await harness({ maxProposals: 2 })
    tracked(test.ctx, test.root)
    await test.ledger.recordProposal(artifacts(['one']), { rationale: 'r1', matchedActive: false })
    await test.ledger.recordProposal(artifacts(['two']), { rationale: 'r2', matchedActive: false })
    await test.ledger.recordProposal(artifacts(['three']), { rationale: 'r3', matchedActive: false })
    const rows = await test.ledger.entries()
    expect(rows.map(row => row.rationale)).toEqual(['r2', 'r3'])
  })

  it('reports an initialization failure when no storage domain composes', async () => {
    const ctx = new Context()
    tracked(ctx, '')
    const error = vi.fn()
    ctx.logger.error = error
    const ledger = new DomainReplayLedger(ctx, {})
    await expect(ledger.waitReady()).rejects.toThrow()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('rsi evolution ledger initialization failed'))
  })

  it('persists across a remount on the same storage root', async () => {
    const first = await harness()
    tracked(first.ctx, first.root)
    await first.ledger.recordProposal(artifacts(['durable content']), { rationale: 'kept', matchedActive: false })
    await first.ledger.recordScore(artifacts(['durable content']), 0.7)
    const ctx = new Context()
    tracked(ctx, first.root)
    await ctx.plugin(Storage)
    await ctx.plugin(storageJson, { root: first.root })
    await ctx.plugin(storageDomainPlugin, { backend: 'json' })
    const remounted = new DomainReplayLedger(ctx, {})
    await remounted.waitReady()
    const rows = await remounted.entries()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ rationale: 'kept', score: 0.7 })
  })
})

describe('HarmonyRsiBenchmark', () => {
  const innerReport: RsiBenchmarkReport = {
    provider: 'stub',
    scoredAt: 1,
    score: 2 / 3,
    cases: [
      { name: 'runs-tests-before-done', passed: true, weight: 2, detail: 'passed' },
      { name: 'concise-policy', passed: false, weight: 1, detail: 'too long' },
    ],
  }

  function harmony(ctx: Context, config: HarmonyBenchmarkConfig): {
    benchmark: HarmonyRsiBenchmark
    inner: StubInnerBenchmark
  } {
    const inner = new StubInnerBenchmark(ctx.isolate('rsiBenchmark'), innerReport)
    const benchmark = new HarmonyRsiBenchmark(ctx, config, inner)
    return { benchmark, inner }
  }

  it('rejects invalid objective configurations at load', () => {
    const ctx = new Context()
    tracked(ctx, '')
    const cases = [{ name: 'a', weight: 1 }, { name: 'b', weight: 1 }]
    const inner = new StubInnerBenchmark(ctx.isolate('rsiBenchmark'), innerReport)
    const build = (objectives: NonNullable<HarmonyBenchmarkConfig['objectives']>): unknown =>
      new HarmonyRsiBenchmark(ctx, { cases, objectives }, inner)
    expect(() => build([{ name: ' x', weight: 1, cases: ['a'] }])).toThrow(/normalized text/)
    expect(() => build([{ name: 'x', weight: 1, cases: ['a'] }, { name: 'x', weight: 1, cases: ['b'] }])).toThrow(/not unique/)
    expect(() => build([{ name: 'x', weight: 0, cases: ['a'] }])).toThrow(/positive finite/)
    expect(() => build([{ name: 'x', weight: Number.NaN, cases: ['a'] }])).toThrow(/positive finite/)
    expect(() => build([{ name: 'x', weight: 1, cases: [] }])).toThrow(/at least one case/)
    expect(() => build([{ name: 'x', weight: 1, cases: ['ghost'] }])).toThrow(/does not define/)
    expect(() => build([{ name: 'x', weight: 1, cases: ['a'] }, { name: 'y', weight: 1, cases: ['a'] }])).toThrow(/more than one Harmony objective/)
    // An empty case set fails loud through the fixture's own rule.
    expect(() => new HarmonyRsiBenchmark(ctx, {}, inner)).toThrow(/requires at least one case/)
  })

  it('scalarizes family attainments by weighted Tchebycheff and appends objective cases', async () => {
    const test = await harness()
    tracked(test.ctx, test.root)
    const { benchmark, inner } = harmony(test.ctx, {
      cases: [{ name: 'runs-tests-before-done', weight: 2 }, { name: 'concise-policy', weight: 1 }],
      objectives: [
        { name: 'verification', weight: 0.75, cases: ['runs-tests-before-done'] },
        { name: 'economy', weight: 0.25, cases: ['concise-policy'] },
      ],
    })
    const report = await benchmark.evaluate(request(generation('gen-3', artifacts(['run npm test']))), new AbortController().signal)
    // verification attainment 2/2, economy attainment 0/1 → shortfall max(0, 0.25) = 0.25.
    expect(report.score).toBe(0.75)
    expect(report.provider).toBe('harmony:stub')
    expect(report.cases.slice(0, 2)).toEqual(innerReport.cases)
    expect(report.cases[2]).toMatchObject({ name: 'objective:verification', passed: true, weight: 0.75 })
    expect(report.cases[3]).toMatchObject({ name: 'objective:economy', passed: false, weight: 0.25 })
    expect(report.cases[3]?.detail).toContain('0/1 weight passed')
    expect(inner.requests[0]?.generation.id).toBe('gen-3')
    // Content never proposed leaves no ledger row behind.
    expect(await test.ledger.entries()).toHaveLength(0)
  })

  it('contains a ledger outage without failing the gate', async () => {
    const ctx = new Context()
    tracked(ctx, '')
    void new ThrowingLedger(ctx)
    const warn = vi.fn()
    ctx.logger.warn = warn
    const { benchmark } = harmony(ctx, {
      cases: [{ name: 'runs-tests-before-done', weight: 2 }, { name: 'concise-policy', weight: 1 }],
      objectives: [
        { name: 'verification', weight: 0.75, cases: ['runs-tests-before-done'] },
        { name: 'economy', weight: 0.25, cases: ['concise-policy'] },
      ],
    })
    const report = await benchmark.evaluate(request(generation('gen-4', EMPTY)), new AbortController().signal)
    expect(report.score).toBe(0.75)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('replay ledger score write failed'))
  })

  it('defaults an absent family to attainment 1 without gate pressure', async () => {
    const test = await harness()
    tracked(test.ctx, test.root)
    const sparseInner = new StubInnerBenchmark(test.ctx.isolate('rsiBenchmark'),
      { provider: 'stub', scoredAt: 1, score: 1, cases: [] })
    const sparseBenchmark = new HarmonyRsiBenchmark(test.ctx, {
      cases: [{ name: 'a', weight: 1 }],
      objectives: [{ name: 'absent', weight: 0.5, cases: ['a'] }],
    }, sparseInner)
    const report = await sparseBenchmark.evaluate(request(generation('gen-5', EMPTY)), new AbortController().signal)
    expect(report.score).toBe(1)
    expect(report.cases[0]).toMatchObject({ name: 'objective:absent', passed: true })
    expect(report.cases[0]?.detail).toContain('no cases of objective')
  })

  it('falls back to one general objective covering every case', async () => {
    const test = await harness()
    tracked(test.ctx, test.root)
    const { benchmark } = harmony(test.ctx, {
      cases: [{ name: 'runs-tests-before-done', weight: 2 }, { name: 'concise-policy', weight: 1 }],
    })
    const report = await benchmark.evaluate(request(generation('gen-6', EMPTY)), new AbortController().signal)
    expect(report.score).toBe(2 / 3)
    expect(report.cases[2]).toMatchObject({ name: 'objective:general', weight: 1 })
  })

  it('starts the shipped fixture provider on a detached context when mounted as a row', async () => {
    const test = await harness()
    tracked(test.ctx, test.root)
    const benchmark = new HarmonyRsiBenchmark(test.ctx, {
      cases: [{ name: 'verify-before-done', weight: 2, requiresGuidance: ['verify'] }],
    })
    await benchmark[Service.init]()
    const passing = await benchmark.evaluate(
      request(generation('gen-7', artifacts(['always verify the diff']))),
      new AbortController().signal,
    )
    expect(passing.provider).toBe('harmony:fixture')
    expect(passing.score).toBe(1)
    const failing = await benchmark.evaluate(
      request(generation('gen-8', EMPTY)),
      new AbortController().signal,
    )
    expect(failing.score).toBe(0)
    expect(failing.cases[0]?.detail).toContain('no guidance line contains "verify"')
  })

  it('decorates an explicitly constructed inner evaluator without starting a detached one', async () => {
    const ctx = new Context()
    tracked(ctx, '')
    const inner = new StubInnerBenchmark(ctx.isolate('rsiBenchmark'), innerReport)
    const benchmark = new HarmonyRsiBenchmark(ctx, {
      cases: [{ name: 'runs-tests-before-done', weight: 2 }, { name: 'concise-policy', weight: 1 }],
    }, inner)
    // init with an explicit inner returns without starting a detached fixture.
    await benchmark[Service.init]()
    const report = await benchmark.evaluate(request(generation('gen-9', EMPTY)), new AbortController().signal)
    expect(report.score).toBe(2 / 3)
  })
})

describe('ReplayRsiDistiller', () => {
  const strongOutput: RsiDistillOutput = {
    rationale: 'adopt stronger habits',
    artifacts: artifacts(['verify every edit with tests']),
  }

  function replay(ctx: Context, config: ReplayDistillerConfig, outputs: readonly RsiDistillOutput[]): {
    distiller: ReplayRsiDistiller
    inner: StubInnerDistiller
  } {
    const inner = new StubInnerDistiller(ctx.isolate('rsiDistiller'), outputs)
    const distiller = new ReplayRsiDistiller(ctx, config, inner)
    return { distiller, inner }
  }

  async function options(ctx: Context): Promise<RsiDistillOptions> {
    return { parent: await stubAgent(ctx), signal: new AbortController().signal }
  }

  it('rejects invalid configuration at load', () => {
    const ctx = new Context()
    tracked(ctx, '')
    const inner = new StubInnerDistiller(ctx.isolate('rsiDistiller'), [])
    expect(() => new ReplayRsiDistiller(ctx, { subagentProvider: ' ' }, inner)).toThrow(/subagentProvider/)
    expect(() => new ReplayRsiDistiller(ctx, { maxLessons: 0 }, inner)).toThrow(/maxLessons/)
    expect(() => new ReplayRsiDistiller(ctx, { maxLessons: 9 }, inner)).toThrow(/maxLessons/)
    expect(() => new ReplayRsiDistiller(ctx, { minSamples: 0 }, inner)).toThrow(/minSamples/)
  })

  it('injects nothing while the world is under-sampled and passes knowledge through by identity', async () => {
    const test = await harness()
    tracked(test.ctx, test.root)
    const active = artifacts(['current policy'])
    await test.ledger.recordProposal(active, { rationale: 'seed', matchedActive: false })
    await test.ledger.recordScore(active, 0.4)
    const { distiller, inner } = replay(test.ctx, { minSamples: 2 }, [strongOutput])
    const input = distillInput(active, ['kept lesson'])
    await distiller.distill(input, await options(test.ctx))
    expect(inner.inputs[0]?.knowledge).toBe(input.knowledge)
    expect(input.knowledge).toHaveLength(1)
  })

  it('dreams the frontier: repeated-content, best, worst, and frontier lessons in order', async () => {
    const test = await harness()
    tracked(test.ctx, test.root)
    const active = artifacts(['current policy'])
    const best = artifacts(['best direction'])
    const worst = artifacts(['worst direction'])
    await test.ledger.recordProposal(best, { rationale: 'b', matchedActive: false, baselineScore: 0.2 })
    await test.ledger.recordScore(best, 0.9)
    await test.ledger.recordProposal(worst, { rationale: 'w', matchedActive: false })
    await test.ledger.recordScore(worst, 0.1)
    await test.ledger.recordProposal(active, { rationale: 'echo', matchedActive: false })
    await test.ledger.recordScore(active, 0.4)

    // maxLessons 4 keeps every minted lesson, frontier included. The second
    // queued output echoes the active content through the same distiller.
    const { distiller, inner } = replay(test.ctx, { maxLessons: 4 },
      [strongOutput, { rationale: 'echo out', artifacts: active }])
    const input = distillInput(active, ['kept lesson'])
    await distiller.distill(input, await options(test.ctx))
    const knowledge = inner.inputs[0]?.knowledge ?? []
    expect(knowledge).toHaveLength(5)
    expect(knowledge[0]?.text).toBe('kept lesson')
    expect(knowledge[1]?.kind).toBe('rejection')
    expect(knowledge[1]?.text).toContain('recorded 1× and settled without improvement')
    expect(knowledge[2]?.kind).toBe('insight')
    expect(knowledge[2]?.text).toContain('strongest recorded proposal scored 0.900 against active 0.200')
    expect(knowledge[2]?.text).toContain('"best direction"')
    expect(knowledge[3]?.kind).toBe('rejection')
    expect(knowledge[3]?.text).toContain('weakest recorded proposal scored 0.100 (active score unknown then)')
    expect(knowledge[4]?.text).toContain('3 recorded proposals carry benchmark outcomes; 1 scored above')
    // The controller's own knowledge lines stay first and the input stays unmutated.
    expect(input.knowledge).toHaveLength(1)

    // The proposal joined the ledger with its baseline fact.
    const rows = await test.ledger.entries()
    expect(rows.find(row => row.fingerprint === artifactsFingerprint(strongOutput.artifacts)))
      .toMatchObject({ rationale: 'adopt stronger habits', matchedActive: false, baselineScore: 0.4 })

    // A second distill whose output equals the active content flips matchedActive.
    await distiller.distill(distillInput(active), await options(test.ctx))
    expect((await test.ledger.entries()).find(row => row.fingerprint === artifactsFingerprint(active))?.matchedActive).toBe(true)
  })

  it('caps the lessons and keeps ids unique across distillations', async () => {
    const test = await harness()
    tracked(test.ctx, test.root)
    const active = artifacts(['current policy'])
    const proposals = [['a'], ['b'], ['c']]
    for (const [index, guidance] of proposals.entries()) {
      const art = artifacts(guidance)
      await test.ledger.recordProposal(art, { rationale: `r${String(index)}`, matchedActive: false, baselineScore: 0.2 })
      await test.ledger.recordScore(art, 0.1 + index * 0.1)
    }
    const { distiller, inner } = replay(test.ctx, { maxLessons: 2 }, [strongOutput, strongOutput])
    await distiller.distill(distillInput(active), await options(test.ctx))
    const first = inner.inputs[0]?.knowledge ?? []
    expect(first).toHaveLength(2)
    await distiller.distill(distillInput(active), await options(test.ctx))
    const second = inner.inputs[1]?.knowledge ?? []
    expect(second).toHaveLength(2)
    expect(second[1]?.id).not.toBe(first[1]?.id)
    // maxLessons 2 keeps the best and weakest lessons, in that order.
    expect(second[0]?.kind).toBe('insight')
    expect(second[1]?.kind).toBe('rejection')
  })

  it('covers the unknown-baseline best lesson and the equal-score tie-break', async () => {
    const test = await harness()
    tracked(test.ctx, test.root)
    const active = artifacts(['current policy'])
    const top = artifacts(['top direction'])
    await test.ledger.recordProposal(top, { rationale: 't', matchedActive: false })
    await test.ledger.recordScore(top, 0.95)
    const { distiller, inner } = replay(test.ctx, { minSamples: 1 }, [strongOutput, strongOutput])
    await distiller.distill(distillInput(active), await options(test.ctx))
    expect(inner.inputs[0]?.knowledge?.[0]?.text).toContain('strongest recorded proposal scored 0.950 (active score unknown then)')
    // One outcome row: worst === best, so the weakest lesson is not minted.
    expect(inner.inputs[0]?.knowledge).toHaveLength(2)

    // Two tied scores fall through the sorts' recency tie-break instead of
    // the score delta, and mint distinct best and weakest lessons.
    const tiedA = artifacts(['tied direction a'])
    const tiedB = artifacts(['tied direction b'])
    await test.ledger.recordProposal(tiedA, { rationale: 'ta', matchedActive: false })
    await test.ledger.recordScore(tiedA, 0.5)
    await test.ledger.recordProposal(tiedB, { rationale: 'tb', matchedActive: false })
    await test.ledger.recordScore(tiedB, 0.5)
    await distiller.distill(distillInput(active), await options(test.ctx))
    const knowledge = inner.inputs[1]?.knowledge ?? []
    expect(knowledge[0]?.text).toContain('strongest recorded proposal scored 0.950 (active score unknown then)')
    expect(knowledge[1]?.text).toContain('"tied direction b"')
    expect(knowledge[2]?.text).toContain('3 recorded proposals carry benchmark outcomes')
  })

  it('contains ledger proposal write failures after the child has answered', async () => {
    const ctx = new Context()
    tracked(ctx, '')
    await ctx.plugin(Storage)
    const throwRoot = await mkdtemp(join(tmpdir(), 'rsi-evolution-throwing-'))
    roots.push(throwRoot)
    await ctx.plugin(storageJson, { root: throwRoot })
    await ctx.plugin(storageDomainPlugin, { backend: 'json' })
    await ctx.plugin(SessionStore)
    void new ThrowingLedger(ctx)
    const warn = vi.fn()
    ctx.logger.warn = warn
    const inner = new StubInnerDistiller(ctx.isolate('rsiDistiller'), [strongOutput])
    const distiller = new ReplayRsiDistiller(ctx, {}, inner)
    const anchor = await stubAgent(ctx)
    await expect(distiller.distill(distillInput(EMPTY), { parent: anchor, signal: new AbortController().signal }))
      .resolves.toEqual(strongOutput)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ledger proposal write failed'))
  })

  it('keeps an explicitly injected inner distiller without starting a detached one', async () => {
    const test = await harness()
    tracked(test.ctx, test.root)
    const { distiller } = replay(test.ctx, {}, [strongOutput])
    await distiller[Service.init]()
    await expect(distiller.distill(distillInput(EMPTY), await options(test.ctx))).resolves.toEqual(strongOutput)
  })

  it('starts the shipped subagent distiller on a detached context wired to the tree subagents', async () => {
    const test = await harness()
    tracked(test.ctx, test.root)
    // The real composition reaches dsh-subagent from dsh-base; the unit world
    // stubs the provider lookup so the spawned child fails loud, proving the
    // detached delegation is wired to the tree's subagents seam.
    await test.ctx.plugin(Object.assign((inner: Context) => {
      inner.provide('subagents', { getProvider: () => undefined })
    }, { inject: [] }))
    const distiller = new ReplayRsiDistiller(test.ctx, { subagentProvider: 'spawn' })
    await distiller[Service.init]()
    expect(test.ctx.rsiDistiller).toBeInstanceOf(ReplayRsiDistiller)
    await expect(distiller.distill(distillInput(EMPTY), await options(test.ctx)))
      .rejects.toThrow(/provider "spawn" is not registered/)
  })
})

describe('plugin entries', () => {
  it('re-export their service classes', () => {
    expect(ledgerEntry.default).toBe(DomainReplayLedger)
    expect(harmonyEntry.default).toBe(HarmonyRsiBenchmark)
    expect(replayEntry.default).toBe(ReplayRsiDistiller)
    expect(rsiEvolutionDomain.name).toBe('rsi_evolution')
  })
})
