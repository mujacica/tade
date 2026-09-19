import { closeSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import { Markdown, type MarkdownTheme, visibleWidth } from '@earendil-works/pi-tui'
import { highlight, languageOf } from './highlight.ts'

// A file, read to be looked at inside the window — and typed into, a little.
//
// Still not the editor you already have: it reads at most `VIEW_BYTES` of a
// file, says when it stopped, and shows a binary file as the fact that it is
// one rather than as noise. What it adds is the short edit — a name, a number,
// a line of prose — that is not worth leaving the window for. Anything longer
// has a button for the real editor two columns away.
//
// The edit itself is a value (`Edited`): lines, a caret and where each line
// came from, changed by pure functions and tested without a disk. Only reading
// and saving touch one.

/** More than anyone reads in a terminal panel, and a bound on what one click can cost. */
export const VIEW_BYTES = 1_000_000

export interface ViewedFile {
  /** Absolute. */
  path: string
  size: number
  binary: boolean
  /** Only the first `VIEW_BYTES` were read. */
  truncated: boolean
  language: string | null
  text: string
  /**
   * When it was last written, as the disk says. What a save checks has not
   * moved: agents change these files while you are reading them.
   */
  mtimeMs: number
  /** Why it could not be read, in words. */
  error: string | null
}

export function readForView(path: string, limit = VIEW_BYTES): ViewedFile {
  const empty = { path, size: 0, binary: false, truncated: false, text: '', mtimeMs: 0 }
  const language = languageOf(path)
  try {
    const stat = statSync(path)
    if (stat.isDirectory()) return { ...empty, language, error: 'That is a folder.' }
    const size = stat.size
    const buffer = Buffer.alloc(Math.min(size, limit))
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buffer, 0, buffer.length, 0)
    } finally {
      closeSync(fd)
    }
    // The test git itself uses: a NUL in the first 8000 bytes.
    const binary = buffer.subarray(0, 8000).includes(0)
    return {
      path,
      size,
      binary,
      truncated: size > limit,
      language,
      text: binary ? '' : buffer.toString('utf8'),
      mtimeMs: stat.mtimeMs,
      error: null,
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const error =
      code === 'ENOENT'
        ? 'It is not there any more.'
        : code === 'EACCES' || code === 'EPERM'
          ? 'Tade is not allowed to read it.'
          : err instanceof Error
            ? err.message
            : String(err)
    return { ...empty, language, error }
  }
}

/** Whether a file can be shown formatted as well as as source. */
export function formattable(file: ViewedFile): boolean {
  return file.language === 'markdown' && !file.binary && file.error === null
}

/** The source, one coloured line per line of the file. */
export function sourceLines(file: ViewedFile, plain: boolean): string[] {
  if (file.binary || file.error) return []
  const lines = highlight(file.text, file.language, plain)
  // A file ending in a newline has no empty last line to show.
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * The same lines with no colour on them: what a find looks through, what an
 * edit starts from, and what a click has to count columns in. One for one with
 * `sourceLines`, or the caret would land on a different line than it is drawn.
 */
export function textLines(file: ViewedFile): string[] {
  if (file.binary || file.error) return []
  const lines = file.text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  return lines
}

/** One line coloured on its own: a line just typed, which no whole-file pass has seen. */
export function colouredLine(text: string, language: string | null, plain: boolean): string {
  return highlight(text, language, plain)[0] ?? text
}

/** Markdown as it reads, at a width: headings, lists and code blocks laid out. */
export function formattedLines(file: ViewedFile, width: number, plain: boolean): string[] {
  return markdownLines(file.text, width, plain, 1)
}

/** Any markdown as it reads, at a width: the viewer's files, the orchestrator's answers. */
export function markdownLines(text: string, width: number, plain: boolean, padding = 0): string[] {
  const markdown = new Markdown(text, padding, 0, plain ? PLAIN_THEME : COLOUR_THEME)
  return markdown.render(Math.max(10, width))
}

const paint =
  (code: string) =>
  (text: string): string =>
    text === '' ? '' : `\x1b[${code}m${text}\x1b[0m`
const same = (text: string) => text

const COLOUR_THEME: MarkdownTheme = {
  heading: paint('38;5;80;1'),
  link: paint('38;5;75;4'),
  linkUrl: paint('38;5;244'),
  code: paint('38;5;114'),
  codeBlock: paint('38;5;252'),
  codeBlockBorder: paint('38;5;240'),
  quote: paint('38;5;248;3'),
  quoteBorder: paint('38;5;240'),
  hr: paint('38;5;240'),
  listBullet: paint('38;5;179'),
  bold: paint('1'),
  italic: paint('3'),
  strikethrough: paint('9'),
  underline: paint('4'),
  // A fence's language is whatever was typed after the backticks; highlight.js
  // knows the usual short names (`ts`, `sh`) and leaves anything else plain.
  highlightCode: (code, lang) => highlight(code, lang ?? null),
}

const PLAIN_THEME: MarkdownTheme = {
  heading: same,
  link: same,
  linkUrl: same,
  code: same,
  codeBlock: same,
  codeBlockBorder: same,
  quote: same,
  quoteBorder: same,
  hr: same,
  listBullet: same,
  bold: same,
  italic: same,
  strikethrough: same,
  underline: same,
}

/** A size the way people say it. */
export function bytes(size: number): string {
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(1)} MB`
  if (size >= 1_000) return `${Math.round(size / 1_000)} KB`
  return `${size} B`
}

// ── Finding ────────────────────────────────────────────────────────────

/** Where a query turned up: the line it is on, the column it starts at, its length. */
export interface Match {
  line: number
  column: number
  length: number
}

/**
 * More matches than anyone pages through one at a time. A query of `e` in a
 * megabyte would otherwise be tens of thousands of them, counted again on
 * every keystroke.
 */
export const MATCHES_MAX = 2_000

/**
 * Every place a query appears, top to bottom. Case is ignored until you type a
 * capital, which is how everyone expects a find box to behave: `todo` finds
 * `TODO`, `TODO` does not find `todo`.
 */
export function matchesIn(lines: readonly string[], query: string, max = MATCHES_MAX): Match[] {
  const found: Match[] = []
  if (query === '') return found
  const cased = query !== query.toLowerCase()
  const needle = cased ? query : query.toLowerCase()
  for (let line = 0; line < lines.length; line++) {
    const text = cased ? (lines[line] ?? '') : (lines[line] ?? '').toLowerCase()
    let at = text.indexOf(needle)
    while (at >= 0) {
      found.push({ line, column: at, length: query.length })
      if (found.length >= max) return found
      at = text.indexOf(needle, at + Math.max(1, needle.length))
    }
  }
  return found
}

// ── Typing into it ────────────────────────────────────────────────────────

/** A file being typed into: its lines as they now are, and where the caret is. */
export interface Edited {
  lines: readonly string[]
  /**
   * Where each line came from in the file as it was read, or `-1` for one
   * typed since. That is what lets a line nobody touched keep the colour the
   * whole-file pass gave it: colouring a megabyte again on every keystroke is
   * tens of milliseconds, and colouring the one line that changed is none.
   */
  from: readonly number[]
  /** The line the caret is on, counting from 0. */
  row: number
  /** The character it is before, counting from 0. Past the end is the end. */
  column: number
  /** What tab types here: whatever this file indents with. */
  indent: string
  /** Typed and not yet saved. */
  dirty: boolean
}

/** A tab is drawn as two spaces, here and in the viewer: one place decides that. */
export const TAB = '  '

/**
 * Where a character of a line is drawn, counting cells from the left: tabs
 * take two, a wide character takes two, everything else one. The caret and a
 * match are laid on a cell, not on a character, and a line of Japanese or of
 * tabs is where the two part company.
 */
export function cellOf(line: string, column: number): number {
  let cells = 0
  let at = 0
  for (const char of line) {
    if (at >= column) break
    cells += char === '\t' ? TAB.length : Math.max(1, visibleWidth(char))
    at += char.length
  }
  return cells
}

/** The same the other way: the character a cell is on, for a click. */
export function columnOf(line: string, cell: number): number {
  let cells = 0
  let at = 0
  for (const char of line) {
    if (cells >= cell) return at
    cells += char === '\t' ? TAB.length : Math.max(1, visibleWidth(char))
    at += char.length
  }
  return at
}

/**
 * How far the whole body slides left to keep a cell on screen. Derived from
 * the caret rather than remembered, so nothing can disagree about it: the view
 * that draws the rows and the click that lands on one work it out the same way.
 */
export function leftOf(cell: number, columns: number): number {
  return cell < columns ? 0 : cell - columns + 1
}

/** Why this file is not one to type into here, or null when it is. */
export function editable(file: ViewedFile): string | null {
  if (file.error) return file.error
  if (file.binary) return 'A binary file is not one to type into.'
  if (file.truncated)
    return `Only the first ${bytes(VIEW_BYTES)} of it were read — open it in your editor.`
  return null
}

/** A caret put down in a file, at a line and a column both clamped to what is there. */
export function editFrom(lines: readonly string[], row = 0, column = 0): Edited {
  const text = lines.length === 0 ? [''] : [...lines]
  // What the file already indents with: a tab in a file of tabs, two spaces
  // anywhere else. A short edit is no place to change a file's habits.
  const indent = text.some((line) => line.startsWith('\t')) ? '\t' : '  '
  return clamp({
    lines: text,
    from: text.map((_, i) => i),
    row,
    column,
    indent,
    dirty: false,
  })
}

/** The caret moved, and nothing else: a click, or an arrow. */
export function caretAt(edit: Edited, row: number, column: number): Edited {
  return clamp({ ...edit, row, column })
}

/** Text typed where the caret is, which then sits after it. */
export function typeIn(edit: Edited, text: string): Edited {
  let out = edit
  // A paste is lines, and each newline in it breaks the line — but brings no
  // indentation of its own: text that arrives already indented and is indented
  // again is the oldest paste bug there is.
  const parts = text.replace(/\r\n/g, '\n').split('\n')
  parts.forEach((part, at) => {
    if (at > 0) out = splitLine(out, false)
    if (part !== '') out = insert(out, part)
  })
  return out
}

/**
 * A key that moves the caret or changes the text, or null where it is not one
 * of those — so the panel can go on to read it as one of its own.
 */
export function editKey(edit: Edited, key: string | undefined, page = 20): Edited | null {
  const line = edit.lines[edit.row] ?? ''
  switch (key) {
    case 'left':
      // Off the front of a line is the end of the one above it.
      return edit.column > 0
        ? caretAt(edit, edit.row, edit.column - 1)
        : edit.row > 0
          ? caretAt(edit, edit.row - 1, Number.MAX_SAFE_INTEGER)
          : edit
    case 'right':
      return edit.column < line.length
        ? caretAt(edit, edit.row, edit.column + 1)
        : edit.row < edit.lines.length - 1
          ? caretAt(edit, edit.row + 1, 0)
          : edit
    case 'up':
      return caretAt(edit, edit.row - 1, edit.column)
    case 'down':
      return caretAt(edit, edit.row + 1, edit.column)
    case 'pageUp':
      return caretAt(edit, edit.row - page, edit.column)
    case 'pageDown':
      return caretAt(edit, edit.row + page, edit.column)
    case 'home':
    case 'ctrl+a':
      return caretAt(edit, edit.row, 0)
    case 'end':
    case 'ctrl+e':
      return caretAt(edit, edit.row, line.length)
    case 'enter':
      return splitLine(edit)
    case 'tab':
      return insert(edit, edit.indent)
    case 'backspace':
      return back(edit)
    case 'delete':
      return forward(edit)
    case 'ctrl+k':
      // What a shell does with it: the rest of the line goes.
      return change(edit, edit.row, line.slice(0, edit.column))
    default:
      return null
  }
}

/** What the file would hold, saved: its own line ending, and its own last line. */
export function editedText(edit: Edited, file: ViewedFile): string {
  const eol = file.text.includes('\r\n') ? '\r\n' : '\n'
  return edit.lines.join(eol) + (file.text.endsWith('\n') ? eol : '')
}

/**
 * Write what was typed back, and read the file again so what is on screen is
 * what is on disk.
 *
 * Refused if the file moved underneath: agents edit these files while you are
 * looking at them, and a window that quietly writes a minute-old copy over an
 * agent's work is worse than one that cannot save at all.
 */
export function saveEdited(file: ViewedFile, text: string): ViewedFile {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(file.path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new Error(code === 'ENOENT' ? 'It is not there any more.' : why(err))
  }
  if (stat.size !== file.size || stat.mtimeMs !== file.mtimeMs)
    throw new Error('It changed on disk since you opened it. Close it and open it again.')
  try {
    writeFileSync(file.path, text)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new Error(
      code === 'EACCES' || code === 'EPERM' ? 'Tade is not allowed to write it.' : why(err),
    )
  }
  return readForView(file.path)
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The caret, put back inside the text it is in. */
function clamp(edit: Edited): Edited {
  const row = Math.max(0, Math.min(edit.lines.length - 1, edit.row))
  const column = Math.max(0, Math.min((edit.lines[row] ?? '').length, edit.column))
  return { ...edit, row, column }
}

/** One line replaced by what was typed into it: it no longer comes from the file. */
function change(edit: Edited, row: number, text: string, column = edit.column): Edited {
  const lines = [...edit.lines]
  const from = [...edit.from]
  lines[row] = text
  from[row] = -1
  return clamp({ ...edit, lines, from, row, column, dirty: true })
}

function insert(edit: Edited, text: string): Edited {
  const line = edit.lines[edit.row] ?? ''
  return change(
    edit,
    edit.row,
    line.slice(0, edit.column) + text + line.slice(edit.column),
    edit.column + text.length,
  )
}

/** Enter: what is after the caret starts a new line, under the same indentation. */
function splitLine(edit: Edited, indented = true): Edited {
  const line = edit.lines[edit.row] ?? ''
  const head = line.slice(0, edit.column)
  const indent = indented ? (/^[\t ]*/.exec(head)?.[0] ?? '') : ''
  const tail = indent + line.slice(edit.column)
  const lines = [...edit.lines]
  const from = [...edit.from]
  lines.splice(edit.row, 1, head, tail)
  from.splice(edit.row, 1, -1, -1)
  return clamp({
    ...edit,
    lines,
    from,
    row: edit.row + 1,
    column: indent.length,
    dirty: true,
  })
}

/** Backspace: a character, or the line break that put this line under the last one. */
function back(edit: Edited): Edited {
  const line = edit.lines[edit.row] ?? ''
  if (edit.column > 0)
    return change(
      edit,
      edit.row,
      line.slice(0, edit.column - 1) + line.slice(edit.column),
      edit.column - 1,
    )
  if (edit.row === 0) return edit
  return joinUp(edit, edit.row)
}

/** Delete: the character after the caret, or the line break after this line. */
function forward(edit: Edited): Edited {
  const line = edit.lines[edit.row] ?? ''
  if (edit.column < line.length)
    return change(edit, edit.row, line.slice(0, edit.column) + line.slice(edit.column + 1))
  if (edit.row >= edit.lines.length - 1) return edit
  return { ...joinUp(edit, edit.row + 1), row: edit.row, column: line.length }
}

/** A line joined onto the end of the one above it, the caret at the seam. */
function joinUp(edit: Edited, row: number): Edited {
  const above = edit.lines[row - 1] ?? ''
  const lines = [...edit.lines]
  const from = [...edit.from]
  lines.splice(row - 1, 2, above + (lines[row] ?? ''))
  from.splice(row - 1, 2, -1)
  return clamp({ ...edit, lines, from, row: row - 1, column: above.length, dirty: true })
}
