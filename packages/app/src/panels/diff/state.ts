import type { LineComment } from '../../comments.ts'
import type { DiffLine } from '../../diff.ts'
import type { PanelInputs } from '../../panels.ts'
import { type Composing, composeKey, composeOn, nextTo } from '../comment.ts'
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
  /** The other machine the task is on, read out of this home's mirror of it; absent for this one. */
  machine?: string
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
  busy: false
}

export function diffPanel(
  task: string,
  files: readonly string[],
  file = 0,
  machine?: string,
): DiffPanel {
  return {
    kind: 'diff',
    task,
    ...(machine ? { machine } : {}),
    files: [...files],
    file: Math.max(0, file),
    scroll: 0,
    at: null,
    following: false,
    composing: null,
    busy: false,
  }
}

/**
 * Reading: ↑↓ move the line you are on, the page keys move the view, ←→ the
 * file. `c` writes on the line — so does a click on it — `s` sends what has
 * been written, and while the box is open every key is the box's.
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
    return stay(at === null ? panel : { ...panel, at, following: true })
  }
  if (key === 'c' || key === 'ctrl+r') return stay(writeOn(panel, lines, panel.at, inputs))
  if (key === 's' && (inputs.drafted ?? 0) > 0) return { panel, submit: true, choice: 'send' }
  const by = pageBy(key)
  return by === null
    ? stay(panel)
    : stay({ ...panel, scroll: Math.max(0, panel.scroll + by), following: false })
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
  // Another machine's change has no file here to open and no agent here to ask.
  if ((control === 'editor' || control === 'ask') && !panel.machine) {
    return { panel, submit: true, choice: control }
  }
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

function stepFile(panel: DiffPanel, delta: number): DiffPanel {
  const count = Math.max(1, panel.files.length)
  return {
    ...panel,
    file: (panel.file + delta + count) % count,
    scroll: 0,
    at: null,
    following: false,
    composing: null,
  }
}
