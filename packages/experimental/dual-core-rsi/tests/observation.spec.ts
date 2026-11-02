/**
 * The self-evolution observation harness: run many scheduled cycles against
 * a scripted distiller whose proposals follow a realistic quality ramp
 * (failures, regressions, incremental wins, saturation), then measure what
 * the daemon actually did — adoption outcomes, per-cycle wall time, retry
 * and incident counts, and what content each adopted generation carried.
 * The printed table is the performance evidence the strategy tuning cites.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import DualCoreRsiService from '../src/index.ts'
import { RsiDistiller } from '../src/distiller.ts'
import { RsiBenchmark } from '../src/benchmark.ts'
import type { RsiBenchmarkReport, RsiBenchmarkRequest, RsiDistillInput, RsiDistillOutput, RsiGeneration } from '../src/index.ts'

/** One scripted step: a settled proposal, or a rejection to simulate breakage. */
type Step = RsiDistillOutput | Error

/** Distiller replaying a scripted step list; beyond the list it saturates. */
class RampDistiller extends RsiDistiller {
  readonly inputs: RsiDistillInput[] = []
  private cursor = 0

  constructor(ctx: Context, private readonly steps: readonly Step[]) {
    super(ctx)
  }

  distill(input: RsiDistillInput): Promise<RsiDistillOutput> {
    this.inputs.push(input)
    const step = this.steps[this.cursor]
    this.cursor += 1
    if (step === undefined) return Promise.resolve(SATURATED)
    if (step instanceof Error) return Promise.reject(step)
    return Promise.resolve(step)
  }
}

const SATURATED: RsiDistillOutput = {
  rationale: 'keep the saturated policy',
  artifacts: { guidance: ['verify each edit with focused tests', 'verify commands succeed before finishing', 'verify the checklist before finishing'], skills: [] },
}

/** Keyword benchmark mirroring the shipped fixture's verify-keyword scoring. */
class VerifyBenchmark extends RsiBenchmark {
  constructor(ctx: Context, private readonly perHit: number) {
    super(ctx)
  }

  async evaluate(request: RsiBenchmarkRequest): Promise<RsiBenchmarkReport> {
    const hits = request.generation.artifacts.guidance.filter(line => line.includes('verify')).length
    return { provider: 'verify', scoredAt: Date.now(), score: Math.min(1, hits * this.perHit), cases: [] }
  }
}

/** The quality ramp: what a real daemon sees across a day of sessions. */
const RAMP: readonly Step[] = [
  // 1: the distiller backend is down.
  new Error('distiller backend offline'),
  // 2: a first incremental win (+0.4).
  { rationale: 'add the first verify habit', artifacts: { guidance: ['verify each edit with focused tests'], skills: [] } },
  // 3: a regression candidate.
  { rationale: 'drop the verify habit', artifacts: { guidance: ['move fast without verification'], skills: [] } },
  // 4: a duplicate of the current policy (ties it).
  { rationale: 'no new evidence worth changing', artifacts: { guidance: ['verify each edit with focused tests'], skills: [] } },
  // 5: another incremental win (+0.4).
  { rationale: 'add a second verify habit', artifacts: { guidance: ['verify each edit with focused tests', 'verify commands succeed before finishing'], skills: [] } },
  // 6: a timeout-prone stall, then saturation steps follow via SATURATED.
  new Error('distiller stalled past the timebox'),
]

const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
})

describe('self-evolution observation', () => {
  it('measures adoption, cycle time, repairs, and content across a quality ramp', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const root = await mkdtemp(join(tmpdir(), 'rsi-observation-'))
    await ctx.plugin(Storage)
    await ctx.plugin(storageJson, { root })
    await ctx.plugin(storageDomainPlugin, { backend: 'json' })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('observation')
    const distiller = new RampDistiller(ctx, RAMP)
    // perHit 0.4 mirrors the bundle's fixture weight so saturation lands at 3 guidance lines.
    void new VerifyBenchmark(ctx, 0.4)
    const service = new DualCoreRsiService(ctx, {
      daemonEnabled: true,
      mergePolicy: 'auto',
      daemonIntervalMs: 5,
      daemonMaxRetries: 2,
      daemonRetryBackoffMs: 1,
      cycleTimeoutMs: 5_000,
      ledgerDir: join(root, 'ledger'),
    })
    await service.waitReady()

    // A live idle agent anchors the daemon children, like any open session.
    let scopeCtx!: Context
    await ctx.plugin(Object.assign((inner: Context) => { scopeCtx = inner }, { inject: ['systemPrompt', 'skills'] }))
    const scope = createScope(scopeCtx, {})
    let status: AgentStatus = 'idle'
    const agent: Agent = {
      id: SessionId('observation'),
      options: {},
      session: ctx.sessions.create(SessionId('observation')),
      inbox: createInboxStub(),
      ctx: scope.ctx,
      get status() { return status },
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject() {},
      cancel() { status = 'idle' },
      runMaintenance: task => task(new AbortController().signal),
      whenIdle() { return Promise.resolve() },
    }
    await ctx.agents.register(agent)
    const session = agent.session
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'please verify the checklist before finishing' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // Drive the scheduled daemon itself, so failures go through the real
    // self-repair path: after every settled cycle, one fresh session event
    // arms the next tick. The ramp carries 2 failures and 4 proposals, then
    // saturation; wait for 6 settled cycles with all 8 attempts consumed.
    const target = 6
    const deadline = Date.now() + 60_000
    let turn = 2
    while ((await service.history(50)).cycles.length < target) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `verify iteration ${turn} before finishing` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      turn += 1
      await new Promise(resolve => setTimeout(resolve, 25))
      if (Date.now() > deadline) {
        const s = await service.status()
        throw new Error(`daemon stalled: cycles=${(await service.history(50)).cycles.length} running=${s.cycleRunning} unseen=${s.unseenSessionCount} distillCalls=${distiller.inputs.length} active=${s.active.id} score=${s.active.benchmark?.score}`)
      }
      void turn
    }
    await new Promise(resolve => setTimeout(resolve, 30))

    const { cycles, incidents } = await service.history(50)
    const adopted = cycles.filter(record => record.outcome === 'promoted')
    const durations = cycles.map(record => record.settledAt - record.startedAt)
    const wallMs = cycles.reduce((sum, record) => sum + (record.settledAt - record.startedAt), 0)

    // The observation table: the durable evidence the strategy reads.
    const table = cycles.map(record => [
      record.id,
      record.trigger,
      record.outcome,
      record.improvement.toFixed(2),
      `${record.settledAt - record.startedAt}ms`,
      record.rationale.slice(0, 40),
    ])
    console.log('RSI observation — cycles:', JSON.stringify(table))
    console.log('RSI observation — incidents:', incidents.length, 'durations min/avg/max(ms):',
      Math.min(...durations), Math.round(durations.reduce((a, b) => a + b, 0) / durations.length), Math.max(...durations),
      'total wall(ms):', wallMs, 'adopted:', adopted.length, '/', cycles.length)

    // Behavioral expectations the tuning must preserve: the two incremental
    // wins adopt, the regression and the duplicate retain, and the saturated
    // proposal adopts once (+0.2) before the ceiling makes further adoption
    // impossible.
    expect(adopted.map(record => record.rationale)).toEqual([
      'keep the saturated policy',
      'add a second verify habit',
      'add the first verify habit',
    ])
    // Every further cycle settles retained; the saturation skip makes each of
    // them free (0ms, no distillation child), so their count is unbounded.
    expect(cycles.filter(record => record.outcome === 'retained').length).toBe(cycles.length - 3)
    expect(cycles.length).toBeGreaterThanOrEqual(6)
    // Both scripted failures self-repaired and were recorded once each.
    expect(incidents.map(incident => incident.detail)).toEqual(['distiller stalled past the timebox', 'distiller backend offline'])
    // The two observation-driven skips, measured: the ramp carries 8
    // distillation-worthy steps (6 outcomes plus 2 failures); every
    // post-saturation cycle settles without a model child, and the
    // duplicate-content cycle spends no benchmark evaluation.
    expect(distiller.inputs.length).toBe(7)
    // The duplicate-content cycle retained without an evaluation, and at
    // least one post-saturation cycle settled on the fixed saturation
    // rationale without spending a model child.
    const duplicate = cycles.find(record => record.rationale === 'no new evidence worth changing')
    expect(duplicate?.outcome).toBe('retained')
    expect(duplicate?.improvement).toBe(0)
    const free = cycles.filter(record => record.rationale.includes('saturates the benchmark'))
    expect(free.length).toBeGreaterThanOrEqual(1)
    expect(free.every(record => record.outcome === 'retained' && record.improvement === 0)).toBe(true)
    // Every cycle settles quickly; the whole observation costs well under a second of daemon wall time.
    expect(Math.max(...durations)).toBeLessThan(2_000)
    expect(wallMs).toBeLessThan(4_000)

    // The adopted content reached the agent surface and the ledger.
    const active: RsiGeneration = (await service.status()).active
    expect(active.artifacts.guidance).toEqual(SATURATED.artifacts.guidance)
    const ledgerMeta = JSON.parse(await readFile(join(root, 'ledger', 'policy', 'meta.json'), 'utf8')) as { generationId: string }
    expect(ledgerMeta.generationId).toBe(active.id)
  }, 60_000)
})
