import { isText } from '@tade/core'
import { expect } from 'vitest'
import type { Frame } from '../src/frame.ts'
import type { AppState } from '../src/model.ts'
import { PLAIN } from '../src/skin.ts'
import { draw } from '../src/view.ts'
import { frame } from './screens/scenarios/fixtures.ts'

// Text Tade did not write, drawn: nothing in it reaches the terminal as
// anything but words. What the two tests beside this file share —
// `outside-text.test.ts` for what arrives from outside, and
// `outside-text-window.test.ts` for the rest of the window it is drawn in.
//
// Each surface there is handed what an outsider could put in the field it
// draws — a ticket's id and body, an agent's title, a model's answer — wrapped
// in everything a terminal reads as an instruction, and the screen it comes
// out on is searched for any of it. The words between the escapes must still
// be there, or the test would pass on a surface that drew nothing at all.

/** Everything a terminal reads as an instruction, and no words of its own. */
export const BEFORE = [
  '\x1b]0;pwned\x07', // OSC: the window's title
  '\x1b[2J\x1b[H', // CSI: clear the screen, cursor home
  '\x1b[?1049h', // CSI: the alternate screen
  '\x1b]52;c;cm0gLXJmIH4=\x1b\\', // OSC: the clipboard, ended by ST
  '\u009b6n', // eight-bit CSI: ask where the cursor is
  '\u009d2;pwned\u009c', // eight-bit OSC, ended by the eight-bit ST
  '\u0085\u008d\u0090q\u009c', // C1: next line, reverse index, a device string
  '\x1bP+q544e\x1b\\', // DCS
  '\x1b]8;;https://evil.example\x1b\\', // a link whose words lie about where it goes
  '‮', // reorder what follows
  '\x07\x08\x00\t',
].join('')
export const AFTER = '\x1b[31m\x1b]8;;\x07\u009b?25l\x1b' // a colour, a link closed, the cursor hidden, a bare ESC

/** `word`, as somebody who wanted to drive the terminal would send it. */
export const hostile = (word: string) => `${BEFORE}${word}${AFTER}`

/** Every code point in a string that is not text. */
export const notText = (said: string): number[] =>
  [...said].map((one) => one.codePointAt(0) ?? 0).filter((point) => !isText(point))

/**
 * What a drawing left on the screen that is not text, which must be nothing.
 *
 * The plain skin paints nothing, so what is left is the terminal library's
 * own: the reset after a cut (`…`), and the empty link an overlay closes with
 * — never one with an address. Anything else came from outside.
 */
export function expectOnlyText(drawn: { rows: readonly string[] }, ...words: string[]): void {
  const screen = drawn.rows.join('\n')
  const text = screen.replaceAll('\x1b[0m', '').replaceAll('\x1b]8;;\x07', '')
  expect(text).not.toContain('\x1b')
  expect(text).not.toContain('pwned')
  expect(notText(text.replaceAll('\n', ''))).toEqual([])
  for (const word of words) expect(screen).toContain(word)
}

export const see = (state: AppState, over: Partial<Frame> = {}) =>
  draw(state, frame({ skin: PLAIN, width: 160, height: 60, ...over }))
