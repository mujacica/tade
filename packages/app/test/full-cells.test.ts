import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { colour256, runsOf, THEME } from '../../web/src/assets/full-cells.js'
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
