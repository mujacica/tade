import { describe, expect, it } from 'vitest'
import { COLOUR, contrast, inkOn, type Look, PLAIN } from '../src/skin.ts'

// What can be read, and what cannot.
//
// A label on a ground is either legible or it is not, and that is arithmetic
// rather than taste — so it is checked here rather than left to whoever draws
// the next button. The number is WCAG's 4.5:1 for ordinary text, which every
// painted control in the window has to clear against its own ground.
//
// This is the test that would have caught the white label on the muted green
// at 4.1:1, which nothing did for as long as each look wrote its own ink down.

/** Every look a button or a chip can wear. */
const LOOKS: readonly Look[] = [
  'rest',
  'hover',
  'pressed',
  'primary',
  'attention',
  'go',
  'danger',
  'off',
  'add',
]

// Escape sequences are written rather than typed, the way the screen tests
// write them: a literal escape inside a regular expression is a control
// character, which the linter turns down for good reasons of its own.
const ESC = String.fromCharCode(27)
const GROUND = new RegExp(`${ESC}\\[48;5;(\\d+)m`)
const INK = new RegExp(`${ESC}\\[38;5;(\\d+)m`)
const ANY = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')

/** The ground and the ink a painted block came out with, read back off it. */
function painted(drawn: string): { ground: number; ink: number } {
  const ground = drawn.match(GROUND)
  const ink = drawn.match(INK)
  expect(ground, drawn).not.toBeNull()
  expect(ink, drawn).not.toBeNull()
  return { ground: Number(ground?.[1]), ink: Number(ink?.[1]) }
}

describe('what a label is painted with', () => {
  it('measures the tones it is given', () => {
    // White on black is the whole range, and a tone against itself is none.
    expect(contrast(231, 16)).toBeCloseTo(21, 1)
    expect(contrast(214, 214)).toBeCloseTo(1, 5)
    // The grey ramp and the colour cube are both read, and either way round.
    expect(contrast(250, 233)).toBeCloseTo(contrast(233, 250), 10)
  })

  it('puts dark ink on a bright ground and light ink on a dark one', () => {
    expect(inkOn(231)).toBe(233)
    expect(inkOn(214)).toBe(233)
    expect(inkOn(236)).toBe(231)
    expect(inkOn(238)).toBe(231)
  })

  it.each(LOOKS)('reads on its own ground: %s', (look) => {
    for (const lit of [false, true]) {
      const { ground, ink } = painted(COLOUR.button('Label', look, lit))
      // `off` is the exception the skin writes down: a control that cannot be
      // pressed is meant to be hard to read, and is the one look excused.
      if (look === 'off') {
        expect(contrast(ground, ink)).toBeLessThan(4.5)
        continue
      }
      expect(contrast(ground, ink), `${look}${lit ? ' lit' : ''}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('takes the ink the ground gives it, unless the look says otherwise', () => {
    for (const look of LOOKS) {
      const { ground, ink } = painted(COLOUR.button('Label', look))
      // Two looks name their own ink and both say why: `off` is meant to be
      // unreadable, and `add`'s label is the amber signal rather than ink.
      if (look === 'off' || look === 'add') continue
      expect(ink, look).toBe(inkOn(ground))
    }
  })

  it('paints the three buttons along the bottom the way the window means them', () => {
    // Extensions and Settings are the same kind of thing and are drawn the
    // same: one grey, one ink, one weight.
    const extensions = painted(COLOUR.button('Extensions', 'rest'))
    const settings = painted(COLOUR.button('Settings', 'rest'))
    expect(extensions).toEqual(settings)
    // The sound button is the stop-and-go pair, dark letters on both.
    const mute = painted(COLOUR.button('Mute', 'danger'))
    const unmute = painted(COLOUR.button('Unmute', 'go'))
    expect(mute.ink).toBe(233)
    expect(unmute.ink).toBe(233)
    expect(mute.ground).not.toBe(unmute.ground)
    // And they are a pair: near enough the same weight to read as two halves
    // of one control rather than as two buttons from different designs.
    expect(Math.abs(contrast(mute.ground, 233) - contrast(unmute.ground, 233))).toBeLessThan(5)
  })

  it('draws the same columns with colour and without', () => {
    for (const look of LOOKS) {
      const plain = PLAIN.button('Label', look)
      const bare = COLOUR.button('Label', look).replaceAll(ANY, '')
      expect(bare.length, look).toBe(plain.length)
    }
  })
})
