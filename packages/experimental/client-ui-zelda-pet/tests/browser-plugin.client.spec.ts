// @vitest-environment jsdom
/** Browser half of the hero plugin: shared-namespace wait, stage teardown, and the panel-open guard. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { RSI_PANEL_ID } from '@deepseek-ai/dsh-experimental-client-ui-rsi/client'
import { Config, inject, mountZeldaPet } from '../src/client/mount.tsx'
import { apply as applyNode } from '../src/index.ts'

const Empty = () => null

const READY = { ok: true, value: { daemonEnabled: true, mergePolicy: 'auto', cycleRunning: false, evolutions: [], repairs: [] } }

afterEach(() => { vi.useRealTimers() })

// A Service preserves the associated namespace lookup used by the real Gateway.
class RemoteStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'remote')
  }
  $on(): () => void { return () => {} }
}

async function baseContext(activity: () => Promise<unknown>) {
  const ctx = new Context()
  new RemoteStub(ctx)
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  ctx.provide('remote.dualCoreRsi', { activity } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const selectPanel = vi.fn()
  ctx.provide('layout', { selectPanel, panelInfo: { getSnapshot: () => ({ activePanelId: null }), subscribe: () => () => {} } } as never)
  const owner = ctx.slots.register({
    name: 'root',
    children: {
      main: { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, Empty)
  return { ctx, owner, selectPanel }
}

describe('zelda-pet browser plugin', () => {
  it('declares only the services used by rendering and keeps the Node half inert', () => {
    expect(inject).toEqual(['remote', 'remote.dualCoreRsi', 'locale', 'layout'])
    expect(() => { applyNode() }).not.toThrow()
    expect(Config({})).toEqual({ refreshIntervalMs: 15_000 })
  })

  it('renders the hero into a fixed stage once the shared namespace exists, and withdraws it on dispose', async () => {
    const activity = vi.fn().mockResolvedValue(READY)
    const test = await baseContext(activity)
    const dispose = await mountZeldaPet(test.ctx, 1_000)
    const stage = document.querySelector('[data-zelda-pet-stage]')
    expect(stage).toBeTruthy()
    expect((stage!.parentElement ?? document.body).tagName).toBe('BODY')
    await vi.waitFor(() => { expect(document.querySelector('[data-hero-pose]')).toBeTruthy() })
    await vi.waitFor(() => { expect(activity.mock.calls.length).toBeGreaterThanOrEqual(1) })
    const reads = activity.mock.calls.length
    // A connection reset rereads activity without remounting the hero.
    test.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(activity.mock.calls.length).toBeGreaterThan(reads) })

    await dispose()
    expect(document.querySelector('[data-zelda-pet-stage]')).toBeNull()
    test.owner()
    await test.ctx.fiber.dispose()
  })

  it('waits without a stage until the panel plugin provides the namespace', async () => {
    const ctx = new Context()
    new RemoteStub(ctx)
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('layout', { selectPanel: vi.fn() } as never)
    const pending = mountZeldaPet(ctx, 1_000)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(document.querySelector('[data-zelda-pet-stage]')).toBeNull()
    // The namespace arriving late renders the hero.
    ctx.provide('remote.dualCoreRsi', { activity: vi.fn().mockResolvedValue(READY) } as never)
    const dispose = await pending
    await vi.waitFor(() => { expect(document.querySelector('[data-hero-pose]')).toBeTruthy() })
    await dispose()
    await ctx.fiber.dispose()
  })

  it('opens the registered Self-evolution panel from the hero button', async () => {
    const test = await baseContext(vi.fn().mockResolvedValue(READY))
    const dispose = await mountZeldaPet(test.ctx, 1_000)
    await vi.waitFor(() => { expect(document.querySelector('button[class*=openPanel]')).toBeTruthy() })
    // Without the panel registered the click stays a no-op on the layout.
    ;(document.querySelector('button[class*=openPanel]') as HTMLButtonElement).click()
    expect(test.selectPanel).not.toHaveBeenCalled()

    test.ctx.slots.register({ name: 'main', key: RSI_PANEL_ID } as never, Empty)
    ;(document.querySelector('button[class*=openPanel]') as HTMLButtonElement).click()
    expect(test.selectPanel).toHaveBeenCalledWith(RSI_PANEL_ID)

    await dispose()
    test.owner()
    await test.ctx.fiber.dispose()
  })

  it('keeps the click inert when the slots registry is absent', async () => {
    const ctx = new Context()
    new RemoteStub(ctx)
    ctx.provide('remote.dualCoreRsi', { activity: vi.fn().mockResolvedValue(READY) } as never)
    ctx.provide('locale', new LocaleRuntime(ctx))
    const selectPanel = vi.fn()
    ctx.provide('layout', { selectPanel } as never)
    const dispose = await mountZeldaPet(ctx, 1_000)
    await vi.waitFor(() => { expect(document.querySelector('button[class*=openPanel]')).toBeTruthy() })
    ;(document.querySelector('button[class*=openPanel]') as HTMLButtonElement).click()
    // No registry means the guard short-circuits without touching the layout.
    expect(selectPanel).not.toHaveBeenCalled()
    await dispose()
    await ctx.fiber.dispose()
  })

  it('withdraws the stage when the React root cannot be created', async () => {
    const test = await baseContext(vi.fn().mockResolvedValue(READY))
    vi.doMock('react-dom/client', () => ({
      createRoot: () => { throw new Error('stage failed') },
    }))
    try {
      const freshModule = '../src/client/mount.tsx?rollback-case=1'
      const fresh = await import(/* @vite-ignore */ freshModule) as typeof import('../src/client/mount.tsx')
      await expect(fresh.mountZeldaPet(test.ctx, 1_000)).rejects.toThrow('stage failed')
    } finally {
      vi.doUnmock('react-dom/client')
    }
    // The failed root left no stage behind.
    expect(document.querySelector('[data-zelda-pet-stage]')).toBeNull()
    test.owner()
    await test.ctx.fiber.dispose()
  })

  it('loads the browser entry and renders through its declared services', async () => {
    const test = await baseContext(vi.fn().mockResolvedValue(READY))
    const browser = await import('../src/client/index.ts')
    expect(browser.inject).toEqual(inject)
    const fiber = test.ctx.plugin({ inject: [...browser.inject], apply: browser.apply }, {})
    await fiber
    await vi.waitFor(() => { expect(document.querySelector('[data-hero-pose]')).toBeTruthy() })
    await fiber.dispose()
    expect(document.querySelector('[data-zelda-pet-stage]')).toBeNull()
    test.owner()
    await test.ctx.fiber.dispose()
  })
})
