import type { WheelTurn } from './port.ts'

// What a turn of the wheel is, as bytes a program reads.
//
// Every driver that can hand a lane the pointer needs exactly this, and two
// of them writing it would be two chances to get the off-by-one wrong. It is
// pure: a turn and what the program asked for in, the bytes it reads out.
//
// A program says how it wants to be told when it turns mouse reporting on,
// and the two encodings are not compatible — bytes in the wrong one are not
// a scroll that misses, they are characters typed into it. So the encoding is
// never assumed: it comes from what the driver watched the program ask for.

/** How a program asked to be told about the pointer. */
export type WheelEncoding = 'sgr' | 'legacy'

/** Which button a wheel is, counting up from the first: up, then down. */
const UP = 64
const DOWN = 65

/**
 * The bytes for one turn of the wheel, one report per row.
 *
 * A report says a wheel moved, not how far — how far is the program's own —
 * so `rows` rows is `rows` reports, and a lane that scrolls itself moves at
 * the rate everything else in the window moves at.
 *
 * Nothing at all for a turn of nothing, so a caller need not check first.
 */
export function wheelBytes(turn: WheelTurn, encoding: WheelEncoding): Uint8Array {
  const rows = Math.trunc(turn.rows)
  if (rows === 0) return new Uint8Array()
  const button = rows < 0 ? UP : DOWN
  // Cells count from one on the wire, and from zero everywhere in Tade.
  const column = Math.max(0, Math.trunc(turn.column)) + 1
  const row = Math.max(0, Math.trunc(turn.row)) + 1
  const one =
    encoding === 'sgr'
      ? `\x1b[<${button};${column};${row}M`
      : // The old encoding carries each number as one byte offset by a space,
        // so nothing past 223 can be said at all. A report off the edge of
        // what it can say would land somewhere else on the screen, which is
        // worse than not sending it: it is clamped to the last cell it can.
        `\x1b[M${String.fromCharCode(32 + button, 32 + Math.min(column, 223), 32 + Math.min(row, 223))}`
  return new TextEncoder().encode(one.repeat(Math.abs(rows)))
}
