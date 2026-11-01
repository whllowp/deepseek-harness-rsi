/** Decorative occupant for the self-evolution sidebar entry. */
import { IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the sparkle glyph at the size the sidebar asks for; the sidebar owns
 * its accessible navigation label.
 * @param props - the sidebar's icon share: the requested edge.
 * @returns decorative sparkle icon.
 */
export function RsiPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconSparkleRegular size={size} />
}
