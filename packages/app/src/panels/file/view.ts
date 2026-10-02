import {
  compositeTuiLine,
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { Hit } from '../../hits.ts'
import { onLine, type Place, placeOf } from '../../input.ts'
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
import { BAR, bar, panelSize } from '../frame.ts'
import { type FileAsk, type FilePanel, fileMatches, fileSelection, showsDiff } from './state.ts'

// What the file viewer looks like: the lines, the selection laid over them,
// the bar along the bottom and what it is asking. What a key does to it is
// beside this in `state.ts`.

/**
 * How big the file viewer is in a window this size, and how wide its text is.
 *
 * `panelSize`, like every other panel: the room there is, less the margin and
 * the strip at the foot. It used to take all but two rows of the window and so
 * covered that strip, which is the one thing a panel may not do.
 */
export function fileViewSize(
  width: number,
  height: number,
): { width: number; height: number; text: number } {
  const size = panelSize({ width, height }, { max: 160, least: 8 })
  return { width: size.width, height: size.height, text: size.width - 2 - 9 }
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
  inline = false,
): { rows: number; columns: number; gutter: number } {
  const size = fileViewSize(width, height)
  // A column in front of the numbers for what git says about the line, where
  // that is being shown: the sign is the half of the answer colour is not, and
  // it is what the golden screens read.
  const gutter = Math.max(3, String(Math.max(1, lines)).length) + 4 + (inline ? 1 : 0)
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

  // What git says about the file, laid into it — once it has been asked, which
  // is what pressing the chip does. The chip itself is drawn wherever git could
  // have something to say, on or off: a toggle you cannot see is a toggle
  // nobody finds twice, and one that appears only once it is on is worse.
  const inline = showsDiff(panel) ? (viewing?.inline ?? null) : null
  const changes =
    !formatted && (inline !== null || (file !== null && !file.binary && file.error === null))
  // What git counted, where it has answered and the answer is the file's own:
  // a file that matches its base is told so in words, because `+0 −0` is a
  // figure drawn for an answer that is not a figure.
  const counted = inline && ctx.diff && !ctx.diff.binary ? ctx.diff : null
  const counts = counted && counted.added + counted.removed > 0 ? counted : null
  const unchanged = counted !== null && counts === null
  const facts =
    file && !file.error
      ? [
          file.language ?? (file.binary ? 'binary' : 'text'),
          file.binary ? null : `${lines.length} line${lines.length === 1 ? '' : 's'}`,
          bytes(file.size),
          file.truncated ? 'first 1 MB' : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : ''
  const dirty = file && !file.error && edit?.dirty === true
  // Everything else on the row, measured before the path is drawn, so the path
  // is what gives way: a heading that pushes its own controls off the row is a
  // heading nobody can press, and a path in a worktree is as long as it likes.
  const beside =
    (facts ? visibleCells(facts) + 2 : 0) +
    (dirty ? '● not saved'.length + 2 : 0) +
    (counts ? `+${counts.added} −${counts.removed}`.length + 2 : 0) +
    (unchanged ? NOTHING.length + 2 : 0) +
    (markdown ? 'Formatted'.length + 'Source'.length + 8 : 0) +
    (changes ? 'Changes'.length + 2 : 0) +
    2
  const head = new Row(inner, skin, ctx.pointer)
    .space()
    .text(shownPath(tildeOf(panel.path, ctx.homeDir), Math.max(12, inner - 1 - beside)), skin.you)
  if (facts) head.space(2).text(facts, skin.hint)
  if (dirty) head.space(2).text('● not saved', skin.waiting)
  if (counts) {
    head.space(2).text(`+${counts.added}`, skin.done).space().text(`−${counts.removed}`, skin.bad)
  }
  if (unchanged) head.space(2).text(NOTHING, skin.hint)
  if (markdown || changes) {
    head.right((r) => {
      if (markdown) {
        r.tab('Formatted', control('formatted'), panel.formatted).tab(
          'Source',
          control('source'),
          !panel.formatted,
        )
      }
      // Off is a chip at rest rather than a chip missing: a toggle you cannot
      // see is a toggle nobody finds twice.
      if (changes) {
        if (markdown) r.space()
        r.chip('Changes', control('inline'), panel.inline ? 'primary' : 'rest')
      }
      r.space()
    })
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
  // How much there is to scroll through: the rows, which the lines git says are
  // gone add to. One answer, and `Files.lines()` reads it the same way.
  const total = inline ? inline.length : lines.length
  const geometry = fileBodySize(
    ctx.width,
    ctx.height,
    total,
    panel.asking !== null,
    inline !== null,
  )
  const body = geometry.rows
  if (!viewing) {
    rows.push(new Row(inner, skin).space(2).text('Reading…', skin.hint).build())
    // A file git says is gone has no lines of its own and still has a diff: what
    // it said is the whole of what there is to show, so the rows win over the
    // reason it could not be read.
  } else if ((file?.error && !inline) || file?.binary) {
    rows.push(blank(inner))
    rows.push(
      new Row(inner, skin)
        .space(2)
        .text(file.error ?? `Binary, ${bytes(file.size)}.`, skin.hint)
        .build(),
    )
  } else {
    // A column down the right is the file's scrollbar: where in it you are
    // reading, and a handle to move.
    const text = inner - BAR
    const digits = geometry.gutter - 4 - (inline ? 1 : 0)
    const scroll = Math.max(0, Math.min(panel.scroll, total - body))
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
      // Which line of the file this row is — and the row is the line itself,
      // until the gone lines put themselves between them. A gone line is no
      // line of the file, so it has no number, no caret and nothing laid over.
      const shown = inline ? inline[at] : null
      const gone = shown?.kind === 'remove'
      const line = inline ? (shown?.line ?? null) : at < lines.length ? at : null
      const there = inline ? shown !== undefined : at < lines.length
      const number = line === null ? null : line + 1
      const marked = !formatted && number !== null && panel.line === number
      const sign = inline ? SIGNS[shown?.kind ?? 'context'] : ''
      const gutter =
        formatted || !there
          ? ''
          : `${sign}${marked ? '▶' : ' '}${(number === null ? '' : String(number)).padStart(digits)} │ `
      const room = Math.max(1, text - visibleCells(gutter))
      const source = !there
        ? ''
        : gone
          ? skin.bad(shown?.text ?? '')
          : line === null
            ? ''
            : colouredAt(line, edit, viewing, ctx)
      const tabbed = source.replaceAll('\t', TAB)
      const cut = fitRow(left === 0 ? tabbed : sliceByColumn(tabbed, left, room), room)
      const painted = `${formatted || !there ? '' : paintGutter(gutter, sign, marked, skin)}${cut}`
      const hits: Hit[] = [
        { row: 0, from: 0, to: text - 1, target: { kind: 'scroll', area: 'panel' } },
      ]
      // Clicking the text puts the caret in it; clicking the numbers does not,
      // so the gutter is still somewhere to take hold of the file and scroll.
      // A gone line is nowhere to put one: it is not in the file to be typed in.
      if (typeable && line !== null)
        hits.push({
          row: 0,
          from: gutterWidth,
          to: text - 1,
          target: { kind: 'caret', line: Math.min(line, lines.length - 1) },
        })
      read.push({
        text: laidOver(marked ? skin.selected(painted) : painted, {
          // Never a row the file has no line on: the selection, the matches and
          // the caret are all placed in the file's own lines.
          at: line ?? -1,
          line: (line === null ? '' : plain[line]) ?? '',
          gutter: gutterWidth,
          left,
          width: text,
          matches,
          current: panel.asking?.kind === 'find' ? matches[panel.asking.index] : undefined,
          ...(selection ? { selection } : {}),
          ...(edit && line !== null && edit.row === line ? { caret: caretCell, caretCells } : {}),
          skin,
        }),
        hits,
      })
    }
    // The same bar every other panel draws, from the same three numbers: how
    // much there is, how much is in view, and where in it you are.
    const cells = bar({ total, shown: body, offset: scroll, rows: body }, 'panel', ctx)
    read.forEach((row, i) => {
      const cell = cells[i]
      rows.push({
        text: `${row.text}${cell?.cell ?? ' '}`,
        hits: [
          ...row.hits,
          ...(cell ? [{ row: 0, from: text, to: text, target: cell.target }] : []),
        ],
      })
    })
  }
  while (rows.length < 2 + body + (panel.asking ? 1 : 0))
    rows.push({
      text: ' '.repeat(inner),
      hits: [{ row: 0, from: 0, to: inner - 1, target: { kind: 'scroll', area: 'panel' } }],
    })
  rows.push({ text: skin.chrome('─'.repeat(inner)), hits: [] })
  const shownTo = Math.min(total, Math.max(0, Math.min(panel.scroll, total - body)) + body)
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
  } else if (total > 0) {
    const from = Math.max(0, Math.min(panel.scroll, total - body)) + 1
    const where = `${formatted || inline ? 'rows' : 'lines'} ${from}–${shownTo} of ${total}`
    // Longest first, and the first of them that fits: a fourth key on this row
    // used to mean the row said one key less at every width, rather than at the
    // widths where there is genuinely no room for it.
    const hints =
      panel.asking?.kind === 'find'
        ? ['  enter the next · ↑↓ move · esc shuts the bar']
        : edit
          ? selection
            ? ['  ctrl+shift+c copies · ctrl+s saves · esc leaves']
            : ['  ctrl+s saves · ctrl+f finds · esc leaves']
          : typeable
            ? changes
              ? // `ctrl+d` goes first where there is no room for all four,
                // because the chip in the heading says it and nothing says
                // `ctrl+g` but this row.
                [
                  '  click to edit · ctrl+f find · ctrl+g line · ctrl+d changes',
                  '  click to edit · ctrl+f find · ctrl+g line',
                ]
              : ['  click to edit · ctrl+f find · ctrl+g line']
            : ['  ↑↓ scroll · space a page · e editor']
    if (1 + where.length + buttons + 2 <= inner) foot.text(where, skin.hint)
    const keys = hints.find((one) => 1 + where.length + one.length + buttons + 2 <= inner)
    if (keys) foot.text(keys, skin.hint)
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

/** What the heading says where git has looked and the file matches its base. */
const NOTHING = 'no changes'

/**
 * The path, shortened from its front where the row has no room for all of it:
 * the end of a path is the part that names the file, so that is the end kept.
 */
function shownPath(path: string, room: number): string {
  if (visibleWidth(path) <= room) return path
  return `…${path.slice(-Math.max(1, room - 1))}`
}

/**
 * What each kind of row says it is in the column in front of the numbers. The
 * sign and not only the colour, because a diff read with no colour — a golden
 * screen, a pipe, `NO_COLOR` — still has to say which side of the change a line
 * is on.
 */
const SIGNS = { context: ' ', add: '+', remove: '−' } as const

/**
 * The numbers down the side, painted: the sign in its own tone, then the mark
 * and the number, then the rule. One place, because the row is built as one
 * string and the slices have to add back up to the gutter's own width.
 */
function paintGutter(gutter: string, sign: string, marked: boolean, skin: Skin): string {
  const signed = sign === '+' ? skin.done(sign) : sign === '−' ? skin.bad(sign) : sign
  const rest = gutter.slice(sign.length)
  const numbers = marked
    ? skin.signal(rest.slice(0, 1)) + skin.you(rest.slice(1, -2))
    : skin.hint(rest.slice(0, -2))
  return `${signed}${numbers}${skin.chrome('│ ')}`
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
