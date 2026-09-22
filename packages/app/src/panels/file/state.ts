import {
  clickedSpan,
  type LineKey,
  lineKey,
  offsetOf,
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
import { close, type PanelOutcome, stay, typed } from '../outcome.ts'

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
  busy: false
}

/** Finding in the file, or going to a line: whichever bar is open. */
export type FileAsk =
  | { kind: 'find'; query: string; index: number }
  | { kind: 'goto'; digits: string }

/**
 * A file, opened at a line when there is one: a few lines of what comes before
 * stay in view, so the line is read in its place. A line asked for means the
 * source, since formatted Markdown has no line numbers to go to.
 */
export function filePanel(path: string, line: number | null = null, markdown = false): FilePanel {
  return {
    kind: 'file',
    path,
    line,
    scroll: line ? Math.max(0, line - 6) : 0,
    formatted: markdown && line === null,
    asking: null,
    edit: null,
    anchor: null,
    said: null,
    warned: false,
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
  if (panel.edit) return typingKey(panel, panel.edit, key, data, body)
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
): PanelOutcome {
  if (key === 'ctrl+s')
    return edit.dirty
      ? { panel: { ...panel, warned: false }, submit: true, choice: 'save' }
      : stay(panel)
  if (key === 'ctrl+f') return stay(asking(panel, { kind: 'find', query: '', index: 0 }))
  if (key === 'ctrl+g') return stay(asking(panel, { kind: 'goto', digits: '' }))
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
    return stay(typedInto({ ...panel, anchor: 0 }, all, body))
  }
  if (what?.do === 'move') return stay(movedIn(panel, edit, what, selected, body))
  // Everything below changes the text, so what is selected is what it
  // replaces: the file with it taken out is what each of them starts from.
  // Worked out only where something is about to change it — a key this editor
  // has no meaning for must cost nothing and leave the selection where it was.
  const without = () => (selected ? cutSelection(edit, selected) : edit)
  const letGo = { ...panel, anchor: null }
  // Backspace and delete take the selection and nothing more: taking it out
  // is the whole of what they were asked for.
  if (selected && (key === 'backspace' || key === 'delete'))
    return stay(typedInto(letGo, without(), body))
  // A paste is text like any other here, newlines and all — pasting a line in
  // is half of what a short edit is for.
  const paste = pastedText(data)
  if (paste !== null) return stay(typedInto(letGo, typeIn(without(), paste), body))
  const text = typed(data, key)
  if (text) return stay(typedInto(letGo, typeIn(without(), text), body))
  // What is left of the editor's own keys, every one of which changes the
  // text: the motions were answered above, and none of these types anything
  // `typed` would have taken first.
  const moved = editKey(without(), key, body)
  return moved ? stay(typedInto(letGo, moved, body)) : stay(panel)
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
): FilePanel {
  if (!what.extend) {
    if (selected && what.by === 'char') {
      const at = placeOf(edit.lines, what.back ? selected.from : selected.to)
      return typedInto({ ...panel, anchor: null }, caretAt(edit, at.line, at.col), body)
    }
    const moved = editKey(edit, motionKey(what), body)
    return moved ? typedInto({ ...panel, anchor: null }, moved, body) : { ...panel, anchor: null }
  }
  const anchor = panel.anchor ?? offsetOf(edit.lines, { line: edit.row, col: edit.column })
  const moved = editKey(edit, motionKey(what), body)
  return moved ? typedInto({ ...panel, anchor }, moved, body) : { ...panel, anchor }
}

/** What was pasted, out of the markers a terminal wraps a paste in. */
function pastedText(data: string): string | null {
  const open = '\x1b[200~'
  const shut = '\x1b[201~'
  if (!data.startsWith(open)) return null
  const end = data.indexOf(shut)
  return data.slice(open.length, end < 0 ? undefined : end)
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
function typedInto(panel: FilePanel, edit: Edited, body: number): FilePanel {
  return {
    ...panel,
    edit,
    line: null,
    warned: false,
    said: null,
    scroll: inView(panel.scroll, edit.row, body),
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
  if (key === 'escape') return stay({ ...panel, asking: null })
  if (ask.kind === 'goto') {
    if (key === 'enter') {
      const line = Number(ask.digits)
      if (!line) return stay({ ...panel, asking: null })
      return stay(atLine(panel, Math.min(Math.max(1, line), Math.max(1, text.length)), body))
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
    return stay(match ? atLine(moved, match.line + 1, body, match.column) : moved)
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
function atLine(panel: FilePanel, line: number, body: number, column = 0): FilePanel {
  return {
    ...panel,
    line,
    scroll: inView(panel.scroll, line - 1, body),
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
        : stay({ ...panel, formatted: true, scroll: 0, edit: null, anchor: null })
    case 'source':
      return stay({ ...panel, formatted: false, scroll: 0 })
    default:
      return stay(panel)
  }
}
