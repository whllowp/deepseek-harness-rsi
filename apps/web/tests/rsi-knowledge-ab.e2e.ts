// Opt-in real-model A/B for the dual-core RSI long-term knowledge base. One
// process runs one arm through the REAL Web composition with the REAL DeepSeek
// adapter: the browser sends five identical workspace tasks, each in a fresh
// session, and the scheduled daemon — never a command — distills, gates,
// adopts, records the ledger, and deposits knowledge in the background after
// every task. The arms differ in exactly one input: `with-knowledge` is the
// shipped composition, while `without-knowledge` hands the distiller an empty
// knowledge base, which reproduces the mission prompt from before the
// knowledge base existed byte for byte. The last task carries no reminders and
// probes whether the evolved policy alone changes the agent's behavior.
//
// The scenario spends real tokens, so it skips unless DSH_RSI_AB_ARM names an
// arm and DSH_SNAPSHOT=record mounts the real adapter (which also requires
// DEEPSEEK_API_KEY). Each arm writes `.artifacts/rsi-knowledge-ab/<arm>.json`
// and a panel screenshot beside it; run the two arms as separate processes:
//   DSH_SNAPSHOT=record DSH_RSI_AB_ARM=with-knowledge pnpm exec vitest run \
//     --config vitest.web.config.ts apps/web/tests/rsi-knowledge-ab.e2e.ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { assembleDigest, RsiGenerationId } from '@deepseek-ai/dsh-experimental-dual-core-rsi'
import type {
  RsiDistillInput, RsiDistillOptions, RsiDistillOutput,
} from '@deepseek-ai/dsh-experimental-dual-core-rsi'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./rsi-knowledge-ab.overlay.yml', import.meta.url))
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/experimental/dual-core-rsi-bundle/package.json', import.meta.url)),
]
const OUTPUT_DIR = join(REPO_ROOT, '.artifacts', 'rsi-knowledge-ab')
/** One task turn, including tool calls, must settle within this window. */
const TURN_TIMEOUT_MS = 6 * 60_000
/** One scheduled round: the overlay's daemon cadence plus up to three attempts with backoff. */
const CYCLE_TIMEOUT_MS = 20 * 60_000

type Arm = 'with-knowledge' | 'without-knowledge'
const ARM: Arm | undefined = process.env.DSH_RSI_AB_ARM === 'with-knowledge' || process.env.DSH_RSI_AB_ARM === 'without-knowledge'
  ? process.env.DSH_RSI_AB_ARM
  : undefined
const ENABLED = ARM !== undefined && webSnapshotMode() === 'record'
/** Optional shorter run (smoke); defaults to the whole workload. */
const ROUNDS = process.env.DSH_RSI_AB_ROUNDS === undefined ? undefined : Number(process.env.DSH_RSI_AB_ROUNDS)
/** Optional trial label so repeated runs of one arm keep separate reports. */
const TRIAL = process.env.DSH_RSI_AB_TRIAL
/**
 * Paired replay repeats per variant (0 disables). After the workload, the
 * newest recorded distiller inputs that carry knowledge are replayed through
 * the real distiller with and without that knowledge, so both variants see
 * the identical generations and digest and differ only in recall.
 */
const PAIRED_REPEATS = Number(process.env.DSH_RSI_AB_PAIRED ?? '0')

/**
 * The shared workload. Early sessions teach the release checklist and the
 * habits; the two-session digest window scrolls them out of the evidence
 * before the probe, which names none of them.
 */
const TASKS: readonly string[] = [
  'Release time for this calc package. Follow our release-checklist: run git status first, bump the patch version in package.json, add a CHANGELOG.md entry for the release, run npm test, then commit everything with the message "release 1.0.1". We repeat this exact release-checklist on every release, so it is a reusable procedure.',
  'Add a subtract(a, b) function to src/math.js and a test for it in test/math.test.js. Before you tell me you are done, run npm test and confirm it passes - an untested change broke our build last week.',
  'Add multiply(a, b) to src/math.js with a test. Start with git status so you know what is already modified, and as always run npm test before you say you are done.',
  'Add divide(a, b) to src/math.js that throws on division by zero, with tests for both cases. Same habits as always: git status first and npm test before done. Keep your final reply to three short bullets.',
  'Add a power(base, exponent) function to src/math.js with a test.',
]

/** Token accounting summed from `assistant/message` usage. */
interface Usage {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

/** Per-session observations collected from live session events. */
interface TrackedSession {
  readonly id: string
  readonly origin: 'top-level' | 'subagent'
  readonly createdAt: number
  /** Index of the distill call in flight when a subagent session was created. */
  readonly distillCall: number | undefined
  readonly usage: Usage
  readonly commands: string[]
  /** First user-message text length: the mission prompt for a distiller child. */
  firstPromptChars: number | undefined
  lastReply: string
}

/** What one distillation proposed, with skill bodies reduced to the facts the report compares. */
interface DistillOutputSummary {
  rationale: string
  guidance: readonly string[]
  skills: readonly { name: string; contentChars: number; mentionsChangelog: boolean }[]
}

/** One observed distillation, with what the arm actually delivered to the child. */
interface DistillCall {
  readonly index: number
  readonly startedAt: number
  settledAt: number | undefined
  readonly activeId: string
  readonly daemonId: string
  readonly digest: readonly { readonly sessionId: string; readonly origin: string; readonly textChars: number }[]
  readonly knowledgeOffered: number
  readonly knowledgeDelivered: number
  readonly knowledgeDeliveredChars: number
  output: DistillOutputSummary | undefined
  error: string | undefined
}

function emptyUsage(): Usage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
}

function addUsage(total: Usage, part: Usage): Usage {
  return {
    calls: total.calls + part.calls,
    inputTokens: total.inputTokens + part.inputTokens,
    outputTokens: total.outputTokens + part.outputTokens,
    cacheReadTokens: total.cacheReadTokens + part.cacheReadTokens,
  }
}

/** Seed a tiny tested Node package under git so the tasks have real work and real checks. */
function seedProject(root: string): void {
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify({ name: 'calc', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
    'src/math.js': 'export function add(a, b) {\n  return a + b\n}\n',
    'test/math.test.js': "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/math.js'\n\ntest('add', () => {\n  assert.equal(add(2, 3), 5)\n})\n",
    'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n\n- add(a, b)\n',
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  }
  git('init', '-q')
  git('config', 'user.name', 'calc-maintainer')
  git('config', 'user.email', 'calc@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('add', '-A')
  git('commit', '-q', '-m', 'calc 1.0.0')
}

describe.skipIf(!ENABLED)('web e2e: dual-core RSI knowledge-base real-model A/B', () => {
  const arm = ARM ?? 'with-knowledge'
  const startedAt = Date.now()
  const sessions = new Map<string, TrackedSession>()
  const calls: DistillCall[] = []
  let activeCall: DistillCall | undefined
  /** Every distiller input as the service offered it, before the arm's ablation. */
  const recordedInputs: RsiDistillInput[] = []
  let realDistill: (input: RsiDistillInput, options: RsiDistillOptions) => Promise<RsiDistillOutput>
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const originalPermissionMode = process.env.DSH_PERMISSION_MODE

  function track(session: Session): TrackedSession {
    const known = sessions.get(session.id)
    if (known !== undefined) return known
    const tracked: TrackedSession = {
      id: session.id,
      origin: session.header.origin === 'subagent' ? 'subagent' : 'top-level',
      createdAt: Date.now(),
      distillCall: session.header.origin === 'subagent' ? activeCall?.index : undefined,
      usage: emptyUsage(),
      commands: [],
      firstPromptChars: undefined,
      lastReply: '',
    }
    sessions.set(session.id, tracked)
    return tracked
  }

  function observe(session: Session, event: SessionEvent): void {
    const tracked = track(session)
    if (event.type === 'user/message') {
      tracked.firstPromptChars ??= event.data.content
        .reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0)
      return
    }
    if (event.type !== 'assistant/message') return
    const usage = event.data.usage
    if (usage !== undefined) {
      tracked.usage.calls += 1
      tracked.usage.inputTokens += usage.inputTokens
      tracked.usage.outputTokens += usage.outputTokens
      tracked.usage.cacheReadTokens += usage.cacheReadTokens ?? 0
    }
    const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    if (text.length > 0) tracked.lastReply = text
    for (const block of event.data.message.content) {
      if (block.type === 'tool-call') tracked.commands.push(`${block.name} ${block.arguments}`)
    }
  }

  /** Resolve with the next top-level session whose turn ends; daemon children never count. */
  function nextTopLevelTurnEnd(): Promise<Session> {
    return new Promise<Session>((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`no top-level turn/end within ${String(TURN_TIMEOUT_MS)}ms`))
      }, TURN_TIMEOUT_MS)
      const off = scaffold.ctx.on('session/event', (session: Session, event: SessionEvent) => {
        if (event.type !== 'turn/end' || session.header.origin === 'subagent') return
        clearTimeout(timer)
        off()
        scaffold.ctx.sessions.flush(session).then(() => { resolve(session) }, reject)
      })
    })
  }

  /**
   * Answer one pending user-question takeover through the real UI: click the
   * first option (the composer renders the recommended one first), submit,
   * and wait for the takeover card to close.
   */
  async function answerPendingQuestion(): Promise<void> {
    const takeover = page.locator('[data-question-key]')
    await takeover.first().waitFor({ timeout: 15_000 })
    const option = takeover.first().getByRole('radio').first()
    await option.click()
    const submit = takeover.first().getByRole('button', { name: 'Submit' }).last()
    await submit.click()
    await expect.poll(async () => page.locator('[data-question-key]').count(), { timeout: 30_000 }).toBe(0)
  }

  beforeAll(async () => {
    // The tasks edit files, run npm test, and commit inside a temp workspace;
    // an unattended real-model run cannot answer approval prompts.
    process.env.DSH_PERMISSION_MODE = 'danger-full-access'
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: INSTALL_ANCHORS })
    scaffold.ctx.on('session/created', (session: Session) => { track(session) })
    scaffold.ctx.on('session/event', observe)
    const distiller = scaffold.ctx.rsiDistiller
    realDistill = distiller.distill.bind(distiller)
    distiller.distill = async (input: RsiDistillInput, options: RsiDistillOptions): Promise<RsiDistillOutput> => {
      recordedInputs.push(input)
      // The ablation arm removes exactly one input; everything else is the shipped child.
      const delivered: RsiDistillInput = arm === 'without-knowledge' ? { ...input, knowledge: [] } : input
      const call: DistillCall = {
        index: calls.length,
        startedAt: Date.now(),
        settledAt: undefined,
        activeId: input.active.id,
        daemonId: input.daemon.id,
        digest: input.digest.sessions.map(entry => ({
          sessionId: entry.sessionId,
          origin: sessions.get(entry.sessionId)?.origin ?? 'unknown',
          textChars: entry.texts.reduce((sum, text) => sum + text.length, 0),
        })),
        knowledgeOffered: input.knowledge.length,
        knowledgeDelivered: delivered.knowledge.length,
        knowledgeDeliveredChars: delivered.knowledge.reduce((sum, entry) => sum + entry.text.length, 0),
        output: undefined,
        error: undefined,
      }
      calls.push(call)
      activeCall = call
      try {
        const output = await realDistill(delivered, options)
        call.output = {
          rationale: output.rationale,
          guidance: output.artifacts.guidance,
          skills: output.artifacts.skills.map(skill => ({
            name: skill.name,
            contentChars: skill.content.length,
            mentionsChangelog: skill.content.includes('CHANGELOG'),
          })),
        }
        return output
      } catch (error) {
        call.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        call.settledAt = Date.now()
        activeCall = undefined
      }
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    seedProject(join(scaffold.workspaceCwd, 'workspace'))
  }, 240_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (originalPermissionMode === undefined) Reflect.deleteProperty(process.env, 'DSH_PERMISSION_MODE')
    else process.env.DSH_PERMISSION_MODE = originalPermissionMode
  })

  it('evolves in the background across five real task sessions and records the arm report', async () => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-rsi-knowledge-ab-${arm}`))
    const rounds: RoundRecord[] = []
    const name = TRIAL === undefined ? arm : `${arm}-${TRIAL}`
    let failure: string | undefined
    try {
      for (const [index, task] of TASKS.slice(0, ROUNDS ?? TASKS.length).entries()) {
        rounds.push(await runRound(index + 1, task))
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      // The report lands even for a failed run: a partial trajectory is evidence too.
      await writeReport(name, rounds, failure)
    }

    await page.getByRole('button', { name: 'Self-evolution', exact: true }).click()
    await page.getByRole('region', { name: 'Self-evolution activity' }).waitFor({ timeout: 15_000 })
    await page.screenshot({ path: join(OUTPUT_DIR, `${name}-panel.png`), fullPage: true })

    expect((await scaffold.ctx.dualCoreRsi.history(100)).cycles.length).toBeGreaterThanOrEqual(rounds.length)
    expect(tripwire.pageErrors).toEqual([])
  }, 150 * 60_000)

  /**
   * Send one task in a fresh session through the real composer, answer any
   * question takeover the agent raises, and wait for the daemon's scheduled
   * cycle that digests the settled session.
   * @returns the round's timing and session identity.
   */
  async function runRound(round: number, task: string): Promise<RoundRecord> {
    if (round > 1) {
      await page.getByRole('button', { name: 'New session', exact: true }).last().click()
      // The blank session view owns the composer once no user row remains.
      await expect.poll(() => page.locator('[data-chat-flow-kind="user"]').count(), { timeout: 15_000 }).toBe(0)
    }
    const composer = page.locator('[data-composer-input][contenteditable="true"]')
    const send = page.getByRole('button', { name: 'Send message', exact: true })
    await composer.waitFor({ timeout: 30_000 })
    // A blank session may remount its composer after the first keystrokes;
    // refill until the live composer holds the task and accepts the send.
    await expect.poll(async () => {
      if ((await composer.textContent()) !== task) await composer.fill(task)
      return await send.isEnabled()
    }, { timeout: 30_000, interval: 1_000 }).toBe(true)
    const settled = nextTopLevelTurnEnd()
    const sentAt = Date.now()
    await send.click()
    // An evolved policy may teach the agent to confirm scope through a
    // question takeover instead of guessing; answering it keeps the round
    // unattended, and the turn settles only after the answer lands.
    let turnDone = false
    let questionsAnswered = 0
    const turn = settled.finally(() => { turnDone = true })
    const answering = (async () => {
      while (!turnDone) {
        if (await page.locator('[data-question-key]').count() > 0) {
          await answerPendingQuestion()
          questionsAnswered += 1
        } else {
          await new Promise(resolve => setTimeout(resolve, 2_000))
        }
      }
    })()
    const session = await turn
    await answering
    const settledAt = Date.now()
    // No command and no answer: the daemon's own schedule picks the session up.
    await expect.poll(async () => (await scaffold.ctx.dualCoreRsi.history(100)).cycles.length,
      { timeout: CYCLE_TIMEOUT_MS, interval: 3_000 }).toBeGreaterThanOrEqual(round)
    return { round, sessionId: session.id, sentAt, settledAt, cycleSettledAt: Date.now(), questionsAnswered }
  }

  /** Assemble the arm report from the live service, the tracked sessions, and the optional paired replay. */
  async function writeReport(name: string, rounds: readonly RoundRecord[], failure: string | undefined): Promise<void> {
    const status = await scaffold.ctx.dualCoreRsi.status()
    const history = await scaffold.ctx.dualCoreRsi.history(100)
    const ledgerDir = join(scaffold.harnessHome, 'dual-core-rsi-ledger')
    const ledger = existsSync(ledgerDir)
      ? execFileSync('git', ['log', '--format=%h %s'], { cwd: ledgerDir, encoding: 'utf8' }).trim().split('\n')
      : []
    const tracked = [...sessions.values()]
    const userSessions = tracked.filter(session => session.origin === 'top-level' && rounds.some(round => round.sessionId === session.id))
    const childSessions = tracked.filter(session => session.distillCall !== undefined)
    // What a default-limit digest would read right now: the daemon's own
    // distillation children must never count as user-core evidence.
    const defaultDigest = await assembleDigest(scaffold.ctx, { maxSessions: 8, maxCharsPerSession: 4000, includeStored: true })
    const report = {
      arm,
      trial: TRIAL,
      failure,
      startedAt: new Date(startedAt).toISOString(),
      elapsedMs: Date.now() - startedAt,
      defaultDigest: defaultDigest.sessions.map(entry => ({
        sessionId: entry.sessionId,
        origin: sessions.get(entry.sessionId)?.origin ?? 'unknown',
        textChars: entry.texts.reduce((sum, text) => sum + text.length, 0),
      })),
      liveSubagentSessions: scaffold.ctx.sessions.list().filter(session => session.header.origin === 'subagent').length,
      rounds: rounds.map((round) => {
        const session = sessions.get(round.sessionId)
        const commands = session?.commands ?? []
        return {
          ...round,
          turnMs: round.settledAt - round.sentAt,
          ranNpmTest: commands.some(command => /npm(?:\.cmd)?\s+(?:run\s+)?test|node\s+--test/u.test(command)),
          ranGitStatus: commands.some(command => /git\s+status/u.test(command)),
          toolCalls: commands.length,
          commands: commands.map(command => command.slice(0, 240)),
          replyChars: session?.lastReply.length ?? 0,
          reply: session?.lastReply.slice(0, 600) ?? '',
          usage: session?.usage ?? emptyUsage(),
        }
      }),
      distillCalls: calls.map(call => ({
        ...call,
        durationMs: call.settledAt === undefined ? undefined : call.settledAt - call.startedAt,
        children: childSessions.filter(session => session.distillCall === call.index).map(session => ({
          id: session.id,
          missionChars: session.firstPromptChars,
          usage: session.usage,
          toolCalls: session.commands.length,
          // Audit what the child read: the RSI storage and the benchmark
          // definition sit outside the workspace the mission points at.
          readsRsiState: session.commands.some(command => /dsh-storages|dual_core_rsi|\.dsh-home|overlay\.yml|cordis/u.test(command)),
          commands: session.commands.map(command => command.slice(0, 240)),
        })),
      })),
      cycles: [...history.cycles].reverse(),
      incidents: [...history.incidents].reverse(),
      knowledge: [...history.knowledge].reverse(),
      archives: history.archives.length,
      final: {
        activeId: status.active.id,
        score: status.active.benchmark?.score,
        cases: status.active.benchmark?.cases,
        guidance: status.active.artifacts.guidance,
        guidanceChars: status.active.artifacts.guidance.reduce((sum, line) => sum + line.length, 0),
        skills: status.active.artifacts.skills,
      },
      ledger,
      usage: {
        user: userSessions.reduce((sum, session) => addUsage(sum, session.usage), emptyUsage()),
        distiller: childSessions.reduce((sum, session) => addUsage(sum, session.usage), emptyUsage()),
      },
      paired: PAIRED_REPEATS > 0 && failure === undefined ? await pairedReplay() : [],
      pageErrors: tripwire.pageErrors,
    }
    await mkdir(OUTPUT_DIR, { recursive: true })
    await writeFile(join(OUTPUT_DIR, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`)
  }

  /**
   * Replay the newest knowledge-carrying distiller inputs through the real
   * distiller with and without their knowledge, scoring every proposal with
   * the composed benchmark against the same active baseline.
   * @returns one row per replayed proposal.
   */
  async function pairedReplay(): Promise<PairedRow[]> {
    const anchor = scaffold.ctx.agents.list().find(agent => agent.session.header.origin !== 'subagent')
    if (anchor === undefined) throw new Error('paired replay needs a live top-level agent to anchor the distiller child')
    const inputs = recordedInputs.filter(input => input.knowledge.length > 0).slice(-2)
    const jobs = inputs.flatMap((input, inputIndex) => (['with-knowledge', 'without-knowledge'] as const)
      .flatMap(variant => Array.from({ length: PAIRED_REPEATS }, (_, repeat) => ({ input, inputIndex, variant, repeat }))))
    return await Promise.all(jobs.map(async ({ input, inputIndex, variant, repeat }): Promise<PairedRow> => {
      const delivered: RsiDistillInput = variant === 'without-knowledge' ? { ...input, knowledge: [] } : input
      const baseline = input.active.benchmark?.score ?? 0
      const row = { inputIndex, variant, repeat, activeId: input.active.id, knowledgeLines: delivered.knowledge.length, baseline }
      try {
        const output = await realDistill(delivered, { parent: anchor, signal: new AbortController().signal })
        const report = await scaffold.ctx.rsiBenchmark.evaluate({
          generation: {
            id: RsiGenerationId(`replay-${String(inputIndex)}-${variant}-${String(repeat)}`),
            origin: 'distilled',
            parent: input.daemon.id,
            createdAt: Date.now(),
            artifacts: output.artifacts,
          },
        }, new AbortController().signal)
        return {
          ...row,
          score: report.score,
          improvement: report.score - baseline,
          failedCases: report.cases.filter(item => !item.passed).map(item => item.name),
          guidanceChars: output.artifacts.guidance.reduce((sum, line) => sum + line.length, 0),
          skills: output.artifacts.skills.map(skill => skill.name),
          rationale: output.rationale,
          guidance: output.artifacts.guidance,
        }
      } catch (error) {
        return { ...row, error: error instanceof Error ? error.message : String(error) }
      }
    }))
  }
})

/** One completed workload round: its session, timing, and answered takeovers. */
interface RoundRecord {
  readonly round: number
  readonly sessionId: string
  readonly sentAt: number
  readonly settledAt: number
  readonly cycleSettledAt: number
  readonly questionsAnswered: number
}

/** One paired-replay proposal: the variant, its score, and what it proposed. */
interface PairedRow {
  readonly inputIndex: number
  readonly variant: Arm
  readonly repeat: number
  readonly activeId: string
  readonly knowledgeLines: number
  readonly baseline: number
  readonly score?: number
  readonly improvement?: number
  readonly failedCases?: readonly string[]
  readonly guidanceChars?: number
  readonly skills?: readonly string[]
  readonly rationale?: string
  readonly guidance?: readonly string[]
  readonly error?: string
}
