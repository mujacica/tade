import type { SettingGroup } from '@tade/core'
import type { ParsedDiff } from '../diff.ts'
import type { Change } from '../frame.ts'
import type { ScrollArea } from '../hits.ts'
import type { AgentPane } from '../model.ts'
import { extensionSetup, extensions, extensionView, settings, spend } from '../panel-view.ts'
import type {
  AccountShown,
  Choice,
  ExtensionView,
  McpServerOffer,
  Panel,
  SetupFieldView,
  UpdatesShown,
  WrittenToolView,
} from '../panels.ts'
import type { SearchEntry } from '../search.ts'
import type { Skin } from '../skin.ts'
import type { SpendView } from '../spend.ts'
import type { Drawn, Pointer } from '../ui.ts'
import type { ViewedFile } from '../viewer.ts'
import { fileView } from './file/view.ts'
import type { MenuItem } from './menu/state.ts'
import { menu } from './menu/view.ts'
import type { ModelChoice } from './models/state.ts'
import { models } from './models/view.ts'
import type { OpenRowView } from './project/state.ts'
import { openProject } from './project/view.ts'
import { search } from './search/view.ts'
import type { BranchRow } from './small/state.ts'
import {
  branches,
  closeDone,
  confirm,
  confirmRemove,
  diff,
  find,
  keysSheet,
  prompt,
  quit,
  reload,
} from './small/view.ts'

// What a panel is handed, and which drawing answers which panel.
//
// The model of what a panel holds and what a key does to it is in `panels.ts`
// and in each panel's own `state.ts`; this is the contract the drawing half is
// written against, and the one dispatch over it. Each panel's two files sit
// together under `panels/<name>/`, so a change to one panel is a change to one
// folder rather than to two shared files.

export interface PanelContext {
  width: number
  height: number
  skin: Skin
  pointer: Pointer
  /**
   * Which of the panel's scrollbars is being dragged, so that one is drawn
   * lit. A panel with two of them — a list and what it is showing — lights
   * the one in your hand, not both.
   */
  scrolling?: ScrollArea | null
  /** Tade's home, as you would type it: where worktrees are made. */
  home: string
  /** A moment with its date, the way the window says one: `Mon 7 Sep 09:00`. */
  date: (at: number) => string
  route: { harness: string; model: string | null; provider: string | null } | null
  /** Where the money went, for the window and grouping the Spend panel is on. */
  spend: SpendView | null
  /** The tasks, for giving each spend row its state. */
  panes: readonly AgentPane[]
  /** The project you are in: its tasks are named short. */
  project: string | null
  /** A task's menu, as it stands. */
  items: readonly MenuItem[]
  /** What a task has changed, for the question before removing it. */
  changes: readonly Change[]
  /** Commits the task's branch has that its base does not. */
  ahead: number | null
  branch: string | null
  base: string | null
  /** The file the diff panel is showing, once git has said. */
  diff: ParsedDiff | null
  /** Models an agent can be started on. */
  choices: readonly Choice[]
  /** Every setting, grouped, as it is now. */
  settings: readonly SettingGroup[]
  /** Every account agents can run as, each harness's own sign-in first. */
  accounts: readonly AccountShown[]
  /**
   * What the Updates page knows: what is installed here and, once somebody
   * has asked, what is current. Null until the page has looked.
   */
  updates: UpdatesShown | null
  /** A check is going: the network half, which only ever runs because it was pressed. */
  updatesBusy: boolean
  /**
   * Whether agents outlive this window — `capabilities.detach`, never the
   * driver's name. It is what decides whether reloading to pick up a new Tade
   * stops the work or leaves it running.
   */
  lanesSurvive: boolean
  /** The config file, as you would type its path. */
  configPath: string
  /** Whether this terminal reports key releases, which holding to talk needs. */
  releases: boolean
  /** Projects over or near their budget today. */
  budgetWarnings: number
  /** How loud the microphone is, while it is being tried. */
  levels: readonly number[]
  /** The Open project list, with what is known about each row. */
  openRows: readonly OpenRowView[]
  /** The folder being browsed, as you would type it. */
  browsing: string | null
  /** Your home directory, which paths are shown relative to. */
  homeDir: string
  /** What search shows for the query as it stands. */
  entries: readonly SearchEntry[]
  /** Search is still looking inside files for the text typed. */
  searching: boolean
  /**
   * The file the viewer is showing, once read: its source coloured line by
   * line, and — for Markdown — laid out at the width `fileViewSize` gives.
   */
  viewing: {
    file: ViewedFile
    source: readonly string[]
    formatted: readonly string[] | null
    /** The same lines with no colour: what a find looks through and a caret counts in. */
    text: readonly string[]
  } | null
  /** The key you talk with, and how. */
  talkKey: string
  talkMode: 'hold' | 'toggle'
  /** The window's other keys as set: `surfaces.window.keys`. */
  bindings: Readonly<Record<string, string>>
  /** Agents that closing would stop. */
  running: number
  /** The project's branches, for switching its checkout. */
  branches: readonly BranchRow[]
  /** The branch the project's checkout is on. */
  checkout: string | null
  /** How many lines of the terminal being searched match. */
  found: number
  /** What the terminal being searched is called. */
  terminalName: string
  /** The extensions this window runs with. */
  extensions: readonly ExtensionView[]
  /** Extensions and servers each harness loads itself, which Tade only lists. */
  harnessExtensions: readonly { name: string; where: string }[]
  /** The MCP servers nobody has decided about: the catalogue, as one row. */
  servers: readonly McpServerOffer[]
  /** The tools Tade wrote for itself, on or off. */
  written: readonly WrittenToolView[]
  /** The extension view being shown, once it has been asked for. */
  extensionView: { title: string; markdown: string } | null
  /** The extension being set up: its state, its guide and its fields. */
  setup: {
    title: string
    state: string
    problem: string | null
    guide: readonly string[]
    links: readonly { title: string; url: string }[]
    fields: readonly SetupFieldView[]
  } | null
  /** Where your own extensions go, as you would type it. */
  extensionsRoot: string
  /** Models to choose from, for the model panel. */
  models: readonly ModelChoice[]
  /** What the model panel is choosing for, as it is called: `the orchestrator`, `agent-1`. */
  modelTarget: string
  /** The model it is on now. */
  currentModel: string | null
}

/** A panel, and anything that opens out of it and may reach past its edge. */
export interface PanelDrawing {
  panel: Drawn
  /** Drawn over the panel, at a place relative to its top-left corner. */
  popups: { drawn: Drawn; row: number; col: number }[]
}

export function drawPanel(panel: Panel, ctx: PanelContext): PanelDrawing {
  switch (panel.kind) {
    case 'spend':
      return { panel: spend(panel, ctx), popups: [] }
    case 'menu':
      return { panel: menu(panel, ctx), popups: [] }
    case 'confirm-remove':
      return { panel: confirmRemove(panel, ctx), popups: [] }
    case 'close-done':
      return { panel: closeDone(panel, ctx), popups: [] }
    case 'diff':
      return { panel: diff(panel, ctx), popups: [] }
    case 'settings':
      return settings(panel, ctx)
    case 'open-project':
      return { panel: openProject(panel, ctx), popups: [] }
    case 'search':
      return { panel: search(panel, ctx), popups: [] }
    case 'file':
      return { panel: fileView(panel, ctx), popups: [] }
    case 'prompt':
      return { panel: prompt(panel, ctx), popups: [] }
    case 'branch':
      return { panel: branches(panel, ctx), popups: [] }
    case 'confirm':
      return { panel: confirm(panel, ctx), popups: [] }
    case 'find':
      return { panel: find(panel, ctx), popups: [] }
    case 'keys':
      return { panel: keysSheet(ctx), popups: [] }
    case 'quit':
      return { panel: quit(panel, ctx), popups: [] }
    case 'reload':
      return { panel: reload(panel, ctx), popups: [] }
    case 'extensions':
      return { panel: extensions(panel, ctx), popups: [] }
    case 'extension-setup':
      return { panel: extensionSetup(panel, ctx), popups: [] }
    case 'extension-view':
      return { panel: extensionView(panel, ctx), popups: [] }
    case 'model':
      return { panel: models(panel, ctx), popups: [] }
  }
}
