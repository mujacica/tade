import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { findOpenable } from './editor.ts'
import { type Hit, sameTarget, type Target } from './hits.ts'
import type { Skin } from './skin.ts'
import { fit, type Pointer } from './ui.ts'

/**
 * A row of text someone else wrote — an agent's screen, the orchestrator's
 * answer — with its links and file references made clickable. The one under
 * the pointer is underlined, which costs that row its own colours while you
 * point at it — a fair trade for seeing what you would open.
 */
export function linkedRow(
  line: string,
  width: number,
  skin: Skin,
  pointer: Pointer,
): { text: string; hits: Hit[] } {
  const plain = stripTerminalSequences(line)
  const hits: Hit[] = []
  let text = fit(line, width)
  for (const found of findOpenable(plain)) {
    if (found.from >= width) continue
    const target: Target =
      found.target.kind === 'url'
        ? { kind: 'link', url: found.target.url }
        : {
            kind: 'place',
            path: found.target.path,
            ...(found.target.line ? { line: found.target.line } : {}),
            ...(found.target.column ? { column: found.target.column } : {}),
          }
    const to = Math.min(found.to, width - 1)
    hits.push({ row: 0, from: found.from, to, target })
    if (sameTarget(pointer.hover, target)) {
      const cells = [...fit(plain, width)]
      text =
        cells.slice(0, found.from).join('') +
        skin.link(cells.slice(found.from, to + 1).join('')) +
        cells.slice(to + 1).join('')
    }
  }
  return { text, hits }
}
