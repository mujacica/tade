import { describe, expect, it } from 'vitest'
import {
  type LanePointing,
  type PointerReport,
  pointerBytes,
  type WheelEncoding,
} from '../src/pointer.ts'

// The one place a press becomes bytes. Worth its own test for the same reason
// the wheel is: the failure is not a click that lands a cell out, it is
// characters typed into somebody's program.

const said = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const at = (did: PointerReport['did'], over: Partial<PointerReport> = {}): PointerReport => ({
  did,
  button: 'left',
  column: 4,
  row: 2,
  ...over,
})
const to = (
  report: PointerReport,
  pointing: LanePointing = 'drag',
  encoding: WheelEncoding = 'sgr',
) => said(pointerBytes(report, encoding, pointing))

describe('what the pointer did, as bytes', () => {
  it('counts cells from one on the wire, and from zero everywhere in Tade', () => {
    expect(to(at('press'))).toBe('\x1b[<0;5;3M')
  })

  it('says which button, as the wire counts them', () => {
    expect(to(at('press', { button: 'middle' }))).toBe('\x1b[<1;5;3M')
    expect(to(at('press', { button: 'right' }))).toBe('\x1b[<2;5;3M')
  })

  // Movement is the button it is holding, counted 32 higher. A drag reported
  // as a press is a program told it was clicked on every cell crossed.
  it('says movement apart from a press', () => {
    expect(to(at('drag'))).toBe('\x1b[<32;5;3M')
    expect(to(at('drag', { button: 'right' }))).toBe('\x1b[<34;5;3M')
  })

  // The whole reason a program asks to be told this way rather than the old
  // way: a release that says which button it was.
  it('says a release as the same button, in the letter', () => {
    expect(to(at('release'))).toBe('\x1b[<0;5;3m')
    expect(to(at('release', { button: 'right' }))).toBe('\x1b[<2;5;3m')
  })

  it('carries the keys that were held, which a program reads as its own shortcuts', () => {
    expect(to(at('press', { shift: true }))).toBe('\x1b[<4;5;3M')
    expect(to(at('press', { alt: true, ctrl: true }))).toBe('\x1b[<24;5;3M')
  })

  // Only ever as much as the program asked for, decided here rather than in
  // each driver: one that wants presses and no movement is answered the same
  // way by every driver instead of by whichever one remembered to check.
  it('sends nothing at all to a lane that never asked', () => {
    expect(to(at('press'), 'nobody')).toBe('')
    expect(to(at('release'), 'nobody')).toBe('')
  })

  it('sends a lane that asked only about presses no movement, and its release', () => {
    expect(to(at('drag'), 'press')).toBe('')
    expect(to(at('press'), 'press')).toBe('\x1b[<0;5;3M')
    expect(to(at('release'), 'press')).toBe('\x1b[<0;5;3m')
  })

  it('says the same thing the old way for a program that asked the old way', () => {
    // Each number a byte, offset by a space: button 0, column 5, row 3.
    expect(to(at('press'), 'drag', 'legacy')).toBe('\x1b[M \x25\x23')
    // The old encoding has no way to say which button was let go: 3 is all of
    // what it can say about a release, and a program reading it has to
    // remember what it saw go down.
    expect(to(at('release', { button: 'right' }), 'drag', 'legacy')).toBe('\x1b[M#\x25\x23')
  })

  it('stops at the last cell the old encoding can name, rather than wrapping', () => {
    expect(to(at('press', { column: 400, row: 400 }), 'drag', 'legacy')).toBe(
      `\x1b[M${String.fromCharCode(32, 32 + 223, 32 + 223)}`,
    )
  })
})
