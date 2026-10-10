import { pageBy } from '../frame.ts'
import { close, type PanelOutcome, stay, typed } from '../outcome.ts'

// The panels that are one question each.
//
// Ten of them — a confirmation, a line of text asked for, a list of branches,
// a diff, the shortcuts sheet — none over a hundred lines of state and none
// with anything the others need. A folder apiece would be indirection for its
// own sake, so they share one, and the threshold is the plan's: a panel gets a
// folder of its own when its two halves pass about 250 lines.

/** Asked before anything that cannot be undone. */
export interface ConfirmRemovePanel {
  kind: 'confirm-remove'
  task: string
  /**
   * The document this task produced that nobody has read, as a clause — or
   * null where closing loses no document.
   *
   * The reason this panel is shown at all for an agent in the project's own
   * checkout, where there is no unmerged work to lose: the task's folder is
   * the only copy of what it produced, and closing the agent deletes it.
   */
  unread: string | null
  field: 'keep' | 'remove'
  busy: boolean
  error: string | null
}

/**
 * Asked before closing every agent that has finished at once. Always asked,
 * however little each one would lose: a button that empties the list without
 * a word is one nobody presses twice.
 */
export interface CloseDonePanel {
  kind: 'close-done'
  /** The tasks it would close, as the list names them. */
  tasks: string[]
  /**
   * Of those, the ones whose produced document nobody has read.
   *
   * Named before the press rather than counted after it: a task's folder is
   * the only copy of the document it produced, so this button is the one that
   * destroys them — six at once, in the case that put this field here.
   */
  unread: string[]
  field: 'keep' | 'remove'
  busy: boolean
  error: string | null
}

/** A changed file, read-only, a hunk at a time. */
export interface DiffPanel {
  kind: 'diff'
  task: string
  /** The changed files, and which one is shown. */
  files: string[]
  file: number
  /** Lines scrolled past. */
  scroll: number
  busy: false
}

/**
 * One line of text asked for: a note, a branch name. What it is for decides
 * what the words become, and a note can be about this project or everything.
 */
export interface PromptPanel {
  kind: 'prompt'
  purpose:
    | 'note'
    | 'edit-note'
    /**
     * The headline over a note in the window: `target` is the note, when it
     * was said and what it said joined by a NUL. The only way one is written
     * for a note that was taken before anybody wrote one.
     */
    | 'note-headline'
    | 'new-branch'
    | 'rename-branch'
    | 'rename-terminal'
    | 'rename-lane'
    | 'run-command'
    | 'rename-agent'
    | 'rename-schedule'
    /**
     * What a project is called on screen: `target` is its name, which is its
     * id and which this never changes.
     */
    | 'rename-project'
    /** An account to add: `target` is its harness and its kind, joined by a NUL. */
    | 'account-name'
    /** An API-key account's key: `target` is the account. Never drawn as typed. */
    | 'account-key'
  /**
   * The terminal or agent it is about, for renaming one or running a command
   * in it; for a note being changed, when it was said and what it said, joined
   * by a NUL.
   */
  target?: string
  /**
   * For a note: everything known about it besides its words, so the page that
   * changes one is also the page that reads it whole.
   */
  note?: NoteKnown
  title: string
  /** What the field is, said before it. */
  label: string
  text: string
  /** A note that is about every project, not the one you are in. */
  everywhere: boolean
  busy: boolean
  error: string | null
}

/** Finding text in a terminal's scrollback, from the bottom up. */
export interface FindPanel {
  kind: 'find'
  /** The terminal's lane id. */
  terminal: string
  query: string
  /** Which match is shown, counting from the newest. */
  index: number
  busy: false
}

export function findPanel(terminal: string, query = '', index = 0): FindPanel {
  return { kind: 'find', terminal, query, index, busy: false }
}

/** Switching the project's checkout to another branch, or a new one. */
export interface BranchPanel {
  kind: 'branch'
  /** Narrows the branches; a name nobody has offers to create it. */
  query: string
  index: number
  /** Lines of the list scrolled past: the panel's place in the one scroll area. */
  scroll: number
  /** Whether the list follows the branch the keyboard is on, until you scroll it. */
  following: boolean
  busy: boolean
  error: string | null
}

/** One of the project's branches, as git lists them. */
export interface BranchRow {
  name: string
  current: boolean
  /** When it last had a commit, said the way people say it. */
  when: string
}

/** Asked before throwing work away. */
export interface ConfirmPanel {
  kind: 'confirm'
  purpose: 'discard'
  task: string | null
  path: string
  /** Keep is where the keyboard starts; the other button is the one that throws work away. */
  field: 'keep' | 'remove'
  busy: boolean
  error: string | null
}

/**
 * What is known about a note besides its words: the headline it was given,
 * what it is about, who said it and when. When it was said and what it said
 * are together what names a note; nothing else about it is unique.
 */
export interface NoteKnown {
  at: string
  /** The headline written beside it when it was taken, if anybody wrote one. */
  summary: string | null
  /** A task id, a project name, or null when it is about everything. */
  scope: string | null
  /** Where it came from: `voice`, `window`, `cli`, `orchestrator`. */
  by: string
}

/** Writing the headline a note is read by, for a note that has none or a worse one. */
export function noteHeadlinePanel(note: NoteKnown, said: string): PromptPanel {
  return {
    ...promptPanel(
      'note-headline',
      'Headline',
      'WHAT IT IS ABOUT AND WHAT IT DOES',
      note.summary ?? '',
    ),
    target: `${note.at}\u0000${said}`,
  }
}

/** A note, read whole and changed from the same page: its words are the field. */
export function notePanel(note: NoteKnown, said: string): PromptPanel {
  return {
    ...promptPanel('edit-note', 'Note', 'NOTE', said),
    target: `${note.at}\u0000${said}`,
    note,
  }
}

/**
 * What is known about a note, in the words a page says it in: what it is
 * about, and who said it when. `when` is the moment as the window says
 * moments, since only the window knows which clock a person is reading.
 */
export function noteFacts(note: NoteKnown, when: string): { about: string; said: string } {
  const who =
    note.by === 'orchestrator'
      ? 'the orchestrator'
      : note.by === 'voice' || note.by === 'window' || note.by === 'cli'
        ? 'you'
        : note.by && note.by !== 'unknown'
          ? note.by
          : 'somebody'
  return {
    about: note.scope === null ? 'About everything' : `About ${note.scope}`,
    said: `Said by ${who} · ${when}`,
  }
}

export function promptPanel(
  purpose: PromptPanel['purpose'],
  title: string,
  label: string,
  text = '',
): PromptPanel {
  return {
    kind: 'prompt',
    purpose,
    title,
    label,
    text,
    everywhere: false,
    busy: false,
    error: null,
  }
}

export function branchPanel(): BranchPanel {
  return {
    kind: 'branch',
    query: '',
    index: 0,
    scroll: 0,
    following: true,
    busy: false,
    error: null,
  }
}

/** The branches matching what was typed, and a new one when none is called that. */
export function branchChoices(
  rows: readonly BranchRow[],
  query: string,
): { name: string; create: boolean; row: BranchRow | null }[] {
  const want = query.trim().toLowerCase()
  const found = rows
    .filter((row) => row.name.toLowerCase().includes(want))
    .map((row) => ({ name: row.name, create: false, row }))
  const exact = rows.some((row) => row.name === query.trim())
  return want && !exact && /^[\w./-]+$/.test(query.trim())
    ? [{ name: query.trim(), create: true, row: null }, ...found]
    : found
}

/** The keys Tade keeps, and the way to change the one that is yours. */
export interface KeysPanel {
  kind: 'keys'
  /** Lines of the sheet scrolled past: thirty of them, on a terminal that may have fourteen. */
  scroll: number
  busy: false
}

export function keysPanel(): KeysPanel {
  return { kind: 'keys', scroll: 0, busy: false }
}

/** Closing, when closing would stop something. */
export interface QuitPanel {
  kind: 'quit'
  field: 'cancel' | 'quit'
  busy: false
}

/** Reloading, when reloading would stop something. */
export interface ReloadPanel {
  kind: 'reload'
  field: 'cancel' | 'reload'
  busy: false
}

/** What `X` in the AGENTS heading asks first, with the agents it would close in it. */
export function closeDonePanel(
  tasks: readonly string[],
  unread: readonly string[] = [],
): CloseDonePanel {
  return {
    kind: 'close-done',
    tasks: [...tasks],
    unread: [...unread],
    field: 'keep',
    busy: false,
    error: null,
  }
}

export function confirmRemovePanel(task: string, unread: string | null = null): ConfirmRemovePanel {
  // Keep is where the keyboard starts: enter on a question like this should
  // be the answer that loses nothing.
  return { kind: 'confirm-remove', task, unread, field: 'keep', busy: false, error: null }
}

export function diffPanel(task: string, files: readonly string[], file = 0): DiffPanel {
  return { kind: 'diff', task, files: [...files], file: Math.max(0, file), scroll: 0, busy: false }
}

/** Typing narrows; enter and ↑ go to an older match, ↓ to a newer one. */
export function findKey(
  panel: FindPanel,
  key: string | undefined,
  data: string,
  found: number,
): PanelOutcome {
  if (key === 'escape') return close
  const count = Math.max(1, found)
  if (key === 'enter' || key === 'up') return stay({ ...panel, index: (panel.index + 1) % count })
  if (key === 'down') return stay({ ...panel, index: (panel.index - 1 + count) % count })
  if (key === 'backspace')
    return stay({ ...panel, query: [...panel.query].slice(0, -1).join(''), index: 0 })
  if (key === 'ctrl+u') return stay({ ...panel, query: '', index: 0 })
  const text = typed(data, key)
  return text ? stay({ ...panel, query: panel.query + text, index: 0 }) : stay(panel)
}

function savePrompt(panel: PromptPanel): PanelOutcome {
  if (panel.text.trim() === '') {
    const said =
      panel.purpose === 'note'
        ? 'Write the note first.'
        : panel.purpose === 'note-headline'
          ? 'Write the headline first.'
          : panel.purpose === 'run-command'
            ? 'Type the command first.'
            : 'Give it a name.'
    return stay({ ...panel, error: said })
  }
  return { panel: { ...panel, busy: true, error: null }, submit: true, choice: 'save' }
}

/** Typing, and enter to keep it. A paste arrives whole; tab turns a note's scope. */
export function promptKey(panel: PromptPanel, key: string | undefined, data: string): PanelOutcome {
  if (panel.busy) return key === 'escape' ? close : stay(panel)
  if (key === 'escape') return close
  if (key === 'enter') return savePrompt(panel)
  if (key === 'tab' && panel.purpose === 'note')
    return stay({ ...panel, everywhere: !panel.everywhere })
  if (key === 'backspace') return stay({ ...panel, text: [...panel.text].slice(0, -1).join('') })
  if (key === 'ctrl+u') return stay({ ...panel, text: '' })
  if (key === 'space') return stay({ ...panel, text: `${panel.text} `, error: null })
  const text = typed(data, key)
  // Branch names have no spaces, so a space typed into one is a dash.
  const branch = panel.purpose === 'new-branch' || panel.purpose === 'rename-branch'
  const typedText = branch ? text.replace(/\s/g, '-') : text
  return typedText ? stay({ ...panel, text: panel.text + typedText, error: null }) : stay(panel)
}

export function branchKey(
  panel: BranchPanel,
  key: string | undefined,
  data: string,
  rows: readonly BranchRow[],
): PanelOutcome {
  if (panel.busy) return key === 'escape' ? close : stay(panel)
  if (key === 'escape') return close
  const choices = branchChoices(rows, panel.query)
  if (key === 'down' || key === 'up') {
    const count = Math.max(1, choices.length)
    return stay({
      ...panel,
      index: (panel.index + (key === 'down' ? 1 : -1) + count) % count,
      following: true,
    })
  }
  if (key === 'enter') {
    const choice = choices[panel.index]
    return choice
      ? {
          panel: { ...panel, busy: true, error: null },
          submit: true,
          choice: `${choice.create ? 'create' : 'switch'}:${choice.name}`,
        }
      : stay(panel)
  }
  if (key === 'backspace')
    return stay({
      ...panel,
      query: [...panel.query].slice(0, -1).join(''),
      index: 0,
      following: true,
    })
  const text = typed(data, key)
  return text && !/\s/.test(text)
    ? stay({ ...panel, query: panel.query + text, index: 0, following: true })
    : stay(panel)
}

export function confirmKey(
  panel: ConfirmRemovePanel | ConfirmPanel | CloseDonePanel,
  key: string | undefined,
): PanelOutcome {
  if (panel.busy) return stay(panel)
  if (key === 'escape') return close
  if (key === 'tab' || key === 'shift+tab' || key === 'left' || key === 'right') {
    return stay({ ...panel, field: panel.field === 'keep' ? 'remove' : 'keep' })
  }
  if (key === 'enter') {
    return panel.field === 'keep'
      ? close
      : { panel: { ...panel, busy: true, error: null }, submit: true }
  }
  return stay(panel)
}

export function diffKey(panel: DiffPanel, key: string | undefined): PanelOutcome {
  if (key === 'escape' || key === 'enter') return close
  if (key === 'left' || key === 'right') return stay(stepFile(panel, key === 'left' ? -1 : 1))
  const by = pageBy(key)
  return by === null ? stay(panel) : stay({ ...panel, scroll: Math.max(0, panel.scroll + by) })
}

export function diffClick(panel: DiffPanel, control: string): PanelOutcome {
  if (control === 'prev-file') return stay(stepFile(panel, -1))
  if (control === 'next-file') return stay(stepFile(panel, 1))
  if (control === 'editor' || control === 'ask') return { panel, submit: true, choice: control }
  return stay(panel)
}

function stepFile(panel: DiffPanel, delta: number): DiffPanel {
  const count = Math.max(1, panel.files.length)
  return { ...panel, file: (panel.file + delta + count) % count, scroll: 0 }
}

/**
 * The shortcuts sheet: nothing to answer, one control that opens the file, and
 * the arrows reading down it — the wheel's own move, said with a key.
 */
export function keysKey(panel: KeysPanel, key: string | undefined): PanelOutcome {
  if (key === 'escape' || key === 'enter') return close
  const by = pageBy(key)
  return by === null ? stay(panel) : stay({ ...panel, scroll: Math.max(0, panel.scroll + by) })
}

export function keysClick(panel: KeysPanel, control: string): PanelOutcome {
  return control === 'change-keys' ? { panel, submit: true, choice: 'change-keys' } : stay(panel)
}

export function quitKey(panel: QuitPanel, key: string | undefined): PanelOutcome {
  if (key === 'escape') return close
  if (key === 'tab' || key === 'left' || key === 'right') {
    return stay({ ...panel, field: panel.field === 'cancel' ? 'quit' : 'cancel' })
  }
  if (key === 'enter')
    return panel.field === 'cancel' ? close : { panel, submit: true, choice: 'quit' }
  return stay(panel)
}

export function quitClick(panel: QuitPanel, control: string): PanelOutcome {
  if (control === 'cancel') return close
  if (control === 'quit') return { panel, submit: true, choice: 'quit' }
  if (control === 'where') return { panel, submit: true, choice: 'where' }
  return stay(panel)
}

export function reloadKey(panel: ReloadPanel, key: string | undefined): PanelOutcome {
  if (key === 'escape') return close
  if (key === 'tab' || key === 'left' || key === 'right') {
    return stay({ ...panel, field: panel.field === 'cancel' ? 'reload' : 'cancel' })
  }
  if (key === 'enter')
    return panel.field === 'cancel' ? close : { panel, submit: true, choice: 'reload' }
  return stay(panel)
}

export function reloadClick(panel: ReloadPanel, control: string): PanelOutcome {
  if (control === 'cancel') return close
  if (control === 'reload') return { panel, submit: true, choice: 'reload' }
  return stay(panel)
}

export function findClick(panel: FindPanel, control: string, found: number): PanelOutcome {
  const count = Math.max(1, found)
  if (control === 'close') return close
  if (control === 'older') return stay({ ...panel, index: (panel.index + 1) % count })
  if (control === 'newer') return stay({ ...panel, index: (panel.index - 1 + count) % count })
  return stay(panel)
}

export function promptClick(panel: PromptPanel, control: string): PanelOutcome {
  if (control === 'cancel') return close
  if (control === 'save') return savePrompt(panel)
  if (control === 'everywhere') return stay({ ...panel, everywhere: !panel.everywhere })
  // A note's own page does what its menu does: have its words, take it back,
  // or write the headline it is read by.
  if (panel.note && (control === 'copy' || control === 'forget' || control === 'headline'))
    return { panel, submit: true, choice: control }
  return stay(panel)
}

export function branchClick(
  panel: BranchPanel,
  control: string,
  rows: readonly BranchRow[],
): PanelOutcome {
  if (control === 'cancel') return close
  const choice = branchChoices(rows, panel.query)[Number(control.slice(4))]
  if (control.startsWith('row:') && choice) {
    return {
      panel: { ...panel, busy: true, error: null },
      submit: true,
      choice: `${choice.create ? 'create' : 'switch'}:${choice.name}`,
    }
  }
  return stay(panel)
}

/** The three panels that ask before doing something: keep it, or go ahead. */
export function confirmClick(
  panel: ConfirmPanel | ConfirmRemovePanel | CloseDonePanel,
  control: string,
): PanelOutcome {
  if (control === 'keep') return close
  if (control === 'remove') return { panel: { ...panel, busy: true, error: null }, submit: true }
  return stay(panel)
}
