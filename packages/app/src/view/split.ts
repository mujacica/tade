import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { type Hit, rowHit, shift, type Target } from '../hits.ts'
import type { Skin } from '../skin.ts'
import { type Drawn, fit, type Pointer, Row } from '../ui.ts'

// Two halves of one place, and where the line between them goes.
//
// The middle of the window splits an agent against a shell and the panel along
// the bottom splits a terminal against another, so this is neither region's
// either — and the approval card reads the same arithmetic, because a card
// that crosses the divider is what a second copy of it looks like.

/**
 * Two halves of one place, beside each other or one below the other, with a
 * divider you can drag and a bar on the second half: what it is, and buttons
 * to swap the halves, turn the split, and close it.
 */
/**
 * Where a split puts its divider: how much the first half gets.
 *
 * Written down once, because two of them read it — `splitView`, which draws
 * the halves, and the approval card, which has to land inside the agent's
 * own half and not across the shell beside it. A second copy of this
 * arithmetic is a card that crosses the divider the first time somebody
 * changes the ratio.
 */
export function besideFirst(width: number, ratio: number): number {
  return Math.max(10, Math.min(width - 11, Math.round((width - 1) * ratio)))
}

export function belowFirst(height: number, ratio: number): number {
  return Math.max(1, Math.min(height - 2, Math.round((height - 1) * ratio)))
}

export function splitView(opts: {
  width: number
  height: number
  split: { direction: 'beside' | 'below'; ratio: number }
  edge: 'split' | 'terminal-split'
  lit: boolean
  /** The keyboard is on the second half. */
  focus: boolean
  label: string
  /** The actions' prefix: `split:<task>` or `terminal-split`. */
  actions: string
  skin: Skin
  pointer: Pointer
  first: (width: number, height: number) => Drawn
  second: (width: number, height: number) => Drawn
}): Drawn {
  const { width, height, split, skin, pointer } = opts
  const divider: Target = { kind: 'divider', edge: opts.edge }
  const bar = (w: number): { text: string; hits: Hit[] } =>
    new Row(w, skin, pointer)
      .text(opts.split.direction === 'below' ? '── ' : ' ', skin.chrome)
      .text(opts.label, opts.focus ? skin.you : skin.hint)
      .text(opts.focus ? '  typing here' : '', skin.signal)
      .right((r) =>
        r
          .button('⇄', { kind: 'action', name: `${opts.actions}:swap` })
          .space()
          .button(split.direction === 'beside' ? '⇅' : '⇆', {
            kind: 'action',
            name: `${opts.actions}:turn`,
          })
          .space()
          .button('×', { kind: 'action', name: `${opts.actions}:close` })
          .space(),
      )
      .build()
  const rows: string[] = []
  const hits: Hit[] = []
  if (split.direction === 'beside' && width >= 24) {
    const firstWidth = besideFirst(width, split.ratio)
    const secondWidth = width - 1 - firstWidth
    const first = opts.first(firstWidth, height)
    const top = bar(secondWidth)
    const second = opts.second(secondWidth, Math.max(0, height - 1))
    for (let i = 0; i < height; i++) {
      const right = i === 0 ? top.text : (second.rows[i - 1] ?? ' '.repeat(secondWidth))
      rows.push(
        `${fit(first.rows[i] ?? '', firstWidth)}${opts.lit ? skin.signal('┃') : skin.chrome('│')}${fit(right, secondWidth)}`,
      )
      hits.push({ row: i, from: firstWidth, to: firstWidth, target: divider })
    }
    hits.push(...first.hits.filter((hit) => hit.row < height))
    hits.push(...shift(top.hits, 0, firstWidth + 1))
    hits.push(...shift(second.hits, 1, firstWidth + 1).filter((hit) => hit.row < height))
    return { rows, hits }
  }
  const firstHeight = belowFirst(height, split.ratio)
  const secondHeight = Math.max(0, height - 1 - firstHeight)
  const first = opts.first(width, firstHeight)
  const second = opts.second(width, secondHeight)
  rows.push(...first.rows.slice(0, firstHeight))
  hits.push(...first.hits.filter((hit) => hit.row < firstHeight))
  const middle = bar(width)
  // The bar is the divider: take hold of it anywhere but its buttons.
  hits.push(rowHit(firstHeight, width, divider))
  hits.push(...shift(middle.hits, firstHeight))
  rows.push(opts.lit ? skin.signal(stripTerminalSequences(middle.text)) : middle.text)
  rows.push(...second.rows.slice(0, secondHeight))
  hits.push(...shift(second.hits, firstHeight + 1).filter((hit) => hit.row < height))
  while (rows.length < height) rows.push(' '.repeat(width))
  return { rows, hits }
}
