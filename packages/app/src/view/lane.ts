import {
  compositeTuiLine,
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { Hit } from '../hits.ts'
import type { AppState } from '../model.ts'
import type { Skin } from '../skin.ts'
import { type Pointer, Row } from '../ui.ts'

// A lane's screen, wherever it is drawn.
//
// The middle of the window draws an agent's screen and the panel along the
// bottom draws a terminal's, and they are the same thing: a capture of what a
// program painted, with the cursor laid under a cell of it, a bar saying how
// far back it is scrolled, and the window's own answer to where what you type
// goes. Both regions reach for these, so they are neither's to keep.

/**
 * The cursor, as a terminal draws it: one cell laid under what is on it, so
 * you can see where typing will land and what it will land on.
 *
 * Put in place after the rows are drawn rather than while they are, because it
 * belongs to the lane's own screen and the rows are what a capture says that
 * screen held — and off the rows it is simply not drawn, which is what a
 * screen scrolled back from the cursor should look like.
 */
export function blockAt(
  rows: { text: string; hits: Hit[] }[],
  row: number,
  column: number,
  width: number,
  skin: Skin,
): void {
  const on = rows[row]
  if (!on || row < 0 || column < 0 || column >= width) return
  const under = stripTerminalSequences(sliceByColumn(on.text, column, 1, true))
  // A cell holding half of a wide character is not a cell a block fits in.
  if (visibleWidth(under) > 1) return
  rows[row] = {
    ...on,
    text: compositeTuiLine(on.text, skin.cursor(under === '' ? ' ' : under), column, 1, width),
  }
}

/**
 * Where what you type goes. The orchestrator's line takes it the moment it is
 * open, and a panel while one is up; otherwise it is the pane or the terminal,
 * whichever was last clicked into.
 */
export function typingIn(state: AppState): 'pane' | 'terminal' | null {
  if (state.panel || state.dictation !== null || state.listening) return null
  return state.keyboard
}

/** The last row of a screen scrolled back: how far, and the way to the newest line. */
export function scrolledBar(
  lines: number,
  action: string,
  width: number,
  skin: Skin,
  pointer: Pointer,
): { text: string; hits: Hit[] } {
  return new Row(width, skin, pointer)
    .text(`── ↑ ${lines} line${lines === 1 ? '' : 's'} back `, skin.chrome)
    .right((r) => r.button('↓ newest', { kind: 'action', name: action }).space())
    .build()
}
