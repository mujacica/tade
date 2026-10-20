import { visibleWidth } from '@earendil-works/pi-tui'

// How many columns a row takes, when the row is one Tade drew.
//
// pi-tui's `visibleWidth` has a fast path that answers without allocating, and
// it gives up on the first byte above `~`. Tade's chrome is box drawing,
// braille spinners and the skin's own marks, so nearly every row the window
// draws — 4,568 of the 4,821 in the golden screens — misses that path and
// falls through to an ANSI-strip pass that builds a second string plus
// `Intl.Segmenter` over every grapheme. Its cache is 512 whole-string keys, so
// a row with a spinner or a figure that moved misses it every frame *and*
// evicts the rows that would have hit.
//
// So this is that fast path, widened by the glyphs Tade itself draws, and
// nothing else: anything it does not recognise is handed straight to
// `visibleWidth`, which is the only answer either of us is allowed to give.
// `test/width.test.ts` holds the two against each other over every golden
// screen — the table below cannot be wrong about a width without failing, and
// a glyph Tade draws that is not in it fails too, naming itself.
//
// **This is dearer than a cache hit and cheaper than a cache miss**, and that
// is the whole of the trade. Measured over 300 painted golden rows of up to
// 150 columns, p50 then p95, microseconds a row:
//
// | | pi-tui | here |
// |---|---|---|
// | a row nothing touched | 0.10 · 9.56 | 0.70 · 0.76 |
// | a row whose spinner moved | 1.83 · 10.92 | 0.81 · 0.93 |
//
// Half a microsecond a row given up on a row that did not change, against a
// microsecond saved on every row that did — and the 95th, which is the figure
// a frame is actually made of, bounded at under one instead of ten. The reason
// the first row's 95th is a hundred times its 50th is the eviction: a window
// with a spinner in it puts a new string in that cache every frame, and the
// rows that would have hit go out to make room for it.

/**
 * The blocks Tade draws from wholesale. Every codepoint in each is one column
 * wide, which is the property `width.test.ts` checks one at a time.
 *
 * Box drawing first because it is nine rows in ten: every divider, every frame
 * and every rule is in it.
 */
const BLOCKS: readonly (readonly [number, number])[] = [
  [0x2500, 0x25fc], // box drawing, block elements, geometric shapes
  [0x2190, 0x22ff], // arrows, and the mathematical operators beside them
  [0x2800, 0x28ff], // braille, which is every spinner frame
]

/**
 * The scattered rest, each one a glyph somewhere in the window — all of them in
 * the basic plane, which is the only place the scan below can see them.
 */
const GLYPHS = '¢§«±¶·»×–—‖‘’“”•…‹›⌕⌘⎿⏎⏺✓✕✗✻❯'

const SINGLE = new Set([...GLYPHS].map((glyph) => glyph.codePointAt(0) as number))

/**
 * One column wide, and known to be, so a row of them needs no segmenting.
 *
 * Exported for `test/width.test.ts` alone, which asks it of every codepoint
 * there is: the ones it says yes to are measured against `visibleWidth` one at
 * a time, and every glyph the golden screens contain has to be one of them.
 * Nothing branches on this — the answer either way is the same width.
 */
export function oneColumn(code: number): boolean {
  for (const [from, to] of BLOCKS) if (code >= from && code <= to) return true
  return SINGLE.has(code)
}

/**
 * The length of the escape sequence at `at`, or 0 where there is none.
 *
 * This is pi-tui's own rule and has to stay it. A sequence skipped here that
 * `visibleWidth` counts, or counted here that it skips, is a row drawn a column
 * out — so the test measures every golden row both ways rather than trusting
 * this to be a faithful copy, which is also where a drift on upgrade shows up.
 */
function escapeAt(text: string, at: number): number {
  const next = text[at + 1]
  // CSI: the styling and the cursor moves, which end at m, G, K, H or J.
  if (next === '[') {
    for (let i = at + 2; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code === 0x6d || code === 0x47 || code === 0x4b || code === 0x48 || code === 0x4a)
        return i + 1 - at
    }
    return 0
  }
  // OSC (a hyperlink) and APC (the cursor marker), which end at BEL or ST.
  if (next === ']' || next === '_') {
    for (let i = at + 2; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code === 0x07) return i + 1 - at
      if (code === 0x1b && text[i + 1] === '\\') return i + 2 - at
    }
    return 0
  }
  return 0
}

/**
 * The visible columns `text` takes, which is `visibleWidth`'s answer — reached
 * without allocating where every character in the row is one Tade knows, and
 * by asking `visibleWidth` where it is not.
 */
export function widthOf(text: string): number {
  let width = 0
  let i = 0
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (code >= 0x20 && code <= 0x7e) {
      width++
      i++
    } else if (oneColumn(code)) {
      width++
      i++
    } else if (code === 0x1b) {
      const skip = escapeAt(text, i)
      if (skip === 0) return visibleWidth(text)
      i += skip
    } else if (code === 0x09) {
      // A tab is three columns, which is pi-tui's answer and not a terminal's.
      width += 3
      i++
    } else {
      return visibleWidth(text)
    }
  }
  return width
}
