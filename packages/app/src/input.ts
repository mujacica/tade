import {
  compositeTuiLine,
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { Skin } from './skin.ts'

// Selecting text: in the line you type on, and in the file you have open.
//
// Both hold the text and the caret themselves — pi's own editor on the one
// hand, the viewer's `Edited` on the other — and a terminal editor that
// reports its own mouse has to be told what a second click means. So what is
// selected is kept beside them, as two offsets into the text: where the
// selection was started, and where the caret has since taken it. Everything a
// click or a key does to those two numbers is in this file, pure, because it
// is arithmetic over a string and nothing about it needs a terminal.
//
// One model for both, because two would drift: a word is the same run of
// letters in a file as on the line, shift and an arrow reach the same way, and
// what a second press takes is not something anybody should have to learn
// twice. What differs is only who is pressed on behalf of — the editor that
// holds the text — and that is the caller's.
//
// Offsets are indexes into the whole text, newlines included, so a selection
// that runs over several lines is still two numbers. Both editors count in
// (line, column), which is the same thing said twice — `offsetOf` and
// `placeOf` are the only places that translate.

/** What is selected: where it was started, and where the caret has taken it. */
export interface Selection {
  anchor: number
  head: number
}

/** A stretch of text, in reading order. */
export interface Span {
  from: number
  to: number
}

/**
 * The selection in reading order, or nothing when it covers nothing — a caret
 * with no selection is an anchor that never moved, not a span of zero width
 * somebody has to remember to check for.
 */
export function spanOf(selection: Selection | null): Span | null {
  if (!selection) return null
  const from = Math.min(selection.anchor, selection.head)
  const to = Math.max(selection.anchor, selection.head)
  return to > from ? { from, to } : null
}

/** A position in the lines an editor holds: which line, and how far into it. */
export interface Place {
  line: number
  col: number
}

/** The offset the editor's caret is at, from the lines it holds. */
export function offsetOf(lines: readonly string[], cursor: Place): number {
  const line = Math.max(0, Math.min(cursor.line, lines.length - 1))
  let at = 0
  for (let i = 0; i < line; i++) at += (lines[i]?.length ?? 0) + 1
  return at + Math.max(0, Math.min(cursor.col, lines[line]?.length ?? 0))
}

/** Where an offset falls: which line, and how far into it. */
export function placeOf(lines: readonly string[], offset: number): Place {
  let left = Math.max(0, offset)
  for (let i = 0; i < lines.length; i++) {
    const length = lines[i]?.length ?? 0
    if (left <= length || i === lines.length - 1) return { line: i, col: Math.min(left, length) }
    left -= length + 1
  }
  return { line: 0, col: 0 }
}

/**
 * What a selection covers on one line of it: the characters it takes, and
 * whether it runs on past the end of the line.
 *
 * For a drawing laid out a line at a time — the file viewer's — where working
 * the offsets out again per row would walk the lines from the top on every
 * one of them. The two ends are placed once, and each row is then a
 * comparison. `eol` is the line break at the end of the row being inside the
 * selection: it is a cell of its own, so a selection through an empty line is
 * something you can see rather than a hole in it.
 */
export function onLine(
  span: { from: Place; to: Place },
  line: number,
  length: number,
): { from: number; to: number; eol: boolean } | null {
  if (line < span.from.line || line > span.to.line) return null
  const from = line === span.from.line ? Math.min(span.from.col, length) : 0
  const to = line === span.to.line ? Math.min(span.to.col, length) : length
  const eol = line < span.to.line
  return to > from || eol ? { from, to, eol } : null
}

/** The text a span covers, out of the lines it runs through. */
export function textOf(lines: readonly string[], span: Span): string {
  const from = placeOf(lines, span.from)
  const to = placeOf(lines, span.to)
  if (from.line === to.line) return (lines[from.line] ?? '').slice(from.col, to.col)
  const out = [(lines[from.line] ?? '').slice(from.col)]
  for (let i = from.line + 1; i < to.line; i++) out.push(lines[i] ?? '')
  out.push((lines[to.line] ?? '').slice(0, to.col))
  return out.join('\n')
}

const WORD = /[\p{L}\p{N}_]/u
const SPACE = /\s/u

type Class = 'word' | 'space' | 'other'

function classOf(char: string | undefined): Class | null {
  if (char === undefined || char === '\n') return null
  if (WORD.test(char)) return 'word'
  if (SPACE.test(char)) return 'space'
  return 'other'
}

/**
 * The word around an offset, as a double click takes it: the run of letters
 * and digits it is in, or the run of punctuation, or the run of spaces —
 * whichever kind of character is there. A double click between two words
 * takes the one it is at the start of, which is where the caret would land.
 */
export function wordAt(text: string, at: number): Span {
  const where = Math.max(0, Math.min(at, text.length))
  const here = classOf(text[where])
  const before = classOf(text[where - 1])
  // A word wins over what is beside it: clicking just after one takes that
  // word rather than the space you landed in. Otherwise it is the run of
  // whatever is under the caret, and at the end of a line what is behind it.
  const kind = here === 'word' || before === 'word' ? 'word' : (here ?? before)
  if (kind === null) return { from: where, to: where }
  let from = where
  let to = where
  while (from > 0 && classOf(text[from - 1]) === kind) from--
  while (to < text.length && classOf(text[to]) === kind) to++
  return { from, to }
}

/**
 * Where a word-wise move lands, from an offset: over the spaces in the way,
 * then over the run of whatever is next to them. The same runs `wordAt` takes,
 * walked rather than spread out from a point, which is what alt and an arrow
 * do in every text box.
 *
 * A move that lands where it started has nowhere to go on this line, and the
 * editor that asked takes it off the end of the line as its plain arrow would.
 */
export function wordStep(text: string, at: number, back: boolean): number {
  let where = Math.max(0, Math.min(at, text.length))
  if (back) {
    while (where > 0 && classOf(text[where - 1]) === 'space') where--
    const kind = classOf(text[where - 1])
    while (where > 0 && classOf(text[where - 1]) === kind) where--
    return where
  }
  while (where < text.length && classOf(text[where]) === 'space') where++
  const kind = classOf(text[where])
  while (where < text.length && classOf(text[where]) === kind) where++
  return where
}

/**
 * The line around an offset, as a triple click takes it: from after the
 * newline before it to before the newline after it. The newline itself is not
 * in it, so a line selected and typed over leaves the line break alone.
 */
export function lineAt(text: string, at: number): Span {
  const where = Math.max(0, Math.min(at, text.length))
  const start = text.lastIndexOf('\n', where - 1)
  const end = text.indexOf('\n', where)
  return { from: start + 1, to: end === -1 ? text.length : end }
}

/**
 * What a click of this many presses selects, in the order every text editor
 * does it: one puts the caret down, two takes the word, three takes the line.
 * The person who asked for this paired two clicks with the whole message and
 * three with a word — the other way round — and the convention wins, because
 * a window that selects differently from every other text box is a window you
 * have to learn.
 */
export function clickedSpan(text: string, at: number, clicks: number): Span {
  if (clicks >= 3) return lineAt(text, at)
  if (clicks === 2) return wordAt(text, at)
  return { from: at, to: at }
}

// A paste is not typing, and a terminal says so.
//
// Bracketed paste mode (`\x1b[?2004h`, which the window turns on) wraps
// everything pasted in two markers, so a program can tell a key from text
// somebody put on the clipboard. Every field in Tade has to know that, because
// what arrives is one string beginning with an escape — and a field that drops
// anything beginning with an escape drops the whole paste, which is what
// pasting a Sentry DSN into Settings did.
//
// Here, with the rest of what a key or a click means to text, because there
// were three copies of this: two decoders that already disagreed about which
// end marker ends a paste, and one filter that threw pastes away.

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * The text of a paste, or null when this is not one.
 *
 * The first end marker ends it: a terminal takes the markers out of what it is
 * pasting, so one inside a paste is not something that arrives. A paste whose
 * end has not arrived at all is what did arrive rather than nothing — the
 * terminal gathers the pieces of a long paste and hands the window one whole
 * string (pi-tui's stdin buffer does this), so a paste without its end marker
 * is a terminal misbehaving, and half a key beats none of it.
 */
export function pastedText(data: string): string | null {
  if (!data.startsWith(PASTE_START)) return null
  const end = data.indexOf(PASTE_END, PASTE_START.length)
  return data.slice(PASTE_START.length, end < 0 ? undefined : end)
}

/** Text wrapped the way a terminal wraps a paste, for a program that asked for them. */
export function asPaste(text: string): string {
  return `${PASTE_START}${text}${PASTE_END}`
}

/** What a keystroke means to a line with a selection in it. */
export type LineKey =
  | { do: 'select all' }
  /** Backspace and delete: the selection when there is one, a character when there is not. */
  | { do: 'delete'; forward: boolean }
  /**
   * The caret moves, `by` that much at a time. `extend` is shift held, which
   * takes the selection with it; without it the selection is let go.
   */
  | { do: 'move'; by: 'char' | 'word' | 'line' | 'row' | 'page'; back: boolean; extend: boolean }

/** The bytes a terminal sends for a key, for handing the editor a motion of its own. */
const SEQUENCES: Record<string, string> = {
  left: '\x1b[D',
  right: '\x1b[C',
  home: '\x1b[H',
  end: '\x1b[F',
  'alt+left': '\x1b[1;3D',
  'alt+right': '\x1b[1;3C',
  backspace: '\x7f',
}

/** What to hand the editor for a key we name ourselves. */
export function sequenceFor(key: string): string {
  return SEQUENCES[key] ?? ''
}

/**
 * As much of pi's editor as selecting needs: what it holds, where its caret
 * is, and the keys that move it. It owns both, so nothing here reaches into
 * it — a caret is moved by pressing the keys that move a caret, and text is
 * taken out by pressing the key that takes text out. Slower than reaching in,
 * and right in every case reaching in would have to be taught about: a
 * grapheme made of four code points, a paste collapsed to one marker, a line
 * that wraps.
 */
export interface Held {
  getText(): string
  getLines(): readonly string[]
  getCursor(): { line: number; col: number }
  setText(text: string): void
  handleInput(data: string): void
}

/** Where the caret is, as one offset into the text. */
export function caretOf(held: Held): number {
  return offsetOf(held.getLines(), held.getCursor())
}

/**
 * Put the caret at an offset: left and right step a grapheme and wrap over a
 * line break, home and end cross a line in one press. Bounded by how far
 * there is to go, and it gives up the moment a press moves nothing — a caret
 * that cannot reach where it was sent must stop, not spin.
 */
export function putCaret(held: Held, offset: number): void {
  const text = held.getText()
  const target = Math.max(0, Math.min(offset, text.length))
  for (let guard = text.length + held.getLines().length + 8; guard > 0; guard--) {
    const lines = held.getLines()
    const at = offsetOf(lines, held.getCursor())
    if (at === target) return
    const here = placeOf(lines, at)
    const there = placeOf(lines, target)
    const end = lines[here.line]?.length ?? 0
    held.handleInput(
      sequenceFor(
        there.line === here.line
          ? there.col < here.col
            ? 'left'
            : 'right'
          : there.line < here.line
            ? here.col === 0
              ? 'left'
              : 'home'
            : here.col === end
              ? 'right'
              : 'end',
      ),
    )
    if (caretOf(held) === at) return
  }
}

/**
 * Take a span out, leaving the caret where it began: from its far end, with
 * the editor's own backspace, so one press takes exactly what the editor
 * thinks one character is. All of it at once is worth the shortcut.
 */
export function cutSpan(held: Held, span: Span): void {
  const text = held.getText()
  if (span.from <= 0 && span.to >= text.length) {
    held.setText('')
    return
  }
  putCaret(held, span.to)
  for (let guard = text.length + 1; guard > 0; guard--) {
    const at = caretOf(held)
    if (at <= span.from) return
    held.handleInput(sequenceFor('backspace'))
    if (caretOf(held) === at) return
  }
}

/**
 * What a key does to the line, or nothing when it is the editor's own
 * business. Only the keys a selection changes the meaning of are named here:
 * everything else — a letter, a paste, ctrl+w, undo — is pi's editor's, and
 * arrives there having first replaced whatever was selected.
 *
 * Ctrl+A selects everything, which is what every text box does and what was
 * asked for; the start of the line is still Home, and still ctrl+a in the
 * terminals and agents Tade never takes a key from.
 */
export function lineKey(key: string | null): LineKey | null {
  if (!key) return null
  const parts = key.split('+')
  const name = (parts.pop() ?? '').toLowerCase()
  const mods = new Set(parts)
  const shift = mods.has('shift')
  const word = mods.has('ctrl') || mods.has('alt')
  if (name === 'a' && !shift && (mods.has('ctrl') || mods.has('super'))) return { do: 'select all' }
  // The end of the line, as every shell binds it. Its opposite is ctrl+a,
  // which is spoken for above — the start of the line is Home.
  if (name === 'e' && mods.has('ctrl'))
    return { do: 'move', by: 'line', back: false, extend: shift }
  if (!word) {
    if (name === 'backspace') return { do: 'delete', forward: false }
    if (name === 'delete') return { do: 'delete', forward: true }
    if (name === 'home') return { do: 'move', by: 'line', back: true, extend: shift }
    if (name === 'end') return { do: 'move', by: 'line', back: false, extend: shift }
  }
  if (name === 'pageup' || name === 'pagedown')
    return { do: 'move', by: 'page', back: name === 'pageup', extend: shift }
  if (name === 'up' || name === 'down')
    return { do: 'move', by: 'row', back: name === 'up', extend: shift }
  if (name === 'left' || name === 'right')
    return { do: 'move', by: word ? 'word' : 'char', back: name === 'left', extend: shift }
  return null
}

/** A drawn row of the line, and where in the text it starts. */
export interface RowStart {
  /** The row as the editor drew it, colour and caret included. */
  row: string
  /** Where its first character is in the text, or null when it could not be placed. */
  at: number | null
  /** How many characters of the text it draws. */
  length: number
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Where each drawn row of the line starts in the text.
 *
 * Read back out of what was drawn rather than worked out again: the editor
 * wraps the text its own way and scrolls it its own way, and a second
 * description of that here would be right until the day it was not. So each
 * row's own characters are looked for in the text, from where the last row
 * left off — a row that cannot be placed is simply left alone. What is at
 * stake either way is a highlight: what is selected, and what a key does to
 * it, are the two offsets, and neither is read back off the screen.
 */
export function rowStarts(rows: readonly string[], text: string, pad: number): RowStart[] {
  const out: RowStart[] = []
  let from = 0
  for (const row of rows) {
    const plain = stripTerminalSequences(row).slice(pad).replace(/\s+$/, '')
    if (plain === '') {
      // An empty row is an empty line, or the blank one the caret sits on at
      // the end of the text: it starts after the break that ended the row
      // before it.
      if (text[from] === '\n') from += 1
      out.push({ row, at: Math.min(from, text.length), length: 0 })
      continue
    }
    const at = text.indexOf(plain, from)
    if (at === -1) {
      out.push({ row, at: null, length: plain.length })
      continue
    }
    out.push({ row, at, length: plain.length })
    from = at + plain.length
  }
  return out
}

/**
 * The columns of a drawn row a span covers, or nothing when it covers none of
 * it. A selection that carries on past the end of the row takes one more cell
 * where the line ends, so a line break and an empty line in the middle of a
 * selection are visible rather than a hole in it.
 */
export function cellsOf(
  row: RowStart,
  text: string,
  span: Span,
  pad: number,
): { from: number; to: number } | null {
  if (row.at === null) return null
  const plain = stripTerminalSequences(row.row).slice(pad).replace(/\s+$/, '')
  let column = 0
  let at = row.at
  let first: number | null = null
  let last = 0
  for (const { segment } of GRAPHEMES.segment(plain)) {
    const next = at + segment.length
    if (at < span.to && next > span.from) {
      if (first === null) first = column
      last = column + visibleWidth(segment)
    }
    column += visibleWidth(segment)
    at = next
  }
  // The break at the end of the row, when the selection runs over it.
  if (at >= span.from && at < span.to && text[at] === '\n') {
    if (first === null) first = column
    last = column + 1
  }
  return first === null ? null : { from: first + pad, to: last + pad }
}

/**
 * The drawn rows with the selection laid on them.
 *
 * Laid over what was drawn, in the skin's own selection colour, the way a
 * match and a caret are laid over a line of a file: the editor drew the text
 * and the caret in it, and painting a background under them is all this does.
 * A row whose cells do not come back the width they went in is left as it
 * was — a highlight that changes a row's width tears the window it is in.
 */
export function withSelection(
  rows: readonly string[],
  text: string,
  span: Span,
  skin: Skin,
  pad: number,
  width: number,
): string[] {
  const placed = rowStarts(rows, text, pad)
  return placed.map((row) => {
    const cells = cellsOf(row, text, span, pad)
    if (!cells) return row.row
    const columns = cells.to - cells.from
    if (columns <= 0 || cells.to > width) return row.row
    const under = sliceByColumn(row.row, cells.from, columns, true)
    if (visibleWidth(under) > columns) return row.row
    const painted = skin.selected(under === '' ? ' '.repeat(columns) : under)
    // A skin with no colour has nothing to lay under a letter, and laying
    // nothing over the row would still rewrite it.
    if (painted === under || visibleWidth(painted) !== columns) return row.row
    return compositeTuiLine(row.row, painted, cells.from, columns, width)
  })
}
