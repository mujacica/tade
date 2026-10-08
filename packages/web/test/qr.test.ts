import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { blocksFor, type Code, codeFor, QUIET, rectsFor, sideWithQuiet } from '../src/qr.ts'

// The encoding, checked by **a decoder somebody else wrote**.
//
// This is the only thing a test on this machine can prove about a QR code, and
// it is worth proving: an encoder that is subtly wrong serves a code that looks
// exactly right on screen and silently does not scan, and there is no assertion
// about our own output that would catch it — a golden matrix compared with
// itself passes for ever.
//
// `jsqr` is a **devDependency** (Apache-2.0, pure JavaScript, no dependencies
// of its own) and never reaches the published tarball: `depsFor` in
// `scripts/release/stage.ts` leaves devDependencies out entirely. It is a
// different codebase from `qrcode-generator`, which is the whole of why it is
// evidence rather than a tautology.
//
// **What this still cannot prove** is the optics: whether the code scans with a
// real camera at the module size a terminal draws. That is a real phone's
// answer and is recorded as outstanding rather than ticked.

const require = createRequire(import.meta.url)
// biome-ignore lint/suspicious/noExplicitAny: a UMD build with no ESM entry.
const decoder = require('jsqr') as any
const decode = (decoder.default ?? decoder) as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string } | null

/**
 * The code as the pixels a decoder reads: black modules on white, with the
 * quiet zone, at four device pixels per module.
 *
 * Four rather than one, because a decoder locating finder patterns in a
 * 33×33 image is being asked to do the hardest version of its job for no
 * reason — the question here is whether the *encoding* is right.
 */
function pixels(code: Code, scale = 4): { data: Uint8ClampedArray; side: number } {
  const modules = sideWithQuiet(code)
  const side = modules * scale
  const data = new Uint8ClampedArray(side * side * 4).fill(255)
  for (let row = 0; row < code.side; row++) {
    for (let column = 0; column < code.side; column++) {
      if (code.modules[row]?.[column] !== true) continue
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const at = (((row + QUIET) * scale + y) * side + (column + QUIET) * scale + x) * 4
          data[at] = 0
          data[at + 1] = 0
          data[at + 2] = 0
        }
      }
    }
  }
  return { data, side }
}

/** What an independent decoder read out of our own encoding. */
function roundTrip(text: string): string | null {
  const code = codeFor(text)
  if (code === null) return null
  const { data, side } = pixels(code)
  return decode(data, side, side)?.data ?? null
}

describe('a pairing URL survives a round trip through another codebase', () => {
  it('decodes back to exactly what went in', () => {
    const url = `http://192.168.1.10:7654/pair#t=${'k7Qx'.repeat(6)}abc`
    expect(roundTrip(url)).toBe(url)
  })

  it('decodes every address the pairing panel could print', () => {
    for (const base of [
      'http://127.0.0.1:7654/pair',
      'http://192.168.1.10:7654/pair',
      'http://studio.local:7654/pair',
      'https://studio.yak-bebop.ts.net/pair',
      // The longest realistic one: a tailnet name is the long case and the
      // ticket is 27 characters on top of it.
      'https://a-very-long-machine-name.tail9f3b21.ts.net/pair',
    ]) {
      const url = `${base}#t=${'A1b2C3d4E5f6G7h8I9j0K1l2M3n'}`
      expect(roundTrip(url), url).toBe(url)
    }
  })

  it('decodes a URL with every character a ticket can contain', () => {
    // base64url: the two that are not alphanumeric are `-` and `_`, and both
    // are byte-mode characters a wrong encoder could mangle.
    const url = 'http://192.168.1.10:7654/pair#t=aA0-_zZ9aA0-_zZ9aA0-_zZ9aA0'
    expect(roundTrip(url)).toBe(url)
  })

  it('decodes a short string and a long one, across versions', () => {
    for (const text of ['a', 'x'.repeat(100), 'y'.repeat(300)])
      expect(roundTrip(text), `${text.length} characters`).toBe(text)
  })
})

describe('the code itself', () => {
  it('picks the smallest version that fits, so the modules stay coarse', () => {
    const small = codeFor('http://127.0.0.1:7654/pair#t=A')
    const large = codeFor('x'.repeat(300))
    expect(small).not.toBeNull()
    expect(large).not.toBeNull()
    // A coarse code is one a camera reads; a smaller version is a coarser one.
    expect(small?.side).toBeLessThan(large?.side ?? 0)
    // Every version is 4n+17 modules on a side.
    for (const code of [small, large]) expect(((code?.side ?? 0) - 17) % 4).toBe(0)
  })

  it('is square, and is every module', () => {
    const code = codeFor('http://192.168.1.10:7654/pair#t=A')
    expect(code?.modules).toHaveLength(code?.side ?? 0)
    for (const row of code?.modules ?? []) expect(row).toHaveLength(code?.side ?? 0)
  })

  it('has the three finder patterns, which is what a camera looks for first', () => {
    const code = codeFor('http://192.168.1.10:7654/pair#t=A')
    if (code === null) throw new Error('nothing encoded')
    // A 7×7 square with a 5×5 light ring and a 3×3 dark centre, in three
    // corners. Checked because it is the one structural property whose absence
    // means "a camera will never find this" rather than "one bit is wrong".
    for (const [top, left] of [
      [0, 0],
      [0, code.side - 7],
      [code.side - 7, 0],
    ] as const) {
      expect(code.modules[top]?.[left], `${top},${left}`).toBe(true)
      expect(code.modules[top + 1]?.[left + 1], `${top},${left} ring`).toBe(false)
      expect(code.modules[top + 3]?.[left + 3], `${top},${left} centre`).toBe(true)
    }
  })

  it('has the timing patterns, which are how a scanner finds the module grid', () => {
    const code = codeFor('http://192.168.1.10:7654/pair#t=A')
    if (code === null) throw new Error('nothing encoded')
    // Row 6 and column 6 alternate dark and light between the finder
    // patterns, starting dark. Together with the three finders above this is
    // the whole of the structure a camera uses before it reads a single bit,
    // and it is exactly the part a hand-rolled encoder gets subtly wrong.
    //
    // The fourth corner is deliberately **not** asserted: there is an
    // alignment pattern near it whose dark centre and light ring look like a
    // finder at three sample points, so a "no fourth finder" assertion there
    // is a coin toss dressed as a rule.
    for (let at = 8; at < code.side - 8; at++) {
      expect(code.modules[6]?.[at], `row 6, column ${at}`).toBe(at % 2 === 0)
      expect(code.modules[at]?.[6], `column 6, row ${at}`).toBe(at % 2 === 0)
    }
  })

  it('answers null rather than throwing for something that will not fit', () => {
    // The caller is a panel being drawn. An address that is somehow too long
    // is a line of text saying so, not a window that fell over.
    expect(codeFor('')).toBeNull()
    expect(codeFor('x'.repeat(100_000))).toBeNull()
  })
})

describe('drawing it', () => {
  it('is half-block rows for a terminal, with the quiet zone included', () => {
    const code = codeFor('http://192.168.1.10:7654/pair#t=A')
    if (code === null) throw new Error('nothing encoded')
    const rows = blocksFor(code)
    const side = sideWithQuiet(code)
    // Two module rows per line, so the drawing is about as wide as it is tall
    // in a terminal whose cells are twice as tall as they are wide.
    expect(rows).toHaveLength(Math.ceil(side / 2))
    for (const row of rows) expect([...row]).toHaveLength(side)
    // The first and last rows are quiet zone: a code drawn hard against a dark
    // panel is one whose finder patterns a camera cannot find.
    expect(rows[0]?.trim()).toBe('')
    expect(rows.at(-1)?.trim()).toBe('')
    for (const row of rows) expect(row.slice(0, QUIET)).toBe(' '.repeat(QUIET))
  })

  it('is rectangles in module units for a page, and no markup', () => {
    const code = codeFor('http://192.168.1.10:7654/pair#t=A')
    if (code === null) throw new Error('nothing encoded')
    const rects = rectsFor(code)
    const dark = code.modules.flat().filter((one) => one).length
    expect(rects).toHaveLength(dark)
    // Offset by the quiet zone and inside the viewBox: the page builds the
    // elements itself, because nothing in the client touches `innerHTML`.
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(QUIET)
      expect(rect.y).toBeGreaterThanOrEqual(QUIET)
      expect(rect.x).toBeLessThan(sideWithQuiet(code))
      expect(rect.y).toBeLessThan(sideWithQuiet(code))
    }
  })

  it('draws the same grid either way, so the two cannot disagree', () => {
    const code = codeFor('http://192.168.1.10:7654/pair#t=A')
    if (code === null) throw new Error('nothing encoded')
    const rows = blocksFor(code)
    for (const { x, y } of rectsFor(code)) {
      const glyph = [...(rows[Math.floor(y / 2)] ?? '')][x]
      const half = y % 2 === 0 ? ['█', '▀'] : ['█', '▄']
      expect(half, `${x},${y} drew ${String(glyph)}`).toContain(glyph)
    }
  })
})
