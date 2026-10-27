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
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import DualCoreRsiService from '../src/index.ts'
import { SubagentRsiDistiller } from '../src/distiller.ts'
import { FixtureRsiBenchmark } from '../src/benchmark.ts'
import * as dualCoreRsiPlugin from '../src/index.ts'
import * as distillerSubagentPlugin from '../src/plugin-distiller-subagent.ts'
import * as benchmarkFixturePlugin from '../src/plugin-benchmark-fixture.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('dual-core RSI through a real Loader composition', () => {
  it('activates the bundle rows: providers, service, tools, and command', async () => {
    root = await mkdtemp(join(tmpdir(), 'dual-core-rsi-loader-'))
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
      '- id: subagents',
      "  name: '@deepseek-ai/dsh-subagent'",
      '- id: dual-core-rsi-distiller',
      "  name: '@deepseek-ai/dsh-experimental-dual-core-rsi/distiller-subagent'",
      '  config:',
      '    subagentProvider: spawn',
      '- id: dual-core-rsi-benchmark',
      "  name: '@deepseek-ai/dsh-experimental-dual-core-rsi/benchmark-fixture'",
      '  config:',
      '    cases:',
      '      - name: verify-before-done',
      '        weight: 2',
      '        requiresGuidance: [verify]',
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
          case '@deepseek-ai/dsh-experimental-dual-core-rsi/distiller-subagent': return distillerSubagentPlugin
          case '@deepseek-ai/dsh-experimental-dual-core-rsi/benchmark-fixture': return benchmarkFixturePlugin
          case '@deepseek-ai/dsh-experimental-dual-core-rsi': return dualCoreRsiPlugin
          default: throw new Error(`unexpected Loader import: ${specifier}`)
        }
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    expect(context.dualCoreRsi).toBeInstanceOf(DualCoreRsiService)
    expect(context.rsiDistiller).toBeInstanceOf(SubagentRsiDistiller)
    expect(context.rsiBenchmark).toBeInstanceOf(FixtureRsiBenchmark)
    expect(context.tools.get('rsi_status')).toBeDefined()
    expect(context.tools.get('rsi_run')).toBeDefined()
    expect(context.tools.get('rsi_history')).toBeDefined()
    expect(context.tools.get('rsi_rollback')).toBeDefined()
    await context.dualCoreRsi.waitReady()
    const status = await context.dualCoreRsi.status()
    expect(status.threshold).toBe(0.05)
    expect(status.active.id).toBe('gen-1')
  })
})
