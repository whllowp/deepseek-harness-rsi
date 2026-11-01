/**
 * Dual-core RSI sidebar plugin, browser half: one left-sidebar entry whose
 * main panel lists every background evolution and self-repair the daemon
 * recorded. The panel reads the Host's `dualCoreRsi.activity` Remote query,
 * rereading it on a configured cadence while the panel is open and after
 * every connection reset; it holds no other transport state.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-experimental-dual-core-rsi/remote'
import type { RsiPanelKey } from './locales.ts'
import { Config, DEFAULT_REFRESH_INTERVAL_MS, mountRsiPanel } from './mount.ts'

export { Config, inject, RSI_PANEL_ID } from './mount.ts'
export type { RsiPanelInjected, RsiPanelProps } from './RsiPanel.tsx'
export type { ActivitySnapshot, ActivitySource, ActivityStatus } from './activity-source.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Self-evolution sidebar panel copy. */
    'rsi.panel': RsiPanelKey
  }
}

/**
 * Client plugin body: mount the Remote and the self-evolution panel.
 * @param ctx - client root context.
 * @param config - validated refresh configuration.
 * @returns disposer that removes the panel and the Remote.
 */
export async function apply(ctx: ClientContext, config: Config = Config({})): Promise<() => Promise<void>> {
  return mountRsiPanel(ctx, remote, config.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS)
}
