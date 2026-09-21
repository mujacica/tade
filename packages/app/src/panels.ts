import type { SettingGroup } from '@tade/core'
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
import type { PanelOutcome } from './panels/outcome.ts'
import { type OpenProjectPanel, type OpenRow, openClick, openKey } from './panels/project/state.ts'
import { type SearchPanel, searchClick, searchKey } from './panels/search/state.ts'
import {
  type AccountAction,
  type Choice,
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
