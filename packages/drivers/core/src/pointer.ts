// What the pointer did, as bytes a program reads — and the one place the
// off-by-one lives.
//
// A wheel turn is a pointer report with a particular button on it, so the
// encoder is shared: `wheel.ts` says which button a turn is and this says how
// any of them is written down. Two encoders would be two chances to get the
// same sum wrong, and the symptom is not a click that misses — a report in
// the wrong encoding is characters typed into the program.

/** How a program asked to be told about the pointer. */
export type WheelEncoding = 'sgr' | 'legacy'

/**
 * How much of the pointer a lane asked for, and so how much it is handed.
 *
 * - `nobody`: it never asked. Every press over it is the window's, which is
 *   every shell and every agent that prints its conversation.
 * - `press`: presses and releases, and nothing about movement. A drag over it
 *   is still the window's to select text with.
 * - `drag`: presses, releases and movement with a button held, so it selects
 *   for itself and the window keeps out of the way.
 *
 * A program that asked to be told about movement with *no* button held is
 * `drag` too: the window never sends that, because the pointer crosses a pane
 * far faster than the window draws and each report is a write and a repaint,
 * and because the window's own hover — the shape of the pointer, a button
 * lighting under it — is drawn from those same moves and both cannot have
 * them. What such a program wanted the moves for it finds out on the press.
 */
export type LanePointing = 'nobody' | 'press' | 'drag'

/** Which button, counting as the wire counts them. */
export type PointerButton = 'left' | 'middle' | 'right'

/**
 * One thing the pointer did over a lane: pressed a button, moved with one
 * held, or let go.
 *
 * `column` and `row` are zero-based cells of the lane's own screen, never of
 * the window: what the program draws it draws in its own corner, and a report
 * in the window's coordinates would land on whatever is that far across the
 * whole terminal.
 */
export interface PointerReport {
  did: 'press' | 'drag' | 'release'
  button: PointerButton
  column: number
  row: number
  shift?: boolean
  alt?: boolean
  ctrl?: boolean
}

/** What the wire calls each button. */
const BUTTON = { left: 0, middle: 1, right: 2 } as const
/** Added to the button for a report about movement rather than a press. */
const MOVING = 32
const SHIFT = 4
const ALT = 8
const CTRL = 16

/**
 * One report, as the program asked to be told.
 *
 * `released` only changes the letter under `sgr`, which is what makes that
 * encoding worth asking for: the old one says a button was let go and never
 * which, so a program reading it has to remember what went down.
 */
export function reportBytes(
  button: number,
  column: number,
  row: number,
  encoding: WheelEncoding,
  released = false,
): Uint8Array {
  // Cells count from one on the wire, and from zero everywhere in Tade.
  const x = Math.max(0, Math.trunc(column)) + 1
  const y = Math.max(0, Math.trunc(row)) + 1
  const said =
    encoding === 'sgr'
      ? `\x1b[<${button};${x};${y}${released ? 'm' : 'M'}`
      : // The old encoding carries each number as one byte offset by a space,
        // so nothing past 223 can be said at all. A report off the edge of
        // what it can say would land somewhere else on the screen, which is
        // worse than not sending it: it is clamped to the last cell it can.
        // And it has no way to say which button was let go: 3 is the whole of
        // what it can say about a release.
        `\x1b[M${String.fromCharCode(32 + (released ? 3 : button), 32 + Math.min(x, 223), 32 + Math.min(y, 223))}`
  return new TextEncoder().encode(said)
}

/**
 * The bytes for one thing the pointer did, or nothing at all where the lane
 * did not ask for that much — a drag reported to a program that asked only
 * about presses is movement it never wanted and cannot read.
 *
 * Nothing for `nobody` either, so a caller need not check first.
 */
export function pointerBytes(
  report: PointerReport,
  encoding: WheelEncoding,
  pointing: LanePointing,
): Uint8Array {
  if (pointing === 'nobody') return new Uint8Array()
  if (report.did === 'drag' && pointing !== 'drag') return new Uint8Array()
  const modifiers = (report.shift ? SHIFT : 0) + (report.alt ? ALT : 0) + (report.ctrl ? CTRL : 0)
  const button = BUTTON[report.button] + (report.did === 'drag' ? MOVING : 0) + modifiers
  return reportBytes(button, report.column, report.row, encoding, report.did === 'release')
}
