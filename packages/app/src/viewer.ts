import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { Markdown, type MarkdownTheme } from '@earendil-works/pi-tui'
import { highlight, languageOf } from './highlight.ts'

// A file, read to be looked at inside the window.
//
// A preview, not an editor: the viewer has a button for the editor you already
// have. So it reads at most `VIEW_BYTES` of a file, says when it stopped, and
// shows a binary file as the fact that it is one rather than as noise.

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
  /** Why it could not be read, in words. */
  error: string | null
}

export function readForView(path: string, limit = VIEW_BYTES): ViewedFile {
  const empty = { path, size: 0, binary: false, truncated: false, text: '' }
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
      error: null,
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const error =
      code === 'ENOENT'
        ? 'It is not there any more.'
        : code === 'EACCES' || code === 'EPERM'
          ? 'Wilco is not allowed to read it.'
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

/** Markdown as it reads, at a width: headings, lists and code blocks laid out. */
export function formattedLines(file: ViewedFile, width: number, plain: boolean): string[] {
  const markdown = new Markdown(file.text, 1, 0, plain ? PLAIN_THEME : COLOUR_THEME)
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
