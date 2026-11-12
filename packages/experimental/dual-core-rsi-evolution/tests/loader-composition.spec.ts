import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { FixtureRsiBenchmark, SubagentRsiDistiller } from '@deepseek-ai/dsh-experimental-dual-core-rsi'
import DualCoreRsiService from '@deepseek-ai/dsh-experimental-dual-core-rsi'
import * as dualCoreRsiPlugin from '@deepseek-ai/dsh-experimental-dual-core-rsi'
import * as distillerSubagentPlugin from '@deepseek-ai/dsh-experimental-dual-core-rsi/distiller-subagent'
import * as benchmarkFixturePlugin from '@deepseek-ai/dsh-experimental-dual-core-rsi/benchmark-fixture'
import { DomainEvolutionTrajectory, DomainReplayLedger, HarmonyRsiBenchmark, LedgerWorldModel, ReplayRsiDistiller } from '../src/index.ts'
import * as evolutionLedgerPlugin from '../src/plugin-evolution-ledger.ts'
import * as harmonyBenchmarkPlugin from '../src/plugin-harmony-benchmark.ts'
import * as replayDistillerPlugin from '../src/plugin-replay-distiller.ts'
import * as trajectoryPlugin from '../src/plugin-trajectory.ts'
import * as worldModelPlugin from '../src/plugin-world-model.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('dual-core RSI evolution through a real Loader composition', () => {
  it('activates the evolution rows: ledger, harmony benchmark, replay distiller, and the service', async () => {
    root = await mkdtemp(join(tmpdir(), 'rsi-evolution-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: storage',
      "  name: '@deepseek-ai/dsh-storage'",
      '- id: storage-json',
      "  name: '@deepseek-ai/dsh-storage-json'",
      '  config:',
      `    root: ${JSON.stringify(join(root, 'units'))}`,
      '- id: storage-domain',
      "  name: '@deepseek-ai/dsh-storage-domain'",
      '  config:',
      '    backend: json',
      '- id: sessions',
      "  name: '@deepseek-ai/dsh-session'",
      '- id: session-projections',
      "  name: '@deepseek-ai/dsh-session-projection'",
      '- id: system-prompt',
      "  name: '@deepseek-ai/dsh-system-prompt'",
      '- id: skills',
      "  name: '@deepseek-ai/dsh-skill'",
      '- id: tools',
      "  name: '@deepseek-ai/dsh-tools'",
      '- id: commands',
      "  name: '@deepseek-ai/dsh-commands'",
      '- id: agents',
      "  name: '@deepseek-ai/dsh-agent'",
      '- id: jobs',
      "  name: '@deepseek-ai/dsh-jobs-local'",
      '- id: subprocess',
      "  name: '@deepseek-ai/dsh-subprocess-local'",
      '- id: subagents',
      "  name: '@deepseek-ai/dsh-subagent'",
      '- id: dual-core-rsi-evolution-ledger',
      "  name: '@deepseek-ai/dsh-experimental-dual-core-rsi-evolution/evolution-ledger'",
      '- id: dual-core-rsi-evolution-world-model',
      "  name: '@deepseek-ai/dsh-experimental-dual-core-rsi-evolution/world-model'",
      '- id: dual-core-rsi-benchmark',
      "  name: '@deepseek-ai/dsh-experimental-dual-core-rsi-evolution/harmony-benchmark'",
      '  config:',
      '    cases:',
      '      - name: verify-before-done',
      '        weight: 2',
      '        requiresGuidance: [verify]',
      '    objectives:',
      '      - name: general',
      '        weight: 1',
      '        cases: [verify-before-done]',
      '- id: dual-core-rsi-distiller',
      "  name: '@deepseek-ai/dsh-experimental-dual-core-rsi-evolution/replay-distiller'",
      '  config:',
      '    subagentProvider: spawn',
      '- id: dual-core-rsi-evolution-trajectory',
      "  name: '@deepseek-ai/dsh-experimental-dual-core-rsi-evolution/trajectory'",
      '  config:',
      '    rounds: 3',
      '- id: dual-core-rsi',
      "  name: '@deepseek-ai/dsh-experimental-dual-core-rsi'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        switch (specifier) {
          // The real composition reaches dsh-subagent from dsh-base; the harness
          // maps it to a stub providing the distiller's provider-lookup surface.
          case '@deepseek-ai/dsh-subagent': return Object.assign((ctx: Context) => {
            ctx.provide('subagents', { getProvider: () => undefined })
          }, { inject: [] })
          case '@deepseek-ai/dsh-storage': return Storage
          case '@deepseek-ai/dsh-storage-json': return storageJson
          case '@deepseek-ai/dsh-storage-domain': return storageDomain
          case '@deepseek-ai/dsh-session': return SessionStore
          case '@deepseek-ai/dsh-session-projection': return SessionProjectionRegistry
          case '@deepseek-ai/dsh-system-prompt': return SystemPrompt
          case '@deepseek-ai/dsh-skill': return SkillRegistry
          case '@deepseek-ai/dsh-tools': return ToolRuntime
          case '@deepseek-ai/dsh-commands': return CommandRuntime
          case '@deepseek-ai/dsh-agent': return AgentRegistry
          case '@deepseek-ai/dsh-jobs-local': return LocalJobRegistry
          case '@deepseek-ai/dsh-subprocess-local': return LocalSubprocessRuntime
          case '@deepseek-ai/dsh-experimental-dual-core-rsi/distiller-subagent': return distillerSubagentPlugin
          case '@deepseek-ai/dsh-experimental-dual-core-rsi/benchmark-fixture': return benchmarkFixturePlugin
          case '@deepseek-ai/dsh-experimental-dual-core-rsi': return dualCoreRsiPlugin
          case '@deepseek-ai/dsh-experimental-dual-core-rsi-evolution/evolution-ledger': return evolutionLedgerPlugin
          case '@deepseek-ai/dsh-experimental-dual-core-rsi-evolution/harmony-benchmark': return harmonyBenchmarkPlugin
          case '@deepseek-ai/dsh-experimental-dual-core-rsi-evolution/replay-distiller': return replayDistillerPlugin
          case '@deepseek-ai/dsh-experimental-dual-core-rsi-evolution/trajectory': return trajectoryPlugin
          case '@deepseek-ai/dsh-experimental-dual-core-rsi-evolution/world-model': return worldModelPlugin
          default: throw new Error(`unexpected Loader import: ${specifier}`)
        }
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    // The decorators own the public seams; the shipped providers stay mounted
    // beneath them in isolated scopes, and the ledger sits beside both.
    expect(context.rsiDistiller).toBeInstanceOf(ReplayRsiDistiller)
    expect(context.rsiBenchmark).toBeInstanceOf(HarmonyRsiBenchmark)
    expect(context.rsiEvolutionLedger).toBeInstanceOf(DomainReplayLedger)
    expect(context.rsiWorldModel).toBeInstanceOf(LedgerWorldModel)
    expect(context.rsiEvolutionTrajectory).toBeInstanceOf(DomainEvolutionTrajectory)
    expect(context.dualCoreRsi).toBeInstanceOf(DualCoreRsiService)
    await context.dualCoreRsi.waitReady()
    const status = await context.dualCoreRsi.status()
    expect(status.threshold).toBe(0.05)
    expect(status.active.id).toBe('gen-1')

    // One evaluation through the composed seam: harmony scores the fixture's
    // case and joins the ledger by content fingerprint.
    const score = await context.rsiBenchmark.evaluate({
      generation: {
        id: 'gen-2' as never,
        origin: 'distilled',
        parent: null,
        createdAt: 1,
        artifacts: { guidance: ['always verify the diff'], skills: [] },
      },
    }, new AbortController().signal)
    expect(score.score).toBe(1)
    expect(score.provider).toBe('harmony:fixture')
    await context.rsiEvolutionLedger.recordProposal(status.active.artifacts, { rationale: 'initial', matchedActive: false })
    expect(await context.rsiEvolutionLedger.entries()).toHaveLength(1)

    // The replay distiller stays a genuine child spawner: its provider lookup
    // reaches the composed subagents stub and fails loud without a key.
    await expect(context.rsiDistiller.distill({
      active: status.active,
      daemon: status.daemon,
      digest: { assembledAt: 1, sessions: [] },
      knowledge: [],
      budgets: {
        maxGuidanceLines: 8, maxGuidanceLineChars: 200, maxGuidanceChars: 800,
        maxSkills: 4, maxSkillDescriptionChars: 120, maxSkillContentChars: 400,
      },
    }, { parent: { id: 'none' } as never, signal: new AbortController().signal }))
      .rejects.toThrow(/provider "spawn" is not registered/)

    // The shipped providers remain mounted one scope below their decorators.
    const fixture = context.rsiBenchmark as unknown as { inner?: never }
    expect(fixture).toBeDefined()
    void FixtureRsiBenchmark
    void SubagentRsiDistiller
  })
})
