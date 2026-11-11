// Opt-in real-model evolution trajectory: the REAL Web composition with the
// REAL DeepSeek adapter drives TEN daemon rounds through the evolution
// trajectory service (`rsiEvolutionTrajectory.runRounds(10)`), then writes the
// trajectory log (`trajectory.jsonl`) and the evolution topology (a mermaid
// lineage graph) to `.artifacts/rsi-evolution-trajectory/`. Skips unless
// DSH_RSI_TRAJECTORY=1 and DSH_SNAPSHOT=record (which also requires
// DEEPSEEK_API_KEY):
//   DSH_SNAPSHOT=record DSH_RSI_TRAJECTORY=1 pnpm exec vitest run \
//     --config vitest.web.config.ts apps/web/tests/rsi-evolution-trajectory.e2e.ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./rsi-evolution-trajectory.overlay.yml', import.meta.url))
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/experimental/dual-core-rsi-evolution-bundle/package.json', import.meta.url)),
  fileURLToPath(new URL('../../../packages/experimental/dual-core-rsi-bundle/package.json', import.meta.url)),
]
const OUTPUT_DIR = join(REPO_ROOT, '.artifacts', 'rsi-evolution-trajectory')
const ENABLED = process.env.DSH_RSI_TRAJECTORY === '1' && webSnapshotMode() === 'record'
const ROUNDS = Number(process.env.DSH_RSI_TRAJECTORY_ROUNDS ?? '10')

/** Seed a tiny tested Node package under git so the rounds distill real evidence. */
function seedProject(root: string): void {
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify({ name: 'calc', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
    'src/math.js': 'export function add(a, b) {\n  return a + b\n}\n',
    'test/math.test.js': "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/math.js'\n\ntest('add', () => {\n  assert.equal(add(2, 3), 5)\n})\n",
    'CHANGELOG.md': '# Changelog\n\n## 1.0.0\n\n- add(a, b)\n',
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirnameSync(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  }
  git('init', '-q')
  git('config', 'user.name', 'calc-maintainer')
  git('config', 'user.email', 'calc@example.invalid')
  git('add', '-A')
  git('commit', '-q', '-m', 'calc 1.0.0')
}

// Local dirname helper (importing node:path's dirname is fine; kept local for clarity).
function dirnameSync(file: string): string {
  return file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')))
}

describe.skipIf(!ENABLED)('web e2e: dual-core RSI evolution trajectory (ten rounds)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const originalPermissionMode = process.env.DSH_PERMISSION_MODE

  beforeAll(async () => {
    // The rounds edit files, run npm test, and commit inside a temp workspace;
    // an unattended real-model run cannot answer approval prompts.
    process.env.DSH_PERMISSION_MODE = 'danger-full-access'
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: INSTALL_ANCHORS })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    seedProject(join(scaffold.workspaceCwd, 'workspace'))
    // One real task session gives round 1's distillation evidence; the later
    // rounds then evolve on the digest of that session and their own outcomes.
    const composer = page.locator('[data-composer-input][contenteditable="true"]')
    const send = page.getByRole('button', { name: 'Send message', exact: true })
    await composer.waitFor({ timeout: 30_000 })
    const settled = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error('no top-level turn/end within 6 minutes'))
      }, 6 * 60_000)
      const off = scaffold.ctx.on('session/event', (session, event) => {
        if (event.type !== 'turn/end' || session.header.origin === 'subagent') return
        clearTimeout(timer)
        off()
        scaffold.ctx.sessions.flush(session).then(() => { resolve() }, reject)
      })
    })
    await composer.fill('Release time for this calc package. Follow our release-checklist: run git status first, bump the patch version in package.json, add a CHANGELOG.md entry for the release, run npm test, then commit everything with the message "release 1.0.1". We repeat this exact release-checklist on every release, so it is a reusable procedure.')
    await send.click()
    await settled
  }, 600_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (originalPermissionMode === undefined) Reflect.deleteProperty(process.env, 'DSH_PERMISSION_MODE')
    else process.env.DSH_PERMISSION_MODE = originalPermissionMode
  })

  it('drives ten evolution rounds and writes the trajectory log and topology', async () => {
    onTestFailed(() => saveFailureShot(page, `rsi-evolution-trajectory-${String(ROUNDS)}`))
    const rounds = await scaffold.ctx.rsiEvolutionTrajectory.runRounds(ROUNDS)
    expect(rounds.length).toBeGreaterThanOrEqual(Math.min(ROUNDS, 1))

    const topology = await scaffold.ctx.rsiEvolutionTrajectory.renderTopology()
    const log = await scaffold.ctx.rsiEvolutionTrajectory.renderLog()
    const status = await scaffold.ctx.dualCoreRsi.status()
    mkdirSync(OUTPUT_DIR, { recursive: true })
    writeFileSync(join(OUTPUT_DIR, 'trajectory.jsonl'), `${JSON.stringify(await scaffold.ctx.rsiEvolutionTrajectory.rounds(), null, 2)}\n`)
    writeFileSync(join(OUTPUT_DIR, 'topology.md'), `${topology}\n`)
    writeFileSync(join(OUTPUT_DIR, 'trajectory.log.txt'), `${log}\n`)
    writeFileSync(join(OUTPUT_DIR, 'final-policy.json'), `${JSON.stringify({
      activeId: status.active.id,
      score: status.active.benchmark?.score ?? null,
      guidance: status.active.artifacts.guidance,
      skills: status.active.artifacts.skills,
    }, null, 2)}\n`)
    // The ledger commits adopted generations for git-level rollback.
    const ledgerDir = join(scaffold.harnessHome, 'dual-core-rsi-ledger')
    if (existsSync(ledgerDir)) {
      writeFileSync(join(OUTPUT_DIR, 'ledger.log'), execFileSync('git', ['log', '--format=%h %s'], { cwd: ledgerDir, encoding: 'utf8' }))
    }

    await page.getByRole('button', { name: 'Self-evolution', exact: true }).click()
    await page.getByRole('region', { name: 'Self-evolution activity' }).waitFor({ timeout: 15_000 })
    await page.screenshot({ path: join(OUTPUT_DIR, 'panel.png'), fullPage: true })

    expect(tripwire.pageErrors).toEqual([])
  }, 150 * 60_000)
})
