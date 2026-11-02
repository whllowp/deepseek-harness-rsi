/**
 * The hero's reactive state, folded from consecutive activity snapshots: the
 * diff between what the panel last showed and what it shows now is what the
 * hero reacts to, so the companion stays a pure projection of the daemon.
 */

import type { ActivitySnapshot } from '@deepseek-ai/dsh-experimental-client-ui-rsi/client'
import type { RsiActivityView } from '@deepseek-ai/dsh-experimental-dual-core-rsi/client'

/** Pose the sprite renders; `hurt` and `levelUp` are transient reactions. */
export type HeroPose = 'idle' | 'distilling' | 'hurt' | 'levelUp'

/** One speech bubble the hero shows beside the sprite. */
export interface HeroBubble {
  readonly kind: 'evolution' | 'repair' | 'empty'
  /** Already-localized one-line text. */
  readonly text: string
}

/** Everything the sprite component renders, derived from one snapshot diff. */
export interface HeroState {
  readonly pose: HeroPose
  readonly bubble: HeroBubble
  /** Whether the daemon driver is armed at all; false mutes every reaction. */
  readonly active: boolean
}

/**
 * Fold one new snapshot against the previous view into the hero's state.
 * @param previous - the last view the fold saw, or none before the first read.
 * @param snapshot - the freshly read activity snapshot.
 * @param format - localized bubble text for the newest evolution and repair.
 * @returns the pose and bubble to render.
 */
export function foldHeroState(
  previous: RsiActivityView | undefined,
  snapshot: ActivitySnapshot,
  format: { evolution: (rationale: string) => string; repair: (detail: string) => string; empty: () => string },
): HeroState {
  if (snapshot.status !== 'ready') {
    // Loading and error keep the hero quiet rather than reacting to absence.
    return { pose: 'idle', bubble: { kind: 'empty', text: format.empty() }, active: previous?.daemonEnabled ?? true }
  }
  const view = snapshot.view
  if (!view.daemonEnabled) return { pose: 'idle', bubble: { kind: 'empty', text: format.empty() }, active: false }
  const newestEvolution = view.evolutions[0]
  const newestRepair = view.repairs[0]
  const firstEvolution = previous === undefined ? undefined : previous.evolutions[0]?.cycleId
  const firstRepair = previous === undefined ? undefined : previous.repairs[0]?.id
  if (newestRepair !== undefined && firstRepair !== newestRepair.id) {
    return { pose: 'hurt', bubble: { kind: 'repair', text: format.repair(newestRepair.detail) }, active: true }
  }
  if (newestEvolution !== undefined && firstEvolution !== newestEvolution.cycleId) {
    return { pose: 'levelUp', bubble: { kind: 'evolution', text: format.evolution(newestEvolution.rationale) }, active: true }
  }
  if (view.cycleRunning) {
    return { pose: 'distilling', bubble: { kind: 'empty', text: format.empty() }, active: true }
  }
  return { pose: 'idle', bubble: { kind: 'empty', text: format.empty() }, active: true }
}
