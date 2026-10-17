import { isText } from '@tade/core'
import { ELIDED, pathIn } from './fields.ts'

// One agent's screen, as it may leave the machine.
//
// **A fourth kind of value, and the least trustworthy one here.** Metadata is
// Tade's own words, authored text is the owner's and outside text is a
// stranger's — and all three are *somebody's sentences*. A lane's screen is
// none of those: it is whatever an agent printed, and an agent prints the file
// it just read, the command it just ran with its arguments, and on a bad day
// the environment it was started with. `fields.ts` calls a lane's bytes the
// field "that can carry anything an agent printed by accident", and that
// sentence stands; what is here is the bounded, scrubbed copy a person granted
// `lanes` at the machine may read while they are looking.
//
// What is taken out, and the claim is exactly this and nothing stronger:
//
// 1. **Every machine path**, by `withoutPaths`' own rule (`pathIn`), so the
//    away view's claim — *it adds no path of its own* — stays true of the one
//    string on the page that is mostly paths.
// 2. **Every key Tade knows of** — what the window hands over as `known`: the
//    keys in the config, the variables they are read from, and every variable
//    of the window's own environment named like a credential, which is the
//    environment every agent inherits. Exact values, so this half is a
//    guarantee rather than a guess, and it is the half that matters most:
//    an agent that runs `env` prints exactly these.
// 3. **Anything shaped like a credential** (`CREDENTIALS`): an issuer's own
//    prefix, a JWT, a value after a name that says what it is, a password in a
//    URL, a private key's whole block. A net and not a promise, which is why
//    `GRANT_MEANS.lanes` says the other half out loud.
//
// What is **not** taken out is everything else an agent printed, and nothing
// here pretends otherwise.
//
// **A terminal wraps, and a scrubber that reads row by row is beaten by it.**
// A 100-character key printed on an 80-column screen is two rows, and neither
// row contains the key. So rows that fill the screen's width are joined to the
// row under them before anything is looked for (`segmentsOf`), the marks are
// made over the joined text, and the rows are cut apart again afterwards — a
// key, a credential or a path split by the wrap is taken out on both rows.
//
// **Bounded twice.** The last `lines` rows and never the scrollback above them
// (the window asks the driver for no more than this, and this cuts again), and
// each row cut at `width` code points. What was left out is counted, so a page
// says *there was more* rather than drawing a screen that looks whole.
//
// Pure: no `node:` import, no clock, nothing awaited.

/** How much of a lane's screen one answer carries. */
export interface ScreenBudget {
  /** The newest rows, and no more: a screen, never its scrollback. */
  lines: number
  /** Code points of one row. A terminal is rarely wider; a minified file is. */
  width: number
}

/**
 * Forty rows of two hundred and forty: a laptop terminal's height and twice
 * its width, so a page shows what somebody at the machine would see and a
 * minified bundle somebody `cat`ted cannot put a megabyte on the wire.
 */
export const SCREEN: ScreenBudget = { lines: 40, width: 240 }

/**
 * The shortest key worth looking for, in characters.
 *
 * Below this a value is a word: a variable called `GITHUB_TOKEN` holding `yes`
 * would take every `yes` off the screen and tell the reader nothing.
 */
export const KNOWN_FLOOR = 8

/** One screen, as it may be read from away. */
export interface Cleaned {
  lines: string[]
  /** Rows that were on the screen above these and are not here. */
  above: number
  /** Rows here that were cut at the budget's width. */
  cut: number
  /** How many things were taken out. A count, never what or where. */
  taken: number
}

/**
 * One row with every character that is not text taken out, by core's one rule
 * (`isText`, `printable.ts`): controls, and the marks that reorder or hide what
 * is drawn around them. A tab is a space here: the driver has already rendered
 * the screen, so a tab that is left is a byte in a row and not a column.
 */
function textOnly(row: string): string {
  let out = ''
  for (const one of row) if (isText(one.codePointAt(0) ?? 0)) out += one
  return out
}

/**
 * Shapes a credential has, and which part of a match is the secret.
 *
 * Where `group` is set only that group goes, so `ANTHROPIC_API_KEY=…` keeps
 * the name — which is what a person reading the screen needs to know what the
 * agent was doing — and loses the value. Each issuer's prefix is the shape its
 * own documentation gives; the last three are about the *place* a value is in
 * rather than what it looks like, because a key somebody minted for an
 * internal service has no prefix anybody here could list.
 */
const CREDENTIALS: readonly { shape: RegExp; group?: number }[] = [
  { shape: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { shape: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { shape: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { shape: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  { shape: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { shape: /\bsntry[su]_[A-Za-z0-9_=+/-]{8,}/g },
  { shape: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { shape: /\bAIza[0-9A-Za-z_-]{35}/g },
  // A JWT: three base64url parts, the first of which is always `ey`.
  { shape: /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}/g },
  // A short prefix and a long random tail, which is what nearly every issuer's
  // key looks like — `telemetry/shape.ts` takes the same shape off a report.
  { shape: /\b[A-Za-z][A-Za-z0-9]{1,11}_[A-Za-z0-9]{24,}\b/g },
  // A value after a name that says what it is: `X_API_KEY=…`, `"token": "…"`,
  // `password: …`. Eight characters or more, so `tokens: 1234` in a usage line
  // is left alone.
  {
    shape:
      /\b[\w.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|auth[_-]?key)[\w.-]*["']?\s*[:=]\s*["']?([^\s"',;]{8,})/dgi,
    group: 1,
  },
  { shape: /\b(?:bearer|basic)\s+([A-Za-z0-9._~+/=-]{8,})/dgi, group: 1 },
  // A password in a URL: `https://user:secret@host`.
  { shape: /\b[a-z][a-z0-9+.-]*:\/\/([^\s/:@]+:[^\s/@]+)@/dgi, group: 1 },
]

/** A private key's block: every row from its first line to its last goes. */
const KEY_BEGINS = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
const KEY_ENDS = /-----END [A-Z0-9 ]*PRIVATE KEY-----/

/**
 * One screen, cleaned and bounded.
 *
 * `known` is every value the window knows to be a key. It is handed in rather
 * than looked up, because this file reads nothing — and because the window is
 * the one process that holds the config and the environment agents inherit.
 */
export function cleanScreen(
  text: string,
  known: readonly string[],
  budget: ScreenBudget = SCREEN,
): Cleaned {
  const all = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((row) => textOnly(row.replace(/\t/g, ' ')).trimEnd())
  while (all.length > 0 && all[all.length - 1] === '') all.pop()
  const most = Math.max(1, budget.lines)
  // **One row more than is kept**, so a key the terminal wrapped from the row
  // above the cut into the first row kept is still joined up and found.
  const from = Math.max(0, all.length - most - 1)
  const rows = all.slice(from)
  const keys = keysOf(known)
  let taken = 0
  const blocked = keyBlocks(rows)
  for (const at of blocked) rows[at] = ELIDED
  taken += countRuns(blocked)
  for (const segment of segmentsOf(rows, blocked)) {
    const flat = segment.map((at) => rows[at] ?? '').join('')
    const mask = new Uint8Array(flat.length)
    markKnown(flat, keys, mask)
    markShapes(flat, mask)
    markPaths(flat, mask)
    taken += runs(mask)
    let offset = 0
    for (const at of segment) {
      const row = rows[at] ?? ''
      rows[at] = masked(row, mask, offset)
      offset += row.length
    }
  }
  const kept = rows.slice(Math.max(0, rows.length - most))
  let cut = 0
  const lines = kept.map((row) => {
    const points = [...row]
    if (points.length <= budget.width) return row
    cut += 1
    return points.slice(0, budget.width).join('')
  })
  return { lines, above: all.length - lines.length, cut, taken }
}

/**
 * Something an agent wrote that is not a screen — the command an approval asks
 * about (`command.ts`) — with what a screen loses taken out the same way: a
 * private key's block, every key Tade knows of and anything shaped like a
 * credential, each one `…`. Its paths are left where they are, for whoever
 * shortens them, and nothing is cut to a budget.
 */
export function withoutCredentials(text: string, known: readonly string[]): string {
  const rows = text.split('\n')
  for (const at of keyBlocks(rows)) rows[at] = ELIDED
  const flat = rows.join('\n')
  const mask = new Uint8Array(flat.length)
  markKnown(flat, keysOf(known), mask)
  markShapes(flat, mask)
  return masked(flat, mask, 0)
}

/** The keys worth looking for, longest first so a key inside a key goes whole. */
function keysOf(known: readonly string[]): string[] {
  const kept = new Set<string>()
  for (const one of known) {
    const value = one.trim()
    if (value.length >= KNOWN_FLOOR) kept.add(value)
  }
  return [...kept].sort((a, b) => b.length - a.length)
}

/** The rows inside a private key's block, its first and last included. */
function keyBlocks(rows: readonly string[]): Set<number> {
  const inside = new Set<number>()
  let open = false
  for (const [at, row] of rows.entries()) {
    if (!open && KEY_BEGINS.test(row)) open = true
    if (open) inside.add(at)
    if (open && KEY_ENDS.test(row)) open = false
  }
  return inside
}

/** How many separate blocks a set of row numbers is. */
function countRuns(rows: ReadonlySet<number>): number {
  let n = 0
  for (const at of rows) if (!rows.has(at - 1)) n += 1
  return n
}

/**
 * Rows a terminal wrapped, joined back into the line they were.
 *
 * A row is a wrap when it fills the widest row on the screen: what a terminal
 * does to a line longer than its width is cut it at exactly that width. The
 * guess can join two rows that were never one line — a box drawn to the edge —
 * and the cost of that is a word marked that did not need to be, which is the
 * direction this file is allowed to be wrong in.
 */
function segmentsOf(rows: readonly string[], skip: ReadonlySet<number>): number[][] {
  const widest = rows.reduce((most, row) => Math.max(most, row.length), 0)
  const segments: number[][] = []
  let open: number[] = []
  for (const [at, row] of rows.entries()) {
    if (skip.has(at)) {
      if (open.length > 0) segments.push(open)
      open = []
      continue
    }
    open.push(at)
    const wrapped = widest >= 20 && row.length === widest
    if (!wrapped) {
      segments.push(open)
      open = []
    }
  }
  if (open.length > 0) segments.push(open)
  return segments
}

function markKnown(flat: string, keys: readonly string[], mask: Uint8Array): void {
  for (const key of keys) {
    let at = flat.indexOf(key)
    while (at >= 0) {
      mask.fill(1, at, at + key.length)
      at = flat.indexOf(key, at + key.length)
    }
  }
}

function markShapes(flat: string, mask: Uint8Array): void {
  for (const one of CREDENTIALS) {
    one.shape.lastIndex = 0
    for (const found of flat.matchAll(one.shape)) {
      const span =
        one.group === undefined
          ? [found.index, found.index + found[0].length]
          : found.indices?.[one.group]
      if (span === undefined) continue
      mask.fill(1, span[0], span[1])
    }
  }
}

function markPaths(flat: string, mask: Uint8Array): void {
  for (const word of flat.matchAll(/\S+/g)) {
    const at = pathIn(word[0])
    if (at !== null) mask.fill(1, word.index + at.from, word.index + at.to)
  }
}

/** How many separate things a mask took out. */
function runs(mask: Uint8Array): number {
  let n = 0
  for (let at = 0; at < mask.length; at += 1) {
    if (mask[at] === 1 && (at === 0 || mask[at - 1] !== 1)) n += 1
  }
  return n
}

/** One row with every marked run in it replaced by one `…`. */
function masked(row: string, mask: Uint8Array, offset: number): string {
  let out = ''
  for (let at = 0; at < row.length; at += 1) {
    if (mask[offset + at] !== 1) {
      out += row[at]
      continue
    }
    if (at === 0 || mask[offset + at - 1] !== 1) out += ELIDED
  }
  return out
}
