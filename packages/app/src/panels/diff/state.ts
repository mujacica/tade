import type { LineComment } from '../../comments.ts'
import type { DiffLine } from '../../diff.ts'
import type { PanelInputs } from '../../panels.ts'
import { type Composing, composeKey, composeOn, nextTo } from '../comment.ts'
import { changesIn } from '../file/inline.ts'
import { pageBy } from '../frame.ts'
import { close, type PanelOutcome, stay } from '../outcome.ts'

// The patch reader: a task's changed files, read-only, one at a time — and the
// one line of it the keyboard is on, which is what a comment is written on.
//
// A comment is the person's words on a line, kept with the rest of the
// review's until they are sent together (`comments.ts`, `wire/comments.ts`);
// the box they are written in is `comment.ts`'s, shared with the file viewer.

/** A changed file, read-only, with a line of it to comment on. */
export interface DiffPanel {
  kind: 'diff'
  task: string
  /** The changed files, and which one is shown. */
  files: string[]
  file: number
  /** Lines scrolled past. */
  scroll: number
  /** The line of git's answer the keyboard is on, once it has been on one. */
  at: number | null
  /** Whether the view keeps that line in sight: the wheel and the bar let go of it. */
  following: boolean
  /** A comment being written on a line, while the box is open. */
  composing: Composing | null
  /**
   * The line `n` or `p` went round an end to get to — past the last change to
   * the first, or before the first to the last. Said only while the keyboard is
   * still on it.
   */
  wrapped: number | null
  busy: false
}

export function diffPanel(task: string, files: readonly string[], file = 0): DiffPanel {
  return {
    kind: 'diff',
    task,
    files: [...files],
    file: Math.max(0, file),
    scroll: 0,
    at: null,
    following: false,
    composing: null,
    wrapped: null,
    busy: false,
  }
}

/**
 * Reading: ↑↓ move the line you are on, `n` and `p` move it to the next change
 * and the one before, the page keys move the view, ←→ the file. `c` writes on
 * the line — so does a click on it — `s` sends what has been written, and
 * while the box is open every key is the box's.
 */
export function diffKey(
  panel: DiffPanel,
  key: string | undefined,
  data: string,
  inputs: PanelInputs = {},
): PanelOutcome {
  if (panel.composing) return composing(panel, panel.composing, key, data, inputs)
  const lines = inputs.patch?.lines ?? []
  if (key === 'escape' || key === 'enter') return close
  if (key === 'left' || key === 'right') return stay(stepFile(panel, key === 'left' ? -1 : 1))
  if (key === 'up' || key === 'down') {
    // The first press lands on the first change in view; after that, a line at a time.
    const at =
      panel.at === null
        ? firstChanged(lines, panel.scroll)
        : stepLine(lines, panel.at, key === 'up' ? -1 : 1)
    return stay(at === null ? panel : { ...panel, at, following: true, wrapped: null })
  }
  if (key === 'n' || key === 'ctrl+n' || key === 'p' || key === 'ctrl+p') {
    const back = key === 'p' || key === 'ctrl+p'
    return stay(toChange(panel, lines, back, inputs.body))
  }
  if (key === 'c' || key === 'ctrl+r') return stay(writeOn(panel, lines, panel.at, inputs))
  if (key === 's' && (inputs.drafted ?? 0) > 0) return { panel, submit: true, choice: 'send' }
  const by = pageBy(key)
  if (by === null) return stay(panel)
  // Never past the last screen, which is as far as the drawing goes (`startOf`):
  // a scroll kept beyond it is a page up that moves the view less than a page,
  // or not at all — so one kept there already pages from the last screen.
  const end = Math.max(0, lines.length - Math.max(1, inputs.body ?? lines.length))
  const from = Math.min(panel.scroll, end)
  return stay({ ...panel, scroll: Math.max(0, Math.min(end, from + by)), following: false })
}

export function diffClick(
  panel: DiffPanel,
  control: string,
  inputs: PanelInputs = {},
): PanelOutcome {
  const lines = inputs.patch?.lines ?? []
  // `line:<n>` — a line of git's answer, pressed: the keyboard goes there and
  // the box opens on it, as a press on a line number does in the file viewer.
  if (control.startsWith('line:')) {
    const at = Number(control.slice('line:'.length))
    return stay(writeOn({ ...panel, composing: null }, lines, at, inputs))
  }
  const box = panel.composing
  if (control === 'comment-keep' && box) return { panel, submit: true, choice: 'comment' }
  if (control === 'comment-shut') return stay({ ...panel, composing: null })
  if (control === 'comment-to' && box)
    return stay({ ...panel, composing: { ...box, to: nextTo(box.to, inputs.commentTo ?? [], 1) } })
  if (control === 'send') return { panel, submit: true, choice: 'send' }
  if (control === 'prev-file') return stay(stepFile(panel, -1))
  if (control === 'next-file') return stay(stepFile(panel, 1))
  if (control === 'editor' || control === 'ask') return { panel, submit: true, choice: control }
  return stay(panel)
}

/** The comment kept on a line of git's answer, if there is one. */
export function keptOn(
  line: DiffLine | undefined,
  comments: readonly LineComment[] | undefined,
): LineComment | null {
  if (!line || line.kind === 'hunk') return null
  const side = line.kind === 'remove' ? 'old' : 'new'
  const number = side === 'old' ? line.old : line.new
  return comments?.find((one) => one.side === side && one.line === number) ?? null
}

function composing(
  panel: DiffPanel,
  box: Composing,
  key: string | undefined,
  data: string,
  inputs: PanelInputs,
): PanelOutcome {
  const answer = composeKey(box, key, data, inputs.commentTo ?? [])
  if ('composing' in answer) return stay({ ...panel, composing: answer.composing })
  if (answer.done === 'keep') return { panel, submit: true, choice: 'comment' }
  return stay({ ...panel, composing: null })
}

/**
 * The box opened on a line — the one asked for, or the first change in view
 * when the keyboard has not been on one — holding what is already kept there.
 * A hunk's own `@@` line is nowhere to write.
 */
function writeOn(
  panel: DiffPanel,
  lines: readonly DiffLine[],
  asked: number | null,
  inputs: PanelInputs,
): DiffPanel {
  const at = asked ?? firstChanged(lines, panel.scroll)
  const line = at === null ? undefined : lines[at]
  if (at === null || !line || line.kind === 'hunk') return panel
  const side = line.kind === 'remove' ? 'old' : 'new'
  const number = (side === 'old' ? line.old : line.new) ?? 0
  return {
    ...panel,
    at,
    following: true,
    composing: composeOn(
      { line: number, side, git: number, text: line.text },
      keptOn(line, inputs.comments),
    ),
  }
}

/** The next line that is a line, one way or the other, or null at either end. */
function stepLine(lines: readonly DiffLine[], from: number, by: 1 | -1): number | null {
  for (let at = from + by; at >= 0 && at < lines.length; at += by) {
    if (lines[at]?.kind !== 'hunk') return at
  }
  return lines[from]?.kind === 'hunk' ? null : from
}

/** Where the keyboard starts: the first line added or taken out at or under the top of the view. */
function firstChanged(lines: readonly DiffLine[], from: number): number | null {
  const changed = (line: DiffLine | undefined) => line?.kind === 'add' || line?.kind === 'remove'
  for (let at = Math.max(0, from); at < lines.length; at++) if (changed(lines[at])) return at
  const any = lines.findIndex((line) => line.kind !== 'hunk')
  return any < 0 ? null : any
}

/**
 * The keyboard on the next change, or the one before: from the line it is on,
 * or from the top of the view before it has been on one. Past the last it goes
 * round to the first, and the foot says it did — a press at an end that did
 * nothing would read as a key that does not work.
 *
 * The view goes with it, the change a few lines down so what comes before it
 * is read with it — never more than half the view, and never past the end.
 * `body` is the rows in view; without it the view is left to follow the line.
 */
function toChange(
  panel: DiffPanel,
  lines: readonly DiffLine[],
  back: boolean,
  body: number | undefined,
): DiffPanel {
  const changes = changesIn(lines)
  if (changes.length === 0) return panel
  const room = Math.max(1, body ?? lines.length)
  const top = Math.max(0, Math.min(panel.scroll, lines.length - room))
  // From the top of the view, a change on its first line is the next one.
  const here = panel.at ?? (back ? top : top - 1)
  let index = back
    ? changes.findLastIndex((one) => one.from < here)
    : changes.findIndex((one) => one.from > here)
  const wrapped = index < 0
  if (wrapped) index = back ? changes.length - 1 : 0
  const at = changes[index]?.from ?? 0
  const lead = Math.min(3, Math.floor((room - 1) / 2))
  const scroll = Math.max(0, Math.min(at - lead, lines.length - room))
  return { ...panel, at, following: true, scroll, wrapped: wrapped ? at : null }
}

/** Which change the keyboard is on, among how many, where it is on one. */
export function changeAt(
  panel: DiffPanel,
  lines: readonly DiffLine[],
): { index: number; count: number; wrapped: boolean } | null {
  const at = panel.at
  if (at === null) return null
  const changes = changesIn(lines)
  const index = changes.findIndex((one) => at >= one.from && at < one.to)
  if (index < 0) return null
  return { index, count: changes.length, wrapped: panel.wrapped === at }
}

function stepFile(panel: DiffPanel, delta: number): DiffPanel {
  const count = Math.max(1, panel.files.length)
  return {
    ...panel,
    file: (panel.file + delta + count) % count,
    scroll: 0,
    at: null,
    following: false,
    composing: null,
    wrapped: null,
  }
}
