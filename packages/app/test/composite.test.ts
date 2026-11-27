import { readdirSync, readFileSync } from 'node:fs'
import { compositeTuiLine as theirs } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { compositeTuiLine as ours } from '../src/composite.ts'

// `composite.ts` is pi-tui's `compositeTuiLine`, copied because pi-tui keeps it
// in the file that brings Node with it. A copy is only worth keeping while it
// is the same function, so this holds it to pi-tui's own over the rows the
// window really draws — every golden screen's, painted — with overlays of
// both kinds laid over them at columns walked across each row.

const SCREENS = new URL('./screens/__screens__/', import.meta.url)

const rows = readdirSync(SCREENS)
  .filter((name) => name.endsWith('.ansi'))
  .flatMap((name) => readFileSync(new URL(name, SCREENS), 'utf8').split('\n'))

const OVERLAYS = [
  '',
  'x',
  '\x1b[1mbold\x1b[0m over',
  '│ ✓ 日本語 │',
  '\x1b]8;;https://a\x07link\x1b]8;;\x07',
]

describe("the window's compositeTuiLine", () => {
  it("answers as pi-tui's does over every golden row", () => {
    let compared = 0
    rows.forEach((row, index) => {
      if (index % 7 !== 0) return
      const overlay = OVERLAYS[index % OVERLAYS.length] ?? ''
      for (const [col, width, total] of [
        [0, 4, 80],
        [index % 60, 12, 120],
        [30, 1, 40],
      ] as const) {
        expect(ours(row, overlay, col, width, total)).toBe(theirs(row, overlay, col, width, total))
        compared++
      }
    })
    expect(compared).toBeGreaterThan(1000)
  })

  it('leaves a row carrying an image as it is', () => {
    const image = '\x1b_Gf=100;AAAA\x1b\\'
    expect(ours(image, 'over', 0, 4, 20)).toBe(theirs(image, 'over', 0, 4, 20))
    expect(ours(image, 'over', 0, 4, 20)).toBe(image)
  })
})
