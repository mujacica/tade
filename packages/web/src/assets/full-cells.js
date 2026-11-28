// The window's rows as runs of painted text, for the full view to put in spans
// (§10 T4 of the Duo plan). The window's own `draw` hands over whole rows of
// text with SGR colour codes in them — never a stream of cursor moves — so no
// terminal emulator is needed: a row is cut into runs that share one paint, and
// each run becomes a span.
//
// **The paint is the README pictures' own.** `packages/app/scripts/terminal.ts`
// turns the same rows into the cells every picture of the window is drawn
// from: its theme, its sixteen colours, its cube, what bold, dim and reverse
// come out as. A phone that coloured a row differently from the pictures would
// be two products, so this is that file's `applySgr` and `paintOf` written out
// again in JavaScript — a browser cannot import a `.ts` file, and the
// alternative is a build step — and `test/full-cells.test.ts` holds the two
// equal over every golden row the window draws.
//
// **Every solid colour is one of the window's xterm-256 tones**, which is what
// `tokens.css` is made of too: the ground is `--ground`, and the amber, the
// violet, the green and the red of a drawn row are the page's own.
//
// What is not paint is stepped over: a hyperlink's opening and closing
// (`OSC 8`), which marks the run it covers with its URL so a tap can follow it,
// and any other escape, which draws nothing.
//
// Pure: no DOM, so a test imports it as the page does.

/** The ground and the ink where a cell paints neither: the pictures' own. */
export const THEME = {
  background: '#1c1c1c',
  foreground: '#d0d0d0',
  ansi: [
    '#3b3b3b',
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
  ],
}

const CUBE = [0, 95, 135, 175, 215, 255]

function hex(n) {
  return Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0')
}

function rgb(r, g, b) {
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

function parse(colour) {
  const n = Number.parseInt(colour.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function mix(from, to, amount) {
  const [ar, ag, ab] = parse(from)
  const [br, bg, bb] = parse(to)
  return rgb(ar + (br - ar) * amount, ag + (bg - ag) * amount, ab + (bb - ab) * amount)
}

/** One of the 256, as a colour. */
export function colour256(n) {
  if (n < 16) return THEME.ansi[n] ?? THEME.foreground
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return rgb(v, v, v)
  }
  const i = n - 16
  return rgb(CUBE[Math.floor(i / 36)] ?? 0, CUBE[Math.floor(i / 6) % 6] ?? 0, CUBE[i % 6] ?? 0)
}

/** A pen nothing has painted. */
export const PEN = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  reverse: false,
}

/** One SGR sequence applied to a pen: `terminal.ts`'s `applySgr`. */
export function applySgr(pen, codes) {
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
    else if (code >= 30 && code <= 37) out.fg = THEME.ansi[code - 30] ?? null
    else if (code === 39) out.fg = null
    else if (code >= 40 && code <= 47) out.bg = THEME.ansi[code - 40] ?? null
    else if (code === 49) out.bg = null
    else if (code >= 90 && code <= 97) out.fg = THEME.ansi[code - 90 + 8] ?? null
    else if (code >= 100 && code <= 107) out.bg = THEME.ansi[code - 100 + 8] ?? null
    else if (code === 38 || code === 48) {
      const where = code === 38 ? 'fg' : 'bg'
      if (codes[i + 1] === 5) {
        out[where] = colour256(codes[i + 2] ?? 7)
        i += 2
      } else if (codes[i + 1] === 2) {
        out[where] = rgb(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0)
        i += 4
      }
    }
  }
  return out
}

/** What a pen comes out as: `terminal.ts`'s `paintOf`. A null ground is the page's own. */
export function paintOf(pen) {
  let ink = pen.fg ?? THEME.foreground
  let ground = pen.bg
  if (pen.reverse) {
    const under = ground ?? THEME.background
    ground = ink
    ink = under
  }
  if (pen.dim) ink = mix(ink, ground ?? THEME.background, 0.45)
  return { ink, ground }
}

/**
 * Whether a character takes two cells: the East Asian wide and full-width
 * blocks, and the pictographs, as a terminal lays them out. A span of one is
 * drawn two cells wide, so the row after it stays in its columns.
 */
export function wide(char) {
  const c = char.codePointAt(0) ?? 0
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0x303e) ||
    (c >= 0x3041 && c <= 0x33ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xa000 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1f64f) ||
    (c >= 0x1f900 && c <= 0x1f9ff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  )
}

const ESC = '\x1b'

/**
 * One drawn row as runs: `{ text, ink, ground, bold, italic, underline, wide,
 * link }`, each the longest stretch with one paint. A wide character is a run
 * of its own, so the page can give it two cells.
 */
export function runsOf(row) {
  const runs = []
  let pen = { ...PEN }
  let link = null
  let text = ''
  const flush = () => {
    if (text === '') return
    runs.push(runOf(pen, link, text, false))
    text = ''
  }
  let i = 0
  while (i < row.length) {
    const char = row[i]
    if (char === ESC) {
      const next = row[i + 1]
      if (next === '[') {
        // CSI: parameters, then one final byte between @ and ~.
        let end = i + 2
        while (end < row.length && !/[@-~]/.test(row[end] ?? '')) end++
        if (row[end] === 'm') {
          flush()
          const body = row.slice(i + 2, end)
          // A colon's sub-parameters are read as their first, as the pictures read them.
          const codes = body.split(';').map((one) => Number(one.split(':')[0]) || 0)
          pen = applySgr(pen, body === '' ? [0] : codes)
        }
        i = end + 1
        continue
      }
      if (next === ']') {
        // OSC, to BEL or ST: a hyperlink is the one that means anything here.
        let end = i + 2
        while (
          end < row.length &&
          row[end] !== '\x07' &&
          !(row[end] === ESC && row[end + 1] === '\\')
        )
          end++
        const body = row.slice(i + 2, end)
        if (body.startsWith('8;')) {
          flush()
          const url = body.slice(body.indexOf(';', 2) + 1)
          link = url === '' ? null : url
        }
        i = end + (row[end] === '\x07' ? 1 : 2)
        continue
      }
      // Any other escape is two characters that draw nothing.
      i += 2
      continue
    }
    const point = row.codePointAt(i) ?? 0
    const whole = String.fromCodePoint(point)
    i += whole.length
    if (point < 0x20 || point === 0x7f) continue
    if (wide(whole)) {
      flush()
      runs.push(runOf(pen, link, whole, true))
      continue
    }
    text += whole
  }
  flush()
  return runs
}

function runOf(pen, link, text, isWide) {
  const { ink, ground } = paintOf(pen)
  return {
    text,
    ink,
    ground,
    bold: pen.bold,
    italic: pen.italic,
    underline: pen.underline,
    wide: isWide,
    link,
  }
}
