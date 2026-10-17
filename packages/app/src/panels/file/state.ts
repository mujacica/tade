import {
  clickedSpan,
  type LineKey,
  lineKey,
  offsetOf,
  pastedText,
  placeOf,
  type Span,
  spanOf,
} from '../../input.ts'
import { normalKey } from '../../keys.ts'
import type { PanelInputs } from '../../panels.ts'
import {
  caretAt,
  cellOf,
  columnOf,
  cutSelection,
  type Edited,
  editFrom,
  editKey,
  leftOf,
  type Match,
  matchesIn,
  typeIn,
} from '../../viewer.ts'
import { type Composing, composeKey, composeOn, nextTo } from '../comment.ts'
import { close, type PanelOutcome, stay, typed } from '../outcome.ts'
import { changesIn, drawnRow, type InlineRow, lineAtRow } from './inline.ts'

// A file read inside the window, and what a key or a click does to it.
//
// The selection and the editing are the viewer's and the line editor's —
// `viewer.ts` and `input.ts` — so that a word is the same run of letters here
// as on the line you type on. The drawing is beside this in `view.ts`.

/**
 * A file, read inside the window: coloured, with line numbers, and a button
 * for the editor. Markdown can be read formatted or as its source.
 *
 * Clicked into, it is also typed into — for the short edit that is not worth
 * leaving the window for. `ctrl+s` saves it, and the button for the real
 * editor stays where it was.
 */
export interface FilePanel {
  kind: 'file'
  /** Absolute. */
  path: string
  /** The line you went to, marked and kept in view. */
  line: number | null
  /** The first line shown, counting from 0. */
  scroll: number
  /** Markdown laid out rather than shown as source. */
  formatted: boolean
  /**
   * What git says about the file, drawn into it: added lines marked, lines it
   * says are gone shown where they were. A diff and the file itself are two
   * things you want separately, so it is a toggle and not how a file opens.
   *
   * Never on at the same time as `formatted`, for `asking`'s reason: laid-out
   * Markdown has no line of the file to draw a mark beside. Each of them turns
   * the other off, so everything else can read one of them and be right.
   */
  inline: boolean
  /** The one bar under the file's name: finding in it, or going to a line. */
  asking: FileAsk | null
  /** What has been typed into it, once you have clicked in. */
  edit: Edited | null
  /**
   * Where a selection in it was started, as an offset into the text. Its other
   * end is the caret, which the edit already holds — so only this is kept, and
   * the two can never disagree about where the selection reaches.
   */
  anchor: number | null
  /** Said in the footer: what the last save did, or why it would not. */
  said: string | null
  /** Esc was pressed on unsaved work, and asked before throwing it away. */
  warned: boolean
  /**
   * The change the view was last sent to (`n`, `p`, or opening a changed
   * file), while it is still there. Only good while `scroll` is still the
   * scroll it was sent at, and the caret still where it was put: the wheel, a
   * key or the bar moving the view is the view somewhere else, and the next
   * change is then the next one under where it is now (`sentTo`).
   */
  atChange: AtChange | null
  busy: false
}

/** Which change the view was sent to, from where, and whether it went round an end to get there. */
export interface AtChange {
  /** Into `changesIn` of the rows it was sent along. */
  index: number
  /** The scroll it was sent at. */
  scroll: number
  /** The line the caret was put on, where one was down; null while reading. */
  line: number | null
  /** Past the last change to the first, or before the first to the last. */
  wrapped: 'top' | 'bottom' | null
}

/** Finding in the file, going to a line, or writing on one: whichever bar is open. */
export type FileAsk =
  | { kind: 'find'; query: string; index: number }
  | { kind: 'goto'; digits: string }
  | { kind: 'comment'; box: Composing }

/**
 * A file, opened at a line when there is one: a few lines of what comes before
 * stay in view, so the line is read in its place. A line asked for means the
 * source, since formatted Markdown has no line numbers to go to.
 */
export function filePanel(
  path: string,
  line: number | null = null,
  markdown = false,
  inline = false,
): FilePanel {
  return {
    kind: 'file',
    path,
    line,
    scroll: line ? Math.max(0, line - 6) : 0,
    formatted: markdown && line === null && !inline,
    inline,
    asking: null,
    edit: null,
    anchor: null,
    said: null,
    warned: false,
    atChange: null,
    busy: false,
  }
}

/**
 * What is selected in the file, in reading order, or nothing. Read from the
 * anchor and the caret every time rather than remembered: a caret that has
 * moved is a selection that has changed, and there is only ever one answer.
 */
export function fileSelection(panel: FilePanel): Span | null {
  const edit = panel.edit
  if (!edit || panel.anchor === null) return null
  return spanOf({
    anchor: panel.anchor,
    head: offsetOf(edit.lines, { line: edit.row, col: edit.column }),
  })
}

/** The matches in the file for the find bar as it stands, in line order. */
export function fileMatches(panel: FilePanel, text: readonly string[]): Match[] {
  return panel.asking?.kind === 'find' ? matchesIn(text, panel.asking.query) : []
}

/**
 * The wheel over a file: it scrolls what is shown, and never moves the caret.
 * Down is further into the file, as it is everywhere else.
 */
export function scrollFile(panel: FilePanel, by: number, lines: number): FilePanel {
  const last = Math.max(0, lines - 1)
  return { ...panel, scroll: Math.max(0, Math.min(last, panel.scroll + by)) }
}

/**
 * The file saved: what is on screen is what is on disk again, so nothing is
 * unsaved and every line comes from the file once more — the caret stays where
 * it was typing.
 */
export function savedFile(panel: FilePanel, lines: readonly string[], said: string): FilePanel {
  const edit = panel.edit
  return {
    ...panel,
    said,
    warned: false,
    edit: edit ? editFrom(lines, edit.row, edit.column) : null,
  }
}

/**
 * Reading: the arrows a line, page keys and space a screen, `e` or enter to
 * the editor. `ctrl+f` finds, `ctrl+g` goes to a line — and once you have
 * clicked into the text, everything printable is typed into it instead.
 */
export function fileKey(
  panel: FilePanel,
  key: string | undefined,
  data: string,
  inputs: PanelInputs,
): PanelOutcome {
  const lines = inputs.lines ?? 0
  const body = Math.max(1, inputs.body ?? 20)
  if (panel.asking) return askKey(panel, panel.asking, key, data, inputs)
  if (panel.edit) return typingKey(panel, panel.edit, key, data, body, inputs)
  const last = Math.max(0, lines - 1)
  const to = (scroll: number) => stay({ ...panel, scroll: Math.max(0, Math.min(last, scroll)) })
  switch (key) {
    case 'escape':
    case 'q':
      return close
    case 'ctrl+f':
      return stay(asking(panel, { kind: 'find', query: '', index: 0 }))
    case 'ctrl+g':
      return stay(asking(panel, { kind: 'goto', digits: '' }))
    case 'ctrl+d':
      return stay(withInline(panel, inputs))
    case 'n':
    case 'ctrl+n':
      return stay(toChange(panel, false, inputs))
    case 'p':
    case 'ctrl+p':
      return stay(toChange(panel, true, inputs))
    case 'c':
    case 'ctrl+r':
      return stay(commentOn(panel, readingLine(panel, inputs), inputs))
    case 's':
      return (inputs.drafted ?? 0) > 0 ? { panel, submit: true, choice: 'send' } : stay(panel)
    case 'down':
      return to(panel.scroll + 1)
    case 'up':
      return to(panel.scroll - 1)
    case 'pageDown':
    case 'space':
      return to(panel.scroll + 20)
    case 'pageUp':
      return to(panel.scroll - 20)
    case 'home':
      return to(0)
    case 'end':
      return to(last)
    case 'enter':
    case 'e':
      return { panel, submit: true, choice: 'editor' }
    case 'm':
      return stay({ ...panel, formatted: !panel.formatted, scroll: 0 })
    default:
      return stay(panel)
  }
}

/**
 * Typing into the file. Every printable key is a character in it, so the
 * reading keys are gone while the caret is down: what is left is `ctrl+s` to
 * save, the two bars, and esc — which asks once when there is something
 * unsaved to lose.
 *
 * What is selected changes what a few of them mean, and those are read first
 * (`lineKey`, the same decoder the line you type on uses): shift and a motion
 * reach further, ctrl+a takes the whole file, and everything that puts text in
 * or takes text out replaces the selection before it does anything else.
 */
function typingKey(
  panel: FilePanel,
  edit: Edited,
  key: string | undefined,
  data: string,
  body: number,
  inputs: PanelInputs,
): PanelOutcome {
  const rows = shownRows(panel, inputs)
  if (key === 'ctrl+s')
    return edit.dirty
      ? { panel: { ...panel, warned: false }, submit: true, choice: 'save' }
      : stay(panel)
  if (key === 'ctrl+f') return stay(asking(panel, { kind: 'find', query: '', index: 0 }))
  if (key === 'ctrl+g') return stay(asking(panel, { kind: 'goto', digits: '' }))
  if (key === 'ctrl+d') return stay(withInline(panel, inputs))
  // Every printable key is a character here, so going through the changes is
  // the two chords that `n` and `p` are while reading.
  if (key === 'ctrl+n' || key === 'ctrl+p') return stay(toChange(panel, key === 'ctrl+p', inputs))
  if (key === 'ctrl+r') return stay(commentOn(panel, edit.row, inputs))
  if (key === 'escape') return edit.dirty && !panel.warned ? stay(warn(panel)) : close
  const selected = fileSelection(panel)
  // With its modifiers in one order, because a terminal reports them in its
  // own: ctrl+shift+c arrives as `shift+ctrl+c` from the ones that speak the
  // Kitty protocol.
  const named = key === undefined ? null : normalKey(key)
  // Copying is the window's, so the panel only says there is something to
  // copy; a drag that selected it has already copied it on being let go.
  if (named === 'ctrl+shift+c' || named === 'super+c')
    return selected ? { panel, submit: true, choice: 'copy-selection' } : stay(panel)
  const what = lineKey(named)
  if (what?.do === 'select all') {
    const last = Math.max(0, edit.lines.length - 1)
    const all = caretAt(edit, last, (edit.lines[last] ?? '').length)
    return stay(typedInto({ ...panel, anchor: 0 }, all, body, rows))
  }
  if (what?.do === 'move') return stay(movedIn(panel, edit, what, selected, body, rows))
  // Everything below changes the text, so what is selected is what it
  // replaces: the file with it taken out is what each of them starts from.
  // Worked out only where something is about to change it — a key this editor
  // has no meaning for must cost nothing and leave the selection where it was.
  const without = () => (selected ? cutSelection(edit, selected) : edit)
  const letGo = { ...panel, anchor: null }
  // Backspace and delete take the selection and nothing more: taking it out
  // is the whole of what they were asked for.
  if (selected && (key === 'backspace' || key === 'delete'))
    return stay(typedInto(letGo, without(), body, rows))
  // A paste is text like any other here, newlines and all — pasting a line in
  // is half of what a short edit is for.
  const paste = pastedText(data)
  if (paste !== null) return stay(typedInto(letGo, typeIn(without(), paste), body, rows))
  const text = typed(data, key)
  if (text) return stay(typedInto(letGo, typeIn(without(), text), body, rows))
  // What is left of the editor's own keys, every one of which changes the
  // text: the motions were answered above, and none of these types anything
  // `typed` would have taken first.
  const moved = editKey(without(), key, body)
  return moved ? stay(typedInto(letGo, moved, body, rows)) : stay(panel)
}

/**
 * The rows the file is drawn as, where it is drawn with git's answer in it.
 * Nothing while the inline diff is off: a line is then its own row, which is
 * what everything below means by one when there is nothing to ask.
 */
function shownRows(panel: FilePanel, inputs: PanelInputs): readonly InlineRow[] | null {
  return panel.inline ? (inputs.diffRows ?? null) : null
}

/** Whether the panel is drawing the file with git's answer in it. */
export function showsDiff(panel: FilePanel): boolean {
  return panel.inline && !panel.formatted
}

/**
 * Rows of what comes before a change kept above it when the view is sent to
 * it, so the change is read in its place — and never more than the caret's own
 * margin allows (`inView`), or the first key typed after going there would
 * move the view again.
 */
function leadOf(body: number): number {
  return Math.min(3, Math.max(0, Math.floor((body - 1) / 2)))
}

/** The scroll a change is read at: its first row a few rows down, as far as the end allows. */
function changeScroll(row: number, body: number, total: number): number {
  return Math.max(0, Math.min(row - leadOf(body), total - body))
}

/**
 * Where a changed file opens: on its first change, with the change it is on
 * written down so the next one is a press away. Nothing where git says nothing
 * changed, and the file opens at its top as any other does.
 *
 * Answered as an offset rather than a panel, because putting the view there is
 * the window's one setter for where a region is (`atOffset`).
 */
export function firstChange(
  rows: readonly InlineRow[] | null,
  body: number,
): { offset: number; atChange: AtChange } | null {
  const first = changesIn(rows)[0]
  if (!rows || !first) return null
  const offset = changeScroll(first.from, Math.max(1, body), rows.length)
  return { offset, atChange: { index: 0, scroll: offset, line: null, wrapped: null } }
}

/** The change the view was sent to, while nothing has moved it since. */
export function sentTo(panel: FilePanel): AtChange | null {
  const at = panel.atChange
  if (!at || at.scroll !== panel.scroll) return null
  return (panel.edit?.row ?? null) === at.line ? at : null
}

/** What `n` says where the changes are not drawn, and where there are none. */
const CHANGES_OFF = 'The changes are not drawn — ctrl+d draws them.'
const NO_CHANGES = 'No changes to go to.'

/**
 * The next change, or the one before — from the one the view was sent to
 * while it is still there, and otherwise from where you are: the caret while
 * typing, and the top of the view while reading (all of it, at the very top,
 * so a change on the first rows is not stepped over).
 *
 * Past the last it goes round to the first, and says it did — a press at the
 * end that did nothing would read as a key that does not work. Typing, the
 * caret goes with the view, onto the change's first line, because the next key
 * typed brings the view back to wherever the caret is.
 */
function toChange(panel: FilePanel, back: boolean, inputs: PanelInputs): FilePanel {
  if (!showsDiff(panel)) return { ...panel, said: CHANGES_OFF }
  const rows = shownRows(panel, inputs)
  const changes = changesIn(rows)
  if (!rows || changes.length === 0) return { ...panel, said: NO_CHANGES }
  const body = Math.max(1, inputs.body ?? 20)
  const edit = panel.edit
  const sent = sentTo(panel)
  let index: number
  if (sent) index = sent.index + (back ? -1 : 1)
  else {
    const here = edit
      ? drawnRow(rows, edit.row)
      : panel.scroll === 0
        ? -1
        : panel.scroll + leadOf(body)
    index = back
      ? changes.findLastIndex((one) => one.from < here)
      : changes.findIndex((one) => one.from > here)
    if (index < 0) index = back ? -1 : changes.length
  }
  const wrapped = index < 0 ? 'bottom' : index >= changes.length ? 'top' : null
  index = wrapped === 'bottom' ? changes.length - 1 : wrapped === 'top' ? 0 : index
  const from = changes[index]?.from ?? 0
  const scroll = changeScroll(from, body, rows.length)
  if (!edit)
    return { ...panel, scroll, said: null, atChange: { index, scroll, line: null, wrapped } }
  // A change that is only lines gone has no line of its own: the caret goes to
  // the line that now stands where they were.
  const line = Math.max(0, Math.min(lineAtRow(rows, from), edit.lines.length - 1))
  return {
    ...panel,
    edit: caretAt(edit, line, 0),
    anchor: null,
    line: null,
    said: null,
    warned: false,
    scroll,
    atChange: { index, scroll, line, wrapped },
  }
}

/**
 * The inline diff turned on or off, with the top of the view left on the same
 * line of the file. The lines git says are gone are rows that come and go, so
 * a scroll kept as a number would jump by however many of them are above it.
 */
function withInline(panel: FilePanel, inputs: PanelInputs): FilePanel {
  const rows = inputs.diffRows ?? null
  const scroll = panel.inline ? lineAtRow(rows, panel.scroll) : drawnRow(rows, panel.scroll)
  return {
    ...panel,
    inline: !panel.inline,
    // Over the source, like the two bars: there is no mark to draw beside a
    // line of laid-out Markdown, because it is not a line of the file.
    formatted: false,
    scroll: Math.max(0, scroll),
    said: null,
  }
}

/** The key of the editor's own that makes a motion: one decoder, both editors. */
function motionKey(what: Extract<LineKey, { do: 'move' }>): string {
  switch (what.by) {
    case 'char':
      return what.back ? 'left' : 'right'
    case 'word':
      return what.back ? 'ctrl+left' : 'ctrl+right'
    case 'line':
      return what.back ? 'home' : 'end'
    case 'row':
      return what.back ? 'up' : 'down'
    case 'page':
      return what.back ? 'pageUp' : 'pageDown'
  }
}

/**
 * An arrow, home, end or a page, with or without shift. The move itself is
 * always the editor's own key — a caret is moved by pressing what moves a
 * caret — and shift is only whether the anchor stays behind it.
 *
 * Without shift a selection is let go of, and a plain left or right collapses
 * to the end the caret was sent towards rather than stepping on from where it
 * was, which is what every text box does.
 */
function movedIn(
  panel: FilePanel,
  edit: Edited,
  what: Extract<LineKey, { do: 'move' }>,
  selected: Span | null,
  body: number,
  rows: readonly InlineRow[] | null,
): FilePanel {
  if (!what.extend) {
    if (selected && what.by === 'char') {
      const at = placeOf(edit.lines, what.back ? selected.from : selected.to)
      return typedInto({ ...panel, anchor: null }, caretAt(edit, at.line, at.col), body, rows)
    }
    const moved = editKey(edit, motionKey(what), body)
    return moved
      ? typedInto({ ...panel, anchor: null }, moved, body, rows)
      : { ...panel, anchor: null }
  }
  const anchor = panel.anchor ?? offsetOf(edit.lines, { line: edit.row, col: edit.column })
  const moved = editKey(edit, motionKey(what), body)
  return moved ? typedInto({ ...panel, anchor }, moved, body, rows) : { ...panel, anchor }
}

/**
 * A click on the window behind the panel, which closes it without a key.
 *
 * It throws away exactly what escape throws away, so it asks what escape
 * asks: a file with something unsaved in it warns once rather than going.
 * A click landing off the edge of a panel is far more often a miss than a
 * decision, and nothing here can put an edit back.
 */
export function fileDismiss(panel: FilePanel): PanelOutcome {
  return panel.edit?.dirty && !panel.warned ? stay(warn(panel)) : close
}

/**
 * Asked once before what was typed is thrown away. Nothing here can put an
 * edit back, so the second press is the one that loses it.
 */
function warn(panel: FilePanel): FilePanel {
  return { ...panel, warned: true, said: 'Not saved. ctrl+s keeps it — again loses it.' }
}

/** The file as it now is, with the caret in view and the last answer cleared. */
function typedInto(
  panel: FilePanel,
  edit: Edited,
  body: number,
  rows: readonly InlineRow[] | null,
): FilePanel {
  return {
    ...panel,
    edit,
    line: null,
    warned: false,
    said: null,
    // Typed into, the rows the change was counted along may not be the rows
    // there are: the next change is the next one from the caret.
    atChange: null,
    scroll: inView(panel.scroll, drawnRow(rows, edit.row), body),
  }
}

/** Finding, and going to a line: one bar, and the same keys in both. */
function askKey(
  panel: FilePanel,
  ask: FileAsk,
  key: string | undefined,
  data: string,
  inputs: PanelInputs,
): PanelOutcome {
  const body = Math.max(1, inputs.body ?? 20)
  const text = inputs.text ?? []
  const rows = shownRows(panel, inputs)
  if (ask.kind === 'comment') {
    const answer = composeKey(ask.box, key, data, inputs.commentTo ?? [])
    if ('composing' in answer)
      return stay({ ...panel, asking: { kind: 'comment', box: answer.composing } })
    if (answer.done === 'keep') return { panel, submit: true, choice: 'comment' }
    return stay({ ...panel, asking: null })
  }
  if (key === 'escape') return stay({ ...panel, asking: null })
  if (ask.kind === 'goto') {
    if (key === 'enter') {
      const line = Number(ask.digits)
      if (!line) return stay({ ...panel, asking: null })
      return stay(atLine(panel, Math.min(Math.max(1, line), Math.max(1, text.length)), body, rows))
    }
    if (key === 'backspace') return stay(asking(panel, { ...ask, digits: ask.digits.slice(0, -1) }))
    const digits = typed(data, key).replace(/\D/g, '')
    return digits ? stay(asking(panel, { ...ask, digits: ask.digits + digits })) : stay(panel)
  }
  const at = (index: number, query = ask.query): PanelOutcome => {
    const found = matchesIn(text, query)
    const next = found.length === 0 ? 0 : ((index % found.length) + found.length) % found.length
    const match = found[next]
    const moved = asking(panel, { ...ask, query, index: next })
    return stay(match ? atLine(moved, match.line + 1, body, rows, match.column) : moved)
  }
  if (key === 'enter' || key === 'down' || key === 'ctrl+f') return at(ask.index + 1)
  if (key === 'up') return at(ask.index - 1)
  if (key === 'backspace') return at(0, [...ask.query].slice(0, -1).join(''))
  if (key === 'ctrl+u') return at(0, '')
  const typing = typed(data, key)
  return typing ? at(0, ask.query + typing) : stay(panel)
}

/** The caret put down by a click, with whatever the click left selected behind it. */
function putCaretIn(panel: FilePanel, edit: Edited, anchor: number | null): FilePanel {
  return { ...panel, edit, anchor, line: null, said: null, warned: false }
}

/** A bar opened over the source: neither find nor go to line has a formatted line to land on. */
function asking(panel: FilePanel, ask: FileAsk): FilePanel {
  return { ...panel, asking: ask, formatted: false, said: null, warned: false }
}

/** The line found or asked for: marked, brought into view, and taken by the caret. */
function atLine(
  panel: FilePanel,
  line: number,
  body: number,
  rows: readonly InlineRow[] | null,
  column = 0,
): FilePanel {
  return {
    ...panel,
    line,
    scroll: inView(panel.scroll, drawnRow(rows, line - 1), body),
    // A caret sent somewhere else is a selection nobody can see the point of.
    anchor: null,
    ...(panel.edit ? { edit: caretAt(panel.edit, line - 1, column) } : {}),
  }
}

/**
 * A line kept on screen, two rows in from either edge, moving no further than
 * it has to: a caret that scrolls the file every time it moves is unreadable.
 */
function inView(scroll: number, row: number, body: number): number {
  const margin = Math.min(2, Math.max(0, Math.floor((body - 1) / 2)))
  if (row < scroll + margin) return Math.max(0, row - margin)
  if (row > scroll + body - 1 - margin) return Math.max(0, row - body + 1 + margin)
  return scroll
}

export function fileClick(panel: FilePanel, control: string, inputs: PanelInputs): PanelOutcome {
  // `caret:<line>:<cell>:<how>` — a click in the text, by the line it landed
  // on and how far into it. Which character that is depends on the tabs and
  // the wide characters before it, and on how far the view has slid to keep
  // the caret on screen, so it is worked out here rather than drawn into the
  // id. `how` is what the press meant: putting the caret down, reaching there
  // from where it was, dragging, or the second and third press.
  if (control.startsWith('caret:')) {
    const parts = control.slice('caret:'.length).split(':')
    const [row, cell] = parts.slice(0, 2).map(Number)
    const how = parts[2] ?? 'put'
    const text = inputs.text ?? []
    if (row === undefined || cell === undefined || text.length === 0) return stay(panel)
    const edit = panel.edit ?? editFrom(text)
    const columns = Math.max(1, inputs.columns ?? 80)
    const left = leftOf(cellOf(edit.lines[edit.row] ?? '', edit.column), columns)
    const at = Math.max(0, Math.min(edit.lines.length - 1, row))
    const line = edit.lines[at] ?? ''
    const column = columnOf(line, cell + left)
    // A word and a line are taken out of the line that was clicked, never out
    // of the whole file: neither ever crosses a line break, and joining a
    // megabyte up to find one would cost that on every second press.
    if (how === 'word' || how === 'line') {
      const span = clickedSpan(line, column, how === 'line' ? 3 : 2)
      const start = offsetOf(edit.lines, { line: at, col: 0 })
      return stay(
        putCaretIn(
          panel,
          caretAt(edit, at, span.to),
          span.to > span.from ? start + span.from : null,
        ),
      )
    }
    const was = offsetOf(edit.lines, { line: edit.row, col: edit.column })
    const anchor = how === 'put' ? null : (panel.anchor ?? was)
    return stay(putCaretIn(panel, caretAt(edit, at, column), anchor))
  }
  // `comment:<line>` — a line's number, pressed: the box opens on that line.
  if (control.startsWith('comment:'))
    return stay(commentOn(panel, Number(control.slice('comment:'.length)), inputs))
  const box = panel.asking?.kind === 'comment' ? panel.asking.box : null
  if (control === 'comment-keep' && box) return { panel, submit: true, choice: 'comment' }
  if (control === 'comment-shut') return stay({ ...panel, asking: null })
  if (control === 'comment-to' && box) {
    const to = nextTo(box.to, inputs.commentTo ?? [], 1)
    return stay({ ...panel, asking: { kind: 'comment', box: { ...box, to } } })
  }
  if (control === 'send') return { panel, submit: true, choice: 'send' }
  // The bar's own arrows: the same step its keys take.
  if (control === 'match-next' || control === 'match-previous') {
    const ask = panel.asking
    if (ask?.kind !== 'find') return stay(panel)
    return askKey(panel, ask, control === 'match-next' ? 'down' : 'up', '', inputs)
  }
  // Leaving the file, either way, loses what was typed into it: both ask first.
  const losing = panel.edit?.dirty === true && !panel.warned
  switch (control) {
    case 'close':
      return losing ? stay(warn(panel)) : close
    case 'save':
      return panel.edit?.dirty ? { panel, submit: true, choice: 'save' } : stay(panel)
    case 'shut-bar':
      return stay({ ...panel, asking: null })
    case 'editor':
      return losing ? stay(warn(panel)) : { panel, submit: true, choice: control }
    case 'copy-path':
      return { panel, submit: true, choice: control }
    case 'formatted':
      return losing
        ? stay(warn(panel))
        : stay({ ...panel, formatted: true, inline: false, scroll: 0, edit: null, anchor: null })
    case 'source':
      return stay({ ...panel, formatted: false, scroll: 0 })
    case 'inline':
      return stay(withInline(panel, inputs))
    default:
      return stay(panel)
  }
}

/**
 * The line a comment goes on when nothing says which: the line gone to, else
 * the first line added at or under the top of the view, else the top of it.
 */
function readingLine(panel: FilePanel, inputs: PanelInputs): number {
  if (panel.line) return panel.line - 1
  const rows = shownRows(panel, inputs)
  for (let at = panel.scroll; rows && at < rows.length; at++) {
    const row = rows[at]
    if (row?.kind === 'add' && row.line !== null) return row.line
  }
  return lineAtRow(rows, panel.scroll)
}

/**
 * The comment box opened on a line of the file, holding what is already kept
 * there. The number is the line as it is drawn; the one git gave it is what
 * finds its hunk, and a line typed since git was asked has none.
 */
function commentOn(panel: FilePanel, line: number, inputs: PanelInputs): FilePanel {
  const lines = panel.edit?.lines ?? inputs.text ?? []
  if (panel.formatted || line < 0 || line >= lines.length) return panel
  const from = panel.edit ? (panel.edit.from[line] ?? -1) : line
  const kept = inputs.comments?.find((one) => one.side === 'new' && one.line === line + 1) ?? null
  const box = composeOn(
    { line: line + 1, side: 'new', git: from >= 0 ? from + 1 : null, text: lines[line] ?? '' },
    kept,
  )
  // Typing, the caret is already on the line, and stays where it was in it.
  const opened = asking(panel, { kind: 'comment', box })
  if (panel.edit) return opened
  return atLine(opened, line + 1, Math.max(1, inputs.body ?? 20), shownRows(panel, inputs))
}
