import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { colour256, glyphAt, runsOf, THEME } from '../../web/src/assets/full-cells.js'
import { JOINED, WIDTHS } from '../../web/src/assets/full-widths.js'
import { joinedTable, points, widthTable } from '../scripts/full-widths.ts'
import { THEME as PICTURES, paintOf, colour256 as pictured, toCells } from '../scripts/terminal.ts'

// The full view paints a row as the README's pictures do (§10 T4 of the Duo
// plan): `full-cells.js` is `scripts/terminal.ts`'s SGR rules written again in
// the page's own JavaScript, because a browser cannot import a `.ts` file. So
// the two are held equal here, over every row of every golden screen the
// window draws — the rows a phone is handed are exactly these.

const SCREENS = fileURLToPath(new URL('./screens/__screens__/', import.meta.url))

/** A row as one paint a code point: what the page would draw, and what a picture is. */
function pageOf(row: string): string[] {
  return runsOf(row).flatMap((run) =>
    [...run.text].map(
      (char) => `${char}|${run.ink}|${run.ground}|${run.bold}|${run.italic}|${run.underline}`,
    ),
  )
}

function pictureOf(row: string): string[] {
  return toCells(row).flatMap((cell) => {
    if (cell.width === 0) return []
    const { ink, ground } = paintOf(cell)
    return [...cell.ch].map(
      (char) => `${char}|${ink}|${ground}|${cell.bold}|${cell.italic}|${cell.underline}`,
    )
  })
}

/** A row as the page lays it out: each glyph and the cells it is given. */
function pageCells(row: string): string[] {
  return runsOf(row).flatMap((run) => {
    if (run.wide) return [`${run.text}|2`]
    const out: string[] = []
    for (let i = 0; i < run.text.length; ) {
      const glyph = glyphAt(run.text, i)
      out.push(`${glyph}|1`)
      i += glyph.length
    }
    return out
  })
}

function pictureCells(row: string): string[] {
  return toCells(row).flatMap((cell) => (cell.width === 0 ? [] : [`${cell.ch}|${cell.width}`]))
}

/** Every code point the width table is made over, sixty-four to a row. */
function everyPoint(): string[] {
  const rows: string[] = []
  let row = ''
  for (const c of points()) {
    row += String.fromCodePoint(c)
    if (row.length >= 64) {
      rows.push(row)
      row = ''
    }
  }
  return [...rows, row]
}

/** Emoji spelled in several code points, and marks on a wide letter. */
function joined(): string[] {
  const bases = ['#', '*', ...'0123456789']
  for (let c = 0x2000; c <= 0x2bff; c++) bases.push(String.fromCodePoint(c))
  for (let c = 0x1f000; c <= 0x1fbff; c++) bases.push(String.fromCodePoint(c))
  const rows = bases.map((base) =>
    ['\ufe0f', '\ufe0e', '\ufe0f\u20e3', '\u{1f3fb}', '\u{1f3fd}\u200d']
      .map((tail) => `${base}${tail}x`)
      .join(''),
  )
  return [
    ...rows,
    'a👨‍👩‍👧b🏳️‍🌈c🇺🇸d🇯e',
    'e\u0301日\u0301\u0302x한\u1160y',
    '✔️ ⚠️ ❤️ ☺️ ✅ ⚡ ❌ ✨ ⭐ ㄅ ꥠ 𖿠',
  ]
}

describe('a row as the full view lays it out', () => {
  it('has pi-tui’s width tables, as `scripts/full-widths.ts` writes them', () => {
    // Red here means pi-tui measures differently now: run
    // `node packages/app/scripts/full-widths.ts` and commit what it writes.
    const widths = widthTable()
    expect(WIDTHS).toEqual(widths)
    expect(JOINED).toEqual(joinedTable(widths))
  })

  it('gives every glyph the cells the picture of it gives, every code point and joined emoji', () => {
    for (const row of [...everyPoint(), ...joined()]) {
      const page = pageCells(row)
      const picture = pictureCells(row)
      if (page.join('\n') !== picture.join('\n')) {
        expect(page, JSON.stringify(row)).toEqual(picture)
      }
    }
  })
})

describe('a row as the full view paints it', () => {
  it('has the pictures’ theme and their 256 colours', () => {
    expect(THEME.background).toBe(PICTURES.background)
    expect(THEME.foreground).toBe(PICTURES.foreground)
    expect(THEME.ansi).toEqual(PICTURES.ansi)
    for (let n = 0; n < 256; n++) expect(colour256(n), String(n)).toBe(pictured(n))
  })

  it('is painted cell for cell as the picture of it is, over every golden row', () => {
    const files = readdirSync(SCREENS).filter((name) => name.endsWith('.ansi'))
    expect(files.length).toBeGreaterThan(100)
    let rows = 0
    for (const name of files) {
      for (const row of readFileSync(join(SCREENS, name), 'utf8').split('\n')) {
        rows += 1
        const page = pageOf(row)
        const picture = pictureOf(row)
        if (page.join('\n') !== picture.join('\n')) {
          expect(page, `${name}: ${JSON.stringify(row).slice(0, 120)}`).toEqual(picture)
        }
      }
    }
    expect(rows).toBeGreaterThan(5_000)
  })

  it('marks a link’s run with its URL and draws none of its escape', () => {
    const runs = runsOf('see \x1b]8;;https://example.com/a\x1b\\here\x1b]8;;\x1b\\ now')
    expect(runs.map((run) => run.text).join('')).toBe('see here now')
    expect(runs.find((run) => run.text === 'here')?.link).toBe('https://example.com/a')
    expect(runs.find((run) => run.text === ' now')?.link).toBeNull()
  })

  it('gives a wide character a run of its own, so it can be given two cells', () => {
    const runs = runsOf('a日b')
    expect(runs.map((run) => [run.text, run.wide])).toEqual([
      ['a', false],
      ['日', true],
      ['b', false],
    ])
  })
})
