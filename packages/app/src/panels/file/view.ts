import {
  compositeTuiLine,
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { Hit, Target } from '../../hits.ts'
import { onLine, type Place, placeOf } from '../../input.ts'
import { BAR, barRows } from '../../scrollbar.ts'
import type { Skin } from '../../skin.ts'
import { blank, box, type Drawn, fit as fitRow, Row } from '../../ui.ts'
import {
  bytes,
  cellOf,
  colouredLine,
  type Edited,
  editable,
  leftOf,
  type Match,
  TAB,
} from '../../viewer.ts'
import { tildeOf } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { type FileAsk, type FilePanel, fileMatches, fileSelection } from './state.ts'

// What the file viewer looks like: the lines, the selection laid over them,
// the bar along the bottom and what it is asking. What a key does to it is
// beside this in `state.ts`.

/** How big the file viewer is in a window this size, and how wide its text is. */
export function fileViewSize(
  width: number,
  height: number,
): { width: number; height: number; text: number } {
  const w = Math.max(40, Math.min(160, width - 4))
  return { width: w, height: Math.max(10, height - 2), text: w - 2 - 9 }
}

/**
 * The body of the file viewer: how many lines it shows at once, how wide they
 * are drawn, and how much of that the numbers down the side take.
 *
 * Exported because the app needs the same three numbers — to keep the caret in
 * view, and to turn the cell you clicked into the character you meant — and
 * two places working them out separately is two layouts to keep in step.
 */
export function fileBodySize(
  width: number,
  height: number,
  lines: number,
  bar = false,
): { rows: number; columns: number; gutter: number } {
  const size = fileViewSize(width, height)
  const gutter = Math.max(3, String(Math.max(1, lines)).length) + 4
  return {
    rows: Math.max(1, size.height - 6 - (bar ? 1 : 0)),
    columns: Math.max(1, size.width - 2 - BAR - gutter),
    gutter,
  }
}

export function fileView(panel: FilePanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const size = fileViewSize(ctx.width, ctx.height)
  const inner = size.width - 2
  const viewing = ctx.viewing?.file.path === panel.path ? ctx.viewing : null
  const file = viewing?.file ?? null
  const markdown = viewing?.formatted !== null && viewing !== null
  const formatted = markdown && panel.formatted
  const drawn = formatted ? (viewing?.formatted ?? []) : (viewing?.source ?? [])
  // Formatted Markdown has no line numbers, so it has no caret either.
  const edit = formatted ? null : panel.edit
  // What is selected, placed in the lines once: every row of the body then
  // asks about itself with a comparison, rather than counting the file from
  // the top again on each of them.
  const chosen = edit ? fileSelection(panel) : null
  const selection =
    chosen && edit
      ? { from: placeOf(edit.lines, chosen.from), to: placeOf(edit.lines, chosen.to) }
      : null
  const plain = edit ? edit.lines : (viewing?.text ?? [])
  const lines = edit ? edit.lines : drawn
  const typeable = file !== null && !formatted && editable(file) === null
  const control = (id: string) => ({ kind: 'control' as const, id })

  const head = new Row(inner, skin, ctx.pointer)
    .space()
    .text(tildeOf(panel.path, ctx.homeDir), skin.you)
  if (file && !file.error) {
    const facts = [
      file.language ?? (file.binary ? 'binary' : 'text'),
      file.binary ? null : `${lines.length} line${lines.length === 1 ? '' : 's'}`,
      bytes(file.size),
      file.truncated ? 'first 1 MB' : null,
    ].filter(Boolean)
    head.space(2).text(facts.join(' · '), skin.hint)
    if (edit?.dirty) head.space(2).text('● not saved', skin.waiting)
  }
  if (markdown) {
    head.right((r) =>
      r
        .tab('Formatted', control('formatted'), panel.formatted)
        .tab('Source', control('source'), !panel.formatted)
        .space(),
    )
  }
  const rows: { text: string; hits: Hit[] }[] = [
    head.build(),
    { text: skin.chrome('─'.repeat(inner)), hits: [] },
  ]

  // The one bar the panel opens: finding in the file, or going to a line. It
  // takes a line of the body rather than a line of the window, so the panel
  // keeps the height it had and nothing under the pointer moves.
  const matches = fileMatches(panel, plain)
  if (panel.asking) rows.push(fileBar(panel.asking, matches, inner, ctx))
  const geometry = fileBodySize(ctx.width, ctx.height, lines.length, panel.asking !== null)
  const body = geometry.rows
  if (!viewing) {
    rows.push(new Row(inner, skin).space(2).text('Reading…', skin.hint).build())
  } else if (file?.error || file?.binary) {
    rows.push(blank(inner))
    rows.push(
      new Row(inner, skin)
        .space(2)
        .text(
          file.error ?? `A binary file, ${bytes(file.size)}. Open it in its own app to see it.`,
          skin.hint,
        )
        .build(),
    )
  } else {
    // A column down the right is the file's scrollbar: where in it you are
    // reading, and a handle to move.
    const text = inner - BAR
    const digits = geometry.gutter - 4
    const scroll = Math.max(0, Math.min(panel.scroll, lines.length - body))
    // Where the caret is drawn, and how far the body has slid left to keep it
    // on screen: a long line is edited at its end as often as at its start.
    const gutterWidth = formatted ? 0 : geometry.gutter
    const caretLine = edit?.lines[edit.row] ?? ''
    const caretCell = edit ? cellOf(caretLine, edit.column) : 0
    // A block covers the character it is on, and a wide one is two cells.
    const caretCells = edit ? Math.max(1, cellOf(caretLine, edit.column + 1) - caretCell) : 1
    const left = edit ? leftOf(caretCell, geometry.columns) : 0
    const read: { text: string; hits: Hit[] }[] = []
    for (let offset = 0; offset < body; offset++) {
      const at = scroll + offset
      const number = at + 1
      const there = at < lines.length
      const marked = !formatted && panel.line === number
      const gutter =
        formatted || !there ? '' : `${marked ? '▶' : ' '}${String(number).padStart(digits)} │ `
      const room = Math.max(1, text - visibleCells(gutter))
      const source = there ? colouredAt(at, edit, viewing, ctx) : ''
      const tabbed = source.replaceAll('\t', TAB)
      const cut = fitRow(left === 0 ? tabbed : sliceByColumn(tabbed, left, room), room)
      const painted = `${formatted || !there ? '' : marked ? skin.signal(gutter.slice(0, 1)) + skin.you(gutter.slice(1, -2)) + skin.chrome('│ ') : skin.hint(gutter.slice(0, -2)) + skin.chrome('│ ')}${cut}`
      const hits: Hit[] = [
        { row: 0, from: 0, to: text - 1, target: { kind: 'scroll', area: 'panel' } },
      ]
      // Clicking the text puts the caret in it; clicking the numbers does not,
      // so the gutter is still somewhere to take hold of the file and scroll.
      if (typeable && lines.length > 0)
        hits.push({
          row: 0,
          from: gutterWidth,
          to: text - 1,
          target: { kind: 'caret', line: Math.min(at, lines.length - 1) },
        })
      read.push({
        text: laidOver(marked ? skin.selected(painted) : painted, {
          at,
          line: plain[at] ?? '',
          gutter: gutterWidth,
          left,
          width: text,
          matches,
          current: panel.asking?.kind === 'find' ? matches[panel.asking.index] : undefined,
          ...(selection ? { selection } : {}),
          ...(edit && edit.row === at ? { caret: caretCell, caretCells } : {}),
          skin,
        }),
        hits,
      })
    }
    const bar = barRows(
      { total: lines.length, shown: body, offset: scroll, rows: body },
      skin,
      ctx.scrolling === 'panel' || ctx.pointer.hover?.kind === 'scrollbar',
    )
    const target: Target = {
      kind: 'scrollbar',
      area: 'panel',
      total: lines.length,
      shown: body,
    }
    read.forEach((row, i) => {
      rows.push({
        text: `${row.text}${bar[i] ?? ' '}`,
        hits: [...row.hits, { row: 0, from: text, to: text, target }],
      })
    })
  }
  while (rows.length < 2 + body + (panel.asking ? 1 : 0))
    rows.push({
      text: ' '.repeat(inner),
      hits: [{ row: 0, from: 0, to: inner - 1, target: { kind: 'scroll', area: 'panel' } }],
    })
  rows.push({ text: skin.chrome('─'.repeat(inner)), hits: [] })
  const shownTo = Math.min(
    lines.length,
    Math.max(0, Math.min(panel.scroll, lines.length - body)) + body,
  )
  const foot = new Row(inner, skin, ctx.pointer).space()
  // The buttons are what the footer is for; where they are position is said,
  // and the keys only where there is room for them too.
  const saving = edit?.dirty === true
  const buttons =
    'Copy path'.length +
    'Open in editor'.length +
    'Close'.length +
    (saving ? 'Save'.length + 5 : 0) +
    12 +
    3
  if (panel.said) {
    foot.text(panel.said, skin.waiting)
  } else if (lines.length > 0) {
    const from = Math.max(0, Math.min(panel.scroll, lines.length - body)) + 1
    const where = `${formatted ? 'rows' : 'lines'} ${from}–${shownTo} of ${lines.length}`
    const keys =
      panel.asking?.kind === 'find'
        ? '  enter the next · ↑↓ move · esc shuts the bar'
        : edit
          ? selection
            ? '  ctrl+shift+c copies · ctrl+s saves · esc leaves'
            : '  ctrl+s saves · ctrl+f finds · esc leaves'
          : typeable
            ? '  click to edit · ctrl+f find · ctrl+g line'
            : '  ↑↓ scroll · space a page · e editor'
    if (1 + where.length + buttons + 2 <= inner) foot.text(where, skin.hint)
    if (1 + where.length + keys.length + buttons + 2 <= inner) foot.text(keys, skin.hint)
  }
  foot.right((r) => {
    if (saving) r.button('Save', control('save'), 'attention').space()
    r.button('Copy path', control('copy-path'))
      .space()
      .button('Open in editor', control('editor'), 'primary')
      .space()
      .button('Close', control('close'))
      .space()
  })
  rows.push(foot.build())
  return box('File', rows, size.width, skin, { corner: 'esc' })
}

/**
 * A line as it is drawn: the colour the whole file was read with where nobody
 * has touched it, and the line on its own where somebody has. Colouring a
 * megabyte again on every keystroke is tens of milliseconds; colouring the one
 * line that changed is none of them.
 */
function colouredAt(
  at: number,
  edit: Edited | null,
  viewing: PanelContext['viewing'],
  ctx: PanelContext,
): string {
  if (!edit) return (viewing?.formatted ?? viewing?.source ?? [])[at] ?? ''
  const from = edit.from[at] ?? -1
  if (from >= 0) return viewing?.source[from] ?? edit.lines[at] ?? ''
  return colouredLine(edit.lines[at] ?? '', viewing?.file.language ?? null, !ctx.skin.colour)
}

/** What is laid over a drawn line: the matches on it, and the caret if it is on it. */
interface Overlays {
  at: number
  line: string
  gutter: number
  left: number
  width: number
  matches: readonly Match[]
  current?: Match | undefined
  /** What is selected, as its two ends in the lines: this row may be in it. */
  selection?: { from: Place; to: Place }
  caret?: number
  caretCells?: number
  skin: Skin
}

/**
 * The matches and the caret, laid on the cells they are on — after the line is
 * drawn, as the lane's cursor is, because both sit on top of coloured text
 * rather than inside it.
 */
function laidOver(row: string, over: Overlays): string {
  const { skin } = over
  let out = row
  // `keep` takes the cells as they were drawn, colour and all, for a paint
  // that only lays a ground under them: a selection is a background the code
  // sits on, and stripping it would take the syntax colouring off everything
  // inside it. A match and the caret are the other way round — they are meant
  // to stand out — so they take the text plain and repaint it.
  const lay = (cell: number, cells: number, paint: (text: string) => string, keep = false) => {
    const from = over.gutter + cell - over.left
    if (cells <= 0 || from < over.gutter || from + cells > over.width) return
    const cut = sliceByColumn(out, from, cells, true)
    const under = keep ? cut : stripTerminalSequences(cut)
    // Half of a wide character is not a cell anything can be laid on, and a
    // paint that came back a different width would tear the row it is in.
    if (visibleWidth(under) > cells) return
    const painted = paint(visibleWidth(under) === 0 ? ' '.repeat(cells) : under)
    if (visibleWidth(painted) !== cells) return
    out = compositeTuiLine(out, painted, from, cells, over.width)
  }
  // Under everything else: a selection is a ground the text sits on, and the
  // matches and the caret are still read where they fall inside it.
  const covered = over.selection ? onLine(over.selection, over.at, over.line.length) : null
  if (covered) {
    const start = cellOf(over.line, covered.from)
    // The break at the end of the line, where the selection runs over it: a
    // cell of its own, so an empty line inside one is not a hole in it.
    const stop = cellOf(over.line, covered.to) + (covered.eol ? 1 : 0)
    // Only the part of it on screen: the body has slid left to keep the caret
    // in view, and a long line reaches past both edges of what is drawn.
    const from = Math.max(start, over.left)
    const to = Math.min(stop, over.left + over.width - over.gutter)
    lay(from, to - from, (text) => skin.selected(text), true)
  }
  for (const match of over.matches) {
    if (match.line !== over.at) continue
    const cell = cellOf(over.line, match.column)
    const cells = cellOf(over.line, match.column + match.length) - cell
    const on = over.current === match
    lay(cell, cells, (text) => skin.found(text, on))
  }
  if (over.caret !== undefined) lay(over.caret, over.caretCells ?? 1, skin.cursor)
  return out
}

/** The find bar, or the go-to-line bar: whichever is open, on one row. */
function fileBar(
  ask: FileAsk,
  matches: readonly Match[],
  inner: number,
  ctx: PanelContext,
): { text: string; hits: Hit[] } {
  const { skin } = ctx
  const control = (id: string) => ({ kind: 'control' as const, id })
  const row = new Row(inner, skin, ctx.pointer).space()
  if (ask.kind === 'goto') {
    return row
      .text('Go to line', skin.label)
      .space()
      .field(ask.digits, 12, { caret: true })
      .space(2)
      .text('enter goes · esc closes', skin.hint)
      .right((r) => r.button('Close', control('shut-bar')).space())
      .build()
  }
  const said =
    ask.query === ''
      ? ''
      : matches.length === 0
        ? 'none'
        : `${Math.min(ask.index + 1, matches.length)} of ${matches.length}`
  return row
    .text('Find', skin.label)
    .space()
    .field(ask.query, Math.min(40, Math.max(12, inner - 40)), { caret: true })
    .space(2)
    .text(said.padEnd(10), matches.length === 0 && ask.query ? skin.waiting : skin.hint)
    .right((r) =>
      r
        .button('↑', control('match-previous'), matches.length > 1 ? 'rest' : 'off')
        .button('↓', control('match-next'), matches.length > 1 ? 'rest' : 'off')
        .space()
        .button('Close', control('shut-bar'))
        .space(),
    )
    .build()
}

/** Columns a plain string takes. */
function visibleCells(text: string): number {
  return [...text].length
}
