import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope, ScopeKey } from '@deepseek-ai/dsh-scope'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { JobId } from '@deepseek-ai/dsh-jobs'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import DualCoreRsiService, { dualCoreRsiDomain, RSI_STATE_KEY } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { renderStatus } from '../src/render.ts'
import { RsiLedger } from '../src/ledger.ts'
import { RsiDistiller } from '../src/distiller.ts'
import { RsiBenchmark } from '../src/benchmark.ts'
import { RsiArchiveId, RsiGenerationId } from '../src/branding.ts'
import type { RsiArtifacts, RsiDistillInput, RsiDistillOutput, RsiGeneration } from '../src/index.ts'

/** Subprocess runtime whose world resolves nothing, for ledger-unavailable paths. */
class StubSubprocessRuntime extends SubprocessRuntime {
  resolveExecutable(): Promise<string> {
    return Promise.reject(new Error('no executable in the stub world'))
  }

  terminalEnvironment(): Promise<never> {
    return Promise.reject(new Error('no terminal in the stub world'))
  }

  spawn(): never {
    throw new Error('the stub world spawns nothing')
  }

  spawnTerminal(): never {
    throw new Error('the stub world allocates no terminal')
  }
}

/** A rejection the stub raises at distill time, possibly with a non-Error reason. */
class Rejection {
  constructor(readonly reason: unknown) {}
}

/** One scripted distiller answer: a settled proposal, a caller-held gate, or a rejection to raise. */
type ScriptedProposal = RsiDistillOutput | Promise<RsiDistillOutput> | Error | Rejection

/** Distiller stub replaying a scripted queue of proposals. */
class ScriptedDistiller extends RsiDistiller {
  readonly inputs: RsiDistillInput[] = []

  constructor(ctx: Context, private queue: ScriptedProposal[]) {
    super(ctx)
  }

  distill(input: RsiDistillInput): Promise<RsiDistillOutput> {
    this.inputs.push(input)
    const next = this.queue.shift()
    if (next === undefined) return Promise.reject(new Error('ScriptedDistiller has no proposal left'))
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error reason is the point of Rejection
    if (next instanceof Rejection) return Promise.reject(next.reason)
    if (next instanceof Error) return Promise.reject(next)
    return Promise.resolve(next)
  }
}

/**
 * Distiller stub whose proposal only settles when the attempt's abort signal
 * fires, so a timeboxed scheduled attempt can be driven deterministically.
 */
class AbortGatedDistiller extends RsiDistiller {
  readonly inputs: RsiDistillInput[] = []

  distill(input: RsiDistillInput, options: { signal: AbortSignal }): Promise<RsiDistillOutput> {
    this.inputs.push(input)
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(options.signal.reason instanceof Error ? options.signal.reason : new Error('distillation aborted'))
      }, { once: true })
    })
  }
}

/** Deterministic benchmark scoring keyword coverage of guidance lines. */
class KeywordBenchmark extends RsiBenchmark {
  constructor(ctx: Context, private readonly keyword: string, private readonly perHit: number) {
    super(ctx)
  }

  async evaluate(request: { generation: { artifacts: RsiArtifacts } }): Promise<{
    provider: string
    scoredAt: number
    score: number
    cases: { name: string; passed: boolean; weight: number; detail: string }[]
  }> {
    const hits = request.generation.artifacts.guidance.filter(line => line.includes(this.keyword)).length
    return {
      provider: 'keyword',
      scoredAt: Date.now(),
      score: Math.min(1, hits * this.perHit),
      cases: [{ name: 'keyword-coverage', passed: hits > 0, weight: 1, detail: `${hits} guidance lines carry "${this.keyword}"` }],
    }
  }
}

interface HarnessOptions {
  /** Keyword each guidance line must carry for benchmark credit. */
  keyword?: string
  /** Score granted per keyword-carrying guidance line. */
  perHit?: number
  /** Swap threshold; the default exercises the shipped 5% gate. */
  threshold?: number
  /** Distiller proposals replayed in order. */
  proposals?: ScriptedProposal[]
  /** Reuse a persisted storage root instead of a fresh temp directory. */
  root?: string
  /** Mount every service except the controller, for agent-before-service compositions. */
  deferService?: boolean
  /** Bounded wait of `/rsi run` in milliseconds. */
  runWaitMs?: number
  /** Extra controller configuration: daemon scheduling, timeboxes, retries. */
  rsi?: Partial<Config>
  /** Mount the user-questions service for exit-consult tests (default false). */
  userQuestions?: boolean
  /** Distiller whose proposals settle only on attempt abort (default the scripted queue). */
  abortGated?: boolean
  /** Mount the never-resolving subprocess stub instead of the local runtime. */
  stubSubprocess?: boolean
}

interface Harness {
  readonly ctx: Context
  service: DualCoreRsiService
  readonly distiller: ScriptedDistiller | AbortGatedDistiller
  readonly ledgerDir: string
}

/** Compose the full service stack over a temp JSON storage root. */
async function harness(options?: HarnessOptions): Promise<Harness> {
  const ctx = new Context()
  const root = options?.root ?? await mkdtemp(join(tmpdir(), 'dual-core-rsi-'))
  const ledgerDir = join(root, 'ledger')
  await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root })
  await ctx.plugin(storageDomainPlugin, { backend: 'json' })
  await ctx.plugin(options?.stubSubprocess === true ? StubSubprocessRuntime : LocalSubprocessRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  if (options?.userQuestions === true) await ctx.plugin(UserQuestionService)
  ctx.jobs.attachController('dual-core-rsi-test')
  const distiller = options?.abortGated === true
    ? new AbortGatedDistiller(ctx)
    : new ScriptedDistiller(ctx, options?.proposals ?? [])
  void new KeywordBenchmark(ctx, options?.keyword ?? 'verify', options?.perHit ?? 0.4)
  if (options?.deferService === true) return { ctx, service: undefined as never, distiller, ledgerDir }
  const service = new DualCoreRsiService(ctx, {
    daemonEnabled: false,
    ledgerDir,
    ...options?.threshold === undefined ? {} : { threshold: options.threshold },
    ...options?.runWaitMs === undefined ? {} : { runWaitMs: options.runWaitMs },
    ...options?.rsi,
  })
  await service.waitReady()
  return { ctx, service, distiller, ledgerDir }
}

/** Everything a test needs from one registered stub agent. */
interface StubAgentHandle {
  agent: Agent
  session: Session
  scope: Context
  key: ScopeKey
  scopeHandle: Scope
  registration: () => void
}

/** Build a live idle agent registered with the registry on its own scope. */
async function stubAgent(harness_: Harness, id: string): Promise<StubAgentHandle> {
  const session = harness_.ctx.sessions.create(SessionId(id))
  let injected!: Context
  await harness_.ctx.plugin(Object.assign((inner: Context) => {
    injected = inner
  }, { inject: ['systemPrompt', 'skills'] }))
  const scopeKey: ScopeKey = {}
  const scope = createScope(injected, scopeKey)
  let status: AgentStatus = 'idle'
  const agent: Agent = {
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
  const registered = await harness_.ctx.agents.register(agent)
  const registration = (): void => { void registered() }
  return { agent, session, scope: scope.ctx, key: scopeKey, scopeHandle: scope, registration }
}

const EMPTY: RsiDistillOutput = {
  rationale: 'nothing worth changing',
  artifacts: { guidance: [], skills: [] },
}

const STRONG: RsiDistillOutput = {
  rationale: 'two verify habits repeated across sessions',
  artifacts: {
    guidance: ['verify each edit with focused tests', 'verify commands succeed before finishing'],
    skills: [{
      name: 'verify-before-done',
      description: 'Habit of verifying work before reporting completion',
      content: 'Run the focused tests, then re-read the changed files before declaring done.',
    }],
  },
}

const STRONGER: RsiDistillOutput = {
  rationale: 'a third verify habit appeared across sessions',
  artifacts: {
    guidance: [
      'verify each edit with focused tests',
      'verify commands succeed before finishing',
      'verify the checklist before finishing',
    ],
    skills: [],
  },
}

const contexts: Context[] = []

afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
})

async function tracked(test: Promise<Harness>): Promise<Harness> {
  const harness_ = await test
  contexts.push(harness_.ctx)
  return harness_
}

function execute(ctx: Context, name: string, args: unknown): Promise<{ isError: boolean; value?: unknown }> {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('rsi-call'),
    name,
    arguments: args,
  })
}

describe('dsh-experimental-dual-core-rsi controller', () => {
  it('seeds the two cores and reports an idle status', async () => {
    const test = await tracked(harness())
    const status = await test.service.status()
    expect(status.active.id).toBe('gen-1')
    expect(status.daemon.id).toBe('gen-2')
    expect(status.active.origin).toBe('initial')
    expect(status.daemon.parent).toBe('gen-1')
    expect(status.threshold).toBe(0.05)
    expect(status.cycleRunning).toBe(false)
    expect(status.archiveCount).toBe(0)
    expect(status.lastCycle).toBeUndefined()
    expect(status.pending).toBeUndefined()
    expect(status.incidents).toEqual([])
    expect((await test.service.history()).cycles).toEqual([])
  })

  it('retains an equal-scoring candidate and keeps the active core', async () => {
    const test = await tracked(harness({ proposals: [EMPTY] }))
    await stubAgent(test, 'user-core')
    const record = await test.service.runCycle('command', new AbortController().signal)
    expect(record.outcome).toBe('retained')
    expect(record.improvement).toBe(0)
    expect(record.candidateScore).toBe(0)
    const status = await test.service.status()
    expect(status.active.id).toBe('gen-1')
    expect(status.daemon.id).toBe(record.candidateId)
    expect(status.lastCycle?.id).toBe('1')
    expect(status.lastCycle?.rationale).toBe('nothing worth changing')
  })

  it('does not promote a candidate at exactly the threshold', async () => {
    const test = await tracked(harness({
      perHit: 0.25,
      threshold: 0.5,
      proposals: [{ rationale: 'half credit', artifacts: { guidance: ['verify once', 'verify twice'], skills: [] } }],
    }))
    await stubAgent(test, 'user-core')
    const record = await test.service.runCycle('tool', new AbortController().signal)
    expect(record.candidateScore).toBe(0.5)
    expect(record.improvement).toBeCloseTo(0.5)
    expect(record.outcome).toBe('retained')
    const history = await test.service.history()
    expect(history.cycles).toHaveLength(1)
  })

  it('parks a gate-passing candidate as pending, then merges it into the active core', async () => {
    const test = await tracked(harness({ proposals: [STRONG] }))
    const core = await stubAgent(test, 'user-core')
    const before = (await core.scope.systemPrompt.assemble({ scope: core.key })).sections.find(section => section.name === 'rsi:distilled-policy')
    expect(before).toBeUndefined()

    const record = await test.service.runCycle('command', new AbortController().signal)
    expect(record.outcome).toBe('pending')
    expect(record.improvement).toBeCloseTo(0.8)
    let status = await test.service.status()
    // A gate-passing candidate never replaces the policy on its own.
    expect(status.active.id).toBe('gen-1')
    expect(status.pending?.generation.id).toBe(record.candidateId)
    expect(status.pending?.cycle.rationale).toBe('two verify habits repeated across sessions')
    expect(renderStatus(status)).toContain('Next: /rsi merge adopts the pending policy and records it in the local git ledger')
    expect(renderStatus(status)).toContain('Pending merge: gen-3 from cycle 1')
    expect((await core.scope.systemPrompt.assemble({ scope: core.key })).sections.find(section => section.name === 'rsi:distilled-policy')).toBeUndefined()

    const merged = await test.service.mergePending('command')
    expect(merged.generation.id).toBe(record.candidateId)
    expect(merged.ledger.committed).toBe(true)
    status = await test.service.status()
    expect(status.active.id).toBe(record.candidateId)
    expect(status.active.artifacts.guidance).toHaveLength(2)
    expect(status.pending).toBeUndefined()
    expect(status.daemon.parent).toBe(record.candidateId)
    expect(status.daemon.artifacts).toEqual(status.active.artifacts)
    expect(status.daemon.benchmark?.score).toBeCloseTo(0.8)

    const { cycles, archives } = await test.service.history()
    expect(cycles[0]?.decision).toBe('merged')
    expect(archives).toHaveLength(1)
    expect(archives[0]!.id).toBe('arc-1')
    expect(archives[0]!.reason).toBe('swap')
    expect(archives[0]!.generation.id).toBe('gen-1')
    expect(archives[0]!.supersededBy).toBe(record.candidateId)

    const section = (await core.scope.systemPrompt.assemble({ scope: core.key })).sections.find(candidate => candidate.name === 'rsi:distilled-policy')
    expect(section?.text).toContain('verify each edit with focused tests')
    expect(section?.text).toContain('verify-before-done')
  })

  it('keeps the better pending candidate when a weaker one also passes the gate', async () => {
    const test = await tracked(harness({
      perHit: 0.3,
      proposals: [STRONG, { rationale: 'weaker but passing', artifacts: { guidance: ['verify once'], skills: [] } }],
    }))
    await stubAgent(test, 'user-core')
    const first = await test.service.runCycle('command', new AbortController().signal)
    const second = await test.service.runCycle('command', new AbortController().signal)
    expect(second.outcome).toBe('retained')
    const status = await test.service.status()
    expect(status.pending?.generation.id).toBe(first.candidateId)
    // The weaker candidate still joins the daemon lineage only when it scores at least as well; it does not.
    expect(status.daemon.id).toBe(first.candidateId)
  })

  it('keeps a worse-scoring candidate off the daemon lineage', async () => {
    const test = await tracked(harness({
      perHit: 0.4,
      proposals: [STRONG, EMPTY],
    }))
    await stubAgent(test, 'user-core')
    await test.service.runCycle('command', new AbortController().signal)
    const daemonBefore = (await test.service.status()).daemon.id
    const record = await test.service.runCycle('command', new AbortController().signal)
    expect(record.candidateScore).toBe(0)
    const status = await test.service.status()
    expect(status.daemon.id).toBe(daemonBefore)
    const history = await test.service.history()
    expect(history.cycles.map(item => item.id)).toEqual(['2', '1'])
    const bounded = await test.service.history(1)
    expect(bounded.cycles).toHaveLength(1)
  })

  it('registers distilled skills on the agent scope through the merge', async () => {
    const test = await tracked(harness({ proposals: [STRONG] }))
    const core = await stubAgent(test, 'user-core')
    await test.service.runCycle('schedule', new AbortController().signal)
    const before = await core.scope.skills.list({ scope: core.key })
    expect(before.some(skill => skill.name === 'verify-before-done')).toBe(false)
    await test.service.mergePending('command')
    const skills = await core.scope.skills.list({ scope: core.key })
    const distilled = skills.find(skill => skill.name === 'verify-before-done')
    expect(distilled?.description).toContain('verifying work')
  })

  it('rolls back to an archive and archives the rollback in turn', async () => {
    const test = await tracked(harness({ proposals: [STRONG] }))
    const core = await stubAgent(test, 'user-core')
    await test.service.runCycle('command', new AbortController().signal)
    await test.service.mergePending('command')

    const first = await test.service.rollback(RsiArchiveId('arc-1'))
    expect(first.restored.id).toBe('gen-1')
    expect(first.archived.reason).toBe('rollback')
    expect(first.ledger.committed).toBe(true)
    const status = await test.service.status()
    expect(status.active.id).toBe('gen-1')
    expect(status.active.artifacts.guidance).toEqual([])
    const section = (await core.scope.systemPrompt.assemble({ scope: core.key })).sections.find(candidate => candidate.name === 'rsi:distilled-policy')
    expect(section).toBeUndefined()

    const again = await test.service.rollback()
    expect(again.restored.id).toBe(first.archived.generation.id)
    expect((await test.service.status()).active.artifacts.guidance).toHaveLength(2)
    const { archives } = await test.service.history()
    expect(archives.map(entry => entry.id)).toEqual(['arc-3', 'arc-2', 'arc-1'])
  })

  it('rejects rollback to an unknown archive id and on an empty archive set', async () => {
    const test = await tracked(harness())
    await expect(test.service.rollback(RsiArchiveId('arc-404'))).rejects.toThrow(/does not exist/)
    await expect(test.service.rollback()).rejects.toThrow(/nothing to roll back to/)
  })

  it('keeps the better daemon lineage when a weaker candidate merges after a decline', async () => {
    const test = await tracked(harness({
      perHit: 0.3,
      proposals: [STRONG, { rationale: 'weaker but passing', artifacts: { guidance: ['verify once'], skills: [] } }],
    }))
    await stubAgent(test, 'lineage-core')
    await test.service.runCycle('command', new AbortController().signal)
    await test.service.declinePending('command')
    const stronger = (await test.service.status()).daemon.id
    const second = await test.service.runCycle('command', new AbortController().signal)
    expect(second.outcome).toBe('pending')
    await test.service.mergePending('command')
    // The declined STRONG generation still scores higher than the merged candidate, so the daemon keeps it.
    const status = await test.service.status()
    expect(status.daemon.id).toBe(stronger)
    expect(status.daemon.benchmark?.score).toBeCloseTo(0.6)
    expect(status.active.id).toBe(second.candidateId)
  })

  it('a rollback declines a still-pending candidate and names it in the ledger record', async () => {
    const test = await tracked(harness({ proposals: [STRONG, STRONGER] }))
    await stubAgent(test, 'pending-rollback-core')
    await test.service.runCycle('command', new AbortController().signal)
    await test.service.mergePending('command')
    const second = await test.service.runCycle('command', new AbortController().signal)
    expect(second.outcome).toBe('pending')

    const rolled = await test.service.rollback()
    expect(rolled.ledger.committed).toBe(true)
    const status = await test.service.status()
    expect(status.pending).toBeUndefined()
    expect(status.active.id).toBe('gen-1')
    expect((await test.service.history()).cycles[0]?.decision).toBe('declined')
    const meta = JSON.parse(await readFile(join(test.ledgerDir, 'policy', 'meta.json'), 'utf8')) as { reason: string }
    expect(meta.reason).toBe('rollback')
  })

  it('reports a completed retained cycle without a pending candidate', async () => {
    const test = await tracked(harness({ proposals: [EMPTY] }))
    const { agent } = await stubAgent(test, 'retained-core')
    const run = await runCommand(test, agent, 'run')
    expect(run.kind).toBe('success')
    expect(run.text).toContain('Cycle finished: cycle 1 (command) kept the current policy')
    expect(run.text).not.toContain('/rsi merge or /rsi decline')
  })

  it('requires a live anchor agent and surfaces distiller exhaustion', async () => {
    const test = await tracked(harness())
    await expect(test.service.runCycle('command', new AbortController().signal)).rejects.toThrow(/open a user session first/)

    await stubAgent(test, 'user-core')
    const held = test.service.runCycle('command', new AbortController().signal)
    await expect(held).rejects.toThrow(/no proposal left/)
    // A failed cycle releases the running lock.
    const status = await test.service.status()
    expect(status.cycleRunning).toBe(false)
  })

  it('rejects a concurrent second cycle while one is in flight', async () => {
    let release: (output: RsiDistillOutput) => void = () => {}
    const gate = new Promise<RsiDistillOutput>((resolve) => { release = resolve })
    const test = await tracked(harness({ proposals: [gate] }))
    await stubAgent(test, 'user-core')
    const first = test.service.runCycle('command', new AbortController().signal)
    await vi.waitFor(() => { expect(test.distiller.inputs.length).toBe(1) })
    await expect(test.service.runCycle('tool', new AbortController().signal)).rejects.toThrow(/already running/)
    release(EMPTY)
    expect((await first).outcome).toBe('retained')
    const status = await test.service.status()
    expect(status.cycleRunning).toBe(false)
  })

  it('applies the active policy to agents created after the merge', async () => {
    const test = await tracked(harness({ proposals: [STRONG] }))
    await stubAgent(test, 'user-core')
    await test.service.runCycle('command', new AbortController().signal)
    await test.service.mergePending('command')
    const late = await stubAgent(test, 'user-core-late')
    const sections = (await late.scope.systemPrompt.assemble({ scope: late.key })).sections.filter(section => section.name === 'rsi:distilled-policy')
    expect(sections).toHaveLength(1)
    expect(sections[0]!.text).toContain('verify each edit with focused tests')
  })

  it('runs the daemon cycle through the job registry and the rsi tools', async () => {
    const test = await tracked(harness({ proposals: [STRONG] }))
    await stubAgent(test, 'user-core')

    const statusResult = await execute(test.ctx, 'rsi_status', {})
    expect(statusResult.isError).toBe(false)

    const runResult = await execute(test.ctx, 'rsi_run', {})
    expect(runResult.isError).toBe(false)
    const jobId = (runResult.value as { jobId: string }).jobId
    expect(jobId).toMatch(/^dual-core-rsi-/)
    const job = await test.ctx.jobs.wait(JobId(jobId), 10_000)
    expect(job.status).toBe('completed')

    // The rollback tools operate on archives a merge created.
    await test.service.mergePending('command')
    const defaultHistory = await execute(test.ctx, 'rsi_history', {})
    expect(defaultHistory.isError).toBe(false)
    const historyResult = await execute(test.ctx, 'rsi_history', { limit: 5 })
    expect(historyResult.isError).toBe(false)
    const noIdRollback = await execute(test.ctx, 'rsi_rollback', {})
    expect(noIdRollback.isError).toBe(false)

    const rollbackResult = await execute(test.ctx, 'rsi_rollback', { archiveId: 'arc-1' })
    expect(rollbackResult.isError).toBe(false)
    expect((await test.service.status()).active.id).toBe('gen-1')
  })

  it('exposes pure presentation functions for every rsi tool', async () => {
    const test = await tracked(harness())
    const status = test.ctx.tools.get('rsi_status')!
    expect(status.presentCall!({})).toEqual({ card: 'generic', title: 'rsi_status', rawInput: '' })
    expect(status.presentResult!({}, { content: [], isError: false })).toEqual({ card: 'generic' })
    const run = test.ctx.tools.get('rsi_run')!
    expect(run.presentCall!({})).toEqual({ card: 'generic', title: 'rsi_run', rawInput: '' })
    expect(run.presentResult!({}, { content: [], isError: false })).toEqual({ card: 'generic' })
    const history = test.ctx.tools.get('rsi_history')!
    expect(history.presentCall!({ limit: 3 })).toEqual({ card: 'generic', title: 'rsi_history', rawInput: '{"limit":3}' })
    expect(history.presentCall!({})).toEqual({ card: 'generic', title: 'rsi_history', rawInput: '{}' })
    expect(history.presentResult!({}, { content: [], isError: false })).toEqual({ card: 'generic' })
    const rollback = test.ctx.tools.get('rsi_rollback')!
    expect(rollback.presentCall!({ archiveId: 'arc-1' })).toEqual({ card: 'generic', title: 'rsi_rollback', rawInput: '{"archiveId":"arc-1"}' })
    expect(rollback.presentCall!({})).toEqual({ card: 'generic', title: 'rsi_rollback', rawInput: '{}' })
    expect(rollback.presentResult!({}, { content: [], isError: false })).toEqual({ card: 'generic' })
  })

  it('renders a failed job detail for non-Error rejections', async () => {
    // The second proposal rejects with a plain string so the job error path handles a non-Error reason.
    const test = await tracked(harness({ proposals: [new Rejection(new Error('first exhausts')), new Rejection('plain string')] }))
    await stubAgent(test, 'user-core')
    const first = await execute(test.ctx, 'rsi_run', {})
    const firstJob = await test.ctx.jobs.wait(JobId((first.value as { jobId: string }).jobId), 10_000)
    expect(firstJob.status).toBe('failed')
    const second = await execute(test.ctx, 'rsi_run', {})
    const secondJob = await test.ctx.jobs.wait(JobId((second.value as { jobId: string }).jobId), 10_000)
    expect(secondJob.status).toBe('failed')
    expect(secondJob.detail).toContain('plain string')
  })

  it('rejects invalid rsi tool arguments', async () => {
    const test = await tracked(harness())
    const badLimit = await execute(test.ctx, 'rsi_history', { limit: 101 })
    expect(badLimit.isError).toBe(true)
    const badArchive = await execute(test.ctx, 'rsi_rollback', { archiveId: ' ' })
    expect(badArchive.isError).toBe(true)
  })

  it('serves the /rsi command grammar including the merge decision verbs', async () => {
    const test = await tracked(harness({ proposals: [STRONG] }))
    const { agent } = await stubAgent(test, 'command-core')
    const signal = new AbortController().signal

    const status = await runCommand(test, agent, 'status', signal)
    expect(status.kind).toBe('success')
    expect(status.text).toContain('User core: gen-1')
    expect(status.text).toContain('guidance text and skills only')

    const run = await runCommand(test, agent, 'run', signal)
    expect(run.kind).toBe('success')
    expect(run.text).toContain('Cycle finished:')
    expect(run.text).toContain('waits for your merge decision')
    expect(run.text).toContain('/rsi merge or /rsi decline')

    const summary = await runCommand(test, agent, 'summary', signal)
    expect(summary.kind).toBe('success')
    expect(summary.text).toContain('Dual-core RSI session summary')
    expect(summary.text).toContain('Improvement points — pending policy')

    const merged = await runCommand(test, agent, 'merge', signal)
    expect(merged.kind).toBe('success')
    expect(merged.text).toContain("Merged gen-3 into your agent's working policy via /rsi merge")
    expect(merged.text).toContain('git ledger recorded commit')

    const declineAfterMerge = await runCommand(test, agent, 'decline', signal)
    expect(declineAfterMerge.kind).toBe('error')
    expect(declineAfterMerge.text).toContain('no dual-core RSI candidate is waiting')

    const bad = await runCommand(test, agent, 'frobnicate', signal)
    expect(bad.kind).toBe('error')

    const missingId = await runCommand(test, agent, 'rollback ', signal)
    expect(missingId.kind).toBe('success')

    const unknown = await runCommand(test, agent, 'rollback arc-9', signal)
    expect(unknown.kind).toBe('error')

    const jobIds = test.ctx.jobs.list().map(job => job.id)
    await Promise.all(jobIds.map(id => test.ctx.jobs.wait(JobId(id), 10_000)))
    const rollback = await runCommand(test, agent, 'rollback arc-1', signal)
    expect(rollback.kind).toBe('success')
    expect(rollback.text).toContain('from its next request')
    const history = await runCommand(test, agent, 'history', signal)
    expect(history.text).toContain('Archives')
    expect(history.text).toContain('Restore one with /rsi rollback')
    const bare = await runCommand(test, agent, '', signal)
    expect(bare.kind).toBe('success')
  })

  it('declines a pending candidate through the command and keeps the current policy', async () => {
    const test = await tracked(harness({ proposals: [STRONG] }))
    const { agent } = await stubAgent(test, 'decline-core')
    await test.service.runCycle('command', new AbortController().signal)
    const decline = await runCommand(test, agent, 'decline')
    expect(decline.kind).toBe('success')
    expect(decline.text).toContain('Kept the current policy via /rsi decline')
    const status = await test.service.status()
    expect(status.active.id).toBe('gen-1')
    expect(status.pending).toBeUndefined()
    expect((await test.service.history()).cycles[0]?.decision).toBe('declined')
    const summary = await runCommand(test, agent, 'summary')
    expect(summary.kind).toBe('success')
    expect(summary.text).toContain('No dual-core RSI candidate is waiting')
    const mergeAfter = await runCommand(test, agent, 'merge')
    expect(mergeAfter.kind).toBe('error')
  })

  it('drops the applied policy when an agent is disposed', async () => {
    const test = await tracked(harness({ proposals: [STRONG] }))
    const core = await stubAgent(test, 'user-core')
    await test.service.runCycle('command', new AbortController().signal)
    await test.service.mergePending('command')
    expect((await core.scope.systemPrompt.assemble({ scope: core.key })).sections.some(section => section.name === 'rsi:distilled-policy')).toBe(true)
    core.registration()
    const status = await test.service.status()
    expect(status.cycleRunning).toBe(false)
    expect((await core.scope.systemPrompt.assemble({ scope: core.key })).sections.some(section => section.name === 'rsi:distilled-policy')).toBe(false)
    await core.scopeHandle.dispose()
  })

  it('reports a failed daemon job with its detail and releases the cycle lock', async () => {
    const test = await tracked(harness())
    await stubAgent(test, 'user-core')
    const runResult = await execute(test.ctx, 'rsi_run', {})
    const jobId = (runResult.value as { jobId: string }).jobId
    const job = await test.ctx.jobs.wait(JobId(jobId), 10_000)
    expect(job.status).toBe('failed')
    expect(job.detail).toContain('no proposal left')
    expect((await test.service.status()).cycleRunning).toBe(false)
  })

  it('kills an in-flight daemon job through the registry', async () => {
    let rejectGate: (error: Error) => void = () => {}
    const gate = new Promise<RsiDistillOutput>((resolve, reject) => {
      rejectGate = reject
      void resolve
    })
    const test = await tracked(harness({ proposals: [gate] }))
    await stubAgent(test, 'user-core')
    const runResult = await execute(test.ctx, 'rsi_run', {})
    const jobId = JobId((runResult.value as { jobId: string }).jobId)
    await vi.waitFor(() => { expect(test.distiller.inputs.length).toBe(1) })
    test.ctx.jobs.kill(jobId)
    // The daemon child honors the aborted cycle signal by failing its proposal.
    rejectGate(new Error('distillation aborted'))
    const job = await test.ctx.jobs.wait(jobId, 10_000)
    expect(job.status).toBe('killed')
    expect(job.detail).toContain('distillation aborted')
    expect((await test.service.status()).cycleRunning).toBe(false)
  })

  it('fails initialization loudly when durable state points at a missing generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dual-core-rsi-corrupt-'))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin(storageJson, { root })
    await ctx.plugin(storageDomainPlugin, { backend: 'json' })
    await ctx.plugin(LocalSubprocessRuntime)
    const domain = await ctx.storageDomain.open(dualCoreRsiDomain)
    await domain.table('state').put(RSI_STATE_KEY, {
      activeId: RsiGenerationId('gen-404'),
      daemonId: RsiGenerationId('gen-405'),
      cycleCounter: 0,
      generationCounter: 2,
      archiveCounter: 0,
    })
    await domain.close()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('dual-core-rsi-test')
    const distiller = new ScriptedDistiller(ctx, [])
    void new KeywordBenchmark(ctx, 'verify', 0.4)
    // The agent registers before the service so the broken initialization never reaches its listener.
    const broken = await stubAgent({ ctx, service: undefined as never, distiller, ledgerDir: join(root, 'ledger') }, 'broken-core')
    const service = new DualCoreRsiService(ctx, { daemonEnabled: false, ledgerDir: join(root, 'ledger') })
    await expect(service.waitReady()).rejects.toThrow(/is missing from the storage domain/)
    // A rollback command on the broken service surfaces the infrastructure failure as an error result.
    const rollback = await runCommand({ ctx, service, distiller, ledgerDir: join(root, 'ledger') }, broken.agent, 'rollback arc-1', new AbortController().signal)
    expect(rollback.kind).toBe('error')
    expect(rollback.text).toContain('is missing from the storage domain')
  })

  it('restores merged cores from persisted state across a remount', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dual-core-rsi-reload-'))
    const first = await tracked(harness({ proposals: [STRONG], root }))
    await stubAgent(first, 'user-core')
    const pending = await first.service.runCycle('command', new AbortController().signal)
    const merged = await first.service.mergePending('command')
    expect(merged.generation.id).toBe(pending.candidateId)
    await first.ctx.fiber.dispose()
    contexts.pop()

    const second = await tracked(harness({ root, deferService: true }))
    const late = await stubAgent(second, 'user-core-late')
    second.service = new DualCoreRsiService(second.ctx, { daemonEnabled: false, ledgerDir: second.ledgerDir })
    await second.service.waitReady()
    const status = await second.service.status()
    expect(status.active.id).toBe(pending.candidateId)
    expect(status.active.artifacts.guidance).toHaveLength(2)
    expect(status.lastCycle?.id).toBe('1')
    expect(status.lastCycle?.decision).toBe('merged')
    expect(status.pending).toBeUndefined()
    const sections = (await late.scope.systemPrompt.assemble({ scope: late.key })).sections
      .filter(section => section.name === 'rsi:distilled-policy')
    expect(sections).toHaveLength(1)
    expect(sections[0]!.text).toContain('verify each edit with focused tests')
  })

  it('reports a failed /rsi run directly with an unchanged-state note', async () => {
    const test = await tracked(harness({ proposals: [new Rejection(new Error('distiller offline'))] }))
    const { agent } = await stubAgent(test, 'user-core')
    const run = await runCommand(test, agent, 'run')
    expect(run.kind).toBe('error')
    expect(run.text).toContain('ended as failed: distiller offline')
    expect(run.text).toContain('Nothing was changed')
    expect((await test.service.status()).active.id).toBe('gen-1')
  })

  it('falls back to background continuation when /rsi run exceeds its wait budget', async () => {
    let release: (output: RsiDistillOutput) => void = () => {}
    const gate = new Promise<RsiDistillOutput>((resolve) => { release = resolve })
    const test = await tracked(harness({ proposals: [gate], runWaitMs: 1 }))
    const { agent } = await stubAgent(test, 'user-core')
    const run = await runCommand(test, agent, 'run')
    expect(run.kind).toBe('success')
    expect(run.text).toContain('still running in the background')
    expect(run.text).toContain('run /rsi again in a moment')
    const jobId = JobId(test.ctx.jobs.list()[0]!.id)
    release(EMPTY)
    await test.ctx.jobs.wait(jobId, 10_000)
    expect((await test.service.status()).lastCycle?.outcome).toBe('retained')
  })


  it('reports a killed /rsi run as an error with an unchanged-state note', async () => {
    let release: (output: RsiDistillOutput) => void = () => {}
    let rejectGate: (error: Error) => void = () => {}
    const gate = new Promise<RsiDistillOutput>((resolve, reject) => {
      release = resolve
      rejectGate = reject
    })
    const test = await tracked(harness({ proposals: [gate] }))
    const { agent } = await stubAgent(test, 'user-core')
    const pending = runCommand(test, agent, 'run')
    await vi.waitFor(() => { expect(test.distiller.inputs.length).toBe(1) })
    const jobId = JobId(test.ctx.jobs.list()[0]!.id)
    test.ctx.jobs.kill(jobId)
    rejectGate(new Error('cycle stopped'))
    const run = await pending
    expect(run.kind).toBe('error')
    expect(run.text).toContain('ended as killed')
    expect(run.text).toContain('Nothing was changed')
    void release
  })

  it('surfaces unseen session activity after a merge and clears it on refresh', async () => {
    const test = await tracked(harness({ proposals: [STRONG, STRONG] }))
    await stubAgent(test, 'user-core')
    await test.service.runCycle('command', new AbortController().signal)
    await test.service.mergePending('command')
    const adopted = (await test.service.status()).knowledgeCutoffAt
    expect(adopted).toBeGreaterThan(0)
    expect((await test.service.status()).unseenSessionCount).toBe(0)

    await new Promise(resolve => setTimeout(resolve, 5))
    const later = test.ctx.sessions.create(SessionId('later-work'))
    later.append('turn/start', { turn: 1 })
    later.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'the deploy steps changed, verify the new checklist' }],
      source: { kind: 'rsi-test' },
    }), { surfaceOp: 'append' })
    later.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const stale = await test.service.status()
    expect(stale.unseenSessionCount).toBe(1)
    const text = renderStatus(stale)
    expect(text).toContain('1 live session changed since the last cycle.')
    expect(text).toContain('Next: that activity is not in the current policy yet; /rsi run refreshes it')

    // The refresh candidate ties the merged policy, so it is retained rather than parked.
    await test.service.runCycle('command', new AbortController().signal)
    const refreshed = await test.service.status()
    expect(refreshed.unseenSessionCount).toBe(0)
    expect(refreshed.lastCycle?.outcome).toBe('retained')
    expect(refreshed.knowledgeCutoffAt!).toBeGreaterThanOrEqual(adopted!)
  })

  it('loads legacy pointer state written before adoption timestamps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dual-core-rsi-legacy-'))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin(storageJson, { root })
    await ctx.plugin(storageDomainPlugin, { backend: 'json' })
    await ctx.plugin(LocalSubprocessRuntime)
    const domain = await ctx.storageDomain.open(dualCoreRsiDomain)
    const legacyState = {
      activeId: RsiGenerationId('gen-1'),
      daemonId: RsiGenerationId('gen-2'),
      cycleCounter: 0,
      generationCounter: 2,
      archiveCounter: 0,
    }
    const initial: RsiGeneration = {
      id: RsiGenerationId('gen-1'),
      origin: 'initial',
      parent: null,
      createdAt: 1,
      artifacts: { guidance: [], skills: [] },
    }
    const daemon: RsiGeneration = { ...initial, id: RsiGenerationId('gen-2'), parent: initial.id }
    await domain.table('generations').put(initial.id, initial)
    await domain.table('generations').put(daemon.id, daemon)
    await domain.table('state').put(RSI_STATE_KEY, legacyState)
    await domain.close()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('dual-core-rsi-test')
    const distiller = new ScriptedDistiller(ctx, [])
    void new KeywordBenchmark(ctx, 'verify', 0.4)
    // Omitting ledgerDir exercises the harness-home default; this test never merges, so nothing is written.
    const service = new DualCoreRsiService(ctx, { daemonEnabled: false })
    await service.waitReady()
    const status = await service.status()
    expect(status.knowledgeCutoffAt).toBeUndefined()
    expect(status.unseenSessionCount).toBe(0)
    expect(status.incidents).toEqual([])
    expect(renderStatus(status)).not.toContain('Knowledge current as of:')
    expect(renderStatus(status)).toContain('nothing has been distilled yet')
    void distiller
  })

  it('renders an empty history and a fresh status through the command', async () => {
    const test = await tracked(harness())
    const { agent } = await stubAgent(test, 'fresh-core')
    const history = await runCommand(test, agent, 'history', new AbortController().signal)
    expect(history.kind).toBe('success')
    expect(history.text).toContain('No completed cycles yet.')
  })

  it('rejects invalid direct-mount configuration before touching services', () => {
    expect(() => new DualCoreRsiService(new Context(), { threshold: 0 })).toThrow(/threshold/)
    expect(() => new DualCoreRsiService(new Context(), { maxGuidanceLines: 0 })).toThrow(/maxGuidanceLines/)
    expect(() => new DualCoreRsiService(new Context(), { maxSkillContentChars: 1.5 })).toThrow(/maxSkillContentChars/)
    expect(() => new DualCoreRsiService(new Context(), { daemonMaxRetries: -1 })).toThrow(/daemonMaxRetries/)
    expect(() => new DualCoreRsiService(new Context(), { daemonMaxRetries: 11 })).toThrow(/daemonMaxRetries/)
    expect(() => new DualCoreRsiService(new Context(), { daemonIntervalMs: 0 })).toThrow(/daemonIntervalMs/)
    expect(() => new DualCoreRsiService(new Context(), { ledgerDir: 'relative/ledger' })).toThrow(/ledgerDir/)
    expect(() => new DualCoreRsiService(new Context(), { ledgerDir: ' padded ' })).toThrow(/ledgerDir/)
    expect(() => new DualCoreRsiService(new Context(), { ledgerDir: '' })).toThrow(/ledgerDir/)
  })
})

type CommandOutcome = { kind: 'success'; text: string } | { kind: 'error'; text: string }

const freshSignal = (): AbortSignal => new AbortController().signal

/** Append one seen turn to a new live session so its activity is unseen knowledge. */
function appendActivity(test: Harness, id: string): void {
  const session = test.ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'please verify the checklist before finishing' }],
    source: { kind: 'rsi-test' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

/** Run one git command inside the ledger repository and return its trimmed stdout. */
async function gitInLedger(test: Harness, args: string[]): Promise<string> {
  const executable = await test.ctx.subprocess.resolveExecutable('git', undefined, new AbortController().signal)
  const handle = test.ctx.subprocess.spawn({
    argv: [executable, ...args],
    cwd: test.ledgerDir,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65_536 }, stderr: { maxBytes: 65_536 } },
    graceMs: 2_000,
    signal: new AbortController().signal,
    env: { GIT_CONFIG_COUNT: '0' },
  })
  const outcome = await handle.done
  /* v8 ignore start -- collect-mode stdio always yields the reader. */
  const stdout = handle.collected.stdout?.readFrom(0)?.text ?? ''
  /* v8 ignore stop */
  if (outcome.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stdout}`)
  return stdout.trim()
}

describe('scheduled daemon', () => {
  it('runs cycles on its own tick when unseen session activity waits', async () => {
    const test = await tracked(harness({
      proposals: [STRONG],
      rsi: { daemonEnabled: true, daemonIntervalMs: 5 },
    }))
    await stubAgent(test, 'daemon-core')
    appendActivity(test, 'daemon-work')
    await vi.waitFor(async () => { expect((await test.service.status()).lastCycle).toBeDefined() })
    const status = await test.service.status()
    expect(status.lastCycle?.trigger).toBe('schedule')
    expect(status.lastCycle?.outcome).toBe('pending')
    expect(status.daemonEnabled).toBe(true)
  })

  it('skips ticks without unseen activity and without a live anchor', async () => {
    const anchored = await tracked(harness({
      proposals: [STRONG],
      rsi: { daemonEnabled: true, daemonIntervalMs: 5 },
    }))
    await stubAgent(anchored, 'quiet-core')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect((await anchored.service.history()).cycles).toEqual([])

    const unanchored = await tracked(harness({
      proposals: [STRONG],
      rsi: { daemonEnabled: true, daemonIntervalMs: 5 },
    }))
    appendActivity(unanchored, 'lonely-work')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect((await unanchored.service.history()).cycles).toEqual([])
  })

  it('re-arms its tick without starting a round while a manual cycle holds the lock', async () => {
    const test = await tracked(harness({
      abortGated: true,
      rsi: { daemonEnabled: true, daemonIntervalMs: 5, cycleTimeoutMs: 60_000 },
    }))
    await stubAgent(test, 'busy-core')
    appendActivity(test, 'busy-work')
    const held = test.service.runCycle('command', new AbortController().signal)
    await vi.waitFor(() => { expect(test.distiller.inputs.length).toBe(1) })
    // Ticks fire while the manual cycle runs; each re-arms instead of contending.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect((await test.service.history()).cycles).toEqual([])
    expect((await test.service.status()).cycleRunning).toBe(true)
    void held
  })

  it('retries a failing scheduled attempt with backoff and records incidents', async () => {
    const test = await tracked(harness({
      proposals: [new Error('distiller offline'), new Error('still offline'), STRONG],
      rsi: { daemonEnabled: true, daemonIntervalMs: 5, daemonMaxRetries: 2, daemonRetryBackoffMs: 1, cycleTimeoutMs: 5_000 },
    }))
    await stubAgent(test, 'flaky-core')
    appendActivity(test, 'flaky-work')
    await vi.waitFor(async () => { expect((await test.service.status()).lastCycle).toBeDefined() })
    const status = await test.service.status()
    expect(status.lastCycle?.outcome).toBe('pending')
    expect(status.incidents).toHaveLength(2)
    expect(status.incidents[0]?.kind).toBe('cycle-error')
    expect(status.incidents[0]?.recovery).toBe('retried')
    expect(status.incidents[0]?.detail).toContain('still offline')
    expect(status.incidents[1]?.attempt).toBe(1)
    const history = await test.service.history()
    expect(history.incidents.map(incident => incident.id)).toEqual(['inc-2', 'inc-1'])
  })

  it('timeboxes a stuck attempt, records the timeout, and defers to the next interval', async () => {
    const test = await tracked(harness({
      abortGated: true,
      rsi: { daemonEnabled: true, daemonIntervalMs: 50, daemonMaxRetries: 0, cycleTimeoutMs: 25 },
    }))
    await stubAgent(test, 'stuck-core')
    appendActivity(test, 'stuck-work')
    await vi.waitFor(async () => { expect((await test.service.status()).incidents.length).toBeGreaterThan(0) }, { timeout: 5_000 })
    const status = await test.service.status()
    expect(status.incidents[0]?.kind).toBe('cycle-timeout')
    expect(status.incidents[0]?.recovery).toBe('deferred')
    expect(status.incidents[0]?.retryAfterMs).toBe(50)
    expect(status.incidents[0]?.detail).toContain('exceeded cycleTimeoutMs (25ms)')
    expect(status.cycleRunning).toBe(false)
    expect(status.lastCycle).toBeUndefined()
  })

  it('kills a scheduled round inside its attempt and during its retry backoff', async () => {
    const inFlight = await tracked(harness({
      abortGated: true,
      rsi: { daemonEnabled: true, daemonIntervalMs: 5, daemonMaxRetries: 1, daemonRetryBackoffMs: 1, cycleTimeoutMs: 60_000 },
    }))
    await stubAgent(inFlight, 'kill-core')
    appendActivity(inFlight, 'kill-work')
    await vi.waitFor(() => { expect(inFlight.distiller.inputs.length).toBe(1) })
    const inFlightJob = JobId(inFlight.ctx.jobs.list().find(job => job.label.includes('scheduled'))!.id)
    inFlight.ctx.jobs.kill(inFlightJob)
    const killedInFlight = await inFlight.ctx.jobs.wait(inFlightJob, 10_000)
    expect(killedInFlight.status).toBe('killed')

    const backing = await tracked(harness({
      proposals: [new Error('one failure then backoff')],
      rsi: { daemonEnabled: true, daemonIntervalMs: 5, daemonMaxRetries: 1, daemonRetryBackoffMs: 60_000, cycleTimeoutMs: 5_000 },
    }))
    await stubAgent(backing, 'backoff-core')
    appendActivity(backing, 'backoff-work')
    await vi.waitFor(async () => { expect((await backing.service.status()).incidents.length).toBe(1) })
    const backoffJob = JobId(backing.ctx.jobs.list().find(job => job.label.includes('scheduled'))!.id)
    backing.ctx.jobs.kill(backoffJob)
    const killedBackoff = await backing.ctx.jobs.wait(backoffJob, 10_000)
    expect(killedBackoff.status).toBe('killed')
  })
})

describe('exit merge consult', () => {
  it('offers the pending candidate when the last session exits and merges on the answer', async () => {
    const test = await tracked(harness({ proposals: [STRONG], userQuestions: true }))
    const seen: { detail: string | undefined }[] = []
    const notes: string[] = []
    vi.spyOn(test.ctx.logger, 'info').mockImplementation((...args: unknown[]) => {
      notes.push(args.map(argument => String(argument)).join(' '))
    })
    test.ctx.on('user-questions/request', (request) => {
      seen.push({ detail: request.questions[0]?.detail })
      return Promise.resolve({ answers: [{ id: 'rsi-pending-merge', selected: ['Merge'] }] })
    })
    const core = await stubAgent(test, 'consult-core')
    await test.service.runCycle('command', new AbortController().signal)
    core.registration()
    await vi.waitFor(async () => { expect((await test.service.status()).active.id).not.toBe('gen-1') })
    const status = await test.service.status()
    expect(status.pending).toBeUndefined()
    expect(status.active.artifacts.guidance).toHaveLength(2)
    expect((await test.service.history()).cycles[0]?.decision).toBe('merged')
    expect(seen[0]?.detail).toContain('Improvement points — pending policy')
    expect(seen[0]?.detail).toContain('every scheduled attempt settled without repair')
    // The durable swap settles before the background git ledger commit; wait for the committed note.
    await vi.waitFor(() => {
      const merged = notes.find(note => note.includes('after the exit consult'))
      expect(typeof merged).toBe('string')
      expect(merged).toContain('ledger commit')
    }, { timeout: 15_000 })
  })

  it('declines the pending candidate when the user keeps the current policy', async () => {
    const test = await tracked(harness({ proposals: [STRONG], userQuestions: true }))
    test.ctx.on('user-questions/request', () => Promise.resolve({ answers: [{ id: 'rsi-pending-merge', selected: ['Keep current'] }] }))
    const core = await stubAgent(test, 'keep-core')
    await test.service.runCycle('command', new AbortController().signal)
    core.registration()
    await vi.waitFor(async () => {
      const status = await test.service.status()
      expect(status.pending).toBeUndefined()
      expect(status.active.id).toBe('gen-1')
    })
    expect((await test.service.history()).cycles[0]?.decision).toBe('declined')
  })

  it('treats an empty answer batch as keeping the current policy', async () => {
    const test = await tracked(harness({ proposals: [STRONG], userQuestions: true }))
    test.ctx.on('user-questions/request', () => Promise.resolve({ answers: [] }))
    const core = await stubAgent(test, 'silent-core')
    await test.service.runCycle('command', new AbortController().signal)
    core.registration()
    await vi.waitFor(async () => {
      const status = await test.service.status()
      expect(status.pending).toBeUndefined()
      expect(status.active.id).toBe('gen-1')
    })
    expect((await test.service.history()).cycles[0]?.decision).toBe('declined')
  })

  it('includes the daemon self-repairs of the session in the exit summary', async () => {
    const test = await tracked(harness({
      proposals: [new Error('distiller offline'), new Error('still offline'), STRONG],
      userQuestions: true,
      rsi: { daemonEnabled: true, daemonIntervalMs: 5, daemonMaxRetries: 2, daemonRetryBackoffMs: 1, cycleTimeoutMs: 5_000 },
    }))
    const seen: { detail: string | undefined }[] = []
    test.ctx.on('user-questions/request', (request) => {
      seen.push({ detail: request.questions[0]?.detail })
      return Promise.resolve({ answers: [{ id: 'rsi-pending-merge', selected: ['Merge'] }] })
    })
    const core = await stubAgent(test, 'repair-core')
    appendActivity(test, 'repair-work')
    await vi.waitFor(async () => { expect((await test.service.status()).pending).toBeDefined() }, { timeout: 5_000 })
    core.registration()
    await vi.waitFor(async () => { expect((await test.service.status()).active.id).not.toBe('gen-1') })
    expect(seen[0]?.detail).toContain('Fix points — daemon self-repairs since the last decision (newest first):')
    expect(seen[0]?.detail).toContain('[cycle-error] attempt 2 retried after 1ms: still offline')
    expect(seen[0]?.detail).toContain('[cycle-error] attempt 1 retried after 1ms: distiller offline')
  })

  it('merges through the consult even when the git ledger is unavailable', async () => {
    const test = await tracked(harness({ proposals: [STRONG], userQuestions: true, stubSubprocess: true }))
    test.ctx.on('user-questions/request', () => Promise.resolve({ answers: [{ id: 'rsi-pending-merge', selected: ['Merge'] }] }))
    const core = await stubAgent(test, 'gitless-consult-core')
    await test.service.runCycle('command', new AbortController().signal)
    core.registration()
    await vi.waitFor(async () => { expect((await test.service.status()).active.id).not.toBe('gen-1') })
    expect((await test.service.status()).active.artifacts.guidance).toHaveLength(2)
  })

  it('keeps the candidate pending when no user-questions service is composed', async () => {
    const test = await tracked(harness({ proposals: [STRONG] }))
    const core = await stubAgent(test, 'headless-core')
    await test.service.runCycle('command', new AbortController().signal)
    core.registration()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect((await test.service.status()).pending).toBeDefined()
  })

  it('keeps the candidate pending when the answerer rejects the consult', async () => {
    const test = await tracked(harness({ proposals: [STRONG], userQuestions: true }))
    test.ctx.on('user-questions/request', () => Promise.reject(new Error('UI disconnected')))
    const core = await stubAgent(test, 'dropped-core')
    await test.service.runCycle('command', new AbortController().signal)
    core.registration()
    await new Promise(resolve => setTimeout(resolve, 30))
    const status = await test.service.status()
    expect(status.pending).toBeDefined()
    expect(status.active.id).toBe('gen-1')
  })
})

describe('git ledger', () => {
  it('records merges and rollbacks as commits in the ledger repository', async () => {
    const test = await tracked(harness({ proposals: [STRONG] }))
    await stubAgent(test, 'ledger-core')
    await test.service.runCycle('command', new AbortController().signal)
    const merged = await test.service.mergePending('command')
    expect(merged.ledger.committed).toBe(true)
    expect(merged.ledger.revision).toMatch(/^[0-9a-f]{7,40}$/)
    const guidance = await readFile(join(test.ledgerDir, 'policy', 'guidance.md'), 'utf8')
    expect(guidance).toContain('- verify each edit with focused tests')
    const skill = await readFile(join(test.ledgerDir, 'policy', 'skills', 'verify-before-done.md'), 'utf8')
    expect(skill).toContain('Run the focused tests')
    let meta = JSON.parse(await readFile(join(test.ledgerDir, 'policy', 'meta.json'), 'utf8')) as { generationId: string; reason: string }
    expect(meta.generationId).toBe(merged.generation.id)
    expect(meta.reason).toBe('merge')

    const rolled = await test.service.rollback()
    expect(rolled.ledger.committed).toBe(true)
    meta = JSON.parse(await readFile(join(test.ledgerDir, 'policy', 'meta.json'), 'utf8')) as { generationId: string; reason: string }
    expect(meta.reason).toBe('rollback')
    expect(await gitInLedger(test, ['rev-list', '--count', 'HEAD'])).toBe('2')
    const subjects = await gitInLedger(test, ['log', '--format=%s'])
    expect(subjects.split('\n')[0]).toContain('rsi rollback: ')
    expect(subjects.split('\n')[1]).toContain('rsi merge: ')
  })

  it('reports a missing git executable without undoing the merge', async () => {
    const test = await tracked(harness({ proposals: [STRONG], stubSubprocess: true }))
    await stubAgent(test, 'gitless-core')
    await test.service.runCycle('command', new AbortController().signal)
    const merged = await test.service.mergePending('command')
    expect(merged.ledger.committed).toBe(false)
    expect(merged.ledger.error).toContain('git')
    // The durable swap and its archive still settled.
    const status = await test.service.status()
    expect(status.active.id).toBe(merged.generation.id)
    expect(status.archiveCount).toBe(1)
  })

  it('records generations without benchmark evidence and rejects an unchanged re-record', async () => {
    const test = await tracked(harness())
    const dir = join(test.ledgerDir, 'direct')
    const ledger = new RsiLedger(test.ctx, dir)
    const bare: RsiGeneration = {
      id: RsiGenerationId('gen-bare'),
      origin: 'initial',
      parent: null,
      createdAt: 1,
      artifacts: { guidance: ['verify once'], skills: [] },
    }
    const first = await ledger.record({ reason: 'rollback', generation: bare, summary: 'restored without evidence' }, new AbortController().signal)
    expect(first.committed).toBe(true)
    const meta = JSON.parse(await readFile(join(dir, 'policy', 'meta.json'), 'utf8')) as { benchmark: unknown; cycleId?: string }
    expect(meta.benchmark).toBeNull()
    expect(meta.cycleId).toBeUndefined()

    // Re-recording the identical generation leaves nothing to commit; git rejects it and the ledger reports the failure.
    const duplicate = await ledger.record({ reason: 'rollback', generation: bare, summary: 'restored without evidence' }, new AbortController().signal)
    expect(duplicate.committed).toBe(false)
    expect(duplicate.error).toContain('git commit failed')
  })
})

async function runCommand(
  test: Harness,
  agent: Agent,
  input: string,
  signal: AbortSignal = freshSignal(),
): Promise<CommandOutcome> {
  const execution = await test.ctx.commands.execute(agent, `/rsi${input.length === 0 ? '' : ` ${input}`}`, [], signal)
  if (execution === undefined) throw new Error('command did not dispatch')
  const result = execution.result
  if (result === undefined || typeof result !== 'object' || !('kind' in result)) {
    throw new Error(`unexpected command result: ${JSON.stringify(result)}`)
  }
  return result as CommandOutcome
}
