// Keyless assembled-browser coverage for the opt-in dual-core RSI bundle:
// the daemon self-repairs and self-evolves in the background with no user
// input, and the left-sidebar Self-evolution panel shows both.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { RsiDistillOutput } from '@deepseek-ai/dsh-experimental-dual-core-rsi'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./rsi-sidebar-panel.overlay.yml', import.meta.url))
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/experimental/dual-core-rsi-bundle/package.json', import.meta.url)),
]

/** The candidate the scripted distiller proposes once the first attempt has failed. */
const EVOLVED: RsiDistillOutput = {
  rationale: 'verification habits repeated across sessions',
  artifacts: {
    guidance: ['verify each edit with focused tests before finishing'],
    skills: [],
  },
}

describe('web e2e: dual-core RSI Self-evolution sidebar panel', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: INSTALL_ANCHORS })
    // The shipped distiller spawns a model child; this keyless smoke scripts it:
    // the first scheduled attempt fails (a self-repair), the retry proposes a winner.
    let attempts = 0
    scaffold.ctx.rsiDistiller.distill = () => {
      attempts += 1
      if (attempts === 1) return Promise.reject(new Error('distiller offline'))
      // The second proposal wins adoption; every later one fails again so the
      // daemon keeps recording fresh repairs the hero reacts to.
      return attempts === 2
        ? Promise.resolve(EVOLVED)
        : Promise.reject(new Error(`distiller offline again (attempt ${attempts})`))
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('connected workspace did not create an Agent')
    // Fresh session activity is the evidence the scheduled daemon waits for.
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Please verify the checklist before finishing.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'Verified.' }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      }),
    }, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(agent.session)
    await page.getByText('Verified.').waitFor({ timeout: 10_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows the background repair and the background evolution in the left sidebar panel without user input', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-rsi-sidebar-panel'))
    // No command, tool call, or answer: the daemon repairs and adopts on its own.
    await expect.poll(async () => (await scaffold.ctx.dualCoreRsi.status()).active.artifacts.guidance, { timeout: 30_000 })
      .toEqual(EVOLVED.artifacts.guidance)

    await page.getByRole('button', { name: 'Self-evolution', exact: true }).click()
    const panel = page.getByRole('region', { name: 'Self-evolution activity' })
    await panel.getByText('Qualifying candidates merge in the background').waitFor({ timeout: 15_000 })

    await panel.getByRole('heading', { name: 'Evolutions' }).waitFor({ timeout: 15_000 })
    await panel.getByText('verification habits repeated across sessions').waitFor()
    await panel.getByText('verify each edit with focused tests before finishing').waitFor()
    await panel.getByText('scheduled cycle').waitFor()

    await panel.getByRole('heading', { name: 'Repairs' }).waitFor()
    await panel.getByText('distiller offline').waitFor()
    await panel.getByText(/^retried after 200 ms$/u).waitFor()
    await panel.getByText('attempt 1').waitFor()

    // The pixel-hero companion reacts to the same background work: with the
    // distiller failing again, every scheduled round records a fresh repair
    // the hero flashes for, and its button opens the panel above.
    const hero = page.locator('[data-hero-pose]')
    await hero.waitFor({ timeout: 15_000 })
    await expect.poll(async () => hero.getAttribute('data-hero-pose'), { timeout: 30_000 }).toBe('hurt')
    await page.locator('button[class*=openPanel]').click()
    await page.getByRole('button', { name: 'Self-evolution', exact: true }).waitFor({ timeout: 15_000 })

    expect(tripwire.pageErrors).toEqual([])
  }, 180_000)
})
