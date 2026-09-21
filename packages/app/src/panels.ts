import { type Setting, type SettingGroup, settingFound, stepped } from '@tade/core'
// Type-only, so the pure panel model never loads the driver stack behind it.
import type { UpdateLook as UpdatesShown } from '@tade/workbench/programs'

export type { UpdatesShown }

import {
  type ExtensionSetupPanel,
  type ExtensionViewPanel,
  extensionViewClick,
  extensionViewKey,
  type SetupFieldView,
  setupClick,
  setupKey,
} from './panels/extensions/setup.ts'
import {
  type ExtensionsPanel,
  type ExtensionView,
  extensionsClick,
  extensionsKey,
  type McpServerOffer,
  type WrittenToolView,
} from './panels/extensions/state.ts'
import { type FilePanel, fileClick, fileKey } from './panels/file/state.ts'
import { type MenuItem, type MenuPanel, menuClick, menuKey } from './panels/menu/state.ts'
import { type ModelChoice, type ModelPanel, modelClick, modelKey } from './panels/models/state.ts'
import { close, control, type PanelOutcome, stay } from './panels/outcome.ts'
import { type OpenProjectPanel, type OpenRow, openClick, openKey } from './panels/project/state.ts'
import { type SearchPanel, searchClick, searchKey } from './panels/search/state.ts'
import {
  type BranchPanel,
  type BranchRow,
  branchClick,
  branchKey,
  type CloseDonePanel,
  type ConfirmPanel,
  type ConfirmRemovePanel,
  confirmClick,
  confirmKey,
  type DiffPanel,
  diffClick,
  diffKey,
  type FindPanel,
  findClick,
  findKey,
  type KeysPanel,
  keysClick,
  keysKey,
  type PromptPanel,
  promptClick,
  promptKey,
  type QuitPanel,
  quitClick,
  quitKey,
  type ReloadPanel,
  reloadClick,
  reloadKey,
} from './panels/small/state.ts'
import { type SpendPanel, spendClick, spendKey } from './panels/spend/state.ts'
import type { SearchEntry } from './search.ts'

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
  /** An action that is asked twice, asked once: removing an account. */
  confirm: string | null
  busy: false
}

export const ACCOUNTS = 'accounts'
/**
 * Keeping what Tade runs current: the programs it shells out to, and Tade
 * itself. A category like the others to whoever walks the side, and its own
 * page, because none of it is a value in a config file.
 */
export const UPDATES = 'updates'

/**
 * One row of the Updates page, in the order the page draws them — which is
 * the order the keyboard walks them, since both come from `updateActions`.
 *
 * Not every row is a button. A program Tade cannot offer a command for is
 * still a row the keyboard stops on, because a page that only stops on
 * buttons is a page whose last programs cannot be scrolled to.
 */
export interface UpdateAction {
  /** `updates:check`, `updates:reload`, `updates:update:<command>`, `updates:row:<command>`. */
  id: string
  /** What the button says. Empty for a row that is not one. */
  label: string
  /** The program it is about, `tade` for Tade itself, null for the page. */
  about: string | null
  /** The exact command it would run, for the one that runs one. */
  command?: string
}

/**
 * Everything on the Updates page the keyboard can be on, in drawing order.
 *
 * Checking is always offered — it is the only thing on the page that touches
 * the network, and it never happens until it is pressed. Updating is offered
 * only where Tade knows the exact command, because a button that guesses at
 * `brew upgrade` is worse than one that is not there; everything else is a
 * row with nothing to press.
 */
export function updateActions(look: UpdatesShown | null, busy: boolean): UpdateAction[] {
  const actions: UpdateAction[] = [
    { id: 'updates:check', label: busy ? 'Checking…' : 'Check for updates', about: null },
  ]
  if (!look) return actions
  if ('command' in look.tade.update) {
    actions.push({
      id: 'updates:update:tade',
      label: 'Update Tade…',
      about: 'tade',
      command: look.tade.update.command,
    })
  }
  actions.push({ id: 'updates:reload', label: 'Reload Tade…', about: 'tade' })
  for (const program of look.programs) {
    const update = program.update
    actions.push(
      'command' in update
        ? {
            id: `updates:update:${program.need.command}`,
            label: `Update ${program.need.title}…`,
            about: program.need.command,
            command: update.command,
          }
        : { id: `updates:row:${program.need.command}`, label: '', about: program.need.command },
    )
  }
  return actions
}

export type Panel =
  | SpendPanel
  | MenuPanel
  | ConfirmRemovePanel
  | CloseDonePanel
  | DiffPanel
  | SettingsPanel
  | OpenProjectPanel
  | SearchPanel
  | FilePanel
  | PromptPanel
  | BranchPanel
  | ConfirmPanel
  | FindPanel
  | KeysPanel
  | QuitPanel
  | ReloadPanel
  | ExtensionsPanel
  | ExtensionSetupPanel
  | ExtensionViewPanel
  | ModelPanel

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
    confirm: null,
    busy: false,
  }
}

/** What the panel needs to know that it does not hold: the settings themselves, and lists. */
export interface PanelInputs {
  choices?: readonly Choice[]
  items?: readonly MenuItem[]
  settings?: readonly SettingGroup[]
  /** What can be done on the Accounts page, in the order the keyboard walks it. */
  accountActions?: readonly AccountAction[]
  /** What can be done on the Updates page, in the order the keyboard walks it. */
  updateActions?: readonly UpdateAction[]
  /** The Open project list, as it stands for the query. */
  rows?: readonly OpenRow[]
  /** What search shows for the query as it stands. */
  entries?: readonly SearchEntry[]
  /** How many lines the file panel has to scroll through. */
  lines?: number
  /** The file's own lines, uncoloured: what a find looks through and an edit starts from. */
  text?: readonly string[]
  /** How many lines the file panel shows at once, and how wide they are drawn. */
  body?: number
  columns?: number
  /** The project's branches, for switching. */
  branches?: readonly BranchRow[]
  /** How many lines the find panel's query matches. */
  found?: number
  /** The extensions, for moving through their actions. */
  extensions?: readonly ExtensionView[]
  /** What each harness loads by itself, which Tade only lists. */
  harnessExtensions?: readonly { name: string; where: string }[]
  /** The MCP servers nobody has decided about: the catalogue, as one row. */
  servers?: readonly McpServerOffer[]
  /**
   * The furthest the Extensions panel's right-hand side can be scrolled: how
   * much it has to say, less the room it is drawn in. Nought where it all fits.
   */
  scrollable?: number
  /** How many rows of the extensions list are in view, for keeping the chosen one in them. */
  listRoom?: number
  /** Models there are to choose from. */
  models?: readonly ModelChoice[]
  /** The tools Tade wrote for itself, on or off. */
  written?: readonly WrittenToolView[]
  /** The fields of the extension being set up. */
  setupFields?: readonly SetupFieldView[]
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
      .filter(({ group, setting }) => settingFound(group, setting, words))
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
  if (panel.kind === 'search') return searchKey(panel, key, data, inputs.entries ?? [])
  if (panel.kind === 'file') return fileKey(panel, key, data, inputs)
  if (panel.kind === 'keys') return keysKey(panel, key)
  if (panel.kind === 'model') return modelKey(panel, key, data, inputs.models ?? [])
  if (panel.kind === 'extension-setup') return setupKey(panel, key, data, inputs.setupFields ?? [])
  if (panel.kind === 'extension-view') return extensionViewKey(panel, key, inputs.lines ?? 0)
  if (panel.kind === 'extensions') return extensionsKey(panel, key, data, inputs)
  if (panel.kind === 'quit') return quitKey(panel, key)
  if (panel.kind === 'reload') return reloadKey(panel, key)
  if (panel.kind === 'spend') return spendKey(panel, key)
  if (panel.kind === 'menu') return menuKey(panel, key, inputs.items ?? [])
  if (panel.kind === 'prompt') return promptKey(panel, key, data)
  if (panel.kind === 'find') return findKey(panel, key, data, inputs.found ?? 0)
  if (panel.kind === 'branch') return branchKey(panel, key, data, inputs.branches ?? [])
  if (panel.kind === 'confirm') return confirmKey(panel, key)
  if (panel.kind === 'confirm-remove') return confirmKey(panel, key)
  if (panel.kind === 'close-done') return confirmKey(panel, key)
  return diffKey(panel, key)
}

/** A click on one of the panel's own controls. */
export function panelClick(panel: Panel, control: string, inputs: PanelInputs = {}): PanelOutcome {
  if (panel.kind === 'settings') return settingsClick(panel, control, inputs)
  if (panel.kind === 'open-project') return openClick(panel, control, inputs.rows ?? [])
  if (panel.kind === 'search') return searchClick(panel, control, inputs.entries ?? [])
  if (panel.kind === 'file') return fileClick(panel, control, inputs)
  if (panel.kind === 'keys') return keysClick(panel, control)
  if (panel.kind === 'model') return modelClick(panel, control, inputs.models ?? [])
  if (panel.kind === 'extension-view') return extensionViewClick(panel, control)
  if (panel.kind === 'extension-setup') return setupClick(panel, control, inputs.setupFields ?? [])
  if (panel.kind === 'extensions') return extensionsClick(panel, control, inputs)
  if (panel.kind === 'quit') return quitClick(panel, control)
  if (panel.kind === 'reload') return reloadClick(panel, control)
  if (panel.kind === 'spend') return spendClick(panel, control)
  if (panel.kind === 'menu') return menuClick(panel, control)
  if (panel.kind === 'find') return findClick(panel, control, inputs.found ?? 0)
  if (panel.kind === 'prompt') return promptClick(panel, control)
  if (panel.kind === 'branch') return branchClick(panel, control, inputs.branches ?? [])
  if (panel.kind === 'confirm-remove' || panel.kind === 'confirm' || panel.kind === 'close-done')
    return confirmClick(panel, control)
  return diffClick(panel, control)
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
    const ids = [...groups.map((group) => group.id), ACCOUNTS, UPDATES]
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
  const count = panel.search
    ? rows.length
    : panel.category === ACCOUNTS
      ? (inputs.accountActions ?? []).length
      : panel.category === UPDATES
        ? (inputs.updateActions ?? []).length
        : rows.length
  if (key === 'tab' || key === 'shift+tab') return stay({ ...panel, focus: 'categories' })
  if (key === 'down')
    return stay({ ...panel, row: Math.min(Math.max(0, count - 1), panel.row + 1) })
  if (key === 'up') {
    return panel.row === 0
      ? stay({ ...panel, focus: 'search' })
      : stay({ ...panel, row: panel.row - 1 })
  }
  if (panel.category === ACCOUNTS && !panel.search) {
    const action = (inputs.accountActions ?? [])[panel.row]
    return key === 'enter' && action ? accountChoice(panel, action.id) : stay(panel)
  }
  if (panel.category === UPDATES && !panel.search) {
    const action = (inputs.updateActions ?? [])[panel.row]
    return key === 'enter' && action
      ? { panel: { ...panel, saved: null, error: null }, submit: true, choice: action.id }
      : stay(panel)
  }
  if (!here) return key === 'left' ? stay({ ...panel, focus: 'categories' }) : stay(panel)
  return operate(panel, here, key)
}

/**
 * One thing that can be done on the Accounts page: `account:<verb>:<harness>:<name>`,
 * the name empty for a harness's own sign-in.
 */
export interface AccountAction {
  id: string
  label: string
  danger?: boolean
  /** The harness it is about. */
  harness: string
  /** The account it is about, `null` being its harness's own sign-in; absent for adding one. */
  account?: string | null
}

/** What an account needs from the page: enough to say how it stands and what can be done. */
export interface AccountShown {
  harness: string
  name: string | null
  kind: 'subscription' | 'api-key'
  canAdd: boolean
  why: string | null
  status: { signedIn: boolean; who: string | null; plan: string | null; problem: string | null }
  limits: { fiveHour: { used: number; resetsAt: number } | null } | null
  agents: number
  forNewAgents: boolean
  canSignIn: boolean
}

/**
 * Everything that can be done to accounts, account by account and harness by
 * harness, in the order the page draws them — which is the order the
 * keyboard walks them, since both come from here.
 */
export function accountActions(accounts: readonly AccountShown[]): AccountAction[] {
  const actions: AccountAction[] = []
  const id = (verb: string, harness: string, name: string | null) =>
    `account:${verb}:${harness}:${name ?? ''}`
  const harnesses = [...new Set(accounts.map((one) => one.harness))]
  for (const harness of harnesses) {
    const mine = accounts.filter((one) => one.harness === harness)
    for (const one of mine) {
      const at = one.name
      if (one.kind === 'api-key') {
        actions.push({
          id: id('key', harness, at),
          label: one.status.signedIn ? 'Change its key…' : 'Set its key…',
          harness,
          account: at,
        })
      } else if (one.canSignIn) {
        actions.push({
          id: id('sign-in', harness, at),
          label: one.status.signedIn ? 'Sign in again…' : 'Sign in…',
          harness,
          account: at,
        })
        // Signing out is the harness's own, for one that keeps accounts apart.
        if (one.status.signedIn && one.canAdd) {
          actions.push({ id: id('sign-out', harness, at), label: 'Sign out', harness, account: at })
        }
      }
      if (!one.forNewAgents && (one.canAdd || mine.length > 1)) {
        actions.push({
          id: id('use', harness, at),
          label: 'Use for new agents',
          harness,
          account: at,
        })
      }
      if (at !== null) {
        actions.push({
          id: id('remove', harness, at),
          label: 'Remove',
          danger: true,
          harness,
          account: at,
        })
      }
    }
    if (mine.some((one) => one.canAdd)) {
      actions.push({ id: id('add', harness, null), label: 'Add an account…', harness })
      actions.push({ id: id('add-key', harness, null), label: 'Add an API-key account…', harness })
    }
  }
  return actions
}

/** Carry out an account action, asking twice for the one that cannot be undone. */
function accountChoice(panel: SettingsPanel, id: string): PanelOutcome {
  if (id.startsWith('account:remove:') && panel.confirm !== id) {
    return stay({ ...panel, confirm: id, saved: null, error: null })
  }
  return { panel: { ...panel, confirm: null }, submit: true, choice: id }
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
      if (key === 'left') return settle(panel, setting.path, stepped(setting, -1))
      if (key === 'right') return settle(panel, setting.path, stepped(setting, 1))
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
    case 'account':
      return accountChoice(panel, control)
    case 'updates': {
      // Both the row and the button: clicking a button on a page of them
      // should put the keyboard where the click was, so the next Enter
      // presses what is under the hand.
      const at = (inputs.updateActions ?? []).findIndex((action) => action.id === control)
      const moved = {
        ...panel,
        saved: null,
        error: null,
        ...(at >= 0 ? { row: at, focus: 'form' as const } : {}),
      }
      return { panel: moved, submit: true, choice: control }
    }
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
      return settle(panel, path, stepped(target, Number(delta)))
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
