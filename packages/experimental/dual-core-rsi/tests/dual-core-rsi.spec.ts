import { mkdtemp } from 'node:fs/promises'
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
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import DualCoreRsiService, { dualCoreRsiDomain, RSI_STATE_KEY } from '../src/index.ts'
import { renderStatus } from '../src/render.ts'
import { RsiDistiller } from '../src/distiller.ts'
import { RsiBenchmark } from '../src/benchmark.ts'
import { RsiArchiveId, RsiGenerationId } from '../src/branding.ts'
import type { RsiArtifacts, RsiDistillInput, RsiDistillOutput, RsiGeneration } from '../src/index.ts'

/** One scripted distiller answer: a settled proposal or a caller-held gate. */
type ScriptedProposal = RsiDistillOutput | Promise<RsiDistillOutput>

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
    return Promise.resolve(next)
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
}

interface Harness {
  readonly ctx: Context
  service: DualCoreRsiService
  readonly distiller: ScriptedDistiller
}

/** Compose the full service stack over a temp JSON storage root. */
async function harness(options?: HarnessOptions): Promise<Harness> {
  const ctx = new Context()
  const root = options?.root ?? await mkdtemp(join(tmpdir(), 'dual-core-rsi-'))
  await ctx.plugin(Storage)
  await ctx.plugin(storageJson, { root })
  await ctx.plugin(storageDomainPlugin, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('dual-core-rsi-test')
  const distiller = new ScriptedDistiller(ctx, options?.proposals ?? [])
  void new KeywordBenchmark(ctx, options?.keyword ?? 'verify', options?.perHit ?? 0.4)
  if (options?.deferService === true) return { ctx, service: undefined as never, distiller }
  const service = new DualCoreRsiService(ctx, {
    ...options?.threshold === undefined ? {} : { threshold: options.threshold },
    ...options?.runWaitMs === undefined ? {} : { runWaitMs: options.runWaitMs },
  })
  await service.waitReady()
  return { ctx, service, distiller }
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

  it('swaps cores past the threshold, archives the replaced core, and applies the distilled policy', async () => {
    const test = await tracked(harness({ proposals: [STRONG] }))
    const core = await stubAgent(test, 'user-core')
    const before = (await core.scope.systemPrompt.assemble({ scope: core.key })).sections.find(section => section.name === 'rsi:distilled-policy')
    expect(before).toBeUndefined()

    const record = await test.service.runCycle('command', new AbortController().signal)
    expect(record.outcome).toBe('promoted')
    expect(record.improvement).toBeCloseTo(0.8)
    const status = await test.service.status()
    expect(status.active.id).toBe(record.candidateId)
    expect(status.active.artifacts.guidance).toHaveLength(2)
    expect(status.daemon.parent).toBe(record.candidateId)
    expect(status.daemon.artifacts).toEqual(status.active.artifacts)
    expect(status.daemon.benchmark?.score).toBeCloseTo(0.8)

    const { archives } = await test.service.history()
    expect(archives).toHaveLength(1)
    expect(archives[0]!.id).toBe('arc-1')
    expect(archives[0]!.reason).toBe('swap')
    expect(archives[0]!.generation.id).toBe('gen-1')
    expect(archives[0]!.supersededBy).toBe(record.candidateId)

    const section = (await core.scope.systemPrompt.assemble({ scope: core.key })).sections.find(candidate => candidate.name === 'rsi:distilled-policy')
    expect(section?.text).toContain('verify each edit with focused tests')
    expect(section?.text).toContain('verify-before-done')
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

  it('registers distilled skills on the agent scope through the swap', async () => {
    const test = await tracked(harness({ proposals: [STRONG] }))
    const core = await stubAgent(test, 'user-core')
    await test.service.runCycle('schedule', new AbortController().signal)
    const skills = await core.scope.skills.list({ scope: core.key })
    const distilled = skills.find(skill => skill.name === 'verify-before-done')
    expect(distilled?.description).toContain('verifying work')
  })

  it('rolls back to an archive and archives the rollback in turn', async () => {
    const test = await tracked(harness({ proposals: [STRONG] }))
    const core = await stubAgent(test, 'user-core')
    await test.service.runCycle('command', new AbortController().signal)

    const first = await test.service.rollback(RsiArchiveId('arc-1'))
    expect(first.restored.id).toBe('gen-1')
    expect(first.archived.reason).toBe('rollback')
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

  it('applies the active policy to agents created after the swap', async () => {
    const test = await tracked(harness({ proposals: [STRONG] }))
    await stubAgent(test, 'user-core')
    await test.service.runCycle('command', new AbortController().signal)
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
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercising the non-Error job detail is the point
    const plain = Promise.reject('plain string')
    const test = await tracked(harness({ proposals: [Promise.reject(new Error('first exhausts')), plain] }))
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

  it('serves the /rsi command grammar', async () => {
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
    expect(run.text).toContain('adopted a new working policy')

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

  it('drops the applied policy when an agent is disposed', async () => {
    const test = await tracked(harness({ proposals: [STRONG] }))
    const core = await stubAgent(test, 'user-core')
    await test.service.runCycle('command', new AbortController().signal)
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
    const broken = await stubAgent({ ctx, service: undefined as never, distiller }, 'broken-core')
    const service = new DualCoreRsiService(ctx, {})
    await expect(service.waitReady()).rejects.toThrow(/is missing from the storage domain/)
    // A rollback command on the broken service surfaces the infrastructure failure as an error result.
    const rollback = await runCommand({ ctx, service, distiller }, broken.agent, 'rollback arc-1', new AbortController().signal)
    expect(rollback.kind).toBe('error')
    expect(rollback.text).toContain('is missing from the storage domain')
  })

  it('restores promoted cores from persisted state across a remount', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dual-core-rsi-reload-'))
    const first = await tracked(harness({ proposals: [STRONG], root }))
    await stubAgent(first, 'user-core')
    const promoted = await first.service.runCycle('command', new AbortController().signal)
    expect(promoted.outcome).toBe('promoted')
    await first.ctx.fiber.dispose()
    contexts.pop()

    const second = await tracked(harness({ root, deferService: true }))
    const late = await stubAgent(second, 'user-core-late')
    second.service = new DualCoreRsiService(second.ctx, {})
    await second.service.waitReady()
    const status = await second.service.status()
    expect(status.active.id).toBe(promoted.candidateId)
    expect(status.active.artifacts.guidance).toHaveLength(2)
    expect(status.lastCycle?.id).toBe('1')
    const sections = (await late.scope.systemPrompt.assemble({ scope: late.key })).sections
      .filter(section => section.name === 'rsi:distilled-policy')
    expect(sections).toHaveLength(1)
    expect(sections[0]!.text).toContain('verify each edit with focused tests')
  })

  it('reports a failed /rsi run directly with an unchanged-state note', async () => {
    const test = await tracked(harness({ proposals: [Promise.reject(new Error('distiller offline'))] }))
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

  it('surfaces unseen session activity after a promotion and clears it on refresh', async () => {
    const test = await tracked(harness({ proposals: [STRONG, STRONG] }))
    await stubAgent(test, 'user-core')
    await test.service.runCycle('command', new AbortController().signal)
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

    await test.service.runCycle('command', new AbortController().signal)
    const refreshed = await test.service.status()
    expect(refreshed.unseenSessionCount).toBe(0)
    expect(refreshed.knowledgeCutoffAt!).toBeGreaterThanOrEqual(adopted!)
  })

  it('loads legacy pointer state written before adoption timestamps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dual-core-rsi-legacy-'))
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin(storageJson, { root })
    await ctx.plugin(storageDomainPlugin, { backend: 'json' })
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
    const service = new DualCoreRsiService(ctx, {})
    await service.waitReady()
    const status = await service.status()
    expect(status.knowledgeCutoffAt).toBeUndefined()
    expect(status.unseenSessionCount).toBe(0)
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
  })
})

type CommandOutcome = { kind: 'success'; text: string } | { kind: 'error'; text: string }

const freshSignal = (): AbortSignal => new AbortController().signal

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
