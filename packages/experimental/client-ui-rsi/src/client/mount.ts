/**
 * Optional Remote and panel registration lifecycle for the self-evolution
 * sidebar: mount the experimental `dualCoreRsi` Remote (the default Remote
 * assembly never carries experimental namespaces), then the dictionaries, the
 * main panel, and its sidebar entry; withdraw them in reverse.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-experimental-dual-core-rsi/remote'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { createActivitySource } from './activity-source.ts'
import { en, NS, zh } from './locales.ts'
import { RsiPanel, type RsiPanelInjected } from './RsiPanel.tsx'
import { RsiPanelIcon } from './RsiPanelIcon.tsx'

/** Main-panel and sidebar-row identity shared by both registrations. */
export const RSI_PANEL_ID = 'rsi-activity' as MainPanelId

/** Default read cadence while the panel is open. */
export const DEFAULT_REFRESH_INTERVAL_MS = 15_000

/** Panel refresh configuration. */
export interface Config {
  /** Milliseconds between activity reads while the panel is open (default 15000). */
  refreshIntervalMs?: number
}

/** Validated panel refresh configuration. */
export const Config: z<Config> = z.object({
  refreshIntervalMs: z.natural().min(1000).default(DEFAULT_REFRESH_INTERVAL_MS),
})

/** Services required to mount the optional Remote and register the panel. */
export const inject = ['remote', 'slots', 'locale']

/**
 * Register the dictionaries, the main panel, and its sidebar entry once the
 * `dualCoreRsi` Remote namespace exists.
 * @param ctx - child context with `remote.dualCoreRsi` injected.
 * @param refreshIntervalMs - validated read cadence while the panel is open.
 */
function registerUi(ctx: ClientContext, refreshIntervalMs: number): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-rsi: dictionaries')
  const t = ctx.locale.bind(NS)
  // Register the reset dispatch once, synchronously with the mount: React may
  // first subscribe the store long after this context could have been retired.
  const resetListeners = new Set<() => void>()
  ctx.effect(() => [
    ctx.on('connection/reset', () => { for (const listener of [...resetListeners]) listener() }),
  ], 'ui-rsi: connection reset dispatch')
  const activity = createActivitySource({
    read: () => ctx.remote.dualCoreRsi.activity(),
    intervalMs: refreshIntervalMs,
    subscribeReset: (listener) => {
      resetListeners.add(listener)
      return () => { resetListeners.delete(listener) }
    },
  })
  ctx.effect(() => () => { activity.dispose() }, 'ui-rsi: activity source')
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: RSI_PANEL_ID,
    locale: NS,
    inject: (): RsiPanelInjected => ({ activity }),
  }, RsiPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: RSI_PANEL_ID,
    order: 20,
    locale: NS,
    label: () => t('panel'),
  }, RsiPanelIcon))
}

/**
 * Mount the generated `dualCoreRsi` Remote, then the panel; the returned
 * disposer withdraws the panel before the Remote it reads.
 * @param ctx - client plugin lifetime.
 * @param contribution - the generated Remote definitions.
 * @param refreshIntervalMs - validated read cadence while the panel is open.
 * @returns disposer that removes both contributions.
 */
export async function mountRsiPanel(
  ctx: ClientContext,
  contribution: TypertRemoteContribution,
  refreshIntervalMs: number,
): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.dualCoreRsi', 'slots', 'locale'], (child) => { registerUi(child, refreshIntervalMs) })
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await unmountRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await unmountRemote()
  }
}
