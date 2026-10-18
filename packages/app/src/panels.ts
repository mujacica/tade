import type { Race, SettingGroup, WorkflowField } from '@tade/core'
// Type-only, so the pure panel model never loads the driver stack behind it.
import type { UpdateLook as UpdatesShown } from '@tade/workbench/programs'

export type { UpdatesShown }

import type { LineComment } from './comments.ts'
import type { ParsedDiff } from './diff.ts'
import { type AwayPanel, awayClick, awayKey } from './panels/away/state.ts'
import { type ChatRow, type ChatsPanel, chatsClick, chatsKey } from './panels/chats/state.ts'
import type { CommentChoice } from './panels/comment.ts'
import { type DiffPanel, diffClick, diffKey } from './panels/diff/state.ts'
import {
  type EvaluationsPanel,
  evaluationsClick,
  evaluationsKey,
} from './panels/evaluations/state.ts'
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
import type { InlineRow } from './panels/file/inline.ts'
import { type FilePanel, fileClick, fileDismiss, fileKey } from './panels/file/state.ts'
import { type IntakePanel, intakeClick, intakeKey } from './panels/intake/state.ts'
import {
  type RequestTherePanel,
  requestThereClick,
  requestThereKey,
} from './panels/intake/there.ts'
import { type MenuItem, type MenuPanel, menuClick, menuKey } from './panels/menu/state.ts'
import { type ModelChoice, type ModelPanel, modelClick, modelKey } from './panels/models/state.ts'
import { close, type PanelOutcome, stay } from './panels/outcome.ts'
import { type OpenProjectPanel, type OpenRow, openClick, openKey } from './panels/project/state.ts'
import { type RacePanel, raceClick, raceKey } from './panels/race/state.ts'
import { type SearchPanel, searchClick, searchKey } from './panels/search/state.ts'
import type { AccountAction } from './panels/settings/accounts.ts'
import type { RemoteAction } from './panels/settings/remotes.ts'
import {
  type Choice,
  DONE,
  type SettingsPanel,
  settingsClick,
  settingsKey,
  type UpdateAction,
} from './panels/settings/state.ts'
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
import { type RowSummaryPanel, rowSummaryClick, rowSummaryKey } from './panels/summary/state.ts'
import { type WaitRow, type WaitsPanel, waitsClick, waitsKey } from './panels/waits/state.ts'
import {
  type WorkflowPanel,
  type WorkflowRow,
  workflowClick,
  workflowKey,
} from './panels/workflow/state.ts'
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

export type Panel =
  | AwayPanel
  | SpendPanel
  | EvaluationsPanel
  | RacePanel
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
  | RowSummaryPanel
  | IntakePanel
  | RequestTherePanel
  | WorkflowPanel
  | ChatsPanel
  | WaitsPanel

/** What the panel needs to know that it does not hold: the settings themselves, and lists. */
export interface PanelInputs {
  choices?: readonly Choice[]
  items?: readonly MenuItem[]
  settings?: readonly SettingGroup[]
  /** What can be done on the Accounts page, in the order the keyboard walks it. */
  accountActions?: readonly AccountAction[]
  /** What can be done on the Updates page, in the order the keyboard walks it. */
  updateActions?: readonly UpdateAction[]
  /** What can be pressed on the Remotes page, in the order the keyboard walks it. */
  remoteActions?: readonly RemoteAction[]
  /** The Open project list, as it stands for the query. */
  rows?: readonly OpenRow[]
  /** What search shows for the query as it stands. */
  entries?: readonly SearchEntry[]
  /** The file's own lines, uncoloured: what a find looks through and an edit starts from. */
  text?: readonly string[]
  /** How many lines the file panel (or the patch reader) shows at once, and how wide they are drawn. */
  body?: number
  columns?: number
  /**
   * The rows the open file is drawn as with git's answer laid into it, whether
   * or not that is what it is showing: turning it on has to know where a line
   * will be drawn, and turning it off where the row at the top of the view is.
   */
  diffRows?: readonly InlineRow[] | null
  /** What git said about the file the patch reader is on: which lines are lines, and which hunks. */
  patch?: ParsedDiff | null
  /** The comments kept on the file a diff panel is showing, for writing on a line again. */
  comments?: readonly LineComment[]
  /** How many comments the review holds in all: what Send sends. */
  drafted?: number
  /** Who a comment can go to, in the order tab goes through them. */
  commentTo?: readonly CommentChoice[]
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
  /** The conversations a chat can be brought back on, in the order the keyboard walks them. */
  chatRows?: readonly ChatRow[]
  /** What queued work could wait on, in the order the waits panel lists them. */
  waitRows?: readonly WaitRow[]
  /** The tools Tade wrote for itself, on or off. */
  written?: readonly WrittenToolView[]
  /** The fields of the extension being set up. */
  setupFields?: readonly SetupFieldView[]
  /** How many paired devices the away panel is reading down. */
  devices?: number
  /** Whether a device is at the away panel's door, waiting for a yes or a no. */
  asking?: boolean
  /**
   * The line the open panel's body was drawn from in the last frame
   * (`Reach.at`): what was on screen when the key was pressed, for a panel
   * whose answer depends on it — the away panel's card is answered only from
   * where it was drawn. Absent where nothing was drawn.
   */
  drawnFrom?: number
  /**
   * The window's own keys, as set.
   *
   * A panel needs them when the act it is asking about is one the window
   * already has keys for: letting a device in is the same act in the same
   * vocabulary as approving a tool call, so it is the same pair of keys — and
   * a panel has the keyboard while it is open, so it has to recognise them
   * itself rather than hope they reach the subject.
   */
  bindings?: Readonly<Record<string, string>>
  /** The fields of the workflow being written, in the order the keyboard walks them. */
  workflowFields?: readonly WorkflowField[]
  /** The rows of its list: the templates, and the chosen one's steps. */
  workflowRows?: readonly WorkflowRow[]
  /** The tabs the extension's own page offers, and whether it is windowed. */
  viewTabs?: readonly { id: string; title: string }[]
  viewWindowed?: boolean
  /** Every race, in the order the panel walks them. */
  races?: readonly Race[]
  /** What each entrant changed, by file, for the patch reader; one missing has not been looked at. */
  raceFiles?: Readonly<Record<string, readonly string[]>>
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
  if (panel.kind === 'chats') return chatsKey(panel, key, inputs.chatRows ?? [])
  if (panel.kind === 'waits') return waitsKey(panel, key, data, inputs.waitRows ?? [])
  if (panel.kind === 'extension-setup') return setupKey(panel, key, data, inputs.setupFields ?? [])
  if (panel.kind === 'extension-view') {
    return extensionViewKey(panel, key, {
      tabs: inputs.viewTabs ?? [],
      windowed: inputs.viewWindowed === true,
    })
  }
  if (panel.kind === 'extensions') return extensionsKey(panel, key, data, inputs)
  if (panel.kind === 'row-summary') return rowSummaryKey(panel, key)
  if (panel.kind === 'intake') return intakeKey(panel, key, data)
  if (panel.kind === 'request-there') return requestThereKey(panel, key)
  if (panel.kind === 'workflow') {
    return workflowKey(panel, key, data, {
      fields: inputs.workflowFields ?? [],
      rows: inputs.workflowRows ?? [],
    })
  }
  if (panel.kind === 'away') return awayKey(panel, key, inputs)
  if (panel.kind === 'race') return raceKey(panel, key, data, inputs)
  if (panel.kind === 'quit') return quitKey(panel, key)
  if (panel.kind === 'reload') return reloadKey(panel, key)
  if (panel.kind === 'spend') return spendKey(panel, key)
  if (panel.kind === 'evaluations') return evaluationsKey(panel, key)
  if (panel.kind === 'menu') return menuKey(panel, key, inputs.items ?? [])
  if (panel.kind === 'prompt') return promptKey(panel, key, data)
  if (panel.kind === 'find') return findKey(panel, key, data, inputs.found ?? 0)
  if (panel.kind === 'branch') return branchKey(panel, key, data, inputs.branches ?? [])
  if (panel.kind === 'confirm') return confirmKey(panel, key)
  if (panel.kind === 'confirm-remove') return confirmKey(panel, key)
  if (panel.kind === 'close-done') return confirmKey(panel, key)
  return diffKey(panel, key, data, inputs)
}

/**
 * A click on the window behind a panel: the other way one is dismissed.
 *
 * It loses exactly what escape loses, so it asks what escape asks — a file
 * with unsaved edits warns once rather than going, and a settings field is
 * saved rather than dropped. A panel in the middle of something stays, as it
 * does for any key.
 */
export function panelDismiss(panel: Panel, inputs: PanelInputs = {}): PanelOutcome {
  if (panel.busy) return stay(panel)
  if (panel.kind === 'file') return fileDismiss(panel)
  // A settings field you have typed in is the other thing a dismiss could
  // lose, so it is dismissed the way its own Done button is: what is in the
  // field is saved, and the page goes when that has happened.
  if (panel.kind === 'settings') return settingsClick(panel, DONE, inputs)
  return close
}

/** A click on one of the panel's own controls. */
export function panelClick(panel: Panel, control: string, inputs: PanelInputs = {}): PanelOutcome {
  if (panel.kind === 'settings') return settingsClick(panel, control, inputs)
  if (panel.kind === 'open-project') return openClick(panel, control, inputs.rows ?? [])
  if (panel.kind === 'search') return searchClick(panel, control, inputs.entries ?? [])
  if (panel.kind === 'file') return fileClick(panel, control, inputs)
  if (panel.kind === 'keys') return keysClick(panel, control)
  if (panel.kind === 'model') return modelClick(panel, control, inputs.models ?? [])
  if (panel.kind === 'chats') return chatsClick(panel, control, inputs.chatRows ?? [])
  if (panel.kind === 'waits') return waitsClick(panel, control, inputs.waitRows ?? [])
  if (panel.kind === 'extension-view') {
    return extensionViewClick(panel, control, {
      tabs: inputs.viewTabs ?? [],
      windowed: inputs.viewWindowed === true,
    })
  }
  if (panel.kind === 'extension-setup') return setupClick(panel, control, inputs.setupFields ?? [])
  if (panel.kind === 'extensions') return extensionsClick(panel, control, inputs)
  if (panel.kind === 'row-summary') return rowSummaryClick(panel, control)
  if (panel.kind === 'intake') return intakeClick(panel, control)
  if (panel.kind === 'request-there') return requestThereClick(panel, control)
  if (panel.kind === 'workflow') {
    return workflowClick(panel, control, {
      fields: inputs.workflowFields ?? [],
      rows: inputs.workflowRows ?? [],
    })
  }
  if (panel.kind === 'away') return awayClick(panel, control)
  if (panel.kind === 'race') return raceClick(panel, control, inputs)
  if (panel.kind === 'quit') return quitClick(panel, control)
  if (panel.kind === 'reload') return reloadClick(panel, control)
  if (panel.kind === 'spend') return spendClick(panel, control)
  if (panel.kind === 'evaluations') return evaluationsClick(panel, control)
  if (panel.kind === 'menu') return menuClick(panel, control)
  if (panel.kind === 'find') return findClick(panel, control, inputs.found ?? 0)
  if (panel.kind === 'prompt') return promptClick(panel, control)
  if (panel.kind === 'branch') return branchClick(panel, control, inputs.branches ?? [])
  if (panel.kind === 'confirm-remove' || panel.kind === 'confirm' || panel.kind === 'close-done')
    return confirmClick(panel, control)
  return diffClick(panel, control, inputs)
}
