// A terminal, as much of one as a picture of Tade needs.
//
// Two things read this. The pictures the README is made of are drawn rows,
// turned into cells here; `capture.ts` runs the real `tade` in a real terminal
// and turns the bytes it writes into the same cells. One parser for both, so a
// picture drawn from a scenario and a picture taken of the running window can
// never disagree about what an escape code means.
//
// Only what a terminal running Tade actually receives is understood, and
// anything else is written down (`unknown`) rather than dropped: a picture
// drawn from a stream nobody could read is worse than no picture, because it
// looks like one.

import { visibleWidth } from '@earendil-works/pi-tui'

/**
 * The theme the pictures are taken in.
 *
 * A terminal's default ink and ground are the person's, not the program's —
 * Tade paints neither, so a picture has to choose. This is that choice, in one
 * place, and it is the dark grey every screenshot of a terminal is taken
 * against: near-black ground, light ink, which is what the window's palette was
 * drawn for (`skin.ts` — dark ink on the amber, bright grey on the chrome).
 *
 * It matters more than it looks. Text Tade leaves unpainted — an agent's own
 * words, a file name, a path — is *default* ink, and a picture that has no
 * default paints it black: the whole transcript in the middle of the window,
 * invisible on its own ground. Every drawing here resolves through
 * `paintOf`, which never returns nothing.
 */
export interface Theme {
  /** The ground, where no cell paints one. */
  background: string
  /** The ink, where no cell paints one. */
  foreground: string
  /**
   * The sixteen colours the codes name rather than number (`31`, `92`).
   * Tade's own window uses none of them — its palette is 73 and up — but a
   * shell in a lane, a diff from git and an agent's own output all do.
   */
  ansi: readonly string[]
  /** The window around the screen, and the caption on its bar. */
  frame: string
  caption: string
}

/**
 * The sixteen, in the shades a modern terminal shows rather than the ones
 * xterm shipped in 1988: `#cd0000` red on a dark ground reads as a smudge, and
 * nobody's terminal has looked like that for twenty years.
 */
const ANSI = [
  '#3b3b3b', // black, lifted off the ground so a black-on-black cell is still visible
  '#e05561',
  '#8cc265',
  '#d5a45c',
  '#5a9cf8',
  '#c162de',
  '#42b3c2',
  '#d7dae0',
  '#6b6b6b',
  '#ff616e',
  '#a5e075',
  '#f0c674',
  '#7aa2f7',
  '#de73ff',
  '#4cd1e0',
  '#f2f4f8',
]

export const THEME: Theme = {
  background: '#1c1c1c',
  foreground: '#d0d0d0',
  ansi: ANSI,
  frame: '#111111',
  caption: '#8a8a8a',
}

const CUBE = [0, 95, 135, 175, 215, 255]

/** One of the 256, as a colour. */
export function colour256(n: number, theme: Theme = THEME): string {
  if (n < 16) return theme.ansi[n] ?? theme.foreground
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return rgb(v, v, v)
  }
  const i = n - 16
  return rgb(CUBE[Math.floor(i / 36)] ?? 0, CUBE[Math.floor(i / 6) % 6] ?? 0, CUBE[i % 6] ?? 0)
}

const hex = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0')
const rgb = (r: number, g: number, b: number) => `#${hex(r)}${hex(g)}${hex(b)}`

const parse = (colour: string): [number, number, number] => {
  const n = Number.parseInt(colour.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** One colour part of the way to another: how dim is drawn, and nothing else. */
function mix(from: string, to: string, amount: number): string {
  const [ar, ag, ab] = parse(from)
  const [br, bg, bb] = parse(to)
  return rgb(ar + (br - ar) * amount, ag + (bg - ag) * amount, ab + (bb - ab) * amount)
}

/** How a cell is painted: what the codes said, not what it comes out as. */
export interface Pen {
  fg: string | null
  bg: string | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  /** `\x1b[7m`: ink and ground swapped, defaults included. */
  reverse: boolean
}

export const PEN: Pen = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  reverse: false,
}

/** One terminal cell: what is in it, how it is painted, and how wide it is. */
export interface Cell extends Pen {
  ch: string
  /** 1 for an ordinary glyph, 2 for one that takes two columns, 0 for its second column. */
  width: number
}

export const EMPTY: Cell = { ...PEN, ch: ' ', width: 1 }

export type Grid = Cell[][]

/**
 * One SGR sequence applied to a pen.
 *
 * Everything a terminal running Tade is sent: the window's own 256 colours and
 * bold, the setup screen's dim and its named colours, italic and underline, and
 * the true colour an agent's output may arrive in. A code that is not here
 * leaves the pen alone and is reported by whoever is reading, because a colour
 * silently ignored is how text ends up the wrong shade in a picture nobody
 * re-reads.
 */
export function applySgr(pen: Pen, codes: readonly number[], theme: Theme = THEME): Pen {
  let out = { ...pen }
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i] ?? 0
    if (code === 0) out = { ...PEN }
    else if (code === 1) out.bold = true
    else if (code === 2) out.dim = true
    else if (code === 3) out.italic = true
    else if (code === 4) out.underline = true
    else if (code === 7) out.reverse = true
    else if (code === 21 || code === 22) {
      out.bold = false
      out.dim = false
    } else if (code === 23) out.italic = false
    else if (code === 24) out.underline = false
    else if (code === 27) out.reverse = false
    else if (code >= 30 && code <= 37) out.fg = theme.ansi[code - 30] ?? null
    else if (code === 39) out.fg = null
    else if (code >= 40 && code <= 47) out.bg = theme.ansi[code - 40] ?? null
    else if (code === 49) out.bg = null
    else if (code >= 90 && code <= 97) out.fg = theme.ansi[code - 90 + 8] ?? null
    else if (code >= 100 && code <= 107) out.bg = theme.ansi[code - 100 + 8] ?? null
    else if (code === 38 || code === 48) {
      const where = code === 38 ? 'fg' : 'bg'
      if (codes[i + 1] === 5) {
        out[where] = colour256(codes[i + 2] ?? 7, theme)
        i += 2
      } else if (codes[i + 1] === 2) {
        out[where] = rgb(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0)
        i += 4
      }
    }
  }
  return out
}

const PLAIN_SGR = new Set([0, 1, 2, 3, 4, 7, 21, 22, 23, 24, 27, 39, 49])

/**
 * Which of one sequence's codes changed nothing, for a reader that wants to
 * say so.
 *
 * A colour's own arguments are stepped over rather than read as codes: `5` and
 * `214` after a `38` are a palette entry, not blinking and not a colour of
 * their own, and reporting them would bury the one code that really was
 * dropped.
 */
export function unknownSgr(codes: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i] ?? 0
    if (code === 38 || code === 48) {
      i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0
      continue
    }
    if (PLAIN_SGR.has(code)) continue
    if (code >= 30 && code <= 37) continue
    if (code >= 40 && code <= 47) continue
    if (code >= 90 && code <= 97) continue
    if (code >= 100 && code <= 107) continue
    out.push(code)
  }
  return out
}

/**
 * What a cell comes out as: ink that is never nothing, and a ground that is
 * nothing only when the theme's own shows through.
 *
 * Dim is a colour part of the way to the ground it sits on, which is what a
 * terminal does with it; reverse swaps the two, defaults included, which is
 * the only way a cell painted with neither can still be a block of colour.
 */
export function paintOf(cell: Pen, theme: Theme = THEME): { ink: string; ground: string | null } {
  let ink = cell.fg ?? theme.foreground
  let ground = cell.bg
  if (cell.reverse) {
    const under = ground ?? theme.background
    ground = ink
    ink = under
  }
  if (cell.dim) ink = mix(ink, ground ?? theme.background, 0.45)
  return { ink, ground }
}

/**
 * One rendered row as cells.
 *
 * A row, not a stream: both things that draw pictures here hand over a screen
 * that has already been rendered — the window's own rows, and what the pty
 * driver's terminal (`capture`, styled) says is on screen — so there is no
 * cursor to move and no clearing to do. Everything that decides what a cell
 * looks like is the paint on it, which is `applySgr`, and nothing here is a
 * second terminal emulator: Tade has one, in the driver, and two would drift.
 *
 * Anything that is not paint — a hyperlink, a title, a mode nobody asked
 * about — is stepped over, and an SGR code that changed nothing is handed to
 * `onUnknown`, because a colour silently ignored is how text ends up the
 * wrong shade in a picture nobody re-reads.
 */
export function toCells(
  line: string,
  theme: Theme = THEME,
  onUnknown?: (code: number) => void,
): Cell[] {
  let pen: Pen = { ...PEN }
  const out: Cell[] = []
  let i = 0
  while (i < line.length) {
    const ch = line[i] ?? ''
    if (ch === '\x1b') {
      const taken = paintFrom(line, i, (codes) => {
        pen = applySgr(pen, codes, theme)
        if (onUnknown) for (const code of unknownSgr(codes)) onUnknown(code)
      })
      if (taken === 0) break
      i += taken
      continue
    }
    // A control character on a rendered row is nothing to draw.
    if (ch < ' ' || ch === '\x7f') {
      i++
      continue
    }
    const glyph = clusterAt(line, i)
    const width = Math.max(1, visibleWidth(glyph))
    out.push({ ...pen, ch: glyph, width })
    // A glyph two columns wide owns the column after it, which holds nothing
    // of its own: anything drawn from this grid places it once, at its width.
    for (let over = 1; over < width; over++) out.push({ ...pen, ch: '', width: 0 })
    i += glyph.length
  }
  return out
}

/**
 * One escape sequence at `at`: how many characters it took, and the SGR codes
 * if that is what it was. Zero where it is not a sequence this can read, which
 * ends the row rather than printing its own escape codes as letters.
 */
function paintFrom(line: string, at: number, sgr: (codes: number[]) => void): number {
  const next = line[at + 1]
  if (next === '[') {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: this is a parser of control characters.
    const match = /^\x1b\[([?>=<]?)([0-9;:]*)([A-Za-z@`])/.exec(line.slice(at))
    if (!match) return 0
    const [whole = '', prefix = '', params = '', final = ''] = match
    if (prefix === '' && final === 'm') {
      sgr(params === '' ? [0] : params.split(';').map((one) => Number(one.split(':')[0])))
    }
    return whole.length
  }
  // An operating-system command — the links Tade puts on rows, a window title
  // — ends at a bell or a string terminator and paints nothing.
  if (next === ']') {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: this is a parser of control characters.
    const end = /\x07|\x1b\\/.exec(line.slice(at + 2))
    return end?.index === undefined ? 0 : 2 + end.index + end[0].length
  }
  return next === undefined ? 0 : 2
}

/** One glyph and whatever combines with it: a mark, a joiner, a variation selector. */
function clusterAt(line: string, at: number): string {
  let glyph = ''
  for (const ch of line.slice(at, at + 16)) {
    // A control character is not a combining mark, however wide a width table
    // says it is: an escape swallowed into the glyph before it is a sequence
    // printed as letters, which is a screen of gibberish.
    if (glyph !== '' && (ch <= '\x1f' || ch === '\x7f' || visibleWidth(ch) !== 0)) break
    glyph += ch
  }
  return glyph
}

/** Every drawn row as cells, padded to the widest so the grid is rectangular. */
export function toGrid(rows: readonly string[], theme: Theme = THEME): Grid {
  const grid = rows.map((row) => toCells(row, theme))
  const width = grid.reduce((most, row) => Math.max(most, row.length), 0)
  for (const row of grid) while (row.length < width) row.push({ ...EMPTY })
  return grid
}
