import { type Setting, type SettingGroup, settingFound, stepped, THINKING_LEVELS } from '@tade/core'
import { completed, SCOPES, type SearchEntry } from './search.ts'
import { SPEND_BY, SPEND_WINDOWS, type SpendBy, type SpendWindow } from './spend.ts'
import {
  caretAt,
  cellOf,
  columnOf,
  type Edited,
  editFrom,
  editKey,
  leftOf,
  type Match,
  matchesIn,
  typeIn,
} from './viewer.ts'

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

/** What a menu is for: an agent, a file or folder in FILES, a changed file, or the branch. */
export type MenuSubject =
  | { kind: 'task'; task: string }
  /** Relative to the folder FILES is showing. */
  | { kind: 'file'; path: string; folder: boolean }
  /** A changed file; `task` is null for the project's own checkout. */
  | { kind: 'change'; task: string | null; path: string }
  | { kind: 'branch' }
  /** A terminal's tab. */
  | { kind: 'terminal'; id: string }
  /** Pictures dropped or pasted on the window, waiting to be given to someone. */
  | { kind: 'images'; paths: string[] }
  /** Which harness an agent runs in. */
  | { kind: 'harness'; task: string; current: string }
  /** A shell beside an agent, in its pane. */
  | { kind: 'lane'; task: string; lane: string; name: string }
  /** A note, named by when it was said and what it said. */
  | { kind: 'note'; at: string; text: string }
  /** How hard an agent thinks: `current` as it last said, or what new agents are given. */
  | { kind: 'thinking'; task: string; current: string | null }
  /** A schedule in the SMART QUEUE. */
  | { kind: 'schedule'; id: string }

/** A menu, opened from a ≡ or a right-click, where it was clicked. */
export interface MenuPanel {
  kind: 'menu'
  subject: MenuSubject
  /** Said along its top: the agent's or the file's name. */
  title: string
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

/**
 * Asked before closing every agent that has finished at once. Always asked,
 * however little each one would lose: a button that empties the list without
 * a word is one nobody presses twice.
 */
export interface CloseDonePanel {
  kind: 'close-done'
  /** The tasks it would close, as the list names them. */
  tasks: string[]
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

/**
 * One line of text asked for: a note, a branch name. What it is for decides
 * what the words become, and a note can be about this project or everything.
 */
export interface PromptPanel {
  kind: 'prompt'
  purpose:
    | 'note'
    | 'edit-note'
    | 'new-branch'
    | 'rename-branch'
    | 'rename-terminal'
    | 'rename-lane'
    | 'run-command'
    | 'rename-agent'
    | 'rename-schedule'
  /**
   * The terminal or agent it is about, for renaming one or running a command
   * in it; for a note being changed, when it was said and what it said, joined
   * by a NUL.
   */
  target?: string
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

/** What can be done with a terminal, from its tab. */
export function terminalMenuItems(split = false): MenuItem[] {
  return [
    { id: 'run', label: 'Run a command…' },
    { id: 'find', label: 'Find…' },
    { id: 'rename', label: 'Rename…' },
    { id: 'clear', label: 'Clear' },
    split
      ? { id: 'unsplit', label: 'Unsplit', divider: true }
      : { id: 'split-beside', label: 'Split: a new terminal beside', divider: true },
    ...(split ? [] : [{ id: 'split-below', label: 'Split: a new terminal below' }]),
    { id: 'close', label: 'Close', danger: true, divider: true },
  ]
}

/**
 * How hard an agent can be told to think, least to most, the one it is at
 * marked. A model that cannot think that hard takes the most it can, and says
 * which.
 */
export function thinkingMenuItems(current: string | null): MenuItem[] {
  return THINKING_LEVELS.map((level) => ({
    id: level,
    label: `${level === current ? '● ' : '  '}${level}`,
    note: level === current ? 'now' : '',
  }))
}

/** What can be done with a note: read and change it whole, have its words, or take it back. */
export function noteMenuItems(): MenuItem[] {
  return [
    { id: 'edit', label: 'Edit…' },
    { id: 'copy', label: 'Copy' },
    { id: 'forget', label: 'Forget', danger: true, divider: true },
  ]
}

/** What can be done with a shell beside an agent. */
export function laneMenuItems(split: boolean, agentRunning = true): MenuItem[] {
  const off = agentRunning ? {} : { off: 'its agent is not running' }
  return [
    { id: 'rename', label: 'Rename…' },
    split
      ? { id: 'unsplit', label: 'Unsplit', divider: true }
      : { id: 'split-beside', label: 'Show beside the agent', divider: true, ...off },
    ...(split ? [] : [{ id: 'split-below', label: 'Show below the agent', ...off }]),
    { id: 'close', label: 'Close', danger: true, divider: true },
  ]
}

/**
 * Who can be given a picture: the orchestrator, each agent in the project —
 * the one in front of you first — and the terminal in front, which only gets
 * the path typed. A drop does not say where it landed, so this is asked.
 */
export function imageMenuItems(where: {
  agents: readonly { task: string; name: string; running: boolean; focused: boolean }[]
  terminal: { id: string; name: string } | null
}): MenuItem[] {
  const agents = [...where.agents].sort((a, b) => Number(b.focused) - Number(a.focused))
  return [
    { id: 'orchestrator', label: 'The orchestrator', note: 'sent with what you say next' },
    ...agents.map((agent, i) => ({
      id: `agent:${agent.task}`,
      label: agent.name,
      note: agent.focused ? 'in front of you' : '',
      ...(agent.running ? {} : { off: 'its agent is not running' }),
      ...(i === 0 ? { divider: true } : {}),
    })),
    ...(where.terminal
      ? [
          {
            id: `terminal:${where.terminal.id}`,
            label: where.terminal.name,
            note: 'types the path',
            divider: true,
          },
        ]
      : []),
  ]
}

/** Switching the project's checkout to another branch, or a new one. */
export interface BranchPanel {
  kind: 'branch'
  /** Narrows the branches; a name nobody has offers to create it. */
  query: string
  index: number
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
  return { kind: 'branch', query: '', index: 0, busy: false, error: null }
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

/** Search: agents, files in every worktree, lines inside them, actions and settings. */
export interface SearchPanel {
  kind: 'search'
  query: string
  /** Which result the keyboard is on. */
  index: number
  busy: false
}

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

/** The keys Tade keeps, and the way to change the one that is yours. */
export interface KeysPanel {
  kind: 'keys'
  busy: false
}

/** Choosing a model: for the orchestrator, or for one agent's session. */
export interface ModelPanel {
  kind: 'model'
  /** `orchestrator`, or the task whose agent it is for. */
  for: string
  query: string
  index: number
  busy: boolean
  error: string | null
}

export interface ModelChoice {
  /** `provider/id`, as the harness names it. */
  id: string
  provider: string
  name: string
  /** US dollars per million tokens, where the catalog prices it. */
  price?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

/** A price per million tokens, the way a person reads one: $5, $0.95, $12.50, $0.016. */
export function perMillion(usd: number): string {
  if (usd >= 100) return `$${Math.round(usd)}`
  if (usd >= 1) return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`
  if (usd === 0) return '$0'
  return `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`
}

/**
 * What a model costs per million tokens, as three cells: in, out, and read
 * back from the cache — which is most of what a long session reads, and so
 * most of what it costs. A catalog price of nothing is one of two things: a
 * free model, or a router whose price is whichever model it picks.
 */
export function priceCells(model: ModelChoice): [string, string, string] {
  const price = model.price
  if (!price) return ['', '', '']
  if (price.input === 0 && price.output === 0 && price.cacheRead === 0) {
    return [/(:|\/)free$/.test(model.id) ? 'free' : 'varies', '', '']
  }
  return [perMillion(price.input), perMillion(price.output), perMillion(price.cacheRead)]
}

/** The same, on one line, for a list without columns: `$5 in · $25 out · $0.50 cached`. */
export function priceSaid(model: ModelChoice): string | null {
  const [input, output, cached] = priceCells(model)
  if (!input) return null
  if (!output) return input
  return `${input} in · ${output} out · ${cached} cached`
}

export function modelPanel(target: string): ModelPanel {
  return { kind: 'model', for: target, query: '', index: 0, busy: false, error: null }
}

/** The models that fit what is typed: every word somewhere in the id or the name. */
export function modelChoices(models: readonly ModelChoice[], query: string): ModelChoice[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return models.filter((model) => {
    const text = `${model.id} ${model.name}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

function modelKey(
  panel: ModelPanel,
  key: string | undefined,
  data: string,
  models: readonly ModelChoice[],
): PanelOutcome {
  const choices = modelChoices(models, panel.query)
  if (key === 'escape') return close
  if (key === 'up') return stay({ ...panel, index: Math.max(0, panel.index - 1) })
  if (key === 'down')
    return stay({ ...panel, index: Math.min(Math.max(0, choices.length - 1), panel.index + 1) })
  if (key === 'pageUp') return stay({ ...panel, index: Math.max(0, panel.index - 10) })
  if (key === 'pageDown')
    return stay({ ...panel, index: Math.min(Math.max(0, choices.length - 1), panel.index + 10) })
  if (key === 'enter') {
    const chosen = choices[panel.index]
    return chosen
      ? { panel: { ...panel, busy: true, error: null }, submit: true, choice: chosen.id }
      : stay(panel)
  }
  if (key === 'backspace') return stay({ ...panel, query: panel.query.slice(0, -1), index: 0 })
  if (key === 'space') return stay({ ...panel, query: `${panel.query} `, index: 0 })
  const typed = data.startsWith('\x1b') ? '' : [...data].filter((char) => !control(char)).join('')
  if (typed) return stay({ ...panel, query: panel.query + typed, index: 0, error: null })
  return stay(panel)
}

/** The extensions this window runs with, and what each can do for you. */
export interface ExtensionsPanel {
  kind: 'extensions'
  /** Which control the keyboard is on, of `extensionControls`. */
  index: number
  busy: boolean
  /** What the last thing done here came to: turned on, approved. */
  said: string | null
}

/** One extension, as the panel shows it. */
export interface ExtensionView {
  name: string
  title: string
  description: string
  source: 'built-in' | 'yours'
  state: 'ready' | 'needs setup' | 'off' | 'broken'
  /** What is wrong, or what to do before it can work. */
  problem: string | null
  tools: string[]
  /** What it can do from here, when it is ready. */
  actions: { id: string; title: string }[]
  /** Settings it was given and does not read. */
  unknownSettings: string[]
  /** It says how to set it up, or what can be changed about it. */
  configurable: boolean
  /** Its folder, for one of yours. */
  folder: string | null
  /** What it offers to watch, and whether each is on in the project you are in. */
  watches: readonly WatchOfferView[]
}

/** A watch an extension offers, as the Extensions panel shows it. */
export interface WatchOfferView {
  /** Its name in the extension: `new-errors`. */
  id: string
  title: string
  means: string
  every: string
  /** The project it would watch: the one you are in. Null when you are in none. */
  project: string | null
  /** The schedule watching it there, once it is on. */
  on: string | null
}

/** What an extension shows when its status is clicked: a document, kept fresh while open. */
export interface ExtensionViewPanel {
  kind: 'extension-view'
  extension: string
  scroll: number
  busy: false
}

export function extensionViewPanel(extension: string): ExtensionViewPanel {
  return { kind: 'extension-view', extension, scroll: 0, busy: false }
}

/** A tool Tade wrote for itself: one file, for you to read and turn on. */
export interface WrittenToolView {
  name: string
  /** What it is for, as Tade said when it wrote it. */
  why: string
  path: string
  /** Whether it is turned on. It loads the next time Tade starts. */
  on: boolean
}

export function extensionsPanel(): ExtensionsPanel {
  return { kind: 'extensions', index: 0, busy: false, said: null }
}

/**
 * Every control in the panel, in the order the keyboard moves through them:
 * for each extension, turning it on or off, setting it up, its actions, its
 * folder, and watching what it offers to watch — or showing the watch, once it
 * is on; then, for each tool Tade wrote for itself, reading it and turning it
 * on or off.
 */
export function extensionControls(
  views: readonly ExtensionView[],
  written: readonly WrittenToolView[] = [],
): string[] {
  const controls: string[] = []
  for (const view of views) {
    if (view.state !== 'broken') controls.push(`toggle:${view.name}`)
    if (view.configurable && view.state !== 'broken' && view.state !== 'off')
      controls.push(`setup:${view.name}`)
    if (view.state === 'ready')
      controls.push(...view.actions.map((action) => `action:${view.name}:${action.id}`))
    if (view.folder) controls.push(`folder:${view.name}`)
    if (view.state === 'broken') continue
    for (const watch of view.watches) {
      const control = watchControl(view.name, watch)
      if (control) controls.push(control)
    }
  }
  for (const tool of written) {
    controls.push(`read:${tool.name}`, `toggle:${tool.name}`)
  }
  return controls
}

/**
 * What a watch's button does: show the schedule watching it, once one is on;
 * turn it on in the project you are in; or nothing, when you are in none.
 */
export function watchControl(extension: string, watch: WatchOfferView): string | null {
  if (watch.on) return `watching:${watch.on}`
  return watch.project ? `watch:${extension}:${watch.id}` : null
}

/** Setting an extension up, or changing its settings: a guide, and fields. */
export interface ExtensionSetupPanel {
  kind: 'extension-setup'
  extension: string
  /** Which control the keyboard is on, of `setupControls`. */
  index: number
  /** What is typed into each field, by key. */
  values: Record<string, string>
  busy: boolean
  error: string | null
  /** What saving came to: ready, or what it still needs. */
  said: string | null
}

/** A field on the setup panel, as the panel is given it. */
export interface SetupFieldView {
  key: string
  label: string
  help: string
  placeholder: string
  kind: 'text' | 'list' | 'map' | 'flag'
  /** What it offers to choose from, once looked up. */
  choices: readonly string[]
}

export function extensionSetupPanel(
  extension: string,
  fields: readonly { key: string; value: string }[],
): ExtensionSetupPanel {
  return {
    kind: 'extension-setup',
    extension,
    index: 0,
    values: Object.fromEntries(fields.map((field) => [field.key, field.value])),
    busy: false,
    error: null,
    said: null,
  }
}

/** The setup panel's controls in keyboard order: each field, the choices it offers, then save and close. */
export function setupControls(fields: readonly SetupFieldView[]): string[] {
  return [
    ...fields.flatMap((field) => [
      `field:${field.key}`,
      ...field.choices.map((choice) => `pick:${field.key}:${choice}`),
    ]),
    'save',
    'cancel',
  ]
}

function setupKey(
  panel: ExtensionSetupPanel,
  key: string | undefined,
  data: string,
  fields: readonly SetupFieldView[],
): PanelOutcome {
  const controls = setupControls(fields)
  const at = controls[panel.index] ?? ''
  if (key === 'escape') return close
  if (panel.busy) return stay(panel)
  if (key === 'tab' || key === 'down')
    return stay({ ...panel, index: (panel.index + 1) % controls.length })
  if (key === 'shift+tab' || key === 'up') {
    return stay({ ...panel, index: (panel.index - 1 + controls.length) % controls.length })
  }
  if (key === 'enter' || (key === 'space' && !at.startsWith('field:')))
    return setupPress(panel, at, fields)
  if (at.startsWith('field:')) {
    const field = fields.find((one) => `field:${one.key}` === at)
    if (!field) return stay(panel)
    const value = panel.values[field.key] ?? ''
    if (field.kind === 'flag') {
      return key === 'space' ? setupPress(panel, at, fields) : stay(panel)
    }
    if (key === 'backspace')
      return stay(setValue(panel, field.key, [...value].slice(0, -1).join('')))
    if (key === 'ctrl+u') return stay(setValue(panel, field.key, ''))
    if (key === 'space') return stay(setValue(panel, field.key, `${value} `))
    const typed = data.startsWith('\x1b') ? '' : [...data].filter((char) => !control(char)).join('')
    if (typed) return stay(setValue(panel, field.key, value + typed))
  }
  return stay(panel)
}

/** Pressing one of the setup panel's controls. */
function setupPress(
  panel: ExtensionSetupPanel,
  at: string,
  fields: readonly SetupFieldView[],
): PanelOutcome {
  if (at === 'cancel') return close
  if (at === 'save')
    return {
      panel: { ...panel, busy: true, error: null, said: null },
      submit: true,
      choice: 'save',
    }
  if (at.startsWith('pick:')) {
    const [, key, ...rest] = at.split(':')
    return stay(setValue(panel, key ?? '', rest.join(':')))
  }
  const field = fields.find((one) => `field:${one.key}` === at)
  if (field?.kind === 'flag') {
    // Unset, on, off, and round again: unset is the extension's own default.
    const next = { '': 'on', on: 'off', off: '' }[panel.values[field.key] ?? ''] ?? ''
    return stay(setValue(panel, field.key, next))
  }
  // Enter in a text field moves on, as it would in a form.
  const controls = setupControls(fields)
  return stay({ ...panel, index: Math.min(controls.length - 1, panel.index + 1) })
}

function setValue(panel: ExtensionSetupPanel, key: string, value: string): ExtensionSetupPanel {
  return { ...panel, values: { ...panel.values, [key]: value }, error: null, said: null }
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

export function searchPanel(query = ''): SearchPanel {
  return { kind: 'search', query, index: 0, busy: false }
}

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
    said: null,
    warned: false,
    busy: false,
  }
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

/** The harnesses an agent could run in: the one it is on marked, the ones not yet runnable said so. */
export function harnessMenuItems(
  choices: readonly { id: string; title: string; about: string; ready: boolean }[],
  current: string,
): MenuItem[] {
  return choices.map((choice) => ({
    id: choice.id,
    label: `${choice.id === current ? '● ' : '  '}${choice.title}`,
    note: choice.id === current ? 'now' : choice.ready ? '' : 'soon',
    ...(choice.ready ? {} : { off: choice.about }),
  }))
}

export function menuPanel(
  subject: MenuSubject,
  title: string,
  anchor: MenuPanel['anchor'] = null,
): MenuPanel {
  return { kind: 'menu', subject, title, index: 0, anchor, busy: false }
}

/** What can be done with a file or folder in FILES. */
export function fileMenuItems(file: {
  folder: boolean
  open: boolean
  /** git says it has uncommitted changes. */
  changed: boolean
  /** An agent is in front of you, so there is someone to ask and a change to show. */
  agent: boolean
  platform: string
}): MenuItem[] {
  const reveal = file.platform === 'darwin' ? 'Reveal in Finder' : 'Show in its folder'
  if (file.folder) {
    return [
      { id: 'toggle', label: file.open ? 'Collapse' : 'Expand', note: 'click' },
      { id: 'search', label: 'Search in this folder' },
      { id: 'editor', label: 'Open in editor' },
      { id: 'copy-path', label: 'Copy path', divider: true },
      { id: 'copy-relative', label: 'Copy relative path' },
      { id: 'reveal', label: reveal },
    ]
  }
  return [
    { id: 'open', label: 'Open', note: 'click' },
    { id: 'editor', label: 'Open in editor' },
    {
      id: 'changes',
      label: 'Show changes',
      ...(file.changed ? {} : { off: 'unchanged' }),
    },
    {
      id: 'ask',
      label: 'Ask the agent about it',
      ...(file.agent ? {} : { off: 'no agent' }),
    },
    { id: 'copy-path', label: 'Copy path', divider: true },
    { id: 'copy-relative', label: 'Copy relative path' },
    { id: 'reveal', label: reveal },
  ]
}

/** What can be done with a changed file. Discarding asks first, and only touches what is not committed. */
export function changeMenuItems(change: { uncommitted: boolean; agent: boolean }): MenuItem[] {
  return [
    { id: 'diff', label: 'Show changes', note: 'click' },
    { id: 'open', label: 'Open file' },
    { id: 'editor', label: 'Open in editor' },
    { id: 'ask', label: 'Ask the agent about it', ...(change.agent ? {} : { off: 'no agent' }) },
    { id: 'copy-path', label: 'Copy path', divider: true },
    {
      id: 'discard',
      label: 'Discard changes…',
      danger: true,
      divider: true,
      ...(change.uncommitted ? {} : { off: 'committed' }),
    },
  ]
}

/**
 * What can be done with the branch under GIT. The project's own checkout can
 * be switched; an agent's branch is where its work is, so it is renamed rather
 * than switched out from under it.
 */
export function branchMenuItems(branch: { agent: boolean; name: string }): MenuItem[] {
  if (branch.agent) {
    return [
      { id: 'rename', label: branch.name ? 'Rename branch…' : 'Name the branch now…' },
      { id: 'copy', label: 'Copy branch name', ...(branch.name ? {} : { off: 'none yet' }) },
      { id: 'changes', label: 'Show changes' },
      { id: 'copy-path', label: 'Copy worktree path', divider: true },
    ]
  }
  return [
    { id: 'switch', label: 'Switch branch…' },
    { id: 'new', label: 'New branch…' },
    { id: 'pull', label: 'Pull', note: 'fast-forward' },
    { id: 'copy', label: 'Copy branch name', divider: true },
    { id: 'copy-path', label: 'Copy path' },
  ]
}

/**
 * A task's menu, from what is true of it now. Nothing is hidden for being
 * unavailable — a menu that changes shape is one you re-read every time.
 */
export function menuItems(
  task: { lane: string | null; state: string; finished?: { by: string } | null },
  changed: number,
): MenuItem[] {
  const running = task.lane !== null
  return [
    { id: 'open', label: 'Open', note: 'enter' },
    { id: 'start', label: 'Start agent', ...(running ? { off: 'running' } : {}) },
    { id: 'stop', label: 'Stop agent', ...(running ? {} : { off: 'not running' }) },
    // Whatever its rule, a person can say it is done: what waits on it starts.
    {
      id: 'mark-done',
      label: 'Mark finished',
      ...(task.finished ? { off: 'finished' } : {}),
    },
    {
      id: 'changes',
      label: 'Show changes',
      ...(changed > 0
        ? { note: `${changed} file${changed === 1 ? '' : 's'}` }
        : { off: 'none yet' }),
    },
    { id: 'rename', label: 'Rename…' },
    { id: 'model', label: 'Change model…', ...(running ? {} : { off: 'not running' }) },
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

/** Queued work's menu: start it, pause or resume it, wait past what held it, rename or remove it. */
export function queueMenuItems(queued: { state: { kind: string } }): MenuItem[] {
  const paused = queued.state.kind === 'paused'
  const held = queued.state.kind === 'held'
  return [
    { id: 'open', label: 'Open', note: 'enter' },
    { id: 'queue-start', label: 'Start now' },
    // A preference among what is ready, not a start: it waits for what it
    // waits on exactly as it did, and goes first when it can go at all.
    { id: 'queue-first', label: 'Do this one first' },
    paused ? { id: 'queue-resume', label: 'Resume' } : { id: 'queue-pause', label: 'Pause' },
    {
      id: 'queue-wait',
      label: 'Wait for a retry',
      ...(held ? {} : { off: 'not held' }),
    },
    { id: 'rename', label: 'Rename…' },
    { id: 'queue-remove', label: 'Remove', danger: true, divider: true },
  ]
}

/** A schedule's menu: open it, run it now, pause or resume it, rename or remove it. */
export function scheduleMenuItems(schedule: {
  paused: boolean
  next: readonly number[]
}): MenuItem[] {
  return [
    { id: 'schedule-open', label: 'Open', note: 'enter' },
    { id: 'schedule-run', label: 'Run now' },
    schedule.paused
      ? { id: 'schedule-resume', label: 'Resume' }
      : {
          id: 'schedule-pause',
          label: 'Pause',
          ...(schedule.next.length > 0 ? {} : { off: 'nothing left to run' }),
        },
    { id: 'schedule-rename', label: 'Rename…' },
    { id: 'schedule-remove', label: 'Remove', danger: true, divider: true },
  ]
}

/** What the cleanup button asks first, with the agents it would close in it. */
export function closeDonePanel(tasks: readonly string[]): CloseDonePanel {
  return { kind: 'close-done', tasks: [...tasks], field: 'keep', busy: false, error: null }
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
  if (panel.kind === 'search') return searchKey(panel, key, data, inputs.entries ?? [])
  if (panel.kind === 'file') return fileKey(panel, key, data, inputs)
  if (panel.kind === 'keys') return key === 'escape' || key === 'enter' ? close : stay(panel)
  if (panel.kind === 'model') return modelKey(panel, key, data, inputs.models ?? [])
  if (panel.kind === 'extension-setup') return setupKey(panel, key, data, inputs.setupFields ?? [])
  if (panel.kind === 'extension-view') {
    const most = Math.max(0, (inputs.lines ?? 0) - 1)
    if (key === 'escape' || key === 'enter') return close
    const by =
      key === 'up' ? -1 : key === 'down' ? 1 : key === 'pageUp' ? -10 : key === 'pageDown' ? 10 : 0
    if (key === 'home') return stay({ ...panel, scroll: 0 })
    if (key === 'end') return stay({ ...panel, scroll: most })
    return by === 0
      ? stay(panel)
      : stay({ ...panel, scroll: Math.max(0, Math.min(most, panel.scroll + by)) })
  }
  if (panel.kind === 'extensions') {
    const controls = extensionControls(inputs.extensions ?? [], inputs.written ?? [])
    if (key === 'escape') return close
    if (panel.busy) return stay(panel)
    if (key === 'up' || key === 'shift+tab' || key === 'left')
      return stay({ ...panel, index: Math.max(0, panel.index - 1) })
    if (key === 'down' || key === 'tab' || key === 'right')
      return stay({ ...panel, index: Math.min(Math.max(0, controls.length - 1), panel.index + 1) })
    const chosen = controls[panel.index]
    if ((key === 'enter' || key === 'space') && chosen) {
      return { panel: { ...panel, said: null }, submit: true, choice: chosen }
    }
    return stay(panel)
  }
  if (panel.kind === 'quit') {
    if (key === 'escape') return close
    if (key === 'tab' || key === 'left' || key === 'right') {
      return stay({ ...panel, field: panel.field === 'cancel' ? 'quit' : 'cancel' })
    }
    if (key === 'enter')
      return panel.field === 'cancel' ? close : { panel, submit: true, choice: 'quit' }
    return stay(panel)
  }
  if (panel.kind === 'reload') {
    if (key === 'escape') return close
    if (key === 'tab' || key === 'left' || key === 'right') {
      return stay({ ...panel, field: panel.field === 'cancel' ? 'reload' : 'cancel' })
    }
    if (key === 'enter')
      return panel.field === 'cancel' ? close : { panel, submit: true, choice: 'reload' }
    return stay(panel)
  }
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
  if (panel.kind === 'keys')
    return control === 'change-keys' ? { panel, submit: true, choice: 'change-keys' } : stay(panel)
  if (panel.kind === 'model') {
    if (control === 'cancel') return close
    const chosen = modelChoices(inputs.models ?? [], panel.query)[Number(control.slice(4))]
    return control.startsWith('row:') && chosen
      ? { panel: { ...panel, busy: true, error: null }, submit: true, choice: chosen.id }
      : stay(panel)
  }
  if (panel.kind === 'extension-view') return control === 'close' ? close : stay(panel)
  if (panel.kind === 'extension-setup') {
    const fields = inputs.setupFields ?? []
    const index = setupControls(fields).indexOf(control)
    if (index < 0) return stay(panel)
    // A field is clicked into; anything else is pressed.
    return control.startsWith('field:') &&
      fields.find((one) => `field:${one.key}` === control)?.kind !== 'flag'
      ? stay({ ...panel, index })
      : setupPress({ ...panel, index }, control, fields)
  }
  if (panel.kind === 'extensions') {
    if (control === 'close') return close
    const index = extensionControls(inputs.extensions ?? [], inputs.written ?? []).indexOf(control)
    return index < 0
      ? stay(panel)
      : { panel: { ...panel, index, said: null }, submit: true, choice: control }
  }
  if (panel.kind === 'quit') {
    if (control === 'cancel') return close
    if (control === 'quit') return { panel, submit: true, choice: 'quit' }
    if (control === 'where') return { panel, submit: true, choice: 'where' }
    return stay(panel)
  }
  if (panel.kind === 'reload') {
    if (control === 'cancel') return close
    if (control === 'reload') return { panel, submit: true, choice: 'reload' }
    return stay(panel)
  }
  if (panel.kind === 'spend') return spendClick(panel, control)
  if (panel.kind === 'menu') {
    return control.startsWith('item:')
      ? { panel, submit: true, choice: control.slice(5) }
      : stay(panel)
  }
  if (panel.kind === 'find') {
    const count = Math.max(1, inputs.found ?? 0)
    if (control === 'close') return close
    if (control === 'older') return stay({ ...panel, index: (panel.index + 1) % count })
    if (control === 'newer') return stay({ ...panel, index: (panel.index - 1 + count) % count })
    return stay(panel)
  }
  if (panel.kind === 'prompt') {
    if (control === 'cancel') return close
    if (control === 'save') return savePrompt(panel)
    if (control === 'everywhere') return stay({ ...panel, everywhere: !panel.everywhere })
    return stay(panel)
  }
  if (panel.kind === 'branch') {
    if (control === 'cancel') return close
    const choice = branchChoices(inputs.branches ?? [], panel.query)[Number(control.slice(4))]
    if (control.startsWith('row:') && choice) {
      return {
        panel: { ...panel, busy: true, error: null },
        submit: true,
        choice: `${choice.create ? 'create' : 'switch'}:${choice.name}`,
      }
    }
    return stay(panel)
  }
  if (panel.kind === 'confirm-remove' || panel.kind === 'confirm' || panel.kind === 'close-done') {
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

/** Typing narrows; enter and ↑ go to an older match, ↓ to a newer one. */
function findKey(
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
        : panel.purpose === 'run-command'
          ? 'Type the command first.'
          : 'Give it a name.'
    return stay({ ...panel, error: said })
  }
  return { panel: { ...panel, busy: true, error: null }, submit: true, choice: 'save' }
}

/** Typing, and enter to keep it. A paste arrives whole; tab turns a note's scope. */
function promptKey(panel: PromptPanel, key: string | undefined, data: string): PanelOutcome {
  if (panel.busy) return key === 'escape' ? close : stay(panel)
  if (key === 'escape') return close
  if (key === 'enter') return savePrompt(panel)
  if (key === 'tab' && panel.purpose === 'note')
    return stay({ ...panel, everywhere: !panel.everywhere })
  if (key === 'backspace') return stay({ ...panel, text: [...panel.text].slice(0, -1).join('') })
  if (key === 'ctrl+u') return stay({ ...panel, text: '' })
  const text = data.startsWith('\x1b')
    ? ''
    : [...data].map((char) => (control(char) ? ' ' : char)).join('')
  if (key === 'space') return stay({ ...panel, text: `${panel.text} `, error: null })
  // Branch names have no spaces, so a space typed into one is a dash.
  const branch = panel.purpose === 'new-branch' || panel.purpose === 'rename-branch'
  const typedText = branch ? text.replace(/\s/g, '-') : text
  return typedText ? stay({ ...panel, text: panel.text + typedText, error: null }) : stay(panel)
}

function branchKey(
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
    return stay({ ...panel, index: (panel.index + (key === 'down' ? 1 : -1) + count) % count })
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
    return stay({ ...panel, query: [...panel.query].slice(0, -1).join(''), index: 0 })
  const text = typed(data, key)
  return text && !/\s/.test(text)
    ? stay({ ...panel, query: panel.query + text, index: 0 })
    : stay(panel)
}

function confirmKey(
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

function searchClick(
  panel: SearchPanel,
  control: string,
  entries: readonly SearchEntry[],
): PanelOutcome {
  const [verb, arg] = control.split(':')
  if (verb === 'entry') {
    const entry = entries[Number(arg)]
    return entry ? { panel, submit: true, choice: entry.id } : stay(panel)
  }
  if (verb === 'scope') {
    // A scope chip replaces the one typed, keeping the words.
    const bare = SCOPES.some((one) => panel.query.startsWith(one.prefix))
      ? panel.query.slice(1)
      : panel.query
    const prefix = SCOPES.find((one) => one.prefix === control.slice('scope:'.length))?.prefix ?? ''
    return stay({ ...panel, query: `${prefix}${bare}`, index: 0 })
  }
  return stay(panel)
}

/**
 * Reading: the arrows a line, page keys and space a screen, `e` or enter to
 * the editor. `ctrl+f` finds, `ctrl+g` goes to a line — and once you have
 * clicked into the text, everything printable is typed into it instead.
 */
function fileKey(
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
  const moved = editKey(edit, key, body)
  if (moved) return stay(typedInto(panel, moved, body))
  // A paste is text like any other here, newlines and all — pasting a line in
  // is half of what a short edit is for.
  const paste = pastedText(data)
  if (paste !== null) return stay(typedInto(panel, typeIn(edit, paste), body))
  const text = typed(data, key)
  return text ? stay(typedInto(panel, typeIn(edit, text), body)) : stay(panel)
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

function fileClick(panel: FilePanel, control: string, inputs: PanelInputs): PanelOutcome {
  // `caret:<line>:<cell>` — a click in the text, by the line it landed on and
  // how far into it. Which character that is depends on the tabs and the wide
  // characters before it, and on how far the view has slid to keep the caret
  // on screen, so it is worked out here rather than drawn into the id.
  if (control.startsWith('caret:')) {
    const [row, cell] = control.slice('caret:'.length).split(':').map(Number)
    const text = inputs.text ?? []
    if (row === undefined || cell === undefined || text.length === 0) return stay(panel)
    const edit = panel.edit ?? editFrom(text)
    const columns = Math.max(1, inputs.columns ?? 80)
    const left = leftOf(cellOf(edit.lines[edit.row] ?? '', edit.column), columns)
    const line = edit.lines[Math.max(0, Math.min(edit.lines.length - 1, row))] ?? ''
    return stay({
      ...panel,
      edit: caretAt(edit, row, columnOf(line, cell + left)),
      line: null,
      said: null,
      warned: false,
    })
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
      return losing ? stay(warn(panel)) : stay({ ...panel, formatted: true, scroll: 0, edit: null })
    case 'source':
      return stay({ ...panel, formatted: false, scroll: 0 })
    default:
      return stay(panel)
  }
}

function searchKey(
  panel: SearchPanel,
  key: string | undefined,
  data: string,
  entries: readonly SearchEntry[],
): PanelOutcome {
  if (key === 'escape') return close
  if (key === 'down' || key === 'up') {
    const count = Math.max(1, entries.length)
    const index = (panel.index + (key === 'down' ? 1 : -1) + count) % count
    return stay({ ...panel, index })
  }
  // Tab completes, as it does in a shell: the chosen result's name into the box.
  if (key === 'tab') {
    const query = completed(panel.query, entries[panel.index])
    return stay({ ...panel, query, index: 0 })
  }
  if (key === 'enter') {
    const entry = entries[panel.index]
    return entry ? { panel, submit: true, choice: entry.id } : stay(panel)
  }
  if (key === 'backspace')
    return stay({ ...panel, query: [...panel.query].slice(0, -1).join(''), index: 0 })
  if (key === 'ctrl+u') return stay({ ...panel, query: '', index: 0 })
  const text = typed(data, key)
  return text ? stay({ ...panel, query: panel.query + text, index: 0 }) : stay(panel)
}
