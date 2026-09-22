import { reportBytes, type WheelEncoding } from './pointer.ts'
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
  const one = reportBytes(rows < 0 ? UP : DOWN, turn.column, turn.row, encoding)
  const said = new Uint8Array(one.length * Math.abs(rows))
  for (let i = 0; i < Math.abs(rows); i++) said.set(one, i * one.length)
  return said
}
