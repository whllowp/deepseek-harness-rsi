/**
 * Branded identities for the dual-core RSI domain.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi/branding
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity of one generation of the improvable surface. */
export type RsiGenerationId = Branded<'rsi-generation'>

/** Identity of one archived pre-swap generation available for rollback. */
export type RsiArchiveId = Branded<'rsi-archive'>

/** Identity of one completed distillation cycle record. */
export type RsiCycleId = Branded<'rsi-cycle'>

/** Identity of one recorded daemon self-repair incident. */
export type RsiIncidentId = Branded<'rsi-incident'>

/**
 * Brand a string as an {@link RsiGenerationId}.
 * @param id - the raw generation id string.
 * @returns the same string with the generation-id brand.
 */
export function RsiGenerationId(id: string): RsiGenerationId {
  return brandString<RsiGenerationId>(id)
}

/**
 * Brand a string as an {@link RsiArchiveId}.
 * @param id - the raw archive id string.
 * @returns the same string with the archive-id brand.
 */
export function RsiArchiveId(id: string): RsiArchiveId {
  return brandString<RsiArchiveId>(id)
}

/**
 * Brand a string as an {@link RsiCycleId}.
 * @param id - the raw cycle id string.
 * @returns the same string with the cycle-id brand.
 */
export function RsiCycleId(id: string): RsiCycleId {
  return brandString<RsiCycleId>(id)
}

/**
 * Brand a string as an {@link RsiIncidentId}.
 * @param id - the raw incident id string.
 * @returns the same string with the incident-id brand.
 */
export function RsiIncidentId(id: string): RsiIncidentId {
  return brandString<RsiIncidentId>(id)
}
