import { printable, printableLines } from '@tade/core'
import type { Hit } from '../hits.ts'
import type { Skin } from '../skin.ts'
import { Row } from '../ui.ts'
import { widthOf } from '../width.ts'

// What an approval card says it wants to run.
//
// A person saying yes to a command they cannot see all of is what an approval
// exists to prevent, and that yes may come from somebody glancing at a corner
// of the window. So a card draws the whole command: read `'whole'`
// (`printable`), so a character that is not text is a mark and never taken
// out with whatever it hid; its own line breaks kept, because a line break in
// a command is a second command; and wrapped under itself rather than cut at
// the card's edge. Only where the room runs out is it cut, and then its last
// row says how much is not shown.
//
// The pane's card and the toast both draw it from here, and the pane's card is
// as tall as what it holds: `cardRows` is how much of the agent's screen it
// takes, which `rowsRead` takes off the screen for the drawing and the look
// alike.

/** The widest a card over an agent's screen is drawn. */
const WIDEST = 64
/** Narrower than this, a card is not drawn over the agent's screen at all. */
const NARROWEST = 30
/** A card's rows besides what it says: its border's two, and the buttons. */
const CHROME = 3

export interface Approval {
  tool: string
  summary: string
  /**
   * Characters of the command the machine that holds it did not send (another
   * machine's card, `machines.ts`): counted with what the room here cut, so the
   * last row never says the command is whole when it is not.
   */
  notShown?: number
}

/** How wide a card over an agent's screen `width` wide is, or null where none fits. */
export function cardWidth(width: number): number | null {
  const card = Math.min(width - 4, WIDEST)
  return card < NARROWEST ? null : card
}

/**
 * How many rows of an agent's screen `width` wide and `body` tall a card
 * takes: its own and the one under it.
 *
 * A screen too narrow to draw one over still gives up the rows a card of one
 * line would take, as it always has.
 */
export function cardRows(approval: Approval, width: number, body: number): number {
  const card = cardWidth(width)
  const said = card === null ? 1 : approvalLines(approval, card - 2, mostOver(body)).length
  return CHROME + said + 1
}

/**
 * The most rows of what it wants to run a card over a screen `body` tall
 * draws: whatever leaves a row of the screen showing above it.
 */
export function mostOver(body: number): number {
  return Math.max(1, body - CHROME - 2)
}

/**
 * The tool and the whole command, as the rows of a card `inner` wide — no
 * more than `most` of them, the last saying how much is not shown where it
 * did not all fit.
 */
export function approvalRows(
  approval: Approval,
  inner: number,
  most: number,
  skin: Skin,
): { text: string; hits: Hit[] }[] {
  return approvalLines(approval, inner, most).map((line) => {
    const row = new Row(inner, skin).space(line.lead)
    if (line.tool) row.text(line.tool, skin.you).space(2)
    if (line.notShown > 0) {
      const count = `${line.notShown} character${line.notShown === 1 ? '' : 's'}`
      return row.text(`… ${count} not shown`, skin.hint).build()
    }
    return row.text(line.text).build()
  })
}

/** One row of what a card says: where it starts, and the tool on the first. */
interface Line {
  lead: number
  tool: string
  text: string
  /** Characters of the command after the last row drawn, on the row that says so. */
  notShown: number
}

/**
 * The rows a card `inner` wide says what it wants to run in.
 *
 * The command beside the tool and wrapped under itself; where the tool's name
 * would leave it less than half the card, the tool on a row of its own and the
 * command under it.
 */
function approvalLines(approval: Approval, inner: number, most: number): Line[] {
  const tool = printable(approval.tool)
  const beside = 1 + widthOf(tool) + 2
  const alone = beside > inner / 2
  const lead = alone ? 3 : beside
  const room = Math.max(1, most - (alone ? 1 : 0))
  const { rows, notShown } = wrapped(
    printableLines(approval.summary, 'whole'),
    inner - lead,
    room,
    approval.notShown ?? 0,
  )
  const lines: Line[] = rows.map((text, i) => ({
    lead: i === 0 && !alone ? 1 : lead,
    tool: i === 0 && !alone ? tool : '',
    text,
    notShown: 0,
  }))
  if (notShown > 0) lines.push({ lead, tool: '', text: '', notShown })
  if (alone) lines.unshift({ lead: 1, tool, text: '', notShown: 0 })
  // The tool on the first row even where nothing of the command fit beside it.
  const first = lines[0]
  if (first && !alone && first.tool === '') lines[0] = { ...first, lead: 1, tool }
  return lines
}

/**
 * Text in rows of a width, every character kept — a space is part of a
 * command — broken after a space past half way where there is one, and at
 * each of its own line breaks. No more than `most` rows; where the text did
 * not fit, or `sent` says it was cut before it got here, a row is kept for
 * saying so, and how many characters were left over.
 */
function wrapped(
  text: string,
  width: number,
  most: number,
  sent = 0,
): { rows: string[]; notShown: number } {
  const points = [...text]
  const rows: string[] = []
  let at = 0
  while (at < points.length && rows.length < most) {
    const start = at
    let used = 0
    let space = -1
    while (at < points.length && points[at] !== '\n') {
      const one = points[at] ?? ''
      const columns = widthOf(one)
      if (used + columns > width && at > start) break
      used += columns
      at += 1
      if (one === ' ') space = at
    }
    const cut = at < points.length && points[at] !== '\n'
    if (cut && space > start + (at - start) / 2) at = space
    rows.push(points.slice(start, at).join(''))
    if (points[at] === '\n') at += 1
  }
  const left = (from: number) => points.slice(from).filter((one) => one !== '\n').length
  if (left(at) === 0 && sent === 0) return { rows, notShown: 0 }
  if (left(at) === 0 && rows.length < most) return { rows, notShown: sent }
  // The last row gives way to the one that says how much is not shown.
  const dropped = rows.pop() ?? ''
  return { rows, notShown: left(at) + [...dropped].length + sent }
}
