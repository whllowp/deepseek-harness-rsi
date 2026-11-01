/** Browser half of the self-evolution plugin: Remote self-mount, registrations, dictionaries, and refresh wiring. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { Config, inject, mountRsiPanel, RSI_PANEL_ID } from '../src/client/mount.ts'
import type { RsiPanelInjected } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'

const Empty = () => null

const contribution: TypertRemoteContribution = { package: '@deepseek-ai/dsh-experimental-dual-core-rsi', descriptors: [] }

const READY = { ok: true, value: { daemonEnabled: true, mergePolicy: 'auto', evolutions: [], repairs: [] } }

afterEach(() => { vi.useRealTimers() })

function injectedFace(entry: StoredEntry, ...args: never[]): object {
  const face = entry.inject?.(...args)
  if (face === undefined) throw new Error('slot entry injected no face')
  return face
}

async function baseContext(activity: () => Promise<unknown>) {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  const mounted: TypertRemoteContribution[] = []
  // A Service preserves the associated namespace lookup used by the real Gateway.
  class TestRemote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(value: TypertRemoteContribution) {
      mounted.push(value)
      ctx.provide('remote.dualCoreRsi', { activity } as never)
      return unmount
    }
  }
  new TestRemote()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  const owner = ctx.slots.register({
    name: 'root',
    children: {
      main: { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, Empty)
  return { ctx, unmount, mounted, owner }
}

describe('ui-rsi browser plugin', () => {
  it('declares only the services used by mounting and keeps the Node half inert', () => {
    expect(inject).toEqual(['remote', 'slots', 'locale'])
    expect(() => { applyNode() }).not.toThrow()
    expect(Config({})).toEqual({ refreshIntervalMs: 15_000 })
  })

  it('mounts the Remote, registers the sidebar entry and panel, and rereads on cadence and reset', async () => {
    vi.useFakeTimers()
    const activity = vi.fn().mockResolvedValue(READY)
    const test = await baseContext(activity)
    const dispose = await mountRsiPanel(test.ctx, contribution, 1_000)
    expect(test.mounted).toEqual([contribution])

    const entry = test.ctx.slots.entries('main')[0]!
    expect(entry.options.key).toBe(RSI_PANEL_ID)
    const panel = test.ctx.slots.entries('sidebar.panellist')[0]!
    expect(panel.options.id).toBe(RSI_PANEL_ID)
    test.ctx.locale.setLocale('en')
    expect(resolveSlotLabel(panel.options.label)).toBe('Self-evolution')
    test.ctx.locale.setLocale('zh')
    expect(resolveSlotLabel(panel.options.label)).toBe('自进化')

    const face = injectedFace(entry, undefined as never) as RsiPanelInjected
    const stop = face.activity.subscribe(vi.fn())
    await vi.waitFor(() => { expect(face.activity.getSnapshot().status).toBe('ready') })
    expect(activity).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(activity).toHaveBeenCalledTimes(2)
    test.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(activity).toHaveBeenCalledTimes(3) })
    stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(activity).toHaveBeenCalledTimes(3)

    await dispose()
    expect(test.unmount).toHaveBeenCalledOnce()
    expect(test.ctx.slots.entries('main')).toEqual([])
    expect(test.ctx.slots.entries('sidebar.panellist')).toEqual([])
    test.owner()
    await test.ctx.fiber.dispose()
  })

  it('rolls the Remote back when panel registration fails', async () => {
    const test = await baseContext(vi.fn().mockResolvedValue(READY))
    vi.spyOn(test.ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('registration failed') })
    await expect(mountRsiPanel(test.ctx, contribution, 1_000)).rejects.toThrow('registration failed')
    expect(test.unmount).toHaveBeenCalledOnce()
    test.owner()
    await test.ctx.fiber.dispose()
  })

  it('loads the browser entry through its generated optional Remote contribution', async () => {
    const test = await baseContext(vi.fn().mockResolvedValue(READY))
    vi.doMock('@deepseek-ai/dsh-experimental-dual-core-rsi/remote', () => ({ default: contribution }))
    try {
      const browser = await import('../src/client/index.ts')
      const fiber = test.ctx.plugin({ inject: [...browser.inject], apply: browser.apply }, {})
      await fiber
      expect(test.mounted).toEqual([contribution])
      expect(test.ctx.slots.entries('main')).toHaveLength(1)
      await fiber.dispose()
      expect(test.unmount).toHaveBeenCalledOnce()
    } finally {
      test.owner()
      await test.ctx.fiber.dispose()
      vi.doUnmock('@deepseek-ai/dsh-experimental-dual-core-rsi/remote')
    }
  })
})
