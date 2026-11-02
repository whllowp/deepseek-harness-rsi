/**
 * Pixel-hero companion plugin, browser half: one original pixel hero that
 * walks the bottom of the Web client and reacts to the dual-core RSI daemon —
 * distilling beside a sparkle while a cycle runs, flashing when the daemon
 * records a self-repair, and glowing with a heart when an evolution is
 * adopted. The hero reads the `dualCoreRsi` Remote namespace the Self-evolution
 * panel plugin mounts and rereads activity on a configured cadence.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { Config, DEFAULT_REFRESH_INTERVAL_MS, mountZeldaPet } from './mount.tsx'

export { Config, inject } from './mount.tsx'
export type { ZeldaPetInjected, ZeldaPetProps } from './ZeldaPet.tsx'
export type { HeroBubble, HeroPose, HeroState } from './pet-state.ts'
export { foldHeroState } from './pet-state.ts'

/**
 * Client plugin body: render the hero companion.
 * @param ctx - client root context.
 * @param config - validated refresh configuration.
 * @returns disposer that removes the hero stage.
 */
export async function apply(ctx: ClientContext, config: Config = Config({})): Promise<() => Promise<void>> {
  return mountZeldaPet(ctx, config.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS)
}
