import { type Setting, type SettingGroup, settingFound, stepped } from '@tade/core'
// Type-only, so the pure panel model never loads the driver stack behind it.
import type { UpdateLook as UpdatesShown } from '@tade/workbench/programs'

export type { UpdatesShown }

import {
  clickedSpan,
  type LineKey,
  lineKey,
  offsetOf,
  placeOf,
  type Span,
  spanOf,
} from './input.ts'
import { normalKey } from './keys.ts'
import { type MenuItem, type MenuPanel, menuClick, menuKey } from './panels/menu/state.ts'
import { type ModelChoice, type ModelPanel, modelClick, modelKey } from './panels/models/state.ts'
import { close, control, type PanelOutcome, stay, typed } from './panels/outcome.ts'
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
import type { SearchEntry } from './search.ts'
import { SPEND_BY, SPEND_WINDOWS, type SpendBy, type SpendWindow } from './spend.ts'
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
 * The extensions this window runs with: the list down the side, and one of
 * them in full beside it.
 *
 * It was one long column once — every extension, its buttons and its watches
 * end to end — which meant the last of them was two screens past the fold and
 * nothing could be found. It is the shape Settings has instead: search, a
 * list, and the one you chose, said properly.
 */
export interface ExtensionsPanel {
  kind: 'extensions'
  /**
   * What the right-hand side is showing: an extension's name, `written` or
   * `harness`. Null until something is chosen, which is the first of the list.
   */
  chosen: string | null
  /** Which control of the right-hand side the keyboard is on, of `extensionControls`. */
  index: number
  /** Lines of the right-hand side scrolled past. */
  scroll: number
  /** Rows of the list scrolled past, for the one that is longer than its side. */
  listScroll: number
  /**
   * Whether the right-hand side follows the control the keyboard is on. It
   * does while you tab between them, and stops the moment you scroll it
   * yourself: a page that jumps back to a button every time you read past it
   * is a page nobody can read.
   */
  following: boolean
  focus: 'search' | 'list' | 'body'
  /** Narrows the list: a name, what it is for, or one of its tools. */
  search: string
  busy: boolean
  /** What the last thing done here came to: turned on, approved. */
  said: string | null
}

/** One extension, as the panel shows it. */
export interface ExtensionView {
  name: string
  title: string
  description: string
  /**
   * How it is used, in its own words, a line at a time. Empty for one that is
   * off or broken: it was never imported, so there is nothing to ask.
   */
  workflow: readonly string[]
  /** Tade's own, a folder of yours, or an MCP server somebody turned on. */
  source: 'built-in' | 'yours' | 'mcp'
  state: 'ready' | 'needs setup' | 'off' | 'broken'
  /** What is wrong, or what to do before it can work. */
  problem: string | null
  tools: readonly ExtensionToolView[]
  /** What it can do from here, when it is ready. */
  actions: { id: string; title: string }[]
  /** What it can be given, and what each is set to now. */
  options: readonly ExtensionOptionView[]
  /** Settings it was given and does not read. */
  unknownSettings: string[]
  /** It says how to set it up, or what can be changed about it. */
  configurable: boolean
  /** Its folder, for one of yours. */
  folder: string | null
  /** What it offers to watch, and whether each is on in the project you are in. */
  watches: readonly WatchOfferView[]
  /** What is only true of a server, for a row that is one. */
  server?: McpServerView
}

/**
 * One MCP server, as the page says it.
 *
 * A server is a source of tools like any other, so it is a row among the
 * extensions rather than a page of its own — and these are the few things
 * that are true of one and of nothing else: how Tade talks to it, what it
 * offered when anybody last asked, and what of that it will not hand on.
 *
 * A credential is not here. It is said where every extension's is: as a
 * place, in the setting the broker generates for it, and never as a value.
 */
export interface McpServerView {
  /** The server's own name: `github`, not `mcp-github`. */
  name: string
  /** How Tade talks to it, as somebody would read it: the command, or the address. */
  how: string
  /** Whether a person has turned it on. */
  on: boolean
  /** Whether anybody has decided about it at all, either way. */
  decided: boolean
  /** The line a person runs to get the program, shown and never run unwatched. */
  install: string | null
  /** What is true about it that nobody would guess. */
  note: string | null
  /** When anybody last asked it what it offers. Null when nobody has. */
  asked: string | null
  /** What it offered that Tade will not hand on, and why. */
  dropped: readonly { name: string; why: string }[]
  /** Its command fetches code from the network every time it starts. */
  fetches: boolean
  /** The server's own name for each tool, by the name agents call it. */
  theirs: Readonly<Record<string, string>>
}

/** One of an extension's tools, as the panel says it. */
export interface ExtensionToolView {
  name: string
  /** What it does, in a line: the front of what the model is told about it. */
  summary: string
  /** Who may call it. */
  for: readonly ('orchestrator' | 'agent')[]
}

/** Something an extension can be given, and where its value stands. */
export interface ExtensionOptionView {
  key: string
  label: string
  /** What is in it now, as somebody would read it; empty where nothing is. */
  value: string
  /** For a credential: where the one it has is (`$TYPESAFE_API_KEY`); empty where there is none. */
  have: string
  /** A credential: never drawn back, only ever said as a place. */
  secret: boolean
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

export function extensionsPanel(chosen: string | null = null): ExtensionsPanel {
  return {
    kind: 'extensions',
    chosen,
    index: 0,
    scroll: 0,
    listScroll: 0,
    following: true,
    focus: 'list',
    search: '',
    busy: false,
    said: null,
  }
}

/** The three groups that are not extensions, and always come last. */
export const WRITTEN = 'written'
export const HARNESS = 'harness'
export const SERVERS = 'servers'

/** A row in the list down the side of the Extensions panel. */
export interface ExtensionEntry {
  /** An extension's name, or `written` / `harness` / `servers`. */
  id: string
  title: string
  kind: 'extension' | 'written' | 'harness' | 'servers'
  /** How the extension stands; null for the groups that are not one. */
  state: ExtensionView['state'] | null
  /** How many tools it has, or how many pieces are in the group. */
  count: number
  /** Something here wants you: it needs setting up, or it is broken. */
  wants: boolean
}

/**
 * The list down the side: every extension the search matches, then the tools
 * Tade wrote for itself and what the harness loads by itself, where there are
 * any. Searching looks at everything the right-hand side would say — what it
 * is called, what it is for, how it is used, its tools and its watches —
 * because somebody looking for “the one that reads Sentry” has not
 * necessarily remembered that it is called Sentry.
 */
export function extensionEntries(
  views: readonly ExtensionView[],
  written: readonly WrittenToolView[] = [],
  harness: readonly { name: string; where: string }[] = [],
  search = '',
  /**
   * The servers nobody has decided about: the catalogue, as one row. The ones
   * somebody has decided about are among `views`, because a live source of
   * tools belongs beside the others — and twelve entries nobody has looked at
   * would triple the length of a list whose whole point is findability.
   */
  servers: readonly McpServerOffer[] = [],
): ExtensionEntry[] {
  const entries: ExtensionEntry[] = views
    .filter((view) => matchesSearch(extensionWords(view), search))
    .map((view) => ({
      id: view.name,
      title: view.title,
      kind: 'extension' as const,
      state: view.state,
      count: view.tools.length,
      wants: view.state === 'needs setup' || view.state === 'broken',
    }))
  if (written.length > 0) {
    const words = ['written by tade', ...written.map((tool) => `${tool.name} ${tool.why}`)]
    if (matchesSearch(words.join(' '), search)) {
      entries.push({
        id: WRITTEN,
        title: 'Written by Tade',
        kind: 'written',
        state: null,
        count: written.length,
        wants: false,
      })
    }
  }
  if (servers.length > 0) {
    const words = [
      'mcp servers',
      ...servers.map((one) => `${one.name} ${one.title} ${one.description} ${one.how}`),
    ]
    if (matchesSearch(words.join(' '), search)) {
      entries.push({
        id: SERVERS,
        title: 'MCP servers',
        kind: 'servers',
        state: null,
        count: servers.length,
        wants: false,
      })
    }
  }
  if (harness.length > 0) {
    const words = ['harnesses’ own', ...harness.map((one) => `${one.name} ${one.where}`)]
    if (matchesSearch(words.join(' '), search)) {
      entries.push({
        id: HARNESS,
        title: "Harnesses' own",
        kind: 'harness',
        state: null,
        count: harness.length,
        wants: false,
      })
    }
  }
  return entries
}

/**
 * One MCP server, as the window is handed it.
 *
 * What is true about a server is the broker's to say — `shownServers` is
 * where it comes from — and this is the window's word for the same thing, the
 * way a harness's own pieces arrive as a name and a place. Nothing here is a
 * credential: a key is said as a place, in the setting the broker generates
 * for it, and never drawn back.
 */
export interface McpServerShown {
  name: string
  title: string
  description: string
  workflow: readonly string[]
  /** Whether a person has turned it on. */
  on: boolean
  /** Whether anybody has decided about it at all, either way. */
  decided: boolean
  /** What is wrong with it, or what has to happen first. */
  problem: string | null
  /** How Tade talks to it: the command, or the address. */
  how: string
  install: string | null
  note: string | null
  /** When anybody last asked it what it offers. */
  asked: string | null
  /** What it offered, by the name agents use, with the server's own beside it. */
  tools: readonly { name: string; from: string; summary: string }[]
  /** What it offered that Tade will not hand on, and why. */
  dropped: readonly { name: string; why: string }[]
  /** Its command fetches code from the network every time it starts. */
  fetches: boolean
}

/** One server nobody has decided about, as the catalogue row offers it. */
export interface McpServerOffer {
  name: string
  title: string
  description: string
  /** What somebody is doing when they reach for it. */
  workflow: readonly string[]
  /** How Tade would talk to it: the command, or the address. */
  how: string
  /** What it would need before it could work: a program, a credential. */
  needs: string | null
  /** The line a person runs to get the program, shown and never run unwatched. */
  install: string | null
  /** What is true about it that nobody would guess. */
  note: string | null
  /** Its command fetches code from the network every time it starts. */
  fetches: boolean
}

/** Everything about an extension that searching it should find. */
function extensionWords(view: ExtensionView): string {
  return [
    view.name,
    view.title,
    view.description,
    view.source,
    view.state,
    ...view.workflow,
    ...view.tools.map((tool) => `${tool.name} ${tool.summary}`),
    ...view.actions.map((action) => action.title),
    ...view.watches.map((watch) => `${watch.title} ${watch.means}`),
    ...view.options.map((option) => option.label),
    // A server is found by what it is reached at, too: somebody looking for
    // the one they set up remembers the address before the name.
    view.server?.how ?? '',
  ].join(' ')
}

/** Every word typed is in it, in any order: the same rule the rest of the window searches by. */
function matchesSearch(text: string, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = text.toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/**
 * The first row of a list to draw: where it was scrolled to, moved as far as
 * it must to keep the row you are on in view.
 *
 * Which is the whole rule, in one place: whoever scrolls reads where they
 * like, and the keyboard moving the choice brings the list back to it —
 * because a choice you cannot see is a choice you did not make.
 */
export function listStart(scroll: number, total: number, room: number, chosen: number): number {
  const most = Math.max(0, total - room)
  let from = Math.max(0, Math.min(scroll, most))
  if (chosen >= from + room) from = Math.min(most, chosen - room + 1)
  if (chosen < from) from = chosen
  return Math.max(0, Math.min(from, most))
}

/** Which entry the panel is on: what was chosen, or the first one there is. */
export function chosenEntry(
  panel: ExtensionsPanel,
  entries: readonly ExtensionEntry[],
): ExtensionEntry | null {
  return entries.find((entry) => entry.id === panel.chosen) ?? entries[0] ?? null
}

/**
 * The controls on the right-hand side, in the order the keyboard moves through
 * them and in the order they are drawn: for the extension shown, setting it
 * up, what it can do from here, its folder, turning it off, and watching what
 * it offers to watch — or showing the watch, once it is on. For the tools Tade
 * wrote for itself, reading each and turning it on or off. What the harness
 * loads by itself has none: Tade only lists those.
 *
 * Turning it off comes last on purpose. Enter into the right-hand side lands
 * on the first control, and the first control being the one that switches the
 * thing off is how a look becomes a change.
 */
export function extensionControls(
  chosen: string | null,
  views: readonly ExtensionView[],
  written: readonly WrittenToolView[] = [],
  servers: readonly McpServerOffer[] = [],
): string[] {
  if (chosen === HARNESS) return []
  if (chosen === WRITTEN) {
    return written.flatMap((tool) => [`read:${tool.name}`, `toggle:${tool.name}`])
  }
  // A catalogue row offers two things at most: running the line that
  // installs the program, in a lane you are looking at, and turning it on —
  // which is a person's act and the only way a server is ever connected.
  if (chosen === SERVERS) {
    return servers.flatMap((server) => [
      ...(server.install ? [`install:${server.name}`] : []),
      `server:${server.name}`,
    ])
  }
  const view = views.find((one) => one.name === chosen)
  if (!view) return []
  const controls: string[] = []
  if (view.configurable && view.state !== 'broken' && view.state !== 'off')
    controls.push(`setup:${view.name}`)
  if (view.state === 'ready')
    controls.push(...view.actions.map((action) => `action:${view.name}:${action.id}`))
  // Nothing is installed behind a spinner: the line is shown, and running it
  // types it into a terminal you are looking at.
  if (view.server?.install && view.state !== 'ready') controls.push(`install:${view.server.name}`)
  if (view.folder) controls.push(`folder:${view.name}`)
  if (view.state !== 'broken') controls.push(`toggle:${view.name}`)
  if (view.state === 'broken') return controls
  for (const watch of view.watches) {
    const control = watchControl(view.name, watch)
    if (control) controls.push(control)
  }
  return controls
}

/**
 * What a tool does, in a line: the first sentence of what its model is told.
 * The whole description is written for whoever is choosing the tool and runs
 * to a paragraph; a person scanning eight of them wants the first clause.
 */
export function toolSummary(description: string): string {
  const said = description.trim().replace(/\s+/g, ' ')
  const stop = said.search(/(?<![A-Z])[.:](?:\s|$)/)
  return stop > 0 ? said.slice(0, stop) : said
}

/**
 * What a watch's button does: show the schedule watching it, once one is on;
 * turn it on in the project you are in; or nothing, when you are in none.
 */
export function watchControl(extension: string, watch: WatchOfferView): string | null {
  if (watch.on) return `watching:${watch.on}`
  return watch.project ? `watch:${extension}:${watch.id}` : null
}

/**
 * Moving around the Extensions panel: typing narrows the list, the arrows walk
 * it, and the right-hand side is a page — tab steps between the things that
 * can be pressed, the arrows scroll what there is to read.
 */
function extensionsKey(
  panel: ExtensionsPanel,
  key: string | undefined,
  data: string,
  inputs: PanelInputs,
): PanelOutcome {
  const entries = extensionEntries(
    inputs.extensions ?? [],
    inputs.written ?? [],
    inputs.harnessExtensions ?? [],
    panel.search,
    inputs.servers ?? [],
  )
  const here = chosenEntry(panel, entries)
  const controls = extensionControls(
    here?.id ?? null,
    inputs.extensions ?? [],
    inputs.written ?? [],
    inputs.servers ?? [],
  )
  /**
   * Moving anywhere in the list starts the right-hand side at its top again,
   * and brings the list to what was chosen if it had been scrolled away from
   * it. The list holds where it is rather than working it out from the
   * choice, so that the wheel and the bar can move it and it stays moved.
   */
  const at = (id: string | null): PanelOutcome => {
    const index = Math.max(
      0,
      entries.findIndex((entry) => entry.id === id),
    )
    const room = Math.max(1, inputs.listRoom ?? entries.length)
    return stay({
      ...panel,
      chosen: id,
      index: 0,
      scroll: 0,
      following: true,
      focus: 'list',
      listScroll: listStart(panel.listScroll, entries.length, room, index),
    })
  }

  if (panel.focus === 'search') {
    if (key === 'escape') return stay({ ...panel, search: '', focus: 'list' })
    if (key === 'enter' || key === 'down' || key === 'tab') return stay({ ...panel, focus: 'list' })
    if (key === 'backspace')
      return stay({
        ...panel,
        search: [...panel.search].slice(0, -1).join(''),
        chosen: null,
        index: 0,
        scroll: 0,
        following: true,
      })
    const typed = key === 'space' ? ' ' : data.startsWith('\x1b') ? '' : data
    if (typed && ![...typed].some(control))
      // What was chosen may not be in the list any more, so the first match is.
      return stay({
        ...panel,
        search: panel.search + typed,
        chosen: null,
        index: 0,
        scroll: 0,
        following: true,
      })
    return stay(panel)
  }

  if (key === 'escape') return close
  if (panel.busy) return stay(panel)
  if (key === 'ctrl+f' || data === '/') return stay({ ...panel, focus: 'search' })

  if (panel.focus === 'list') {
    const index = Math.max(
      0,
      entries.findIndex((entry) => entry.id === here?.id),
    )
    if (key === 'down' || key === 'up') {
      const step = key === 'down' ? 1 : -1
      const next = entries[index + step]
      if (!next)
        return key === 'up' && index === 0 ? stay({ ...panel, focus: 'search' }) : stay(panel)
      return at(next.id)
    }
    if (key === 'home') return entries[0] ? at(entries[0].id) : stay(panel)
    if (key === 'end') {
      const last = entries[entries.length - 1]
      return last ? at(last.id) : stay(panel)
    }
    if (key === 'right' || key === 'tab' || key === 'enter')
      return stay({ ...panel, chosen: here?.id ?? null, focus: 'body', index: 0, following: true })
    return stay(panel)
  }

  // The right-hand side: tab steps between what can be pressed, the arrows
  // read through what there is to read.
  const most = Math.max(0, inputs.scrollable ?? 0)
  const scrolled = (by: number) =>
    stay({
      ...panel,
      scroll: Math.max(0, Math.min(most, panel.scroll + by)),
      following: false,
    })
  if (key === 'left' || (key === 'shift+tab' && panel.index === 0))
    return stay({ ...panel, focus: 'list' })
  if (key === 'shift+tab')
    return stay({ ...panel, index: Math.max(0, panel.index - 1), following: true })
  if (key === 'tab')
    return stay({
      ...panel,
      index: Math.min(Math.max(0, controls.length - 1), panel.index + 1),
      following: true,
    })
  if (key === 'up') return scrolled(-1)
  if (key === 'down') return scrolled(1)
  if (key === 'pageUp') return scrolled(-10)
  if (key === 'pageDown') return scrolled(10)
  if (key === 'home') return stay({ ...panel, scroll: 0, following: false })
  if (key === 'end') return stay({ ...panel, scroll: most, following: false })
  const pressed = controls[panel.index]
  if ((key === 'enter' || key === 'space') && pressed)
    return { panel: { ...panel, said: null }, submit: true, choice: pressed }
  return stay(panel)
}

/** A click in the Extensions panel: on the list, the search field, or a control. */
function extensionsClick(
  panel: ExtensionsPanel,
  control: string,
  inputs: PanelInputs,
): PanelOutcome {
  if (control === 'close') return close
  if (control === 'search') return stay({ ...panel, focus: 'search' })
  if (control.startsWith('pick:')) {
    const id = control.slice(5)
    return stay({
      ...panel,
      chosen: id,
      index: 0,
      scroll: 0,
      following: true,
      focus: 'list',
      said: null,
    })
  }
  const entries = extensionEntries(
    inputs.extensions ?? [],
    inputs.written ?? [],
    inputs.harnessExtensions ?? [],
    panel.search,
    inputs.servers ?? [],
  )
  const here = chosenEntry(panel, entries)
  const index = extensionControls(
    here?.id ?? null,
    inputs.extensions ?? [],
    inputs.written ?? [],
    inputs.servers ?? [],
  ).indexOf(control)
  return index < 0
    ? stay(panel)
    : {
        panel: { ...panel, index, focus: 'body', following: true, said: null },
        submit: true,
        choice: control,
      }
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
  kind: 'text' | 'list' | 'map' | 'flag' | 'secret'
  /** What it offers to choose from, once looked up. */
  choices: readonly string[]
  /**
   * For a secret: where the key it has now is (`$TYPESAFE_API_KEY`, `the
   * macOS keychain`), or empty. Never the key itself — nothing draws that.
   */
  have?: string
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

export function spendPanel(): SpendPanel {
  return { kind: 'spend', window: 'today', by: 'agent', busy: false }
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

function fileClick(panel: FilePanel, control: string, inputs: PanelInputs): PanelOutcome {
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
