import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ICONS as FAVICONS, pixelsOf } from '../scripts/icons.ts'
import { WORDS } from '../src/assets/icons.js'
import { assetsDir } from '../src/assets.ts'
import { contrast } from './colour.ts'

// Tade's mark on the page, held to the two things it is the same object as:
// the favicon, whose squares it draws, and tade-web's `.mk`, whose letters it
// draws. Both are arithmetic here, because a mark that drifted from either
// would look nearly right, and nearly right is the one thing nobody files.
//
// **What this cannot see** is that the outlines are Tade Mono Bold's: they
// were taken from the font once (`icons.js` says how) and nothing in this
// repository has the font to compare them with. What it can hold is where
// every letter sits, which is the half of the wordmark a hand edit breaks.

const DIR = assetsDir()
const read = (name: string) => readFileSync(join(DIR, name), 'utf8')
const HTML = read('index.html')
const TOKENS = read('tokens.css')
const FRAME = read('frame.css')

/** A symbol in the sprite: its viewBox and what is inside it. */
function symbolOf(id: string): { box: number[]; body: string } {
  const found = new RegExp(`<symbol id="${id}" viewBox="([\\d. ]+)">(.*?)</symbol>`).exec(HTML)
  expect(found, id).not.toBeNull()
  return { box: (found?.[1] ?? '').split(' ').map(Number), body: found?.[2] ?? '' }
}

const hex = (token: string) =>
  new RegExp(`${token}:\\s*(#[0-9a-f]{6})`).exec(TOKENS)?.[1] ?? '#000000'

/** A rule's declarations, by its exact selector. */
function ruleOf(sheet: string, selector: string): string {
  const at = sheet.indexOf(`\n${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return sheet.slice(at, sheet.indexOf('}', at))
}

describe('the mark is the favicon’s two squares', () => {
  const { box, body } = symbolOf('i-mark')
  const squares = [...body.matchAll(/<rect ([^>]*)\/>/g)].map((found) => {
    const attr = (name: string) =>
      Number(new RegExp(`\\b${name}="([\\d.]+)"`).exec(found[1] ?? '')?.[1] ?? 0)
    return {
      x: attr('x'),
      y: attr('y'),
      width: attr('width'),
      height: attr('height'),
      rounded: /\brx=/.test(found[1] ?? ''),
    }
  })

  it('is squares of a 2×2 grid, square-cornered, filling its box', () => {
    // The box is the boxes' height on the page (`--word`), so a mark with room
    // round it would be a smaller mark beside them, which is what it was.
    expect(box).toEqual([0, 0, 2, 2])
    expect(squares).toHaveLength(2)
    for (const one of squares) {
      expect(one.width).toBe(1)
      expect(one.height).toBe(1)
      expect(one.rounded).toBe(false)
    }
  })

  it('fills the quadrants the favicon fills, and no other', () => {
    // Read off the pixels `test/icons.test.ts` holds every PNG to: the centre
    // of each quarter of the favicon's mark is amber exactly where a square is.
    const icon = FAVICONS.find((one) => one.purpose === 'any') ?? FAVICONS[0]
    if (icon === undefined) throw new Error('no favicon')
    const pixels = pixelsOf(icon)
    const side = Math.round(icon.size * icon.fills)
    const from = (icon.size - side) / 2
    for (const qx of [0, 1]) {
      for (const qy of [0, 1]) {
        const x = Math.floor(from + (qx + 0.5) * (side / 2))
        const y = Math.floor(from + (qy + 0.5) * (side / 2))
        const amber = pixels[(y * icon.size + x) * 3] === 0xff
        const square = squares.some((one) => one.x === qx && one.y === qy)
        expect(square, `quadrant ${qx},${qy}`).toBe(amber)
      }
    }
  })
})

describe('the words are tade-web’s wordmark', () => {
  // tade-web's `.mk`: letters half an em wide, a column of tracking after each,
  // two columns of ground before them and one after the last letter's tracking,
  // 1.5em of line. In a 1000-unit em that is a 5500 by 1500 box, and letter
  // `i` lives in the half-em that starts at 1000 + 1000i.
  const EM = 1000
  const CAP = 735

  it('draws a symbol for every word the page asks for, and none it does not', () => {
    const drawn = [...HTML.matchAll(/<symbol id="w-([\w-]+)"/g)].map((found) => found[1])
    expect(drawn.sort()).toEqual([...WORDS].sort())
  })

  for (const word of WORDS) {
    it(`sets ${word} the way tade-web sets TADE`, () => {
      const { box, body } = symbolOf(`w-${word}`)
      expect(box).toEqual([0, 0, 5.5 * EM, 1.5 * EM])
      // The ground is the whole box, so the colour behind the letters is the box.
      expect(body).toContain(`<rect width="${5.5 * EM}" height="${1.5 * EM}"/>`)
      const letters = [...body.matchAll(/<path d="([^"]+)"\/>/g)].map((found) => found[1] ?? '')
      expect(letters).toHaveLength(word.length)
      // Every command here is absolute and takes x y pairs, so the numbers of
      // a path, two at a time, are its points — curve handles included.
      const top = (1.5 * EM - CAP) / 2
      letters.forEach((d, at) => {
        const numbers = (d.match(/-?[\d.]+/g) ?? []).map(Number)
        expect(numbers.length % 2, `${word}[${at}]`).toBe(0)
        const left = EM + at * EM
        for (let n = 0; n < numbers.length; n += 2) {
          const x = numbers[n] ?? -1
          const y = numbers[n + 1] ?? -1
          expect(x, `${word}[${at}] x`).toBeGreaterThanOrEqual(left)
          expect(x, `${word}[${at}] x`).toBeLessThanOrEqual(left + EM / 2)
          // Capitals, centred in the line: nothing above the cap height or
          // below the baseline, give or take the half unit the centring rounds.
          expect(y, `${word}[${at}] y`).toBeGreaterThanOrEqual(Math.floor(top))
          expect(y, `${word}[${at}] y`).toBeLessThanOrEqual(Math.ceil(top + CAP))
        }
      })
    })
  }
})

describe('the boxes are two colours, each with the ink its ground takes', () => {
  const tade = ruleOf(FRAME, '.word-tade')
  const away = ruleOf(FRAME, '.word-away')

  it('puts TADE black on amber, as tade-web does', () => {
    expect(tade).toContain('fill: var(--amber)')
    expect(tade).toContain('color: var(--ink)')
    expect(contrast(hex('--ink'), hex('--amber'))).toBeGreaterThanOrEqual(4.5)
  })

  it('puts AWAY on a ground of another colour, with the light ink a mid ground takes', () => {
    // `--amber-dark` is the palette's one colour that is only ever a ground,
    // so it is the box; a ground that dark takes `--ink-light`, never amber.
    expect(away).toContain('fill: var(--amber-dark)')
    expect(away).toContain('color: var(--ink-light)')
    expect(hex('--amber-dark')).not.toBe(hex('--amber'))
    expect(contrast(hex('--ink-light'), hex('--amber-dark'))).toBeGreaterThanOrEqual(4.5)
  })

  it('lets AWAY go at a phone’s width, and never TADE', () => {
    const phone = FRAME.slice(FRAME.indexOf('@media (max-width: 479px)'))
    const block = phone.slice(0, phone.indexOf('\n}\n'))
    expect(block).toMatch(/\.brand \.word-away \{\s*display: none;/)
    expect(block).not.toContain('.word-tade')
  })

  it('is one image with one name, inside a link that keeps its own', () => {
    // The drawings are aria-hidden; the wordmark is the one thing read out,
    // and the header's link says where it goes.
    const icons = read('icons.js')
    expect(icons).toContain("node.setAttribute('role', 'img')")
    expect(icons).toContain("node.setAttribute('aria-label', 'Tade away')")
    expect(read('shell.js')).toContain("'aria-label': 'Tade, overview'")
  })
})
