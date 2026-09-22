import {
  compositeTuiLine,
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { LaneView } from '../frame.ts'
import type { Hit } from '../hits.ts'
import type { AgentPane, AppState } from '../model.ts'
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

/** How tall the approval card is: its border and two rows. */
export const APPROVAL_ROWS = 4

/**
 * How many rows of a lane's screen a pane actually shows.
 *
 * Not the pane's height, which is what everything used to count: an approval
 * card sits at the bottom of the agent's own screen and takes five rows off
 * it, and a screen drawn in twenty-five rows was being measured against
 * thirty. Everything downstream is that number — the bar says how much is in
 * view, the wheel reads the end off the bar, and the look clamps how far back
 * it may read — so all three were out by the height of the card, in the same
 * direction. A screen with twenty-eight lines in it reported twenty-eight of
 * thirty shown and answered the wheel with nothing at all, which is what
 * "scrolling sometimes works and sometimes doesn't" was: the card is only
 * there while the agent is waiting on you.
 *
 * `back` is a screen scrolled away from its newest line, whose last row says
 * so and takes you back there — a row of the pane that is not a line of the
 * lane, and so one fewer in view. Left out, the bar said the end was a row
 * further than the look would allow, so the top of a scrollback answered every
 * notch by springing back a row.
 *
 * One function, because two readings of one layout drift — and this one is
 * read in two files, the drawing and the look.
 */
export function rowsRead(body: number, carded: boolean, back = false): number {
  const room = carded ? body - APPROVAL_ROWS - 1 : body
  return Math.max(1, room - (back ? 1 : 0))
}

/**
 * Whether an approval card is over the agent's screen, which is what takes
 * rows off it.
 *
 * One reading, because the drawing and the look both need it and a second one
 * would drift: the card belongs to an agent's own lane, never to a shell
 * opened beside it, and it is there only while the agent is waiting on you.
 */
export function carded(pane: AgentPane | undefined, lane: string | null): boolean {
  if (!pane?.approval) return false
  return pane.lanes.find((one) => one.id === lane)?.kind === 'agent'
}

/**
 * Whether what the pointer does inside a lane's screen is the lane's.
 *
 * Two things have to be true, and they are two different facts about the
 * lane. It has to have **taken the whole screen** (`scrolling`), because only
 * then are the rows the window drew the rows the program thinks it has —
 * anything else is a conversation drawn bottom-anchored into a region that is
 * not its screen, and a report about the wrong row is worse than none. And it
 * has to have **asked for the mouse** (`pointing`), because bytes a program
 * did not ask for it reads as somebody typing.
 *
 * The third is the window's own: it has to have the keyboard. An unfocused
 * pane answers a click the way it always has — by taking the keyboard — so
 * one click always lands in Tade, whatever the program in the lane thinks,
 * and nobody can be shut out of their own window. `typing` is that, passed in
 * rather than worked out here, so the block where typing lands and the cell a
 * press goes to can never disagree about which lane is in front.
 */
export function pointedIn(view: LaneView | null | undefined, typing: boolean): boolean {
  if (!view || !typing) return false
  return view.scrolling === 'lane' && view.pointing !== undefined && view.pointing !== 'nobody'
}

/**
 * Where a region's rows are in the program's own screen: the row the first of
 * them is, and how many of them hold a row of it at all.
 *
 * A lane is made the size of the pane and then read back in however many rows
 * are left for it — an approval card takes five — so what is on show is the
 * *bottom* of its screen and the top of it is behind the card. A report is
 * about the program's screen, so the rows are counted there: drawn row 0
 * under a card is row five of the lane, and a click told otherwise lands five
 * rows above what was pressed.
 *
 * `lines` is how far down the lane's screen the last row with anything on it
 * is, which is what the driver reports and the last row a capture returns. So
 * both of the two ways a region and a screen can be out of step are the one
 * subtraction: a screen taller than the room for it hides its top rows, and
 * one shorter leaves rows of the region holding no row of it.
 *
 * Which of the region's rows those are is the drawing's own to say and not
 * this: a pane anchors an agent's screen to its bottom and the panel along
 * the bottom anchors a terminal's to its top, so one counts back from the end
 * and the other forward from the start — of the same `rows` rows, at the same
 * `from`.
 */
export function screenRows(lines: number, shown: number): { from: number; rows: number } {
  const rows = Math.max(0, Math.min(Math.trunc(lines), Math.trunc(shown)))
  return { from: Math.max(0, Math.trunc(lines) - rows), rows }
}
