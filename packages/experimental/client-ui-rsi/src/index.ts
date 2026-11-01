/**
 * Node half of the dual-core RSI sidebar panel plugin. The browser half in
 * `src/client/` owns every contribution; this entry exists so the package
 * appears as an ordinary Loader row.
 * @module @deepseek-ai/dsh-experimental-client-ui-rsi
 */

/** Loader-visible no-op body; the browser half carries the feature. */
export function apply(): void {}
