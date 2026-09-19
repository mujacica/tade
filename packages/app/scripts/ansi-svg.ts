// What the window draws, as a picture anybody can look at.
//
// The window's own rows are ANSI; a README, a pull request and a web page take
// images. This turns the one into the other without a screenshot being taken
// by hand: every picture in the README is drawn from the same scenarios the
// golden tests protect, so a change to how Tade looks changes the pictures too
// and `pnpm screens --assets` is all it takes.
//
// SVG rather than PNG or GIF, for three reasons: text stays text, so it can be
// searched and read by a screen reader; a screen is a few tens of kilobytes
// instead of a few hundred; and an animation is a stylesheet rather than a
// video codec, which is what lets a short demo live in a repository.

import { colour256 } from './ansi-html.ts'

/** One terminal cell: what is in it, and how it is painted. */
export interface Cell {
  ch: string
  fg: string | null
  bg: string | null
  bold: boolean
  underline: boolean
}

export type Grid = Cell[][]

const EMPTY: Cell = { ch: ' ', fg: null, bg: null, bold: false, underline: false }

/**
 * Split one drawn row into cells.
 *
 * Only what the window emits is understood — reset, bold, underline and the
 * 256 colours — and anything else is dropped, which is honest for a picture
 * meant to show what the window draws rather than to be a terminal.
 */
export function toCells(line: string): Cell[] {
  let fg: string | null = null
  let bg: string | null = null
  let bold = false
  let underline = false
  const out: Cell[] = []
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this is a parser of control characters.
  const parts = line.split(/(\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/)
  for (const part of parts) {
    if (part === '' || part.startsWith('\x1b]')) continue
    if (part.startsWith('\x1b[')) {
      const codes = part.slice(2, -1).split(';').map(Number)
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i]
        if (code === 0 || Number.isNaN(code)) {
          fg = null
          bg = null
          bold = false
          underline = false
        } else if (code === 1) bold = true
        else if (code === 4) underline = true
        else if (code === 24) underline = false
        else if (code === 38 && codes[i + 1] === 5) {
          fg = colour256(codes[i + 2] ?? 7)
          i += 2
        } else if (code === 48 && codes[i + 1] === 5) {
          bg = colour256(codes[i + 2] ?? 0)
          i += 2
        }
      }
      continue
    }
    for (const ch of part) out.push({ ch, fg, bg, bold, underline })
  }
  return out
}

/** Every drawn row as cells, padded to the widest so the grid is rectangular. */
export function toGrid(rows: readonly string[]): Grid {
  const grid = rows.map(toCells)
  const width = grid.reduce((most, row) => Math.max(most, row.length), 0)
  for (const row of grid) while (row.length < width) row.push({ ...EMPTY })
  return grid
}

export interface Box {
  top?: number
  left?: number
  width?: number
  height?: number
}

/** A rectangle of the screen: what a feature's picture usually wants. */
export function cropGrid(grid: Grid, box: Box): Grid {
  const top = box.top ?? 0
  const left = box.left ?? 0
  const height = box.height ?? grid.length - top
  const width = box.width ?? (grid[0]?.length ?? 0) - left
  const out: Grid = []
  for (let y = top; y < top + height; y++) {
    const row = grid[y] ?? []
    const cells: Cell[] = []
    for (let x = left; x < left + width; x++) cells.push(row[x] ?? { ...EMPTY })
    out.push(cells)
  }
  return out
}

// Geometry. The cell is 8.4 × 17 at a 14px font, which is the shape a terminal
// has; every run is drawn with `textLength`, so columns line up in a renderer
// whose monospace font is not the one this was written on.
const CW = 8.4
const CH = 17
const FONT = 14
const BASELINE = 13.2
const PAD = 12
const BAR = 28
const FONT_STACK =
  "ui-monospace,SFMono-Regular,Menlo,Consolas,'DejaVu Sans Mono','Liberation Mono',monospace"

export interface ShotOptions {
  /** The caption in the title bar. Left out, the frame has no title bar. */
  title?: string
  /** The screen's own ground, where a cell paints none. */
  background?: string
  /** What is around the screen: the window's frame. */
  frame?: string
}

const SCREEN = '#1c1c1c'
const FRAME = '#111111'
const CAPTION = '#8a8a8a'

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const round = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(2).replace(/0+$/, ''))

function sameStyle(a: Cell, b: Cell): boolean {
  return a.fg === b.fg && a.bold === b.bold && a.underline === b.underline
}

/**
 * The block elements, as the fraction of a cell each one fills.
 *
 * They are drawn as rectangles rather than letters because a block glyph fills
 * its font's em box, and a terminal's line is taller than that: left to the
 * font, every divider, scrollbar and selection band in the window comes out as
 * a dotted line with the gap between rows showing through. As rectangles they
 * are what they are in a terminal — and a column of them is one rectangle,
 * which is smaller than a hundred letters.
 */
const BLOCKS: Record<string, [x0: number, y0: number, x1: number, y1: number, alpha?: number]> = {
  '\u2588': [0, 0, 1, 1], // █ full
  '\u2580': [0, 0, 1, 0.5], // ▀ upper half
  '\u2584': [0, 0.5, 1, 1], // ▄ lower half
  '\u258c': [0, 0, 0.5, 1], // ▌ left half
  '\u2590': [0.5, 0, 1, 1], // ▐ right half
  '\u258f': [0, 0, 0.125, 1], // ▏ left eighth
  '\u258e': [0, 0, 0.25, 1],
  '\u258d': [0, 0, 0.375, 1],
  '\u258b': [0, 0, 0.625, 1],
  '\u258a': [0, 0, 0.75, 1],
  '\u2589': [0, 0, 0.875, 1],
  '\u2595': [0.875, 0, 1, 1], // ▕ right eighth
  '\u2581': [0, 0.875, 1, 1], // ▁ lower eighth, up to ▇
  '\u2582': [0, 0.75, 1, 1],
  '\u2583': [0, 0.625, 1, 1],
  '\u2585': [0, 0.375, 1, 1],
  '\u2586': [0, 0.25, 1, 1],
  '\u2587': [0, 0.125, 1, 1],
  '\u2591': [0, 0, 1, 1, 0.25], // ░ ▒ ▓ shades
  '\u2592': [0, 0, 1, 1, 0.5],
  '\u2593': [0, 0, 1, 1, 0.75],
}

/**
 * The box-drawing characters, as which arms they have and how heavy each is.
 *
 * They are drawn as lines rather than letters for the same reason the blocks
 * are drawn as rectangles, and one more: a renderer whose monospace font puts
 * a box character in a wider cell than the rest pushes the whole rule sideways,
 * and a frame drawn a third of a cell out of place is the one thing that makes
 * a picture of a terminal look fake. As lines they meet exactly.
 */
const RULES: Record<string, { u?: number; r?: number; d?: number; l?: number; round?: true }> = {
  '\u2500': { l: 1, r: 1 }, // ─
  '\u2501': { l: 2, r: 2 }, // ━
  '\u2502': { u: 1, d: 1 }, // │
  '\u2503': { u: 2, d: 2 }, // ┃
  '\u256d': { r: 1, d: 1, round: true }, // ╭
  '\u256e': { l: 1, d: 1, round: true }, // ╮
  '\u2570': { u: 1, r: 1, round: true }, // ╰
  '\u256f': { u: 1, l: 1, round: true }, // ╯
  '\u250f': { r: 2, d: 2 }, // ┏
  '\u2513': { l: 2, d: 2 }, // ┓
  '\u2517': { u: 2, r: 2 }, // ┗
  '\u251b': { u: 2, l: 2 }, // ┛
  '\u252c': { l: 1, r: 1, d: 1 }, // ┬
  '\u2534': { l: 1, r: 1, u: 1 }, // ┴
  '\u251c': { u: 1, d: 1, r: 1 }, // ├
  '\u2524': { u: 1, d: 1, l: 1 }, // ┤
  '\u253c': { u: 1, d: 1, l: 1, r: 1 }, // ┼
}

const WEIGHT = [0, 1.1, 2]

/** Every rule in the grid: runs merged along their own direction, corners drawn where they turn. */
function rules(grid: Grid, originX: number, originY: number): string[] {
  const out: string[] = []
  const done = new Set<string>()
  const at = (x: number, y: number) => {
    const cell = grid[y]?.[x]
    const rule = cell ? RULES[cell.ch] : undefined
    return cell && rule ? { cell, rule } : null
  }
  const line = (x1: number, y1: number, x2: number, y2: number, width: number, fill: string) =>
    out.push(
      `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" stroke="${fill}" stroke-width="${width}"/>`,
    )
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y] ?? []
    for (let x = 0; x < row.length; x++) {
      const here = at(x, y)
      if (!here || done.has(`${x},${y}`)) continue
      const { cell, rule } = here
      const fill = cell.fg ?? '#dadada'
      const left = originX + x * CW
      const top = originY + y * CH
      const cx = left + CW / 2
      const cy = top + CH / 2
      // A straight run — the rules the window is mostly made of — is one line
      // however long it is.
      const straight = (along: 'x' | 'y') => {
        let end = along === 'x' ? x : y
        for (;;) {
          const next = along === 'x' ? at(end + 1, y) : at(x, end + 1)
          if (!next || next.cell.ch !== cell.ch || next.cell.fg !== cell.fg) break
          end++
          done.add(along === 'x' ? `${end},${y}` : `${x},${end}`)
        }
        return end
      }
      if (rule.l && rule.r && !rule.u && !rule.d) {
        const end = straight('x')
        line(left, cy, originX + (end + 1) * CW, cy, WEIGHT[rule.r] ?? 1, fill)
        continue
      }
      if (rule.u && rule.d && !rule.l && !rule.r) {
        const end = straight('y')
        line(cx, top, cx, originY + (end + 1) * CH, WEIGHT[rule.d] ?? 1, fill)
        continue
      }
      const width = WEIGHT[Math.max(rule.u ?? 0, rule.d ?? 0, rule.l ?? 0, rule.r ?? 0)] ?? 1
      if (rule.round) {
        // A corner that turns: its two arm ends, joined by one curve through
        // the middle of the cell.
        const ends: [number, number][] = []
        if (rule.u) ends.push([cx, top])
        if (rule.d) ends.push([cx, top + CH])
        if (rule.l) ends.push([left, cy])
        if (rule.r) ends.push([originX + (x + 1) * CW, cy])
        const [from, to] = ends
        if (from && to) {
          out.push(
            `<path d="M${round(from[0])} ${round(from[1])}Q${round(cx)} ${round(cy)} ${round(to[0])} ${round(to[1])}" fill="none" stroke="${fill}" stroke-width="${width}"/>`,
          )
          continue
        }
      }
      if (rule.l) line(left, cy, cx, cy, WEIGHT[rule.l] ?? 1, fill)
      if (rule.r) line(cx, cy, originX + (x + 1) * CW, cy, WEIGHT[rule.r] ?? 1, fill)
      if (rule.u) line(cx, top, cx, cy, WEIGHT[rule.u] ?? 1, fill)
      if (rule.d) line(cx, cy, cx, top + CH, WEIGHT[rule.d] ?? 1, fill)
    }
  }
  return out
}

/**
 * Every block element in the grid, joined into as few rectangles as it takes.
 *
 * A block is joined to its neighbour only along the side it fills: a full block
 * to the one beside it and the one under it, a half-height one only sideways, a
 * one-eighth-wide divider only downwards. Left as one rectangle per cell they
 * are all correct and all wrong — the seam between two rectangles that touch
 * shows as a hairline, which turns a meter into a picket fence.
 */
function blocks(grid: Grid, originX: number, originY: number): string[] {
  const out: string[] = []
  const cols = grid[0]?.length ?? 0
  const done = new Set<string>()
  const same = (x: number, y: number, ch: string, fg: string | null) => {
    const cell = grid[y]?.[x]
    return !!cell && cell.ch === ch && cell.fg === fg && !done.has(`${x},${y}`)
  }
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < cols; x++) {
      const cell = grid[y]?.[x]
      const box = cell ? BLOCKS[cell.ch] : undefined
      if (!cell || !box || done.has(`${x},${y}`)) continue
      const [x0, y0, x1, y1, alpha] = box
      let lastX = x
      if (x1 - x0 === 1) while (same(lastX + 1, y, cell.ch, cell.fg)) lastX++
      let lastY = y
      if (y1 - y0 === 1) {
        for (;;) {
          let whole = true
          for (let at = x; at <= lastX; at++) whole &&= same(at, lastY + 1, cell.ch, cell.fg)
          if (!whole) break
          lastY++
        }
      }
      for (let atY = y; atY <= lastY; atY++)
        for (let atX = x; atX <= lastX; atX++) done.add(`${atX},${atY}`)
      const left = originX + (x + x0) * CW
      const top = originY + (y + y0) * CH
      out.push(
        `<rect x="${round(left)}" y="${round(top)}" width="${round((lastX - x + (x1 - x0)) * CW)}" height="${round((lastY - y + (y1 - y0)) * CH)}" fill="${cell.fg ?? '#dadada'}"${alpha ? ` opacity="${alpha}"` : ''}/>`,
      )
    }
  }
  return out
}

/** The painted grounds of one row, merged into as few rectangles as it takes. */
function grounds(row: readonly Cell[], y: number, originX: number, originY: number): string[] {
  const out: string[] = []
  let x = 0
  while (x < row.length) {
    const bg = row[x]?.bg ?? null
    if (bg === null) {
      x++
      continue
    }
    let end = x
    while (end + 1 < row.length && row[end + 1]?.bg === bg) end++
    const left = originX + x * CW
    const top = originY + y * CH
    out.push(
      `<rect x="${round(left)}" y="${round(top)}" width="${round((end - x + 1) * CW)}" height="${CH}" fill="${bg}"/>`,
    )
    x = end + 1
  }
  return out
}

/** The letters of one row, merged into as few runs as it takes. */
function letters(row: readonly Cell[], y: number, originX: number, originY: number): string[] {
  const out: string[] = []
  const baseline = originY + y * CH + BASELINE
  let x = 0
  while (x < row.length) {
    const cell = row[x]
    if (!cell || cell.ch === ' ') {
      x++
      continue
    }
    if (BLOCKS[cell.ch] || RULES[cell.ch]) {
      x++
      continue
    }
    let end = x
    while (end + 1 < row.length) {
      const next = row[end + 1]
      if (!next || next.ch === ' ' || BLOCKS[next.ch] || RULES[next.ch] || !sameStyle(cell, next))
        break
      end++
    }
    const text = row
      .slice(x, end + 1)
      .map((one) => one.ch)
      .join('')
    const attrs = [
      `x="${round(originX + x * CW)}"`,
      `y="${round(baseline)}"`,
      `textLength="${round(text.length * CW)}"`,
      // Glyphs as well as gaps, so a box-drawing character that a renderer's
      // fallback font makes wider than a cell is squeezed back into its column
      // instead of pushing the rest of the line sideways.
      'lengthAdjust="spacingAndGlyphs"',
    ]
    if (cell.fg) attrs.push(`fill="${cell.fg}"`)
    if (cell.bold) attrs.push('font-weight="700"')
    if (cell.underline) attrs.push('text-decoration="underline"')
    out.push(`<text ${attrs.join(' ')}>${escapeXml(text)}</text>`)
    x = end + 1
  }
  return out
}

/** One picture of a screen: the grounds, then the letters, in a window frame. */
function body(grid: Grid, originX: number, originY: number): string {
  const parts: string[] = []
  for (let y = 0; y < grid.length; y++) parts.push(...grounds(grid[y] ?? [], y, originX, originY))
  parts.push(...blocks(grid, originX, originY), ...rules(grid, originX, originY))
  for (let y = 0; y < grid.length; y++) parts.push(...letters(grid[y] ?? [], y, originX, originY))
  return parts.join('')
}

interface Chrome {
  width: number
  height: number
  originX: number
  originY: number
  head: string
}

function chrome(grid: Grid, opts: ShotOptions): Chrome {
  const cols = grid[0]?.length ?? 0
  const rows = grid.length
  const bar = opts.title === undefined ? 0 : BAR
  const width = cols * CW + PAD * 2
  const height = rows * CH + PAD * 2 + bar
  const dots = ['#5a5a5a', '#484848', '#3a3a3a']
    .map((fill, i) => `<circle cx="${18 + i * 16}" cy="${BAR / 2}" r="4.5" fill="${fill}"/>`)
    .join('')
  const caption =
    opts.title === undefined
      ? ''
      : `${dots}<text x="${round(width / 2)}" y="${BAR / 2 + 4}" fill="${CAPTION}" font-size="12" text-anchor="middle">${escapeXml(opts.title)}</text>`
  const head =
    `<rect width="${round(width)}" height="${round(height)}" rx="8" fill="${opts.frame ?? FRAME}"/>` +
    `<rect x="${PAD / 2}" y="${round(bar)}" width="${round(width - PAD)}" height="${round(height - bar - PAD / 2)}" rx="5" fill="${opts.background ?? SCREEN}"/>` +
    caption
  return { width, height, originX: PAD, originY: bar + PAD / 2, head }
}

const open = (width: number, height: number, label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(width)} ${round(height)}" width="${round(width)}" height="${round(height)}" font-family="${FONT_STACK}" font-size="${FONT}" role="img" aria-label="${escapeXml(label)}">`

/** A still of one screen. */
export function shot(grid: Grid, opts: ShotOptions = {}): string {
  const { width, height, originX, originY, head } = chrome(grid, opts)
  return `${open(width, height, opts.title ?? 'Tade')}${head}${body(grid, originX, originY)}</svg>\n`
}

export interface Shot {
  grid: Grid
  /** How long it stays, in seconds. */
  hold: number
  /** What it is, for anyone reading the source. */
  about?: string
}

/**
 * A short demo: several screens, one after another, forever.
 *
 * A stylesheet rather than a video — which is what an `<img>` in a README can
 * play without a plugin, at a tenth of a GIF's weight, and what a reader with
 * animation turned off is spared.
 */
export function reel(shots: readonly Shot[], opts: ShotOptions = {}): string {
  const first = shots[0]
  if (!first) throw new Error('a reel needs at least one frame')
  const { width, height, originX, originY, head } = chrome(first.grid, opts)
  const total = shots.reduce((sum, one) => sum + one.hold, 0)
  // Frames are stacked and shown one at a time by opacity: a cut rather than a
  // fade, so the stops either side of one are a hundredth of a percent apart.
  // Everything is spelt out, 0% to 100%, because a keyframe list that starts
  // part-way through is filled in from the element's own value, and what that
  // interpolates to is a renderer's business rather than ours.
  const rules: string[] = ['.f{opacity:0}']
  const frames: string[] = []
  const step = 0.01
  let at = 0
  shots.forEach((one, i) => {
    const from = (at / total) * 100
    at += one.hold
    // The last frame holds to the end, so no rounding can leave a blank flash
    // between one loop and the next.
    const to = i === shots.length - 1 ? 100 : (at / total) * 100
    const stops: string[] = []
    if (from > 0) stops.push('0%{opacity:0}', `${round(from - step)}%{opacity:0}`)
    stops.push(`${round(from)}%{opacity:1}`)
    if (to < 100) stops.push(`${round(to - step)}%{opacity:1}`, `${round(to)}%{opacity:0}`)
    stops.push(`100%{opacity:${to < 100 ? 0 : 1}}`)
    rules.push(
      `#f${i}{animation:f${i} ${round(total)}s infinite}`,
      `@keyframes f${i}{${stops.join('')}}`,
    )
    const comment = one.about ? `<!-- ${escapeXml(one.about)} -->` : ''
    // The attribute as well as the class, so a reader that has no stylesheets
    // at all — a thumbnailer, a PDF — shows the first frame rather than every
    // frame at once. An animation overrides both.
    frames.push(
      `${comment}<g id="f${i}" class="f"${i === 0 ? ' style="opacity:1"' : ' opacity="0"'}>${body(one.grid, originX, originY)}</g>`,
    )
  })
  // Somebody who has asked for less movement gets the first frame and no
  // demo. Last, and naming the same ids, so it wins on order rather than on
  // `!important` — which reverses the cascade and is never needed here.
  rules.push(
    `@media (prefers-reduced-motion:reduce){${shots.map((_, i) => `#f${i}`).join(',')}{animation:none}}`,
  )
  return `${open(width, height, opts.title ?? 'Tade')}<style>${rules.join('')}</style>${head}${frames.join('')}</svg>\n`
}
