import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { oneColumn, widthOf } from '../src/width.ts'

// Tade's own width fast path, held against the only answer it is allowed to
// give: pi-tui's.
//
// `widthOf` exists because `visibleWidth`'s own fast path stops at the first
// byte above `~`, and Tade's chrome is box drawing and braille — so the rows
// the window animates fall through to grapheme segmentation every frame. It
// buys that back by knowing the glyphs Tade draws, and it is only worth having
// while it cannot be wrong, which is what these four hold:
//
// - the rows: every line of every golden screen, measured both ways;
// - the table: every codepoint it claims, measured alone, doubled and with
//   neighbours, because a width is only a width if nothing clusters;
// - the chrome: every glyph the goldens contain is one the table knows, which
//   is what keeps the fast path *fast* as the window gains glyphs;
// - everything else: handed over, and whatever pi-tui says is the answer.
//
// The first is also where a drift shows up when pi-tui is upgraded: the escape
// sequences it skips are the ones `escapeAt` copies, and a golden row is full
// of them.

const SCREENS = fileURLToPath(new URL('./screens/__screens__', import.meta.url))

/** Every line of every golden screen: what the window actually draws. */
function drawn(): string[] {
  const rows: string[] = []
  for (const file of readdirSync(SCREENS)) {
    for (const row of readFileSync(`${SCREENS}/${file}`, 'utf8').split('\n')) {
      if (row.length > 0) rows.push(row)
    }
  }
  return rows
}

/** The codepoints the table says are one column. */
function claimed(): number[] {
  const codes: number[] = []
  for (let code = 0x80; code <= 0x10ffff; code++) if (oneColumn(code)) codes.push(code)
  return codes
}

describe('measuring a row Tade drew', () => {
  it('agrees with pi-tui on every line of every screen', () => {
    const rows = drawn()
    expect(rows.length).toBeGreaterThan(1_000)
    const apart = rows.filter((row) => widthOf(row) !== visibleWidth(row))
    expect(apart.slice(0, 3)).toEqual([])
  })

  it('is one column for every codepoint it says is one column', () => {
    const codes = claimed()
    // A glyph can be a column on its own and not be one in a row: `Intl`
    // groups a base and its marks into one grapheme, and then two codepoints
    // are one column between them. So each is asked three ways, and anything
    // that clusters is not in the table.
    const wrong = codes.filter((code) => {
      const glyph = String.fromCodePoint(code)
      return (
        visibleWidth(glyph) !== 1 ||
        visibleWidth(glyph + glyph) !== 2 ||
        visibleWidth(`x${glyph}x`) !== 3
      )
    })
    expect(wrong.map((code) => `U+${code.toString(16).toUpperCase()}`)).toEqual([])
    // And the table is a table of Tade's glyphs, not of Unicode: if it ever
    // claims most of the plane, something has been widened by guessing.
    expect(codes.length).toBeLessThan(3_000)
  })

  it('knows every glyph the window draws', () => {
    const unknown = new Set<string>()
    for (const row of drawn()) {
      for (const glyph of row) {
        const code = glyph.codePointAt(0) ?? 0
        if (code > 0x7f && !oneColumn(code)) unknown.add(glyph)
      }
    }
    // A glyph missing here is not a wrong width — `widthOf` hands an unknown
    // row to pi-tui and gets the right answer. It is a row that goes the slow
    // way every frame. So: add it to `GLYPHS` in `width.ts`, and that is all.
    expect(
      [...unknown],
      `${unknown.size} glyph(s) the window draws are not in the table in width.ts`,
    ).toEqual([])
  })

  it('hands anything else to pi-tui and says what it says', () => {
    const others = [
      '', // nothing at all
      'plain ascii', // the path pi-tui already had
      'a\tb', // a tab, which pi-tui calls three columns and a terminal does not
      '\x1b[1;31mred\x1b[0m', // the styling every painted row is made of
      '\x1b]8;;https://example.com\x07link\x1b]8;;\x07', // an OSC-8 hyperlink
      '\x1b_tade\x1b\\marked', // an APC sequence, the cursor marker's shape
      '\x1b[2Amoved', // a cursor move pi-tui does not skip
      '\x1b[unfinished', // an escape that never ends
      'ha\x07lf', // a bare BEL, which is no sequence at all
      '日本語', // two columns a character
      `e${String.fromCodePoint(0x0301)}clair`, // a combining mark: two codepoints, one column
      `a${String.fromCodePoint(0x200b)}b`, // a zero-width space, which is none
      '🙂 done', // outside the plane, and wide
      '👍🏽', // an emoji with a modifier, which is one grapheme
      '🇬🇧', // two regional indicators, which are also one
      '━┫⠋ working', // and Tade's own, for the contrast
    ]
    expect(others.map((text) => widthOf(text))).toEqual(others.map((text) => visibleWidth(text)))
  })
})
