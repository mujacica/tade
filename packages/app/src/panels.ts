import type { Setting, SettingGroup } from '@wilco/core'
import { SPEND_BY, SPEND_WINDOWS, type SpendBy, type SpendWindow } from './spend.ts'

// Panels: the questions the window asks, floating over it.
//
// A click does the thing. When the thing needs more than a click — which
// folder to open, what to change — it gets a panel with the fields in it, filled
// with the likely answers, and Enter runs it. Nothing types a half-written
// command into a line for you to finish, and nothing takes the screen away:
// the window keeps running underneath.
//
// Pure, like the rest of the model. What a key or a click does to a panel is
// decided here; carrying it out is the app's job.

/** One choice in a dropdown, grouped under a heading. */
export interface Choice {
  value: string
  label: string
  group: string
  /** Said quietly on the right. */
  note?: string
  /** Why it cannot be picked yet. */
  off?: string
}

/** The choices matching what was typed: every word, in any order. */
export function matchingChoices(choices: readonly Choice[], query: string): Choice[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...choices]
  return choices.filter((choice) => {
    const haystack = `${choice.group} ${choice.label} ${choice.value}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

/** Where the money went, regrouped and re-windowed by its tabs. */
export interface SpendPanel {
  kind: 'spend'
  window: SpendWindow
  by: SpendBy
  busy: false
}

/** An agent's own menu, opened from its ≡ or a right-click, where it was clicked. */
export interface MenuPanel {
  kind: 'menu'
  task: string
  /** Which item the keyboard is on. */
  index: number
  /** The screen cell it was opened from, so it appears there. */
  anchor: { row: number; col: number } | null
  busy: false
}

/** What a menu offers. Unavailable items stay listed, with the reason. */
export interface MenuItem {
  id: string
  label: string
  /** Why not, when it cannot be done now. */
  off?: string
  /** Said quietly on the right: a key, a count. */
  note?: string
  danger?: boolean
  /** A rule above it. */
  divider?: boolean
}

/** Asked before anything that cannot be undone. */
export interface ConfirmRemovePanel {
  kind: 'confirm-remove'
  task: string
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
 * Settings, over the window: categories down the side, real controls on the
 * right, saved as you change them.
 */
export interface SettingsPanel {
  kind: 'settings'
  /** A group id, or `accounts`. */
  category: string
  /** Which row of the category the keyboard is on. */
  row: number
  focus: 'categories' | 'form' | 'search'
  search: string
  /** A text setting being typed into. */
  editing: { path: string; text: string } | null
  /** A list opened from a setting. */
  dropdown: { path: string; query: string; index: number } | null
  /** Waiting for a key to be pressed, and the one pressed so far. */
  capture: { path: string; key: string | null } | null
  /** What the last change did, or why it did not happen. */
  saved: string | null
  error: string | null
  /** The microphone is being tried. */
  testing: boolean
  busy: false
}

export const ACCOUNTS = 'accounts'

/**
 * Opening a project: a folder browser that starts in your home folder, with
 * the projects you opened lately beside it, and git for a folder without it.
 */
export interface OpenProjectPanel {
  kind: 'open-project'
  /** The folder being looked in, as an absolute path. */
  dir: string
  /** Folders looked in before this one, and after it once you have gone back. */
  back: string[]
  forward: string[]
  /** Narrows what is listed; starting with `~`, `/` or `.` it goes to that path instead. */
  query: string
  /**
   * Which row is chosen — this folder, the folders in it, then the recent
   * projects — or -1 before anything is. Nothing is chosen on arriving in a
   * folder, so looking around never offers to open the place you walked through.
   */
  index: number
  field: 'query' | 'init' | 'name'
  /** The name you typed, or null to use the folder's. */
  name: string | null
  /** Make a folder without git into a repository. */
  init: boolean
  busy: boolean
  error: string | null
}

/** A row in the Open project list, as the app found it. */
export interface OpenRow {
  /** A project opened before, the folder being looked in, or a folder inside it. */
  kind: 'recent' | 'here' | 'folder'
  name: string
  path: string
  git: boolean
}

/** Every task, action, setting and approval, found by name. */
export interface PalettePanel {
  kind: 'palette'
  query: string
  index: number
  busy: false
}

/** One thing the palette can go to. */
export interface PaletteEntry {
  /** What choosing it does, for the app to carry out. */
  id: string
  label: string
  /** What kind of thing it is, said quietly: `task in checkout`, `setting`. */
  kind: string
  /** A mark before it: a task's state, or what an action is. */
  mark: string
  /** Colour of the mark: `waiting`, `busy`, `done`, `bad`, or plain. */
  tone?: 'waiting' | 'busy' | 'done' | 'bad' | 'hint'
  /** Said at the right: `waiting on you`. */
  note?: string
}

/** The keys Wilco keeps, and the way to change the one that is yours. */
export interface KeysPanel {
  kind: 'keys'
  busy: false
}

/** Closing, when closing would stop something. */
export interface QuitPanel {
  kind: 'quit'
  field: 'cancel' | 'quit'
  busy: false
}

export function palettePanel(): PalettePanel {
  return { kind: 'palette', query: '', index: 0, busy: false }
}

/** Entries matching what was typed: every word, somewhere in the label or its kind. */
export function matchingEntries(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...entries]
  return entries.filter((entry) => {
    const haystack = `${entry.label} ${entry.kind}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

export function openProjectPanel(dir: string, query = ''): OpenProjectPanel {
  return {
    kind: 'open-project',
    dir,
    back: [],
    forward: [],
    query,
    index: -1,
    field: 'query',
    name: null,
    init: true,
    busy: false,
    error: null,
  }
}

export type Panel =
  | SpendPanel
  | MenuPanel
  | ConfirmRemovePanel
  | DiffPanel
  | SettingsPanel
  | OpenProjectPanel
  | PalettePanel
  | KeysPanel
  | QuitPanel

export function settingsPanel(category = 'agents'): SettingsPanel {
  return {
    kind: 'settings',
    category,
    row: 0,
    focus: 'form',
    search: '',
    editing: null,
    dropdown: null,
    capture: null,
    saved: null,
    error: null,
    testing: false,
    busy: false,
  }
}

/** What the panel needs to know that it does not hold: the settings themselves, and lists. */
export interface PanelInputs {
  choices?: readonly Choice[]
  items?: readonly MenuItem[]
  settings?: readonly SettingGroup[]
  /** Accounts rows, for the Accounts category: how many there are to move through. */
  accounts?: number
  /** The Open project list, as it stands for the query. */
  rows?: readonly OpenRow[]
  /** Everything the palette can go to. */
  entries?: readonly PaletteEntry[]
}

/** The settings a panel is showing: a category's, or everything matching the search. */
export function visibleSettings(panel: SettingsPanel, groups: readonly SettingGroup[]): Setting[] {
  const words = panel.search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length > 0) {
    // One setting can live in two groups (the talk key is under Voice and Keys);
    // a search shows it once.
    const seen = new Set<string>()
    return groups
      .flatMap((group) => group.settings.map((setting) => ({ group, setting })))
      .filter(({ group, setting }) => {
        const haystack = `${group.title} ${setting.title} ${setting.means}`.toLowerCase()
        return words.every((word) => haystack.includes(word))
      })
      .map(({ setting }) => setting)
      .filter((setting) => {
        if (seen.has(setting.path)) return false
        seen.add(setting.path)
        return true
      })
  }
  return groups.find((group) => group.id === panel.category)?.settings ?? []
}

/** Choices a setting offers in a list: its own options, or the model catalog. */
export function choicesFor(setting: Setting, models: readonly Choice[]): Choice[] {
  if (setting.type.kind === 'model') return [...models]
  if (setting.type.kind === 'choice') {
    const about = setting.type.about ?? {}
    return setting.type.options.map((option) => ({
      value: option,
      label: about[option]?.label ?? option,
      group: about[option]?.group ?? setting.title,
      ...(about[option]?.note ? { note: about[option].note } : {}),
    }))
  }
  return []
}

/** Radios for a short list; a dropdown for a long one, or for models. */
export function usesDropdown(setting: Setting): boolean {
  return (
    setting.type.kind === 'model' ||
    (setting.type.kind === 'choice' &&
      (setting.type.list === true || setting.type.options.length > 3))
  )
}

/** A write for the app to carry out: path and value, unset when empty. */
export function writeOf(path: string, value: string): string {
  return `write:${path}\u0000${value}`
}

export function menuPanel(task: string, anchor: MenuPanel['anchor'] = null): MenuPanel {
  return { kind: 'menu', task, index: 0, anchor, busy: false }
}

/**
 * A task's menu, from what is true of it now. Nothing is hidden for being
 * unavailable — a menu that changes shape is one you re-read every time.
 */
export function menuItems(
  task: { lane: string | null; state: string },
  changed: number,
): MenuItem[] {
  const running = task.lane !== null
  return [
    { id: 'open', label: 'Open', note: 'enter' },
    { id: 'start', label: 'Start agent', ...(running ? { off: 'running' } : {}) },
    { id: 'stop', label: 'Stop agent', ...(running ? {} : { off: 'not running' }) },
    {
      id: 'changes',
      label: 'Show changes',
      ...(changed > 0
        ? { note: `${changed} file${changed === 1 ? '' : 's'}` }
        : { off: 'none yet' }),
    },
    { id: 'editor', label: 'Open in editor' },
    { id: 'copy-branch', label: 'Copy branch name' },
    {
      id: 'park',
      label: task.state === 'parked' ? 'Pick up again' : 'Park',
      divider: true,
    },
    { id: 'remove', label: 'Remove agent…', danger: true },
  ]
}

export function confirmRemovePanel(task: string): ConfirmRemovePanel {
  // Keep is where the keyboard starts: enter on a question like this should
  // be the answer that loses nothing.
  return { kind: 'confirm-remove', task, field: 'keep', busy: false, error: null }
}

export function diffPanel(task: string, files: readonly string[], file = 0): DiffPanel {
  return { kind: 'diff', task, files: [...files], file: Math.max(0, file), scroll: 0, busy: false }
}

export function spendPanel(): SpendPanel {
  return { kind: 'spend', window: 'today', by: 'agent', busy: false }
}

/** What a keystroke or click did: the panel as it now is, and whether to run it. */
export interface PanelOutcome {
  panel: Panel | null
  submit: boolean
  /** For a menu: which item was chosen. */
  choice?: string
}

const stay = (panel: Panel): PanelOutcome => ({ panel, submit: false })
const close: PanelOutcome = { panel: null, submit: false }

/**
 * A keystroke, while a panel has the keyboard.
 *
 * `key` is the key's name where it has one (`escape`, `enter`, `left`), and
 * `data` is what was typed, so a paste arrives as the text it is.
 */
export function panelKey(
  panel: Panel,
  key: string | undefined,
  data: string,
  inputs: PanelInputs = {},
): PanelOutcome {
  if (panel.kind === 'settings') return settingsKey(panel, key, data, inputs)
  if (panel.kind === 'open-project') return openKey(panel, key, data, inputs.rows ?? [])
  if (panel.kind === 'palette') return paletteKey(panel, key, data, inputs.entries ?? [])
  if (panel.kind === 'keys') return key === 'escape' || key === 'enter' ? close : stay(panel)
  if (panel.kind === 'quit') {
    if (key === 'escape') return close
    if (key === 'tab' || key === 'left' || key === 'right') {
      return stay({ ...panel, field: panel.field === 'cancel' ? 'quit' : 'cancel' })
    }
    if (key === 'enter')
      return panel.field === 'cancel' ? close : { panel, submit: true, choice: 'quit' }
    return stay(panel)
  }
  if (panel.kind === 'spend') return spendKey(panel, key)
  if (panel.kind === 'menu') return menuKey(panel, key, inputs.items ?? [])
  if (panel.kind === 'confirm-remove') return confirmKey(panel, key)
  return diffKey(panel, key)
}

/** A click on one of the panel's own controls. */
export function panelClick(panel: Panel, control: string, inputs: PanelInputs = {}): PanelOutcome {
  if (panel.kind === 'settings') return settingsClick(panel, control, inputs)
  if (panel.kind === 'open-project') return openClick(panel, control, inputs.rows ?? [])
  if (panel.kind === 'palette') {
    return control.startsWith('entry:')
      ? { panel, submit: true, choice: control.slice(6) }
      : stay(panel)
  }
  if (panel.kind === 'keys')
    return control === 'change-keys' ? { panel, submit: true, choice: 'change-keys' } : stay(panel)
  if (panel.kind === 'quit') {
    if (control === 'cancel') return close
    if (control === 'quit') return { panel, submit: true, choice: 'quit' }
    if (control === 'where') return { panel, submit: true, choice: 'where' }
    return stay(panel)
  }
  if (panel.kind === 'spend') return spendClick(panel, control)
  if (panel.kind === 'menu') {
    return control.startsWith('item:')
      ? { panel, submit: true, choice: control.slice(5) }
      : stay(panel)
  }
  if (panel.kind === 'confirm-remove') {
    if (control === 'keep') return close
    if (control === 'remove') return { panel: { ...panel, busy: true, error: null }, submit: true }
    return stay(panel)
  }
  return diffClick(panel, control)
}

/** ← → move through the time windows, tab through the groupings. */
function spendKey(panel: SpendPanel, key: string | undefined): PanelOutcome {
  if (key === 'escape' || key === 'enter') return close
  if (key === 'left' || key === 'right') {
    return stay({ ...panel, window: cycle(SPEND_WINDOWS, panel.window, key === 'left' ? -1 : 1) })
  }
  if (key === 'tab' || key === 'shift+tab') {
    return stay({ ...panel, by: cycle(SPEND_BY, panel.by, key === 'tab' ? 1 : -1) })
  }
  return stay(panel)
}

function spendClick(panel: SpendPanel, control: string): PanelOutcome {
  if (control === 'close') return close
  const [kind, id] = control.split(':')
  if (kind === 'window' && SPEND_WINDOWS.some((w) => w.id === id)) {
    return stay({ ...panel, window: id as SpendWindow })
  }
  if (kind === 'by' && SPEND_BY.some((b) => b.id === id))
    return stay({ ...panel, by: id as SpendBy })
  return stay(panel)
}

function cycle<T extends string>(options: readonly { id: T }[], current: T, delta: number): T {
  const at = options.findIndex((option) => option.id === current)
  return options[(at + delta + options.length) % options.length]?.id ?? current
}

/** Up and down through what can be done, enter to do it. */
function menuKey(
  panel: MenuPanel,
  key: string | undefined,
  items: readonly MenuItem[],
): PanelOutcome {
  if (key === 'escape') return close
  const usable = items.map((item, at) => ({ item, at })).filter(({ item }) => !item.off)
  if (key === 'down' || key === 'tab' || key === 'up' || key === 'shift+tab') {
    const here = usable.findIndex(({ at }) => at === panel.index)
    const step = key === 'down' || key === 'tab' ? 1 : -1
    const next = usable[(Math.max(0, here) + step + usable.length) % Math.max(1, usable.length)]
    return stay({ ...panel, index: next?.at ?? panel.index })
  }
  if (key === 'enter') {
    const item = items[panel.index]
    return item && !item.off ? { panel, submit: true, choice: item.id } : stay(panel)
  }
  return stay(panel)
}

function confirmKey(panel: ConfirmRemovePanel, key: string | undefined): PanelOutcome {
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

function diffKey(panel: DiffPanel, key: string | undefined): PanelOutcome {
  if (key === 'escape' || key === 'enter') return close
  if (key === 'down') return stay({ ...panel, scroll: panel.scroll + 1 })
  if (key === 'up') return stay({ ...panel, scroll: Math.max(0, panel.scroll - 1) })
  if (key === 'pageDown' || key === 'space') return stay({ ...panel, scroll: panel.scroll + 10 })
  if (key === 'pageUp') return stay({ ...panel, scroll: Math.max(0, panel.scroll - 10) })
  if (key === 'left' || key === 'right') return stay(stepFile(panel, key === 'left' ? -1 : 1))
  return stay(panel)
}

function diffClick(panel: DiffPanel, control: string): PanelOutcome {
  if (control === 'prev-file') return stay(stepFile(panel, -1))
  if (control === 'next-file') return stay(stepFile(panel, 1))
  if (control === 'editor' || control === 'ask') return { panel, submit: true, choice: control }
  return stay(panel)
}

function stepFile(panel: DiffPanel, delta: number): DiffPanel {
  const count = Math.max(1, panel.files.length)
  return { ...panel, file: (panel.file + delta + count) % count, scroll: 0 }
}

// ── Settings ────────────────────────────────────────────────────────────────

const settle = (panel: SettingsPanel, path: string, value: string): PanelOutcome => ({
  panel: { ...panel, editing: null, dropdown: null, capture: null, error: null },
  submit: true,
  choice: writeOf(path, value),
})

function settingsKey(
  panel: SettingsPanel,
  key: string | undefined,
  data: string,
  inputs: PanelInputs,
): PanelOutcome {
  const groups = inputs.settings ?? []
  const rows = visibleSettings(panel, groups)
  const here = rows[panel.row]

  // Pressing the key you want is the whole of choosing it.
  if (panel.capture) {
    if (key === 'escape') return stay({ ...panel, capture: null })
    if (key === 'enter' && panel.capture.key)
      return settle(panel, panel.capture.path, panel.capture.key)
    if (key && key !== 'enter') return stay({ ...panel, capture: { ...panel.capture, key } })
    return stay(panel)
  }

  if (panel.dropdown) {
    const setting = rows.find((row) => row.path === panel.dropdown?.path)
    const found = setting
      ? matchingChoices(choicesFor(setting, inputs.choices ?? []), panel.dropdown.query)
      : []
    if (key === 'escape') return stay({ ...panel, dropdown: null })
    if (key === 'down' || key === 'up') {
      const step = key === 'down' ? 1 : -1
      const index =
        (panel.dropdown.index + step + Math.max(1, found.length)) % Math.max(1, found.length)
      return stay({ ...panel, dropdown: { ...panel.dropdown, index } })
    }
    if (key === 'enter') {
      const picked = found[panel.dropdown.index]
      return picked ? settle(panel, panel.dropdown.path, picked.value) : stay(panel)
    }
    if (key === 'backspace') {
      return stay({
        ...panel,
        dropdown: {
          ...panel.dropdown,
          query: [...panel.dropdown.query].slice(0, -1).join(''),
          index: 0,
        },
      })
    }
    const text = key === 'space' ? ' ' : data.startsWith('\x1b') ? '' : data
    if (text && ![...text].some(control)) {
      return stay({
        ...panel,
        dropdown: { ...panel.dropdown, query: panel.dropdown.query + text, index: 0 },
      })
    }
    return stay(panel)
  }

  if (panel.editing) {
    if (key === 'escape') return stay({ ...panel, editing: null })
    if (key === 'enter') return settle(panel, panel.editing.path, panel.editing.text.trim())
    if (key === 'backspace') {
      return stay({
        ...panel,
        editing: { ...panel.editing, text: [...panel.editing.text].slice(0, -1).join('') },
      })
    }
    if (key === 'ctrl+u') return stay({ ...panel, editing: { ...panel.editing, text: '' } })
    const text = key === 'space' ? ' ' : data.startsWith('\x1b') ? '' : data
    if (text && ![...text].some(control)) {
      return stay({ ...panel, editing: { ...panel.editing, text: panel.editing.text + text } })
    }
    return stay(panel)
  }

  if (panel.focus === 'search') {
    if (key === 'escape' || key === 'enter' || key === 'down' || key === 'tab') {
      return stay({ ...panel, focus: 'form', row: 0, ...(key === 'escape' ? { search: '' } : {}) })
    }
    if (key === 'backspace')
      return stay({ ...panel, search: [...panel.search].slice(0, -1).join(''), row: 0 })
    const text = key === 'space' ? ' ' : data.startsWith('\x1b') ? '' : data
    if (text && ![...text].some(control))
      return stay({ ...panel, search: panel.search + text, row: 0 })
    return stay(panel)
  }

  if (key === 'escape') return close
  if (key === 'ctrl+f' || data === '/') return stay({ ...panel, focus: 'search' })

  if (panel.focus === 'categories') {
    const ids = [...groups.map((group) => group.id), ACCOUNTS]
    const at = Math.max(0, ids.indexOf(panel.category))
    if (key === 'down' || key === 'up') {
      const next = ids[(at + (key === 'down' ? 1 : -1) + ids.length) % ids.length] ?? panel.category
      return stay({ ...panel, category: next, row: 0 })
    }
    if (key === 'right' || key === 'tab' || key === 'enter')
      return stay({ ...panel, focus: 'form', row: 0 })
    return stay(panel)
  }

  // The form.
  const count =
    panel.category === ACCOUNTS && !panel.search ? (inputs.accounts ?? 0) + 1 : rows.length
  if (key === 'tab' || key === 'shift+tab') return stay({ ...panel, focus: 'categories' })
  if (key === 'down')
    return stay({ ...panel, row: Math.min(Math.max(0, count - 1), panel.row + 1) })
  if (key === 'up') {
    return panel.row === 0
      ? stay({ ...panel, focus: 'search' })
      : stay({ ...panel, row: panel.row - 1 })
  }
  if (panel.category === ACCOUNTS && !panel.search) {
    return key === 'enter' ? { panel, submit: true, choice: 'sign-in' } : stay(panel)
  }
  if (!here) return key === 'left' ? stay({ ...panel, focus: 'categories' }) : stay(panel)
  return operate(panel, here, key)
}

/** What a key does to the setting the keyboard is on. */
function operate(panel: SettingsPanel, setting: Setting, key: string | undefined): PanelOutcome {
  const type = setting.type
  switch (type.kind) {
    case 'flag':
      if (key === 'enter' || key === 'space' || key === 'left' || key === 'right') {
        return settle(panel, setting.path, setting.value === 'true' ? 'false' : 'true')
      }
      return stay(panel)
    case 'number': {
      const now = Number(setting.value || setting.fallback) || 0
      if (key === 'left') return settle(panel, setting.path, String(Math.max(1, now - 1)))
      if (key === 'right') return settle(panel, setting.path, String(now + 1))
      if (key === 'enter')
        return stay({ ...panel, editing: { path: setting.path, text: setting.value } })
      return stay(panel)
    }
    case 'text':
    case 'hours':
      return key === 'enter'
        ? stay({ ...panel, editing: { path: setting.path, text: setting.value } })
        : stay(panel)
    case 'key':
      return key === 'enter'
        ? stay({ ...panel, capture: { path: setting.path, key: null } })
        : stay(panel)
    case 'model':
      return key === 'enter'
        ? stay({ ...panel, dropdown: { path: setting.path, query: '', index: 0 } })
        : stay(panel)
    case 'choice': {
      if (usesDropdown(setting)) {
        return key === 'enter'
          ? stay({ ...panel, dropdown: { path: setting.path, query: '', index: 0 } })
          : stay(panel)
      }
      if (key === 'left' || key === 'right') {
        const at = Math.max(0, type.options.indexOf(setting.value || setting.fallback))
        const next =
          type.options[
            (at + (key === 'right' ? 1 : -1) + type.options.length) % type.options.length
          ]
        return next ? settle(panel, setting.path, next) : stay(panel)
      }
      return stay(panel)
    }
  }
}

function settingsClick(panel: SettingsPanel, control: string, inputs: PanelInputs): PanelOutcome {
  const [verb, ...rest] = control.split(':')
  const arg = rest.join(':')
  const rows = visibleSettings(panel, inputs.settings ?? [])
  const setting = rows.find((row) => row.path === arg.split('=')[0])
  switch (verb) {
    case 'done':
      return close
    case 'open-file':
      return { panel, submit: true, choice: 'open-file' }
    case 'sign-in':
      return { panel, submit: true, choice: 'sign-in' }
    case 'mic-test':
      return panel.testing
        ? stay(panel)
        : { panel: { ...panel, testing: true }, submit: true, choice: 'mic-test' }
    case 'search':
      return stay({ ...panel, focus: 'search' })
    case 'category':
      return stay({
        ...panel,
        category: arg,
        row: 0,
        focus: 'form',
        search: '',
        editing: null,
        dropdown: null,
      })
    case 'row': {
      const at = rows.findIndex((row) => row.path === arg)
      return stay({ ...panel, row: Math.max(0, at), focus: 'form' })
    }
    case 'set': {
      const [path, value] = arg.split('=')
      return path !== undefined && value !== undefined ? settle(panel, path, value) : stay(panel)
    }
    case 'toggle':
      return setting
        ? settle(panel, setting.path, setting.value === 'true' ? 'false' : 'true')
        : stay(panel)
    case 'step': {
      const [path, delta] = arg.split('=')
      const target = rows.find((row) => row.path === path)
      if (!target || path === undefined) return stay(panel)
      const now = Number(target.value || target.fallback) || 0
      return settle(panel, path, String(Math.max(1, now + Number(delta))))
    }
    case 'edit':
      return setting
        ? stay({ ...panel, editing: { path: setting.path, text: setting.value } })
        : stay(panel)
    case 'drop':
      return setting
        ? stay({
            ...panel,
            dropdown:
              panel.dropdown?.path === setting.path
                ? null
                : { path: setting.path, query: '', index: 0 },
          })
        : stay(panel)
    case 'choose':
      return panel.dropdown ? settle(panel, panel.dropdown.path, arg) : stay(panel)
    case 'capture':
      return setting ? stay({ ...panel, capture: { path: setting.path, key: null } }) : stay(panel)
    case 'capture-use':
      return panel.capture?.key ? settle(panel, panel.capture.path, panel.capture.key) : stay(panel)
    case 'capture-suggest':
      return panel.capture
        ? stay({ ...panel, capture: { ...panel.capture, key: arg } })
        : stay(panel)
    case 'capture-cancel':
      return stay({ ...panel, capture: null })
    default:
      // A click anywhere else in the panel closes what was open inside it.
      return stay({ ...panel, dropdown: null, editing: null })
  }
}

// ── Open project ────────────────────────────────────────────────────────────

/** A control character: never something a person meant to type. */
function control(char: string): boolean {
  const code = char.charCodeAt(0)
  return code < 32 || code === 127
}

function typed(data: string, key: string | undefined): string {
  const text = key === 'space' ? ' ' : data.startsWith('\x1b') ? '' : data
  return text && ![...text].some(control) ? text : ''
}

/** Look in another folder, remembering this one for back. */
function goTo(panel: OpenProjectPanel, dir: string): OpenProjectPanel {
  if (dir === panel.dir && panel.query === '') return panel
  return {
    ...panel,
    back: [...panel.back, panel.dir],
    forward: [],
    dir,
    query: '',
    index: -1,
    name: null,
    error: null,
    field: 'query',
  }
}

/** The folder above, or the folder itself at the top of the disk. */
function parentOf(dir: string): string {
  const trimmed = dir.replace(/\/+$/, '')
  const at = trimmed.lastIndexOf('/')
  return at <= 0 ? '/' : trimmed.slice(0, at)
}

/** Back, forward and up: what a folder browser's own buttons do. */
function navigate(panel: OpenProjectPanel, where: string): OpenProjectPanel {
  if (where === 'back') {
    const previous = panel.back.at(-1)
    if (previous === undefined) return panel
    return {
      ...panel,
      back: panel.back.slice(0, -1),
      forward: [panel.dir, ...panel.forward],
      dir: previous,
      query: '',
      index: -1,
      name: null,
      error: null,
    }
  }
  if (where === 'forward') {
    const next = panel.forward[0]
    if (next === undefined) return panel
    return {
      ...panel,
      back: [...panel.back, panel.dir],
      forward: panel.forward.slice(1),
      dir: next,
      query: '',
      index: -1,
      name: null,
      error: null,
    }
  }
  if (where === 'up') return goTo(panel, parentOf(panel.dir))
  return panel
}

function openKey(
  panel: OpenProjectPanel,
  key: string | undefined,
  data: string,
  rows: readonly OpenRow[],
): PanelOutcome {
  if (panel.busy) return key === 'escape' ? close : stay(panel)
  if (key === 'escape') return close
  const chosen = rows[panel.index]
  if (key === 'enter')
    return chosen
      ? { panel: { ...panel, busy: true, error: null }, submit: true, choice: 'open' }
      : stay(panel)
  if (key === 'tab' || key === 'shift+tab') {
    const order: OpenProjectPanel['field'][] =
      chosen && !chosen.git ? ['query', 'init', 'name'] : ['query', 'name']
    const at = Math.max(0, order.indexOf(panel.field))
    const next = order[(at + (key === 'tab' ? 1 : -1) + order.length) % order.length] ?? 'query'
    return stay({ ...panel, field: next })
  }
  if (panel.field === 'init') {
    return key === 'space' ? stay({ ...panel, init: !panel.init }) : stay(panel)
  }
  if (panel.field === 'name') {
    const name = panel.name ?? (chosen ? nameFrom(chosen.path) : '')
    if (key === 'backspace') return stay({ ...panel, name: [...name].slice(0, -1).join('') })
    const text = typed(data, key)
    return text ? stay({ ...panel, name: name + text.toLowerCase() }) : stay(panel)
  }
  if (key === 'down' || key === 'up') {
    if (rows.length === 0) return stay(panel)
    const from = panel.index < 0 ? (key === 'down' ? -1 : 0) : panel.index
    const index = (from + (key === 'down' ? 1 : -1) + rows.length) % rows.length
    return stay({ ...panel, index, name: null })
  }
  // → goes into the chosen folder, ← to the one above: the arrows a list of
  // folders has everywhere else.
  if (key === 'right' && (chosen?.kind === 'folder' || chosen?.kind === 'recent')) {
    return stay(goTo(panel, chosen.path))
  }
  if (key === 'left' && panel.query === '') return stay(navigate(panel, 'up'))
  if (key === 'backspace' && panel.query === '') return stay(navigate(panel, 'up'))
  if (key === 'backspace')
    return stay({ ...panel, query: [...panel.query].slice(0, -1).join(''), index: -1, name: null })
  const text = typed(data, key)
  return text
    ? stay({ ...panel, query: panel.query + text, index: -1, name: null, error: null })
    : stay(panel)
}

function openClick(
  panel: OpenProjectPanel,
  control: string,
  rows: readonly OpenRow[],
): PanelOutcome {
  if (panel.busy) return stay(panel)
  const [verb, ...rest] = control.split(':')
  const arg = rest.join(':')
  switch (verb) {
    case 'cancel':
      return close
    case 'open':
      return rows[panel.index]
        ? { panel: { ...panel, busy: true, error: null }, submit: true, choice: 'open' }
        : stay(panel)
    case 'back':
    case 'forward':
    case 'up':
      return stay(navigate(panel, verb))
    case 'go':
      return stay(goTo(panel, arg))
    case 'row': {
      const index = Number(arg)
      const row = rows[index]
      // A second click on a folder goes into it, as it would anywhere else.
      if (row?.kind === 'folder' && index === panel.index) return stay(goTo(panel, row.path))
      return stay({ ...panel, index: Math.max(-1, index), field: 'query', name: null })
    }
    case 'into': {
      const row = rows[Number(arg)]
      return row ? stay(goTo(panel, row.path)) : stay(panel)
    }
    case 'init':
      return stay({ ...panel, init: !panel.init, field: 'init' })
    case 'name':
      return stay({ ...panel, field: 'name' })
    case 'query':
      return stay({ ...panel, field: 'query' })
    default:
      return stay(panel)
  }
}

/** A project name from a folder path: what `projects.<name>` accepts. */
export function nameFrom(path: string): string {
  const base = path.replace(/\/+$/, '').split('/').at(-1) ?? ''
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  )
}

function paletteKey(
  panel: PalettePanel,
  key: string | undefined,
  data: string,
  entries: readonly PaletteEntry[],
): PanelOutcome {
  if (key === 'escape') return close
  const found = matchingEntries(entries, panel.query)
  if (key === 'down' || key === 'up' || key === 'tab' || key === 'shift+tab') {
    const step = key === 'down' || key === 'tab' ? 1 : -1
    const index = (panel.index + step + Math.max(1, found.length)) % Math.max(1, found.length)
    return stay({ ...panel, index })
  }
  if (key === 'enter') {
    const entry = found[panel.index]
    return entry ? { panel, submit: true, choice: entry.id } : stay(panel)
  }
  if (key === 'backspace')
    return stay({ ...panel, query: [...panel.query].slice(0, -1).join(''), index: 0 })
  if (key === 'ctrl+u') return stay({ ...panel, query: '', index: 0 })
  const text = typed(data, key)
  return text ? stay({ ...panel, query: panel.query + text, index: 0 }) : stay(panel)
}
