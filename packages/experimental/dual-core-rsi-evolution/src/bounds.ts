/**
 * Shared config-bound validators for the evolution package's provider configs.
 * @module @deepseek-ai/dsh-experimental-dual-core-rsi-evolution/bounds
 */

/** Validate one optional positive-safe-integer config field against its fallback. */
export function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer, got ${String(value)}`)
  }
  return value
}
