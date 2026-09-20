// ANSI to HTML, for looking at screens outside a terminal.
//
// The same parser the pictures use (`terminal.ts`), so the gallery and the
// README can never come to disagree about what a code means — and the same
// theme, so a page of screens is the terminal the pictures are taken in.

import { escapeHtml } from './escape.ts'
import { paintOf, THEME, type Theme, toCells } from './terminal.ts'

export { colour256 } from './terminal.ts'

export function ansiToHtml(line: string, theme: Theme = THEME): string {
  let out = ''
  let run = ''
  let style = ''
  const flush = () => {
    if (run === '') return
    out += style === '' ? escapeHtml(run) : `<span style="${style}">${escapeHtml(run)}</span>`
    run = ''
  }
  for (const cell of toCells(line, theme)) {
    if (cell.width === 0) continue
    const { ink, ground } = paintOf(cell, theme)
    const mine = [
      `color:${ink}`,
      ground === null ? '' : `background:${ground}`,
      cell.bold ? 'font-weight:700' : '',
      cell.italic ? 'font-style:italic' : '',
      cell.underline ? 'text-decoration:underline' : '',
    ]
      .filter(Boolean)
      .join(';')
    if (mine !== style) {
      flush()
      style = mine
    }
    run += cell.ch
  }
  flush()
  return out
}
