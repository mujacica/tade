import { describe, expect, it } from 'vitest'
import { wheelBytes } from '../src/wheel.ts'

// The one place a turn of the wheel becomes bytes. It is worth its own test
// because the failure is not a scroll that goes the wrong way: bytes in an
// encoding the program cannot read are characters typed into it.

const said = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe('a turn of the wheel, as bytes', () => {
  it('says up and down as the two buttons a wheel has', () => {
    expect(said(wheelBytes({ rows: -1, column: 0, row: 0 }, 'sgr'))).toBe('\x1b[<64;1;1M')
    expect(said(wheelBytes({ rows: 1, column: 0, row: 0 }, 'sgr'))).toBe('\x1b[<65;1;1M')
  })

  it('counts cells from one on the wire, and from zero everywhere in Tade', () => {
    expect(said(wheelBytes({ rows: -1, column: 4, row: 9 }, 'sgr'))).toBe('\x1b[<64;5;10M')
  })

  // A report says the wheel moved, never how far: how far is how many.
  it('is one report a row, so a lane moves as far as anything else would', () => {
    const three = said(wheelBytes({ rows: 3, column: 0, row: 0 }, 'sgr'))
    expect(three.split('\x1b').length - 1).toBe(3)
    expect(said(wheelBytes({ rows: 0, column: 0, row: 0 }, 'sgr'))).toBe('')
  })

  it('says the same thing the old way for a program that asked the old way', () => {
    // Each number a byte, offset by a space: button 64, column 5, row 3.
    expect(said(wheelBytes({ rows: -1, column: 4, row: 2 }, 'legacy'))).toBe('\x1b[M`%#')
  })

  // The old encoding simply cannot say a number past 223. A report that wrapped
  // round would land somewhere else on the screen, which is worse than one
  // that stops at the edge of what it can say.
  it('stops at the last cell the old encoding can name, rather than wrapping', () => {
    const wide = said(wheelBytes({ rows: -1, column: 400, row: 400 }, 'legacy'))
    expect(wide).toBe(`\x1b[M${String.fromCharCode(96, 32 + 223, 32 + 223)}`)
  })
})
