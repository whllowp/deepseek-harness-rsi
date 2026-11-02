/**
 * Companion registration lifecycle for the pixel hero: render the walking
 * hero into a fixed bottom-right stage once the shared `dualCoreRsi` Remote
 * namespace (mounted once by the Self-evolution panel plugin of the same
 * bundle) exists, and withdraw the stage on disposal.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-experimental-dual-core-rsi/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { RSI_PANEL_ID, createActivitySource } from '@deepseek-ai/dsh-experimental-client-ui-rsi/client'
import { createRoot, type Root } from 'react-dom/client'
import { ZeldaPet } from './ZeldaPet.tsx'
import css from './ZeldaPet.module.css'
import { en, NS, zh } from './locales.ts'

/** Default read cadence while the companion is mounted. */
export const DEFAULT_REFRESH_INTERVAL_MS = 15_000

/** Companion refresh configuration. */
export interface Config {
  /** Milliseconds between activity reads (default 15000). */
  refreshIntervalMs?: number
}

/** Validated companion refresh configuration. */
export const Config: z<Config> = z.object({
  refreshIntervalMs: z.natural().min(1000).default(DEFAULT_REFRESH_INTERVAL_MS),
})

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Pixel-hero companion copy. */
    'zeldaPet': import('./locales.ts').ZeldaPetKey
  }
}

/**
 * Services required to render the hero. `remote.dualCoreRsi` arrives from the
 * panel plugin's single namespace mount; a composition without that row keeps
 * the hero waiting rather than mounting a duplicate contribution. `remote`
 * itself is read only through that namespace.
 */
export const inject = ['remote', 'remote.dualCoreRsi', 'locale', 'layout']

/**
 * Render the hero into one fixed stage under the plugin context.
 * @param ctx - child context with `remote.dualCoreRsi` and `layout` injected.
 * @param refreshIntervalMs - validated read cadence.
 */
function renderHero(ctx: ClientContext, refreshIntervalMs: number): () => void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'zelda-pet: dictionaries')
  const t = ctx.locale.bind(NS)
  // Register the reset dispatch once, synchronously with the mount: React may
  // first subscribe the store long after this context could have been retired.
  const resetListeners = new Set<() => void>()
  ctx.effect(() => [
    ctx.on('connection/reset', () => { for (const listener of [...resetListeners]) listener() }),
  ], 'zelda-pet: connection reset dispatch')
  const activity = createActivitySource({
    read: () => ctx.remote.dualCoreRsi.activity(),
    intervalMs: refreshIntervalMs,
    subscribeReset: (listener) => {
      resetListeners.add(listener)
      return () => { resetListeners.delete(listener) }
    },
  })
  ctx.effect(() => () => { activity.dispose() }, 'zelda-pet: activity source')

  // The stage exists synchronously with the mount, so presence checks never
  // race React's first commit; the hero inside it renders asynchronously.
  const host = document.createElement('div')
  host.dataset.zeldaPetStage = 'true'
  host.classList.add(css.stage)
  document.body.appendChild(host)
  let root: Root
  try {
    root = createRoot(host)
  } catch (error) {
    // A failed root must not leak the stage into the document.
    host.remove()
    throw error
  }
  const openSelfEvolution = (): void => {
    // The sidebar panel registers under the same bundle; when a composition
    // mounts the hero without it, the hero stays and the button reports nothing to open.
    const registered = ctx.get('slots')?.entries('main').some(entry => entry.options.key === RSI_PANEL_ID) ?? false
    if (registered) ctx.layout.selectPanel(RSI_PANEL_ID)
  }
  root.render(<ZeldaPet inject={{ activity, openSelfEvolution }} t={t} />)
  return () => {
    root.unmount()
    host.remove()
  }
}

/**
 * Render the hero once the shared `dualCoreRsi` Remote namespace exists.
 * @param ctx - client plugin lifetime.
 * @param refreshIntervalMs - validated read cadence.
 * @returns disposer that removes the hero stage.
 */
export async function mountZeldaPet(ctx: ClientContext, refreshIntervalMs: number): Promise<() => Promise<void>> {
  const ui = ctx.inject(inject, (child) => {
    const teardown = renderHero(child, refreshIntervalMs)
    child.effect(() => teardown, 'zelda-pet: hero stage')
  })
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    throw error
  }
  return async () => { await ui.dispose() }
}
