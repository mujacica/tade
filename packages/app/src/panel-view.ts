import {
  compositeTuiLine,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import { duration, KEY_BINDINGS, type Setting, type SettingGroup } from '@tade/core'
import type { ParsedDiff } from './diff.ts'
import type { Hit, Target } from './hits.ts'
import { checkTalkKey, keyCaps, TALK_SUGGESTIONS } from './keys.ts'
import { linkedRow } from './links.ts'
import { type AgentPane, glyph, MARK_TONES, markOf } from './model.ts'
import {
  ACCOUNTS,
  type BranchPanel,
  type BranchRow,
  branchChoices,
  type Choice,
  type CloseDonePanel,
  type ConfirmPanel,
  type ConfirmRemovePanel,
  choicesFor,
  type DiffPanel,
  type ExtensionSetupPanel,
  type ExtensionsPanel,
  type ExtensionView,
  type ExtensionViewPanel,
  extensionControls,
  type FileAsk,
  type FilePanel,
  type FindPanel,
  fileMatches,
  type MenuItem,
  type MenuPanel,
  type ModelChoice,
  type ModelPanel,
  matchingChoices,
  modelChoices,
  nameFrom,
  type OpenProjectPanel,
  type OpenRow,
  type Panel,
  type PromptPanel,
  priceCells,
  type QuitPanel,
  type ReloadPanel,
  type SearchPanel,
  type SettingsPanel,
  type SetupFieldView,
  type SpendPanel,
  setupControls,
  usesDropdown,
  visibleSettings,
  type WrittenToolView,
  watchControl,
} from './panels.ts'
import { BAR, barRows } from './scrollbar.ts'
import { completed, GROUPS, parseQuery, SCOPES, type SearchEntry } from './search.ts'
import type { Skin } from './skin.ts'
import { SPEND_BY, SPEND_WINDOWS, type SpendView } from './spend.ts'
import { blank, box, type Drawn, fit as fitRow, type Pointer, Row } from './ui.ts'
import type { Change } from './view.ts'
import {
  bytes,
  cellOf,
  colouredLine,
  type Edited,
  editable,
  leftOf,
  type Match,
  markdownLines,
  TAB,
  type ViewedFile,
} from './viewer.ts'

// How each panel looks. The model of what a panel holds and what a key does to
// it is in `panels.ts`; this only draws it, and names each control so a click
// can find its way back there.

export interface PanelContext {
  width: number
  height: number
  skin: Skin
  pointer: Pointer
  /** The panel's own scrollbar is being dragged, so it is drawn lit. */
  scrolling?: boolean
  /** Tade's home, as you would type it: where worktrees are made. */
  home: string
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
  /** Providers pi is signed in to. */
  accounts: readonly string[]
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
  /** Extensions the harness loads itself, which Tade only lists. */
  harnessExtensions: readonly { name: string; where: string }[]
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

export interface OpenRowView {
  row: OpenRow
  branch: string | null
  tasks: number
  /** When it was last opened, said the way people say it. */
  when: string | null
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

/** One price column: room for `$12.50` or `varies`, and the gap before it. */
const PRICE_CELL = 8
const PRICE_COLUMNS = PRICE_CELL * 3

/**
 * Choosing a model: typing narrows by provider, id or name, the one in use is
 * marked, what each costs is in columns you can run your eye down, and a fixed
 * height so the list does not jump while it narrows.
 */
function models(panel: ModelPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(120, ctx.width - 4)
  const inner = width - 2
  const choices = modelChoices(ctx.models, panel.query)
  // As tall as the window allows: a long list is scrolled, never cut short.
  const room = Math.max(4, Math.min(40, ctx.height - 12))
  // Columns that stay put while you type: the model, as wide as the longest in
  // the catalog allows; what it costs; then its name, where there is room.
  const lead = 4
  const idWidth = Math.min(
    40,
    Math.max(16, ...ctx.models.map((model) => visibleWidth(model.id) - model.provider.length - 1)),
  )
  const priced = inner >= lead + idWidth + PRICE_COLUMNS && ctx.models.some((one) => one.price)
  const nameRoom = inner - lead - idWidth - (priced ? PRICE_COLUMNS : 0) - 3
  const rows: { text: string; hits: Hit[] }[] = [
    new Row(inner, skin)
      .space()
      .field(panel.query, inner - 2, {
        caret: true,
        ...(panel.query ? {} : { ghost: 'type to narrow: opus, kimi, openrouter…' }),
      })
      .build(),
    new Row(inner, skin)
      .space()
      .text(`${ctx.modelTarget} is on `, skin.hint)
      .text(ctx.currentModel ?? 'its default model', skin.busy)
      .build(),
    blank(inner),
  ]
  if (priced) {
    // What the price columns are, over them.
    const head = new Row(inner, skin).space(lead + idWidth)
    for (const label of ['in', 'out', 'cached']) head.text(label.padStart(PRICE_CELL), skin.label)
    if (nameRoom >= 14) head.space(3).text('$ per 1M tokens', skin.hint)
    rows.push(head.build())
  }
  const start = Math.max(0, Math.min(panel.index - room + 1, choices.length - room))
  choices.slice(start, start + room).forEach((choice, offset) => {
    const at = start + offset
    const on = at === panel.index
    const current =
      ctx.currentModel !== null &&
      (choice.id === ctx.currentModel || choice.id.endsWith(`/${ctx.currentModel}`))
    const r = new Row(inner, skin)
      .text(on ? '▌' : ' ', skin.signal)
      .space()
      .text(current ? '● ' : '  ', skin.done)
    const id = choice.id.slice(choice.provider.length + 1)
    const shownId = visibleWidth(id) > idWidth ? truncateToWidth(id, idWidth, '…') : id
    r.text(shownId, on ? skin.you : skin.busy).space(idWidth - visibleWidth(shownId))
    if (priced) {
      const [input, output, cached] = priceCells(choice)
      const tone = input === 'free' ? skin.done : input === 'varies' ? skin.hint : (t: string) => t
      for (const cell of [input, output, cached]) r.text(cell.padStart(PRICE_CELL), tone)
    }
    if (nameRoom >= 8) {
      const said = `${choice.name} · ${choice.provider}`
      r.space(3).text(
        visibleWidth(said) > nameRoom ? truncateToWidth(said, nameRoom, '…') : said,
        skin.hint,
      )
    }
    const built = r.build()
    rows.push({
      text: on ? skin.selected(built.text) : built.text,
      hits: [{ row: 0, from: 0, to: inner - 1, target: { kind: 'control', id: `row:${at}` } }],
    })
  })
  if (choices.length === 0)
    rows.push(
      new Row(inner, skin)
        .space()
        .text('No model like that among the ones you can use.', skin.hint)
        .build(),
    )
  for (let gap = room - Math.min(room, Math.max(1, choices.length)); gap > 0; gap--)
    rows.push(blank(inner))
  rows.push(
    panel.error
      ? new Row(inner, skin).space().text(`▲ ${panel.error}`, skin.waiting).build()
      : blank(inner),
  )
  rows.push(
    new Row(inner, skin, ctx.pointer)
      .space()
      .text(
        panel.busy
          ? 'Switching…'
          : `↑↓ choose · enter switches · ${choices.length} of ${ctx.models.length}`,
        skin.hint,
      )
      .right((r) => r.button('Cancel', { kind: 'control', id: 'cancel' }).space())
      .build(),
  )
  return box(`Model for ${ctx.modelTarget}`, rows, width, skin, { corner: 'esc' })
}

/**
 * The extensions: each with whether it works and, when it does not, what to
 * do about it; turning it on or off, setting it up, its actions; then the
 * tools Tade wrote for itself, to read and turn on. A fixed height, scrolled
 * to the control the keyboard is on, so nothing jumps while you move.
 */
function extensions(panel: ExtensionsPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(104, ctx.width - 4)
  const inner = width - 2
  const controls = extensionControls(ctx.extensions, ctx.written)
  const chosen = controls[panel.index] ?? null
  // The keyboard's control is lit as the pointer's would be, when the pointer is not on one.
  const pointer =
    ctx.pointer.hover?.kind === 'control'
      ? ctx.pointer
      : { ...ctx.pointer, hover: chosen ? { kind: 'control' as const, id: chosen } : null }
  const row = () => new Row(inner, skin, pointer)
  const lines: { text: string; hits: Hit[]; chosen?: boolean }[] = []
  const control = (id: string) => ({ kind: 'control' as const, id })
  /** Buttons in rows that wrap, each row knowing whether the chosen control is on it. */
  const buttons = (
    items: readonly { id: string; label: string; look?: 'attention' | 'danger' | 'primary' }[],
    indent = 3,
  ) => {
    let current = row().text(' '.repeat(indent))
    let here = false
    for (const item of items) {
      if (current.used + visibleWidth(item.label) + 5 > inner) {
        lines.push({ ...current.build(), chosen: here })
        current = row().text(' '.repeat(indent))
        here = false
      }
      current.button(item.label, control(item.id), item.look).space()
      if (item.id === chosen) here = true
    }
    if (items.length > 0) lines.push({ ...current.build(), chosen: here })
  }

  for (const view of ctx.extensions) {
    const mark =
      view.state === 'ready'
        ? skin.done('●')
        : view.state === 'broken'
          ? skin.bad('✗')
          : view.state === 'off'
            ? skin.hint('○')
            : skin.waiting('◐')
    lines.push(
      row()
        .space()
        .text(mark)
        .space()
        // The name is a way in too: to setting it up, where it can be.
        .text(
          view.title,
          view.state === 'off' ? skin.hint : skin.you,
          view.configurable && view.state !== 'broken' && view.state !== 'off'
            ? control(`setup:${view.name}`)
            : undefined,
        )
        .text(`  ${view.source} · ${view.state}`, skin.hint)
        .right((r) =>
          r
            .text(
              view.tools.length > 0
                ? `${view.tools.length} tool${view.tools.length === 1 ? '' : 's'}`
                : '',
              skin.hint,
            )
            .space(),
        )
        .build(),
    )
    const problem = view.state === 'needs setup' || view.state === 'broken'
    for (const piece of wrapTextWithAnsi(
      problem && view.problem ? view.problem : view.description,
      Math.max(10, inner - 4),
    )) {
      lines.push(
        row()
          .text('   ')
          .text(piece, problem ? skin.waiting : skin.hint)
          .build(),
      )
    }
    if (view.unknownSettings.length > 0) {
      lines.push(
        row()
          .text('   ')
          .text(`not read: extensions.${view.name}.${view.unknownSettings.join(', ')}`, skin.bad)
          .build(),
      )
    }
    const items: { id: string; label: string; look?: 'attention' | 'danger' | 'primary' }[] = []
    if (view.state !== 'broken') {
      items.push({
        id: `toggle:${view.name}`,
        label: view.state === 'off' ? 'Turn on' : 'Turn off',
      })
    }
    if (view.configurable && view.state !== 'broken' && view.state !== 'off') {
      items.push({
        id: `setup:${view.name}`,
        label: view.state === 'needs setup' ? 'Set up…' : 'Settings…',
        ...(view.state === 'needs setup' ? { look: 'attention' as const } : {}),
      })
    }
    if (view.state === 'ready') {
      items.push(
        ...view.actions.map((action) => ({
          id: `action:${view.name}:${action.id}`,
          label: action.title,
        })),
      )
    }
    if (view.folder) items.push({ id: `folder:${view.name}`, label: 'Open folder' })
    buttons(items)
    // What it offers to watch: a schedule like any other once it is on.
    for (const watch of view.state === 'broken' ? [] : view.watches) {
      const control = watchControl(view.name, watch)
      const title = row()
        .text('   ')
        .text('◎', watch.on ? skin.done : skin.hint)
        .space()
        .text(watch.title, skin.you)
        .text(`  every ${watch.every}`, skin.hint)
      title.right((r) => {
        if (watch.on) r.text(`on in ${watch.project ?? ''}  `, skin.done)
        if (control) {
          r.button(watch.on ? 'Show' : `Watch ${watch.project ?? ''}`, {
            kind: 'control',
            id: control,
          })
        } else {
          r.text('open a project to watch it', skin.hint)
        }
        r.space()
      })
      lines.push({ ...title.build(), chosen: control !== null && control === chosen })
      for (const piece of wrapTextWithAnsi(watch.means, Math.max(10, inner - 6))) {
        lines.push(row().text('     ').text(piece, skin.hint).build())
      }
    }
    lines.push(blank(inner))
  }
  if (ctx.extensions.length === 0) {
    lines.push(row().space().text('No extensions are loaded.', skin.hint).build(), blank(inner))
  }

  if (ctx.written.length > 0) {
    lines.push(
      row()
        .space()
        .text('WRITTEN BY TADE', skin.label)
        .text('  tools for the orchestrator: one you turn on loads next start', skin.hint)
        .build(),
    )
    for (const tool of ctx.written) {
      const title = row()
        .text('   ')
        .text(tool.on ? skin.done('●') : skin.hint('○'))
        .space()
        .text(tool.name, tool.on ? skin.you : skin.hint)
        .text(tool.on ? '  on' : '  off', skin.hint)
      title.right((r) =>
        r
          .button('Read', control(`read:${tool.name}`))
          .space()
          .button(
            tool.on ? 'Turn off' : 'Turn on',
            control(`toggle:${tool.name}`),
            tool.on ? undefined : 'primary',
          )
          .space(),
      )
      lines.push({
        ...title.build(),
        chosen: chosen === `read:${tool.name}` || chosen === `toggle:${tool.name}`,
      })
      if (tool.why) {
        for (const piece of wrapTextWithAnsi(tool.why, Math.max(10, inner - 6))) {
          lines.push(row().text('     ').text(piece, skin.hint).build())
        }
      }
    }
    lines.push(blank(inner))
  }

  if (ctx.harnessExtensions.length > 0) {
    lines.push(
      row()
        .space()
        .text("PI'S OWN", skin.label)
        .text('  loaded by pi itself, in every agent', skin.hint)
        .build(),
    )
    for (const piece of ctx.harnessExtensions) {
      lines.push(row().text('   ').text(piece.name).text(`  ${piece.where}`, skin.hint).build())
    }
    lines.push(blank(inner))
  }

  // As tall as the window allows, and no taller than it needs; scrolled so the
  // chosen control is in view.
  const room = Math.max(6, Math.min(lines.length, ctx.height - 8))
  const at = Math.max(
    0,
    lines.findIndex((line) => line.chosen),
  )
  const start = Math.max(0, Math.min(at - Math.floor(room / 2), lines.length - room))
  const shown = lines.slice(start, start + room)
  const footer = panel.said
    ? row().space().text(panel.said, skin.busy).build()
    : row()
        .space()
        .text(`yours go in ${ctx.extensionsRoot}/<name>/extension.ts, off until you say`, skin.hint)
        .right((r) => r.text('tab moves · enter presses · esc closes', skin.hint).space())
        .build()
  return box('Extensions', [...shown, footer], width, skin, { corner: 'esc' })
}

/**
 * What an extension shows when its status is clicked: its document, formatted,
 * as tall as the window allows and scrolled with the arrows. It is asked again
 * while it is open, so what it shows stays current.
 */
function extensionView(panel: ExtensionViewPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(110, ctx.width - 4)
  const inner = width - 2
  const lines = ctx.extensionView
    ? markdownLines(ctx.extensionView.markdown, inner - 2, !skin.colour)
    : []
  const room = Math.max(6, ctx.height - 8)
  const start = Math.max(0, Math.min(panel.scroll, lines.length - room))
  const rows: { text: string; hits: Hit[] }[] = []
  if (!ctx.extensionView)
    rows.push(new Row(inner, skin).space().text('Looking…', skin.hint).build())
  for (const line of lines.slice(start, start + room))
    rows.push(linkedRow(` ${line}`, inner, skin, ctx.pointer))
  for (let gap = room - rows.length; gap > 0; gap--) rows.push(blank(inner))
  rows.push(
    new Row(inner, skin, ctx.pointer)
      .space()
      .text(
        lines.length > room
          ? `↑↓ scrolls · ${start + 1}–${Math.min(lines.length, start + room)} of ${lines.length} · kept current while open`
          : 'kept current while open',
        skin.hint,
      )
      .right((r) => r.button('Close', { kind: 'control', id: 'close' }).space())
      .build(),
  )
  return box(ctx.extensionView?.title ?? 'Extension', rows, width, skin, { corner: 'esc' })
}

/**
 * Setting an extension up: what it needs, in steps; links worth opening; the
 * fields to fill in, with what they can be chosen from; and what saving came
 * to — ready, or what is still missing.
 */
function extensionSetup(panel: ExtensionSetupPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(96, ctx.width - 4)
  const inner = width - 2
  const setup = ctx.setup
  const controls = setupControls(setup?.fields ?? [])
  const chosen = controls[panel.index] ?? null
  const pointer =
    ctx.pointer.hover?.kind === 'control'
      ? ctx.pointer
      : { ...ctx.pointer, hover: chosen ? { kind: 'control' as const, id: chosen } : null }
  const row = () => new Row(inner, skin, pointer)
  const rows: { text: string; hits: Hit[] }[] = []
  if (!setup) {
    rows.push(row().space().text('This extension has nothing to set up.', skin.hint).build())
    return box('Set up', rows, width, skin, { corner: 'esc' })
  }
  rows.push(
    row()
      .space()
      .text(setup.state === 'ready' ? skin.done('●') : skin.waiting('◐'))
      .space()
      .text(
        setup.state === 'ready' ? 'Ready' : `Needs setting up: ${setup.problem ?? ''}`,
        setup.state === 'ready' ? skin.done : skin.waiting,
      )
      .build(),
    blank(inner),
  )
  for (const step of setup.guide) {
    for (const line of markdownLines(step, inner - 2, !skin.colour)) {
      rows.push(linkedRow(`  ${line}`, inner, skin, pointer))
    }
  }
  if (setup.links.length > 0) {
    const links = row().space()
    for (const link of setup.links)
      links.text(`${link.title} ↗`, skin.link, { kind: 'link', url: link.url }).space(3)
    rows.push(links.build())
  }
  rows.push(blank(inner))
  const label = 16
  for (const field of setup.fields) {
    const focused = chosen === `field:${field.key}`
    const value = panel.values[field.key] ?? ''
    const r = row()
      .space()
      .text(field.label.padEnd(label).slice(0, label), focused ? skin.you : skin.label)
    if (field.kind === 'flag') {
      r.check(value === 'on', value === '' ? 'as it comes' : value, {
        kind: 'control',
        id: `field:${field.key}`,
      })
    } else {
      r.field(value, Math.max(10, inner - label - 4), {
        caret: focused,
        target: { kind: 'control', id: `field:${field.key}` },
        ...(value === '' && field.placeholder ? { ghost: field.placeholder } : {}),
      })
    }
    rows.push(r.build())
    if (field.help)
      rows.push(
        row()
          .text(' '.repeat(label + 1))
          .text(field.help, skin.hint)
          .build(),
      )
    if (field.choices.length > 0) {
      let picks = row().text(' '.repeat(label + 1))
      for (const choice of field.choices) {
        if (picks.used + visibleWidth(choice) + 5 > inner) {
          rows.push(picks.build())
          picks = row().text(' '.repeat(label + 1))
        }
        picks.button(choice, { kind: 'control', id: `pick:${field.key}:${choice}` }).space()
      }
      rows.push(picks.build())
    }
  }
  rows.push(blank(inner))
  rows.push(
    panel.error
      ? row().space().text(`▲ ${panel.error}`, skin.waiting).build()
      : panel.said
        ? row().space().text(panel.said, skin.done).build()
        : blank(inner),
  )
  rows.push(
    row()
      .space()
      .text(
        panel.busy ? 'Checking…' : 'tab moves · enter presses · space turns on and off',
        skin.hint,
      )
      .right((r) =>
        r
          .button('Close', { kind: 'control', id: 'cancel' })
          .space()
          .button('Save and check', { kind: 'control', id: 'save' }, 'primary')
          .space(),
      )
      .build(),
  )
  const room = Math.max(8, ctx.height - 6)
  return box(`Set up ${setup.title}`, rows.slice(0, room), width, skin, { corner: 'esc' })
}

function search(panel: SearchPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(100, ctx.width - 4)
  const inner = width - 2
  const entries = ctx.entries
  const query = parseQuery(panel.query)
  const chosen = entries[panel.index]
  const suggestion = completed(panel.query, chosen)
  const ghost =
    suggestion !== panel.query && suggestion.toLowerCase().startsWith(panel.query.toLowerCase())
      ? suggestion.slice(panel.query.length)
      : ''

  const rows: { text: string; hits: Hit[] }[] = [
    new Row(inner, skin)
      .space()
      .text('⌕', skin.signal)
      .field(panel.query, inner - 4, { caret: true, ghost })
      .build(),
  ]
  const chips = new Row(inner, skin, ctx.pointer).space(3)
  for (const scope of SCOPES) {
    chips.tab(
      `${scope.prefix} ${scope.label}`,
      { kind: 'control', id: `scope:${scope.prefix}` },
      query.scope === scope.scope,
    )
    chips.space()
  }
  chips.right((r) =>
    r.text(ctx.searching ? 'looking in files…' : 'file:42 goes to a line', skin.hint).space(),
  )
  rows.push(chips.build())
  rows.push(blank(inner))

  // Headings between the groups, and every result a row: the list is laid out
  // whole, then the part around the chosen result is shown.
  const lines: { text: string; hits: Hit[]; at: number | null }[] = []
  for (const group of GROUPS) {
    const members = entries
      .map((entry, at) => ({ entry, at }))
      .filter(({ entry }) => entry.kind === group.kind)
    if (members.length === 0) continue
    lines.push({
      ...new Row(inner, skin)
        .space()
        .text(group.title, skin.label)
        .space()
        .badge(members.length)
        .build(),
      at: null,
    })
    for (const { entry, at } of members)
      lines.push({ ...resultRow(entry, at, at === panel.index, inner, query.text, ctx), at })
  }
  const room = Math.max(6, Math.min(40, ctx.height - 12))
  const chosenLine = Math.max(
    0,
    lines.findIndex((line) => line.at === panel.index),
  )
  // Keep the chosen result in view, with its group's heading where there is room.
  const start = Math.max(0, Math.min(chosenLine - room + 2, lines.length - room))
  for (const line of lines.slice(start, start + room)) {
    rows.push({
      text: line.text,
      hits: [
        { row: 0, from: 0, to: inner - 1, target: { kind: 'scroll', area: 'panel' } },
        ...line.hits,
      ],
    })
  }
  if (entries.length === 0) {
    rows.push(
      new Row(inner, skin)
        .space()
        .text(
          query.scope === 'text' && query.text.length < 3
            ? 'Type at least three letters to look inside files.'
            : ctx.searching
              ? 'Looking…'
              : 'Nothing matches.',
          skin.hint,
        )
        .build(),
    )
  }
  for (
    let gap = room - Math.min(room, lines.length) - (entries.length === 0 ? 1 : 0);
    gap > 0;
    gap--
  )
    rows.push(blank(inner))
  rows.push(blank(inner))
  rows.push(
    new Row(inner, skin)
      .space()
      .text('↑↓ move · tab completes · enter opens · esc closes', skin.hint)
      .build(),
  )
  return box('Search', rows, width, skin, { corner: 'ctrl+k' })
}

/** One result: its mark, its name with what matched lit, where it is, and why at the edge. */
function resultRow(
  entry: SearchEntry,
  at: number,
  on: boolean,
  width: number,
  text: string,
  ctx: PanelContext,
): { text: string; hits: Hit[] } {
  const { skin } = ctx
  const tone = entry.tone
    ? skin[entry.tone]
    : entry.kind === 'file' || entry.kind === 'match'
      ? skin.busy
      : skin.tab
  const r = new Row(width, skin)
    .text(on ? '▌' : ' ', skin.signal)
    .space()
    .text(entry.mark, tone)
    .space()
  const hits = new Set(entry.hits ?? [])
  const label = [...entry.label]
  // Runs of matched and unmatched characters, painted as runs.
  let run = ''
  let lit = false
  const flush = () => {
    if (run) r.text(run, lit ? skin.waiting : on ? skin.you : (t: string) => t)
    run = ''
  }
  label.forEach((char, i) => {
    const hit = hits.has(i)
    if (hit !== lit) {
      flush()
      lit = hit
    }
    run += char
  })
  flush()
  if (entry.detail) r.space(2).text(entry.detail, skin.hint)
  if (entry.preview !== undefined) {
    r.space(2)
    const preview = entry.preview
    const found = text ? preview.toLowerCase().indexOf(text.toLowerCase()) : -1
    // The line from a little before what matched, so the match is in view.
    const from = found > 24 ? found - 20 : 0
    const shown = (from > 0 ? '…' : '') + preview.slice(from)
    const hit = found >= 0 ? found - from + (from > 0 ? 1 : 0) : -1
    if (hit >= 0) {
      r.text(shown.slice(0, hit), skin.hint)
        .text(shown.slice(hit, hit + text.length), skin.waiting)
        .text(shown.slice(hit + text.length), skin.hint)
    } else {
      r.text(shown, skin.hint)
    }
  }
  if (entry.note) {
    const note = entry.note
    r.right((right) =>
      right.text(note, entry.tone === 'waiting' ? skin.waiting : skin.hint).space(),
    )
  }
  const built = r.build()
  return {
    text: on ? skin.selected(built.text) : built.text,
    hits: [{ row: 0, from: 0, to: width - 1, target: { kind: 'control', id: `entry:${at}` } }],
  }
}

/** How big the file viewer is in a window this size, and how wide its text is. */
export function fileViewSize(
  width: number,
  height: number,
): { width: number; height: number; text: number } {
  const w = Math.max(40, Math.min(160, width - 4))
  return { width: w, height: Math.max(10, height - 2), text: w - 2 - 9 }
}

/**
 * The body of the file viewer: how many lines it shows at once, how wide they
 * are drawn, and how much of that the numbers down the side take.
 *
 * Exported because the app needs the same three numbers — to keep the caret in
 * view, and to turn the cell you clicked into the character you meant — and
 * two places working them out separately is two layouts to keep in step.
 */
export function fileBodySize(
  width: number,
  height: number,
  lines: number,
  bar = false,
): { rows: number; columns: number; gutter: number } {
  const size = fileViewSize(width, height)
  const gutter = Math.max(3, String(Math.max(1, lines)).length) + 4
  return {
    rows: Math.max(1, size.height - 6 - (bar ? 1 : 0)),
    columns: Math.max(1, size.width - 2 - BAR - gutter),
    gutter,
  }
}

function fileView(panel: FilePanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const size = fileViewSize(ctx.width, ctx.height)
  const inner = size.width - 2
  const viewing = ctx.viewing?.file.path === panel.path ? ctx.viewing : null
  const file = viewing?.file ?? null
  const markdown = viewing?.formatted !== null && viewing !== null
  const formatted = markdown && panel.formatted
  const drawn = formatted ? (viewing?.formatted ?? []) : (viewing?.source ?? [])
  // Formatted Markdown has no line numbers, so it has no caret either.
  const edit = formatted ? null : panel.edit
  const plain = edit ? edit.lines : (viewing?.text ?? [])
  const lines = edit ? edit.lines : drawn
  const typeable = file !== null && !formatted && editable(file) === null
  const control = (id: string) => ({ kind: 'control' as const, id })

  const head = new Row(inner, skin, ctx.pointer)
    .space()
    .text(tildeOf(panel.path, ctx.homeDir), skin.you)
  if (file && !file.error) {
    const facts = [
      file.language ?? (file.binary ? 'binary' : 'text'),
      file.binary ? null : `${lines.length} line${lines.length === 1 ? '' : 's'}`,
      bytes(file.size),
      file.truncated ? 'first 1 MB' : null,
    ].filter(Boolean)
    head.space(2).text(facts.join(' · '), skin.hint)
    if (edit?.dirty) head.space(2).text('● not saved', skin.waiting)
  }
  if (markdown) {
    head.right((r) =>
      r
        .tab('Formatted', control('formatted'), panel.formatted)
        .tab('Source', control('source'), !panel.formatted)
        .space(),
    )
  }
  const rows: { text: string; hits: Hit[] }[] = [
    head.build(),
    { text: skin.chrome('─'.repeat(inner)), hits: [] },
  ]

  // The one bar the panel opens: finding in the file, or going to a line. It
  // takes a line of the body rather than a line of the window, so the panel
  // keeps the height it had and nothing under the pointer moves.
  const matches = fileMatches(panel, plain)
  if (panel.asking) rows.push(fileBar(panel.asking, matches, inner, ctx))
  const geometry = fileBodySize(ctx.width, ctx.height, lines.length, panel.asking !== null)
  const body = geometry.rows
  if (!viewing) {
    rows.push(new Row(inner, skin).space(2).text('Reading…', skin.hint).build())
  } else if (file?.error || file?.binary) {
    rows.push(blank(inner))
    rows.push(
      new Row(inner, skin)
        .space(2)
        .text(
          file.error ?? `A binary file, ${bytes(file.size)}. Open it in its own app to see it.`,
          skin.hint,
        )
        .build(),
    )
  } else {
    // A column down the right is the file's scrollbar: where in it you are
    // reading, and a handle to move.
    const text = inner - BAR
    const digits = geometry.gutter - 4
    const scroll = Math.max(0, Math.min(panel.scroll, lines.length - body))
    // Where the caret is drawn, and how far the body has slid left to keep it
    // on screen: a long line is edited at its end as often as at its start.
    const gutterWidth = formatted ? 0 : geometry.gutter
    const caretLine = edit?.lines[edit.row] ?? ''
    const caretCell = edit ? cellOf(caretLine, edit.column) : 0
    // A block covers the character it is on, and a wide one is two cells.
    const caretCells = edit ? Math.max(1, cellOf(caretLine, edit.column + 1) - caretCell) : 1
    const left = edit ? leftOf(caretCell, geometry.columns) : 0
    const read: { text: string; hits: Hit[] }[] = []
    for (let offset = 0; offset < body; offset++) {
      const at = scroll + offset
      const number = at + 1
      const there = at < lines.length
      const marked = !formatted && panel.line === number
      const gutter =
        formatted || !there ? '' : `${marked ? '▶' : ' '}${String(number).padStart(digits)} │ `
      const room = Math.max(1, text - visibleCells(gutter))
      const source = there ? colouredAt(at, edit, viewing, ctx) : ''
      const tabbed = source.replaceAll('\t', TAB)
      const cut = fitRow(left === 0 ? tabbed : sliceByColumn(tabbed, left, room), room)
      const painted = `${formatted || !there ? '' : marked ? skin.signal(gutter.slice(0, 1)) + skin.you(gutter.slice(1, -2)) + skin.chrome('│ ') : skin.hint(gutter.slice(0, -2)) + skin.chrome('│ ')}${cut}`
      const hits: Hit[] = [
        { row: 0, from: 0, to: text - 1, target: { kind: 'scroll', area: 'panel' } },
      ]
      // Clicking the text puts the caret in it; clicking the numbers does not,
      // so the gutter is still somewhere to take hold of the file and scroll.
      if (typeable && lines.length > 0)
        hits.push({
          row: 0,
          from: gutterWidth,
          to: text - 1,
          target: { kind: 'caret', line: Math.min(at, lines.length - 1) },
        })
      read.push({
        text: laidOver(marked ? skin.selected(painted) : painted, {
          at,
          line: plain[at] ?? '',
          gutter: gutterWidth,
          left,
          width: text,
          matches,
          current: panel.asking?.kind === 'find' ? matches[panel.asking.index] : undefined,
          ...(edit && edit.row === at ? { caret: caretCell, caretCells } : {}),
          skin,
        }),
        hits,
      })
    }
    const bar = barRows(
      { total: lines.length, shown: body, offset: scroll, rows: body },
      skin,
      ctx.scrolling === true || ctx.pointer.hover?.kind === 'scrollbar',
    )
    const target: Target = {
      kind: 'scrollbar',
      area: 'panel',
      total: lines.length,
      shown: body,
    }
    read.forEach((row, i) => {
      rows.push({
        text: `${row.text}${bar[i] ?? ' '}`,
        hits: [...row.hits, { row: 0, from: text, to: text, target }],
      })
    })
  }
  while (rows.length < 2 + body + (panel.asking ? 1 : 0))
    rows.push({
      text: ' '.repeat(inner),
      hits: [{ row: 0, from: 0, to: inner - 1, target: { kind: 'scroll', area: 'panel' } }],
    })
  rows.push({ text: skin.chrome('─'.repeat(inner)), hits: [] })
  const shownTo = Math.min(
    lines.length,
    Math.max(0, Math.min(panel.scroll, lines.length - body)) + body,
  )
  const foot = new Row(inner, skin, ctx.pointer).space()
  // The buttons are what the footer is for; where they are position is said,
  // and the keys only where there is room for them too.
  const saving = edit?.dirty === true
  const buttons =
    'Copy path'.length +
    'Open in editor'.length +
    'Close'.length +
    (saving ? 'Save'.length + 5 : 0) +
    12 +
    3
  if (panel.said) {
    foot.text(panel.said, skin.waiting)
  } else if (lines.length > 0) {
    const from = Math.max(0, Math.min(panel.scroll, lines.length - body)) + 1
    const where = `${formatted ? 'rows' : 'lines'} ${from}–${shownTo} of ${lines.length}`
    const keys =
      panel.asking?.kind === 'find'
        ? '  enter the next · ↑↓ move · esc shuts the bar'
        : edit
          ? '  ctrl+s saves · ctrl+f finds · esc leaves'
          : typeable
            ? '  click to edit · ctrl+f find · ctrl+g line'
            : '  ↑↓ scroll · space a page · e editor'
    if (1 + where.length + buttons + 2 <= inner) foot.text(where, skin.hint)
    if (1 + where.length + keys.length + buttons + 2 <= inner) foot.text(keys, skin.hint)
  }
  foot.right((r) => {
    if (saving) r.button('Save', control('save'), 'attention').space()
    r.button('Copy path', control('copy-path'))
      .space()
      .button('Open in editor', control('editor'), 'primary')
      .space()
      .button('Close', control('close'))
      .space()
  })
  rows.push(foot.build())
  return box('File', rows, size.width, skin, { corner: 'esc' })
}

/**
 * A line as it is drawn: the colour the whole file was read with where nobody
 * has touched it, and the line on its own where somebody has. Colouring a
 * megabyte again on every keystroke is tens of milliseconds; colouring the one
 * line that changed is none of them.
 */
function colouredAt(
  at: number,
  edit: Edited | null,
  viewing: PanelContext['viewing'],
  ctx: PanelContext,
): string {
  if (!edit) return (viewing?.formatted ?? viewing?.source ?? [])[at] ?? ''
  const from = edit.from[at] ?? -1
  if (from >= 0) return viewing?.source[from] ?? edit.lines[at] ?? ''
  return colouredLine(edit.lines[at] ?? '', viewing?.file.language ?? null, !ctx.skin.colour)
}

/** What is laid over a drawn line: the matches on it, and the caret if it is on it. */
interface Overlays {
  at: number
  line: string
  gutter: number
  left: number
  width: number
  matches: readonly Match[]
  current?: Match | undefined
  caret?: number
  caretCells?: number
  skin: Skin
}

/**
 * The matches and the caret, laid on the cells they are on — after the line is
 * drawn, as the lane's cursor is, because both sit on top of coloured text
 * rather than inside it.
 */
function laidOver(row: string, over: Overlays): string {
  const { skin } = over
  let out = row
  const lay = (cell: number, cells: number, paint: (text: string) => string) => {
    const from = over.gutter + cell - over.left
    if (cells <= 0 || from < over.gutter || from + cells > over.width) return
    const under = stripTerminalSequences(sliceByColumn(out, from, cells, true))
    // Half of a wide character is not a cell anything can be laid on, and a
    // paint that came back a different width would tear the row it is in.
    if (visibleWidth(under) > cells) return
    const painted = paint(under === '' ? ' '.repeat(cells) : under)
    if (visibleWidth(painted) !== cells) return
    out = compositeTuiLine(out, painted, from, cells, over.width)
  }
  for (const match of over.matches) {
    if (match.line !== over.at) continue
    const cell = cellOf(over.line, match.column)
    const cells = cellOf(over.line, match.column + match.length) - cell
    const on = over.current === match
    lay(cell, cells, (text) => skin.found(text, on))
  }
  if (over.caret !== undefined) lay(over.caret, over.caretCells ?? 1, skin.cursor)
  return out
}

/** The find bar, or the go-to-line bar: whichever is open, on one row. */
function fileBar(
  ask: FileAsk,
  matches: readonly Match[],
  inner: number,
  ctx: PanelContext,
): { text: string; hits: Hit[] } {
  const { skin } = ctx
  const control = (id: string) => ({ kind: 'control' as const, id })
  const row = new Row(inner, skin, ctx.pointer).space()
  if (ask.kind === 'goto') {
    return row
      .text('Go to line', skin.label)
      .space()
      .field(ask.digits, 12, { caret: true })
      .space(2)
      .text('enter goes · esc closes', skin.hint)
      .right((r) => r.button('Close', control('shut-bar')).space())
      .build()
  }
  const said =
    ask.query === ''
      ? ''
      : matches.length === 0
        ? 'none'
        : `${Math.min(ask.index + 1, matches.length)} of ${matches.length}`
  return row
    .text('Find', skin.label)
    .space()
    .field(ask.query, Math.min(40, Math.max(12, inner - 40)), { caret: true })
    .space(2)
    .text(said.padEnd(10), matches.length === 0 && ask.query ? skin.waiting : skin.hint)
    .right((r) =>
      r
        .button('↑', control('match-previous'), matches.length > 1 ? 'rest' : 'off')
        .button('↓', control('match-next'), matches.length > 1 ? 'rest' : 'off')
        .space()
        .button('Close', control('shut-bar'))
        .space(),
    )
    .build()
}

/** Columns a plain string takes. */
function visibleCells(text: string): number {
  return [...text].length
}

function keysSheet(ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(92, ctx.width - 4)
  const inner = width - 2
  const label = (text: string) =>
    new Row(inner, skin, ctx.pointer).space().text(pad(text, 26), skin.label)
  const talk = ctx.talkKey
  const rows: { text: string; hits: Hit[] }[] = [
    blank(inner),
    label('Push to talk')
      .keys(keyCaps(talk))
      .space(2)
      .text(ctx.releases && ctx.talkMode === 'hold' ? 'hold' : 'press, press again', skin.hint)
      .build(),
  ]
  // Every other key the window keeps, as it is set now.
  for (const binding of KEY_BINDINGS) {
    const bound = ctx.bindings[binding.key] ?? binding.fallback
    rows.push(
      label(binding.title).keys(keyCaps(bound)).space(2).text(binding.means, skin.hint).build(),
    )
  }
  rows.push(
    blank(inner),
    // Sending keeps the line, so say what leaves it: enter used to be both.
    label('On the orchestrator line')
      .keys(['↑'])
      .keys(['↓'])
      .space()
      .keys(['ctrl', 'r'])
      .space(2)
      .text('what you said before · esc leaves', skin.hint)
      .build(),
    label('In a panel')
      .keys(['enter'])
      .space()
      .keys(['esc'])
      .space()
      .keys(['↑'])
      .keys(['↓'])
      .space(2)
      .text('the wheel scrolls it', skin.hint)
      .build(),
    label('In a file you are reading')
      .keys(['ctrl', 'f'])
      .keys(['ctrl', 'g'])
      .keys(['ctrl', 's'])
      .space(2)
      .text('find · line · save', skin.hint)
      .build(),
    label('Quit').keys(['ctrl', 'c']).build(),
    blank(inner),
    new Row(inner, skin)
      .space()
      .text("Everything else goes to the agent or terminal you're typing at.", skin.hint)
      .build(),
    new Row(inner, skin, ctx.pointer)
      .right((r) => r.button('Change keys…', { kind: 'control', id: 'change-keys' }).space())
      .build(),
  )
  return box('Keys', rows, width, skin, { corner: 'esc' })
}

function quit(panel: QuitPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(62, ctx.width - 4)
  const inner = width - 2
  const pointer = ctx.pointer.hover
    ? ctx.pointer
    : { ...ctx.pointer, hover: { kind: 'control' as const, id: panel.field } }
  const row = () => new Row(inner, skin, pointer)
  const running = ctx.running
  const rows: { text: string; hits: Hit[] }[] = [
    blank(inner),
    row()
      .space()
      .text(
        `${running} agent${running === 1 ? ' is' : 's are'} running inside this window.`,
        skin.you,
      )
      .build(),
    blank(inner),
    row()
      .space()
      .text('Agents here run under ')
      .text('pty', skin.busy)
      .text(', so closing stops them. Their')
      .build(),
    row().space().text('conversations are kept, and they open again where they').build(),
    row().space().text('stopped the next time Tade opens.').build(),
    blank(inner),
    row().space().text('Under tmux they would keep working after you close.', skin.hint).build(),
    row()
      .space()
      .text('Settings › Agents › Where agents run', skin.link, { kind: 'control', id: 'where' })
      .build(),
    blank(inner),
    row()
      .right((r) =>
        r
          .button('Cancel', { kind: 'control', id: 'cancel' })
          .space()
          .button('Stop agents and close', { kind: 'control', id: 'quit' }, 'attention')
          .space(),
      )
      .build(),
  ]
  return box('Close Tade?', rows, width, skin, { corner: 'esc' })
}

function reload(panel: ReloadPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(62, ctx.width - 4)
  const inner = width - 2
  const pointer = ctx.pointer.hover
    ? ctx.pointer
    : { ...ctx.pointer, hover: { kind: 'control' as const, id: panel.field } }
  const row = () => new Row(inner, skin, pointer)
  const running = ctx.running
  const rows: { text: string; hits: Hit[] }[] = [
    blank(inner),
    row()
      .space()
      .text(
        `${running} agent${running === 1 ? ' is' : 's are'} running inside this window.`,
        skin.you,
      )
      .build(),
    blank(inner),
    row().space().text('Reload restarts the window with your changes.').build(),
    row()
      .space()
      .text('Agents here run under ')
      .text('pty', skin.busy)
      .text(', so reloading stops them. Their')
      .build(),
    row().space().text('conversations are kept, and they open again where they').build(),
    row().space().text('stopped the next time Tade opens.').build(),
    blank(inner),
    row()
      .right((r) =>
        r
          .button('Cancel', { kind: 'control', id: 'cancel' })
          .space()
          .button('Reload anyway', { kind: 'control', id: 'reload' }, 'attention')
          .space(),
      )
      .build(),
  ]
  return box('Reload Tade?', rows, width, skin, { corner: 'esc' })
}

function openProject(panel: OpenProjectPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(100, ctx.width - 4)
  const inner = width - 2
  const pointer =
    ctx.pointer.hover || (panel.field !== 'init' && panel.field !== 'name')
      ? ctx.pointer
      : { ...ctx.pointer, hover: { kind: 'control' as const, id: panel.field } }
  const row = () => new Row(inner, skin, pointer)
  const rows: { text: string; hits: Hit[] }[] = []
  const control = (id: string) => ({ kind: 'control' as const, id })

  // ── back, forward, up, where you are, and a field to narrow or jump ──
  const bar = row()
    .space()
    .button('‹', control('back'), panel.back.length > 0 ? 'rest' : 'off')
    .button('›', control('forward'), panel.forward.length > 0 ? 'rest' : 'off')
    .button('↑', control('up'), panel.dir !== '/' ? 'rest' : 'off')
    .space(2)
  const fieldWidth = Math.min(30, Math.max(16, Math.floor(inner / 3)))
  const crumbs = crumbsOf(ctx.browsing ?? panel.dir, ctx.homeDir)
  const room = inner - bar.used - fieldWidth - 3
  // The end of the path is where you are; the start is what gives way.
  let from = 0
  const widthFrom = (at: number) =>
    crumbs.slice(at).reduce((n, crumb) => n + crumb.label.length + 3, 0) + (at > 0 ? 2 : 0)
  while (from < crumbs.length - 1 && widthFrom(from) > room) from++
  if (from > 0) bar.text('… ', skin.hint)
  crumbs.slice(from).forEach((crumb, i, shown) => {
    const last = i === shown.length - 1
    bar.text(crumb.label, last ? skin.you : skin.busy, control(`go:${crumb.path}`))
    if (!last) bar.text(' / ', skin.hint)
  })
  bar.right((r) =>
    r
      .field(
        panel.query === '' && panel.field !== 'query' ? 'filter, or a path' : panel.query,
        fieldWidth,
        {
          caret: panel.field === 'query',
          hint: panel.query === '',
          target: control('query'),
        },
      )
      .space(),
  )
  rows.push(bar.build())
  rows.push(blank(inner))

  // ── recent projects on the left, this folder and its folders on the right ──
  const left = Math.min(30, Math.max(22, Math.floor(inner * 0.32)))
  const right = inner - left - 1
  const views = ctx.openRows.map((view, at) => ({ view, at }))
  const recent = views.filter(({ view }) => view.row.kind === 'recent')
  const here = views.filter(({ view }) => view.row.kind !== 'recent')
  // As tall as the window allows, whatever the folder holds: going into a
  // folder with fewer in it must not move the back button out from under you.
  const list = Math.max(6, Math.min(16, ctx.height - 18))

  const recentRows: { text: string; hits: Hit[] }[] = [
    new Row(left, skin).space().text('RECENT', skin.label).build(),
  ]
  for (const { view, at } of recent.slice(0, list - 1)) {
    const on = at === panel.index
    const r = new Row(left, skin)
      .text(on ? '▌' : ' ', skin.signal)
      .text(pad(view.row.name, 11), on ? skin.you : (t: string) => t)
      .text(tildeOf(view.row.path, ctx.homeDir), skin.hint)
    const built = r.build()
    recentRows.push({
      text: on ? skin.selected(built.text) : built.text,
      hits: [{ row: 0, from: 0, to: left - 1, target: control(`row:${at}`) }],
    })
  }
  if (recent.length === 0)
    recentRows.push(new Row(left, skin).space().text('none yet', skin.hint).build())

  const chosenAt = panel.index
  const start = Math.max(0, Math.min(chosenAt - (list - 2), here.length - (list - 1)))
  const folderRows: { text: string; hits: Hit[] }[] = []
  const nameWidth = Math.min(30, Math.max(16, ...here.map(({ view }) => view.row.name.length + 4)))
  for (const { view, at } of here.slice(start, start + list - 1)) {
    const on = at === panel.index
    const r = new Row(right, skin, pointer).text(on ? '▌' : ' ', skin.signal)
    if (view.row.kind === 'here') {
      r.text('◆ ', skin.signal).text(pad('this folder', nameWidth - 2), on ? skin.you : skin.label)
    } else {
      r.text('▸ ', skin.busy).text(
        pad(`${view.row.name}/`, nameWidth - 2),
        on ? skin.you : skin.busy,
      )
    }
    r.text(
      view.row.git ? `git · ${view.branch ?? '…'}` : 'no git',
      view.row.git ? skin.done : skin.hint,
    )
    const hits: Hit[] = [{ row: 0, from: 0, to: right - 1, target: control(`row:${at}`) }]
    if (view.row.kind === 'folder') {
      r.right((g) => g.text(' › ', skin.hint, control(`into:${at}`)).space())
    }
    const built = r.build()
    hits.push(...built.hits)
    folderRows.push({ text: on ? skin.selected(built.text) : built.text, hits })
  }
  if (here.length <= 1)
    folderRows.push(
      new Row(right, skin)
        .space(3)
        .text(panel.query ? 'no folder like that here' : 'no folders here', skin.hint)
        .build(),
    )
  const more = here.length - (start + list - 1)
  const listRows = Math.max(recentRows.length, list)
  for (let i = 0; i < listRows; i++) {
    const l = recentRows[i] ?? blank(left)
    const rr =
      i === list - 1 && more > 0
        ? new Row(right, skin)
            .space(3)
            .text(`${more} more — scroll, or type to narrow`, skin.hint)
            .build()
        : (folderRows[i] ?? blank(right))
    rows.push({
      text: `${fitRow(l.text, left)}${skin.chrome('│')}${fitRow(rr.text, right)}`,
      hits: [
        { row: 0, from: 0, to: inner - 1, target: { kind: 'scroll', area: 'panel' } },
        ...l.hits,
        ...rr.hits.map((hit) => ({ ...hit, from: hit.from + left + 1, to: hit.to + left + 1 })),
      ],
    })
  }
  rows.push(blank(inner))

  // Always the same height, said or not: a panel that grew when a folder was
  // chosen would move under the pointer, and the second click would land on
  // the folder below the one you meant.
  const chosen = ctx.openRows[panel.index]?.row
  const notice: { text: string; hits: Hit[] }[] = []
  if (panel.error) {
    notice.push(row().space().text(`▲ ${panel.error}`, skin.waiting).build())
  } else if (chosen && !chosen.git) {
    notice.push(
      row()
        .space()
        .text('▲ ', skin.waiting)
        .text(
          `${chosen.kind === 'here' ? 'This folder' : chosen.name} isn't a git repository. Agents work in git worktrees,`,
        )
        .build(),
    )
    notice.push(row().space(3).text('so Tade needs one before it can start work there.').build())
    notice.push(
      row()
        .space(3)
        .check(panel.init, "git init, and commit what's there as the first commit", control('init'))
        .build(),
    )
  }
  for (let i = 0; i < 4; i++) rows.push(notice[i] ?? blank(inner))

  const known = chosen?.kind === 'recent'
  const name = known ? chosen.name : (panel.name ?? (chosen ? nameFrom(chosen.path) : ''))
  const label = panel.busy
    ? 'Opening…'
    : !chosen
      ? 'Choose a folder'
      : known
        ? `Go to ${chosen.name}`
        : `Open ${tildeOf(chosen.path, ctx.homeDir)}`
  rows.push(
    row()
      .space()
      .text('Name  ', skin.hint)
      .field(chosen ? name : '', 24, {
        caret: panel.field === 'name' && !known,
        hint: known || !chosen,
        target: control('name'),
      })
      .right((r) =>
        r
          .button('Cancel', control('cancel'))
          .space()
          .button(
            label.length > 34 ? `${label.slice(0, 33)}…` : label,
            control('open'),
            panel.busy || !chosen || (!chosen.git && !panel.init) ? 'off' : 'primary',
          )
          .space(),
      )
      .build(),
  )
  rows.push(
    row()
      .space()
      .text('click to choose · click again or → to go in · ← up · enter opens', skin.hint)
      .build(),
  )
  return box('Open a project', rows, width, skin, { corner: 'esc' })
}

/** `/Users/me/src/pay` as the parts you can click back to: `~`, `src`, `pay`. */
function crumbsOf(dir: string, home: string): { label: string; path: string }[] {
  const typed = tildeOf(dir, home)
  if (typed.startsWith('~')) {
    const parts = typed.slice(1).split('/').filter(Boolean)
    return [
      { label: '~', path: home },
      ...parts.map((label, i) => ({ label, path: `${home}/${parts.slice(0, i + 1).join('/')}` })),
    ]
  }
  const parts = dir.split('/').filter(Boolean)
  return [
    { label: '/', path: '/' },
    ...parts.map((label, i) => ({ label, path: `/${parts.slice(0, i + 1).join('/')}` })),
  ]
}

function tildeOf(path: string, home: string): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

// ── Settings ────────────────────────────────────────────────────────────────

const CHOICE_LABELS: Record<string, string> = {
  hold: 'Hold to talk',
  toggle: 'Press to start, press to stop',
}

const SIDE = 24
const LABEL = 18

function settings(panel: SettingsPanel, ctx: PanelContext): PanelDrawing {
  const { skin } = ctx
  const width = Math.min(104, ctx.width - 6)
  const height = Math.max(14, Math.min(28, ctx.height - 4))
  const inner = width - 2
  const form = inner - SIDE - 1
  const pointer = ctx.pointer

  // ── the side: search, then categories ──
  const side: { text: string; hits: Hit[] }[] = []
  side.push(
    new Row(SIDE, skin, pointer)
      .space()
      .field(panel.search, SIDE - 2, {
        caret: panel.focus === 'search',
        hint: panel.search === '' && panel.focus !== 'search',
        target: { kind: 'control', id: 'search' },
      })
      .build(),
  )
  if (panel.search === '' && panel.focus !== 'search') {
    // The field says what it is for until you use it.
    side[0] = new Row(SIDE, skin, pointer)
      .space()
      .field('search settings', SIDE - 2, { hint: true, target: { kind: 'control', id: 'search' } })
      .build()
  }
  side.push({ text: ' '.repeat(SIDE), hits: [] })
  const categories = [
    ...ctx.settings.map((group) => ({ id: group.id, title: group.title })),
    { id: ACCOUNTS, title: 'Accounts' },
  ]
  for (const category of categories) {
    const on = panel.search === '' && panel.category === category.id
    const target = { kind: 'control' as const, id: `category:${category.id}` }
    const row = new Row(SIDE, skin, pointer)
      .text(on ? '▌' : ' ', skin.signal, target)
      .space()
      .text(category.title, on ? skin.you : (t: string) => t, target)
    row.right((r) => {
      const badge = badgeFor(category.id, ctx)
      if (badge) badge(r)
      r.space()
    })
    const built = row.build()
    side.push({
      text: on ? skin.selected(built.text) : built.text,
      hits: [{ row: 0, from: 0, to: SIDE - 1, target }],
    })
  }

  // ── the form ──
  const main: { text: string; hits: Hit[] }[] = []
  const group = ctx.settings.find((g) => g.id === panel.category)
  const title = panel.search
    ? `Matching “${panel.search}”`
    : panel.category === ACCOUNTS
      ? 'Accounts'
      : (group?.title ?? '')
  const about = panel.search
    ? 'Every setting whose name or meaning has those words.'
    : panel.category === ACCOUNTS
      ? 'The providers pi can think with. Signing in happens in pi, inside this window.'
      : (group?.about ?? '')
  main.push(new Row(form, skin).space().text(title, skin.brand).build())
  main.push(new Row(form, skin).space().text(about, skin.hint).build())
  main.push({ text: ' '.repeat(form), hits: [] })

  const popups: PanelDrawing['popups'] = []
  if (panel.category === ACCOUNTS && !panel.search) {
    for (const provider of ctx.accounts) {
      main.push(
        new Row(form, skin)
          .space()
          .text(pad(provider, LABEL))
          .text('● signed in', skin.done)
          .build(),
      )
    }
    if (ctx.accounts.length === 0)
      main.push(
        new Row(form, skin).space().text('Not signed in to anything yet.', skin.hint).build(),
      )
    main.push({ text: ' '.repeat(form), hits: [] })
    main.push(
      new Row(form, skin, withFocus(pointer, panel.focus === 'form' ? 'sign-in' : null))
        .space()
        .button('Sign in to a provider…', { kind: 'control', id: 'sign-in' }, 'primary')
        .build(),
    )
  } else {
    const rows = visibleSettings(panel, ctx.settings)
    if (rows.length === 0)
      main.push(new Row(form, skin).space().text('Nothing here matches.', skin.hint).build())
    rows.forEach((setting, at) => {
      const focused = panel.focus === 'form' && at === panel.row
      const line = new Row(form, skin, focused ? withFocus(pointer, controlOf(setting)) : pointer)
      line.text(focused ? '▌' : ' ', skin.signal, { kind: 'control', id: `row:${setting.path}` })
      line.text(pad(setting.title, LABEL), focused ? skin.you : (t: string) => t, {
        kind: 'control',
        id: `row:${setting.path}`,
      })
      const controlCol = line.used
      control(line, setting, panel, ctx)
      if (!setting.live) line.right((r) => r.text('↻ on restart', skin.hint).space())
      main.push(line.build())
      if (setting.path === 'surfaces.voice.mic.device') {
        // Trying it is the only way to know the terminal may use it.
        const meter = new Row(form, skin, pointer).space(1 + LABEL)
        const cells = 14
        const heard = ctx.levels.slice(-cells)
        const bars = '▁▂▃▄▅▆▇█'
        meter.text(
          heard.map((level) => bars[Math.max(0, Math.min(7, Math.round(level * 7)))]).join(''),
          skin.busy,
        )
        meter.text('▁'.repeat(cells - heard.length), skin.chrome).space(2)
        meter.button(
          panel.testing ? 'Listening…' : 'Test',
          { kind: 'control', id: 'mic-test' },
          panel.testing ? 'off' : 'rest',
        )
        main.push(meter.build())
      }
      if (panel.dropdown?.path === setting.path) {
        popups.push({
          drawn: settingsDropdown(panel, setting, ctx),
          row: 1 + main.length,
          col: 1 + SIDE + 1 + controlCol,
        })
      }
      // The sentence under a setting, for the one you are on, and what the
      // terminal allows for the talk key, which is not something to guess.
      const roomy =
        setting.type.kind === 'key' ||
        setting.type.kind === 'model' ||
        setting.type.kind === 'choice'
      const listOpen = panel.dropdown?.path === setting.path
      if (!listOpen && (focused || (setting.type.kind === 'key' && panel.search === ''))) {
        const note =
          setting.type.kind === 'key'
            ? ctx.releases
              ? {
                  mark: '✓',
                  text: 'Hold works here: this terminal reports releases.',
                  tone: skin.done,
                }
              : {
                  mark: '▲',
                  text: "This terminal can't report releases, so talking toggles.",
                  tone: skin.waiting,
                }
            : { mark: '', text: setting.means, tone: skin.hint }
        const r = new Row(form, skin).space(1 + LABEL)
        if (note.mark) r.text(note.mark, note.tone).space()
        r.text(note.text, skin.hint)
        main.push(r.build())
      }
      // Settings that say more than one line's worth stand apart; plain ones stack.
      if (roomy && at < rows.length - 1) main.push({ text: ' '.repeat(form), hits: [] })
    })
  }

  // ── the foot of the form ──
  const foot = new Row(form, skin, pointer).space()
  if (panel.error) foot.text(`▲ ${panel.error}`, skin.waiting)
  else if (panel.saved) foot.text('● ', skin.done).text(panel.saved, skin.hint)
  else foot.text('● ', skin.done).text('Saved as you change it.', skin.hint)
  const buttons = new Row(form, skin, pointer).right((r) =>
    r
      .button('Open config.yaml', { kind: 'control', id: 'open-file' })
      .space()
      .button('Done', { kind: 'control', id: 'done' }, 'primary')
      .space(),
  )

  const body = height - 2
  const lines: { text: string; hits: Hit[] }[] = []
  for (let i = 0; i < body; i++) {
    const left = side[i] ?? { text: ' '.repeat(SIDE), hits: [] }
    let right = main[i] ?? { text: ' '.repeat(form), hits: [] }
    if (i === body - 2) right = foot.build()
    if (i === body - 1) right = buttons.build()
    lines.push({
      text: `${fitTo(left.text, SIDE)}${skin.chrome('│')}${fitTo(right.text, form)}`,
      hits: [
        ...left.hits,
        ...right.hits.map((hit) => ({ ...hit, from: hit.from + SIDE + 1, to: hit.to + SIDE + 1 })),
      ],
    })
  }

  if (panel.capture) {
    popups.push({
      drawn: capture(panel, ctx),
      row: 3,
      col: Math.max(2, Math.floor((width - 62) / 2)),
    })
  }
  return {
    panel: box('Settings', lines, width, skin, { corner: `${ctx.configPath} · esc` }),
    popups,
  }
}

/** The control on the right of a setting, drawn for its kind. */
function control(row: Row, setting: Setting, panel: SettingsPanel, ctx: PanelContext): void {
  const { skin } = ctx
  const type = setting.type
  const value = setting.value
  switch (type.kind) {
    case 'key':
      row.keys(keyCaps(value || setting.fallback)).space(3)
      row.button('Change…', { kind: 'control', id: `capture:${setting.path}` })
      return
    case 'flag':
      row.toggle((value || setting.fallback) === 'true', {
        kind: 'control',
        id: `toggle:${setting.path}`,
      })
      return
    case 'number': {
      if (panel.editing?.path === setting.path) {
        row.field(panel.editing.text, 10, {
          caret: true,
          target: { kind: 'control', id: `edit:${setting.path}` },
        })
        return
      }
      row
        .text(skin.colour ? ' ‹ ' : '[-]', skin.signal, {
          kind: 'control',
          id: `step:${setting.path}=-1`,
        })
        .text(` ${value || setting.fallback} `, value ? skin.you : skin.hint, {
          kind: 'control',
          id: `edit:${setting.path}`,
        })
        .text(skin.colour ? ' › ' : '[+]', skin.signal, {
          kind: 'control',
          id: `step:${setting.path}=1`,
        })
      if (type.unit) row.space(2).text(type.unit, skin.hint)
      return
    }
    case 'hours': {
      const target = { kind: 'control' as const, id: `edit:${setting.path}` }
      if (panel.editing?.path === setting.path) {
        row.field(panel.editing.text, 16, { caret: true, target })
        row.space(2).text('like 22:00-07:00', skin.hint)
        return
      }
      const [from, to] = value.split('-')
      if (!value || !from || !to) {
        row.field('none', 9, { hint: true, target })
        return
      }
      row.field(from, 9, { target }).space().text('to', skin.hint).space().field(to, 9, { target })
      return
    }
    case 'text':
      if (panel.editing?.path === setting.path) {
        row.field(panel.editing.text, 40, {
          caret: true,
          target: { kind: 'control', id: `edit:${setting.path}` },
        })
      } else {
        row.field(value || setting.fallback, 40, {
          hint: !value,
          target: { kind: 'control', id: `edit:${setting.path}` },
        })
      }
      return
    case 'model':
    case 'choice':
      if (usesDropdown(setting)) {
        const shown =
          type.kind === 'choice'
            ? (type.about?.[value || setting.fallback]?.label ?? (value || setting.fallback))
            : value || setting.fallback
        row.field(shown, 40, {
          arrow: true,
          hint: !value,
          target: { kind: 'control', id: `drop:${setting.path}` },
        })
        return
      }
      if (type.kind === 'choice') {
        type.options.forEach((option, i) => {
          if (i > 0) row.space(3)
          row.radio((value || setting.fallback) === option, CHOICE_LABELS[option] ?? option, {
            kind: 'control',
            id: `set:${setting.path}=${option}`,
          })
        })
      }
      return
  }
}

/** The control the keyboard would operate, so it looks the part. */
function controlOf(setting: Setting): string | null {
  switch (setting.type.kind) {
    case 'key':
      return `capture:${setting.path}`
    case 'flag':
      return `toggle:${setting.path}`
    case 'text':
    case 'hours':
      return `edit:${setting.path}`
    default:
      return usesDropdown(setting) ? `drop:${setting.path}` : null
  }
}

function withFocus(pointer: Pointer, id: string | null): Pointer {
  if (!id || pointer.hover) return pointer
  return { ...pointer, hover: { kind: 'control', id } }
}

/** A badge beside a category, when something there is worth a look. */
function badgeFor(id: string, ctx: PanelContext): ((row: Row) => void) | null {
  const { skin } = ctx
  if (id === 'approvals') {
    const mode = ctx.settings.find((g) => g.id === 'approvals')?.settings[0]?.value
    return mode ? (row) => row.text(mode, skin.hint) : null
  }
  if (id === 'projects') {
    const count = ctx.settings.find((g) => g.id === 'budgets')?.settings.length ?? 0
    return count > 0 ? (row) => row.badge(count) : null
  }
  if (id === 'budgets' && ctx.budgetWarnings > 0)
    return (row) => row.text(`● ${ctx.budgetWarnings}`, skin.waiting)
  if (id === ACCOUNTS && ctx.accounts.length > 0)
    return (row) => row.text(`● ${ctx.accounts.length}`, skin.done)
  return null
}

/** A setting's list, opened under it: grouped, narrowed by typing, the current one ticked. */
function settingsDropdown(panel: SettingsPanel, setting: Setting, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = 46
  const inner = width - 2
  const query = panel.dropdown?.query ?? ''
  const found = matchingChoices(choicesFor(setting, ctx.choices), query)
  const rows: { text: string; hits: Hit[] }[] = [
    new Row(inner, skin)
      .space()
      .field(query, inner - 2, { caret: true })
      .build(),
  ]
  let group = ''
  found.slice(0, 12).forEach((choice, index) => {
    if (
      choice.group !== group &&
      (setting.type.kind === 'model' || (setting.type.kind === 'choice' && setting.type.about))
    ) {
      group = choice.group
      // What a group needs is said once, at its heading: every option under it shares it.
      const note = choice.note
      const heading = new Row(inner, skin).space().text(group.toUpperCase(), skin.label)
      if (note) heading.right((r) => r.text(note, skin.hint).space())
      rows.push(heading.build())
    }
    const on = index === (panel.dropdown?.index ?? 0)
    const target = { kind: 'control' as const, id: `choose:${choice.value}` }
    const r = new Row(inner, skin)
      .text(on ? '▌' : ' ', skin.signal)
      .space()
      .text(choice.label, on ? skin.you : (t: string) => t)
    r.right((right) => {
      right
        .text(choice.value === (setting.value || setting.fallback) ? '✓' : ' ', skin.done)
        .space()
    })
    const built = r.build()
    rows.push({
      text: on ? skin.selected(built.text) : built.text,
      hits: [{ row: 0, from: 0, to: inner - 1, target }],
    })
  })
  if (found.length === 0)
    rows.push(new Row(inner, skin).space().text('Nothing matches that.', skin.hint).build())
  return box('', rows, width, skin, { corner: '▴' })
}

/** Press the keys you want to hold to talk. */
function capture(panel: SettingsPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = 62
  const inner = width - 2
  const pressed = panel.capture?.key ?? null
  const setting = ctx.settings
    .flatMap((group) => group.settings)
    .find((one) => one.path === panel.capture?.path)
  const talking = panel.capture?.path === 'surfaces.voice.talk.key'
  const printable = setting?.type.kind === 'key' && setting.type.printable === true
  const check = pressed ? checkTalkKey(pressed, printable) : null
  const row = () => new Row(inner, skin, ctx.pointer)
  const rows: { text: string; hits: Hit[] }[] = [
    { text: ' '.repeat(inner), hits: [] },
    row()
      .right((r) =>
        r
          .text(
            talking
              ? 'Press the keys you want to hold to talk.'
              : `Press the keys for ${setting?.title ?? 'this'}.`,
            skin.you,
          )
          .space(8),
      )
      .build(),
    { text: ' '.repeat(inner), hits: [] },
  ]
  const caps = row()
  if (pressed) {
    const width =
      keyCaps(pressed).reduce((sum, k) => sum + k.length + 4, 0) + keyCaps(pressed).length - 1
    caps.space(Math.max(1, Math.floor((inner - width) / 2))).keys(keyCaps(pressed))
  } else {
    caps.space(Math.floor((inner - 13) / 2)).text('waiting for a key', skin.hint)
  }
  rows.push(caps.build())
  rows.push({ text: ' '.repeat(inner), hits: [] })
  if (check && !check.ok) {
    rows.push(row().space().text(`▲ ${check.reason}`, skin.bad).build())
  } else if (check?.ok && check.warning) {
    const [first, ...rest] = check.warning.split('. ')
    rows.push(row().space().text(`▲ ${first}.`, skin.waiting).build())
    if (rest.length > 0) rows.push(row().space(3).text(rest.join('. '), skin.hint).build())
  } else if (check?.ok) {
    rows.push(row().space().text('✓ Nothing in pi or your shell uses this.', skin.done).build())
  } else {
    rows.push({ text: ' '.repeat(inner), hits: [] })
  }
  rows.push({ text: ' '.repeat(inner), hits: [] })
  const suggested = row().space().text('Suggested: ', skin.hint)
  TALK_SUGGESTIONS.forEach((key, i) => {
    if (i > 0) suggested.space()
    const at = suggested.used
    suggested.keys(keyCaps(key))
    void at
  })
  const built = suggested.build()
  // Each suggestion is a click that picks it.
  let col = 12
  const hits: Hit[] = []
  for (const key of TALK_SUGGESTIONS) {
    const w = keyCaps(key).reduce((sum, k) => sum + k.length + 4, 0) + keyCaps(key).length - 1
    hits.push({
      row: 0,
      from: col,
      to: col + w - 1,
      target: { kind: 'control', id: `capture-suggest:${key}` },
    })
    col += w + 1
  }
  rows.push({ text: built.text, hits })
  rows.push(
    row().space().text('Never a key that types a character — you have to be', skin.hint).build(),
  )
  rows.push(row().space().text('able to type a space into your agent.', skin.hint).build())
  rows.push({ text: ' '.repeat(inner), hits: [] })
  const usable = check?.ok === true
  rows.push(
    row()
      .right((r) =>
        r
          .button(usable ? 'Try another' : 'Cancel', { kind: 'control', id: 'capture-cancel' })
          .space()
          .button(
            usable && pressed
              ? check.warning
                ? `Use ${pressed} anyway`
                : `Use ${pressed}`
              : 'Use it',
            { kind: 'control', id: 'capture-use' },
            usable ? (check.warning ? 'attention' : 'primary') : 'off',
          )
          .space(),
      )
      .build(),
  )
  return box(talking ? 'Push to talk' : (setting?.title ?? 'Key'), rows, width, skin, {
    corner: 'esc',
  })
}

function fitTo(text: string, width: number): string {
  return fitRow(text, width)
}

function menu(panel: MenuPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  // As wide as its longest item and what is said beside it, within reason.
  const width = Math.min(
    46,
    Math.max(
      30,
      panel.title.length + 8,
      ...ctx.items.map((item) => item.label.length + (item.off ?? item.note ?? '').length + 6),
    ),
  )
  const inner = width - 2
  const rows: { text: string; hits: Hit[] }[] = []
  ctx.items.forEach((item, at) => {
    if (item.divider) rows.push({ text: skin.chrome('─'.repeat(inner)), hits: [] })
    const target = { kind: 'control' as const, id: `item:${item.id}` }
    const on =
      at === panel.index ||
      (ctx.pointer.hover?.kind === 'control' && ctx.pointer.hover.id === target.id)
    const row = new Row(inner, skin).text(on && !item.off ? '▌' : ' ', skin.signal).space()
    const paint = item.off ? skin.faded : item.danger ? skin.bad : on ? skin.you : (t: string) => t
    row.text(item.label, paint, item.off ? undefined : target)
    const note = item.off ?? item.note
    if (note) row.right((r) => r.text(note, skin.hint).space())
    const built = row.build()
    rows.push({
      text: on && !item.off ? skin.selected(built.text) : built.text,
      hits: built.hits.map((hit) => ({ ...hit, from: 0, to: inner - 1 })),
    })
  })
  return box(panel.title, rows, width, skin)
}

/** One line asked for: a note, with whether it is about everything, or a branch name. */
function prompt(panel: PromptPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(72, ctx.width - 4)
  const inner = width - 2
  const row = () => new Row(inner, skin, ctx.pointer)
  const rows: { text: string; hits: Hit[] }[] = [
    blank(inner),
    row().space().text(panel.label, skin.label).build(),
    row()
      .space()
      .field(panel.text, inner - 2, { caret: true })
      .build(),
  ]
  // A field shows the end of what is typed; a note is read whole, under it.
  const aNote = panel.purpose === 'note' || panel.purpose === 'edit-note'
  if (aNote && visibleWidth(panel.text) > inner - 5) {
    for (const line of wrapTextWithAnsi(panel.text, inner - 3).slice(0, 8)) {
      rows.push(row().space(2).text(line, skin.hint).build())
    }
  }
  if (panel.purpose === 'note') {
    rows.push(blank(inner))
    rows.push(
      row()
        .space()
        .radio(!panel.everywhere, `About ${ctx.project ?? 'this project'}`, {
          kind: 'control',
          id: 'everywhere',
        })
        .space(3)
        .radio(panel.everywhere, 'About everything', { kind: 'control', id: 'everywhere' })
        .build(),
    )
    rows.push(
      row()
        .space()
        .text('Kept word for word. Saying "remember …" to Tade does the same.', skin.hint)
        .build(),
    )
  }
  rows.push(
    panel.error ? row().space().text(`▲ ${panel.error}`, skin.waiting).build() : blank(inner),
  )
  rows.push(
    row()
      .right((r) =>
        r
          .button('Cancel', { kind: 'control', id: 'cancel' })
          .space()
          .button(
            panel.busy ? 'Saving…' : aNote ? 'Save note ⏎' : 'Save ⏎',
            { kind: 'control', id: 'save' },
            panel.busy ? 'off' : 'primary',
          )
          .space(),
      )
      .build(),
  )
  return box(panel.title, rows, width, skin, { corner: 'esc' })
}

/** The project's branches, narrowed by typing, with a new one offered for a name nobody has. */
function branches(panel: BranchPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(72, ctx.width - 4)
  const inner = width - 2
  const choices = branchChoices(ctx.branches, panel.query)
  const room = Math.max(4, Math.min(40, ctx.height - 12))
  const rows: { text: string; hits: Hit[] }[] = [
    new Row(inner, skin)
      .space()
      .field(panel.query, inner - 2, { caret: true })
      .build(),
    new Row(inner, skin)
      .space()
      .text(`on ${ctx.checkout ?? 'no branch'} now`, skin.hint)
      .build(),
    blank(inner),
  ]
  const start = Math.max(0, Math.min(panel.index - room + 1, choices.length - room))
  choices.slice(start, start + room).forEach((choice, offset) => {
    const at = start + offset
    const on = at === panel.index
    const r = new Row(inner, skin).text(on ? '▌' : ' ', skin.signal).space()
    if (choice.create) {
      r.text('+ ', skin.signal)
        .text('Create ', on ? skin.you : (t: string) => t)
        .text(choice.name, skin.busy)
    } else {
      r.text(choice.row?.current ? '● ' : '  ', skin.done).text(
        choice.name,
        on ? skin.you : skin.busy,
      )
      const when = choice.row?.when ?? ''
      r.right((g) => g.text(choice.row?.current ? 'current' : when, skin.hint).space())
    }
    const built = r.build()
    rows.push({
      text: on ? skin.selected(built.text) : built.text,
      hits: [{ row: 0, from: 0, to: inner - 1, target: { kind: 'control', id: `row:${at}` } }],
    })
  })
  if (choices.length === 0)
    rows.push(new Row(inner, skin).space().text('No branch like that.', skin.hint).build())
  for (let gap = room - Math.min(room, Math.max(1, choices.length)); gap > 0; gap--)
    rows.push(blank(inner))
  rows.push(
    panel.error
      ? new Row(inner, skin).space().text(`▲ ${panel.error}`, skin.waiting).build()
      : blank(inner),
  )
  rows.push(
    new Row(inner, skin, ctx.pointer)
      .space()
      .text(
        panel.busy ? 'Switching…' : '↑↓ choose · enter switches · a new name creates it',
        skin.hint,
      )
      .right((r) => r.button('Cancel', { kind: 'control', id: 'cancel' }).space())
      .build(),
  )
  return box('Switch branch', rows, width, skin, { corner: 'esc' })
}

/** Finding in a terminal: the box, how many, and older and newer. */
function find(panel: FindPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(58, ctx.width - 4)
  const inner = width - 2
  const count = ctx.found
  const said =
    panel.query === ''
      ? ''
      : count === 0
        ? 'none'
        : `${Math.min(panel.index + 1, count)} of ${count}`
  const row = new Row(inner, skin, ctx.pointer)
    .space()
    .field(panel.query, inner - 22, { caret: true })
    .space()
    .text(said.padEnd(9), count === 0 && panel.query ? skin.waiting : skin.hint)
    .button('↑', { kind: 'control', id: 'older' }, count > 1 ? 'rest' : 'off')
    .button('↓', { kind: 'control', id: 'newer' }, count > 1 ? 'rest' : 'off')
  return box(`Find in ${ctx.terminalName}`, [row.build()], width, skin, { corner: 'esc' })
}

/** Throwing a file's uncommitted changes away, asked first. */
function confirm(panel: ConfirmPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(66, ctx.width - 4)
  const inner = width - 2
  const pointer = ctx.pointer.hover
    ? ctx.pointer
    : { ...ctx.pointer, hover: { kind: 'control' as const, id: panel.field } }
  const row = () => new Row(inner, skin, pointer)
  const rows: { text: string; hits: Hit[] }[] = [
    blank(inner),
    row().space().text(panel.path, skin.you).build(),
    blank(inner),
    row().space().text('Its uncommitted changes go back to the last commit. A file').build(),
    row().space().text('nobody has committed yet is deleted. This cannot be undone.').build(),
    panel.error ? row().space().text(`▲ ${panel.error}`, skin.waiting).build() : blank(inner),
    row()
      .right((r) =>
        r
          .button('Keep them', { kind: 'control', id: 'keep' })
          .space()
          .button(
            panel.busy ? 'Discarding…' : 'Discard',
            { kind: 'control', id: 'remove' },
            panel.busy ? 'off' : 'danger',
          )
          .space(),
      )
      .build(),
  ]
  return box('Discard changes?', rows, width, skin, { corner: 'esc' })
}

function confirmRemove(panel: ConfirmRemovePanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(66, ctx.width - 4)
  const inner = width - 2
  const pointer = ctx.pointer.hover
    ? ctx.pointer
    : { ...ctx.pointer, hover: { kind: 'control' as const, id: panel.field } }
  const row = () => new Row(inner, skin, pointer)
  const name = panel.task.split('/').at(-1) ?? panel.task
  const rows: { text: string; hits: Hit[] }[] = [blank(inner)]

  const unmerged = ctx.changes.length > 0 || (ctx.ahead ?? 0) > 0
  if (unmerged) {
    rows.push(row().space().text("Its worktree has work that isn't merged:").build())
    for (const change of ctx.changes.slice(0, 6)) {
      const tone =
        change.mark === 'A' || change.mark === '?'
          ? skin.done
          : change.mark === 'D'
            ? skin.bad
            : skin.waiting
      rows.push(row().space(3).text(change.mark, tone).space().text(change.path).build())
    }
    if (ctx.changes.length > 6)
      rows.push(
        row()
          .space(5)
          .text(`and ${ctx.changes.length - 6} more`, skin.hint)
          .build(),
      )
    if ((ctx.ahead ?? 0) > 0 && ctx.branch) {
      const commits = `${ctx.ahead} commit${ctx.ahead === 1 ? '' : 's'}`
      rows.push(
        row()
          .space(3)
          .text(
            `${commits} on ${ctx.branch} that ${ctx.base ?? 'its base'} doesn't have`,
            skin.hint,
          )
          .build(),
      )
    }
  } else {
    rows.push(row().space().text('Nothing in it is unmerged.').build())
  }
  rows.push(blank(inner))
  rows.push(row().space().text("Removing deletes the worktree and the branch. The agent's").build())
  rows.push(row().space().text("conversation stays in pi's sessions.").build())
  rows.push(
    panel.error ? row().space().text(`▲ ${panel.error}`, skin.waiting).build() : blank(inner),
  )
  rows.push(
    row()
      .right((r) =>
        r
          .button('Keep it', { kind: 'control', id: 'keep' })
          .space()
          .button(
            panel.busy ? 'Removing…' : unmerged ? 'Remove anyway' : 'Remove',
            { kind: 'control', id: 'remove' },
            panel.busy ? 'off' : 'danger',
          )
          .space(),
      )
      .build(),
  )
  return box(`Remove ${name}?`, rows, width, skin, { corner: 'esc' })
}

/**
 * Closing every agent that has finished, asked first: what it would close, by
 * name, so a list that is longer than you thought is still your decision.
 */
function closeDone(panel: CloseDonePanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(66, ctx.width - 4)
  const inner = width - 2
  const pointer = ctx.pointer.hover
    ? ctx.pointer
    : { ...ctx.pointer, hover: { kind: 'control' as const, id: panel.field } }
  const row = () => new Row(inner, skin, pointer)
  const count = panel.tasks.length
  const rows: { text: string; hits: Hit[] }[] = [blank(inner)]
  for (const task of panel.tasks.slice(0, 6)) {
    rows.push(
      row()
        .space(3)
        .text('✓', skin.done)
        .space()
        .text(task.split('/').at(-1) ?? task)
        .build(),
    )
  }
  if (count > 6)
    rows.push(
      row()
        .space(5)
        .text(`and ${count - 6} more`, skin.hint)
        .build(),
    )
  rows.push(blank(inner))
  rows.push(row().space().text('Each is stopped and taken off the list, its worktree and').build())
  rows.push(
    row().space().text("branch with it. Their conversations stay in pi's sessions.").build(),
  )
  rows.push(
    panel.error ? row().space().text(`▲ ${panel.error}`, skin.waiting).build() : blank(inner),
  )
  rows.push(
    row()
      .right((r) =>
        r
          .button('Keep them', { kind: 'control', id: 'keep' })
          .space()
          .button(
            panel.busy ? 'Closing…' : `Close ${count}`,
            { kind: 'control', id: 'remove' },
            panel.busy ? 'off' : 'danger',
          )
          .space(),
      )
      .build(),
  )
  return box(`Close ${count} finished agent${count === 1 ? '' : 's'}?`, rows, width, skin, {
    corner: 'esc',
  })
}

function diff(panel: DiffPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(96, ctx.width - 4)
  const inner = width - 2
  const row = () => new Row(inner, skin, ctx.pointer)
  const path = panel.files[panel.file] ?? ''
  const name = panel.task.split('/').at(-1) ?? panel.task
  const room = Math.max(6, Math.min(24, ctx.height - 10))
  const rows: { text: string; hits: Hit[] }[] = []
  const parsed = ctx.diff

  if (!parsed) {
    rows.push(row().space().text('reading the diff…', skin.hint).build())
  } else if (parsed.binary) {
    rows.push(row().space().text('A binary file: there are no lines to show.', skin.hint).build())
  } else if (parsed.lines.length === 0) {
    rows.push(row().space().text('No differences from where the task branched.', skin.hint).build())
  } else {
    const numberWidth = String(
      Math.max(...parsed.lines.map((line) => line.new ?? line.old ?? 0)),
    ).length
    const scroll = Math.min(panel.scroll, Math.max(0, parsed.lines.length - room))
    for (const line of parsed.lines.slice(scroll, scroll + room)) {
      const r = row().space()
      if (line.kind === 'hunk') {
        r.text(line.text, skin.hint)
      } else {
        const number = String((line.kind === 'remove' ? line.old : line.new) ?? '').padStart(
          numberWidth,
        )
        r.text(number, skin.hint).space()
        const sign = line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '
        const tone =
          line.kind === 'add' ? skin.done : line.kind === 'remove' ? skin.bad : (t: string) => t
        r.text(`${sign}${line.text}`, tone)
      }
      rows.push(r.build())
    }
  }
  while (rows.length < Math.min(room, 4)) rows.push(blank(inner))
  rows.push(blank(inner))
  rows.push(
    row()
      .space()
      .button('Open in editor', { kind: 'control', id: 'editor' })
      .space()
      .button('Ask the agent about this', { kind: 'control', id: 'ask' })
      .right((r) => {
        if (panel.files.length > 1) {
          r.text('‹', skin.signal, { kind: 'control', id: 'prev-file' })
            .text(` ${panel.file + 1}/${panel.files.length} `, skin.hint)
            .text('›', skin.signal, { kind: 'control', id: 'next-file' })
            .space(2)
        }
        r.text('↑↓ scroll · ←→ file', skin.hint).space()
      })
      .build(),
  )
  const counts =
    parsed && !parsed.binary
      ? `${skin.done(`+${parsed.added}`)} ${skin.bad(`−${parsed.removed}`)} `
      : ''
  return box(`${path} · ${name}`, rows, width, skin, { corner: `${counts}esc` })
}

function spend(panel: SpendPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(74, ctx.width - 4)
  const inner = width - 2
  const row = () => new Row(inner, skin, ctx.pointer)
  const view = ctx.spend
  const rows: { text: string; hits: Hit[] }[] = []

  const head = row().space()
  head.text(view?.hasCost ? money(view.usd) : '—', skin.you).space(2)
  head.text(tokenCount(view?.tokens ?? 0), skin.hint).space(2)
  // Every agent's time added together, which is why two working at once put
  // two hours on the clock in one. Bare, beside the money and the tokens: the
  // column below says what it is.
  const ran = view?.runtime
  head.text(duration(ran?.ms ?? 0), ran?.running ? skin.busy : skin.hint)
  head.right((r) => {
    for (const window of SPEND_WINDOWS) {
      r.tab(
        window.label,
        { kind: 'control', id: `window:${window.id}` },
        panel.window === window.id,
      )
    }
    r.space()
  })
  rows.push(head.build())
  rows.push(blank(inner))

  const by = row().space().text('by ', skin.hint)
  for (const option of SPEND_BY) {
    by.tab(option.label, { kind: 'control', id: `by:${option.id}` }, panel.by === option.id)
  }
  rows.push(by.build())
  rows.push(blank(inner))

  const name = 18
  const model = 15
  const bar = 10
  rows.push(
    row()
      .space()
      .text(
        `${pad('WHO', name + 2)}${pad(panel.by === 'model' ? '' : 'MODEL', model)} ${'TOKENS'.padStart(6)}  ${pad('SHARE', bar)}${'RUNTIME'.padStart(7)}${'COST'.padStart(8)}`,
        skin.label,
      )
      .build(),
  )
  const total = Math.max(1, view?.tokens ?? 0)
  // The orchestrator first, as its own line: it is the one cost that is not
  // any task's, and the one people forget is running.
  const entries = [...(view?.rows ?? [])].sort(
    (a, b) => Number(b.kind === 'orchestrator') - Number(a.kind === 'orchestrator'),
  )
  if (entries.length === 0) {
    rows.push(row().space(3).text('Nothing spent or run in this window.', skin.hint).build())
  }
  for (const entry of entries.slice(0, 8)) {
    const pane = ctx.panes.find((p) => p.task === entry.label)
    const mark =
      entry.kind === 'orchestrator'
        ? skin.brand('◆')
        : pane
          ? toneOf(pane, skin)(glyph(pane))
          : skin.hint('·')
    const label = pane && pane.project === ctx.project ? pane.name : entry.label
    rows.push(
      row()
        .space()
        .text(`${mark} `)
        .text(pad(label, name))
        .text(pad(entry.model ? shortModel(entry.model) : '', model), skin.hint)
        .space()
        .text(tokenCount(entry.tokens, false).padStart(6))
        .space(2)
        .meter(entry.tokens / total, bar)
        .text(
          (entry.runtime && entry.runtime.ms > 0 ? duration(entry.runtime.ms) : '—').padStart(7),
          entry.runtime?.running ? skin.busy : undefined,
        )
        .text((view?.hasCost ? money(entry.usd) : '—').padStart(8))
        .build(),
    )
  }

  rows.push(blank(inner))
  rows.push(row().space().text('BUDGETS', skin.label).build())
  // Only projects with something to say: a budget, or money spent without one.
  const budgets = (view?.budgets ?? []).filter(
    (budget) => budget.budget || budget.usd > 0 || budget.tokens > 0,
  )
  if (budgets.length === 0) rows.push(row().space(3).text('No budgets set.', skin.hint).build())
  for (const budget of budgets.slice(0, 5)) {
    const line = row().space().text(pad(budget.project, 11))
    const limit = budget.budget?.usd_per_day
    const spent = limit
      ? `${money(budget.usd)} of ${money(limit)} a day`
      : budget.budget?.tokens_per_day
        ? `${tokenCount(budget.tokens, false)} of ${tokenCount(budget.budget.tokens_per_day, false)} a day`
        : money(budget.usd)
    line.text(pad(spent, 25))
    if (budget.share !== null) {
      const tone =
        budget.verdict === 'over' ? skin.bad : budget.verdict === 'warn' ? skin.waiting : skin.done
      line
        .meter(Math.min(1, budget.share), 12, tone)
        .space()
        .text(`${Math.round(budget.share * 100)}%`, skin.hint)
    } else {
      line
        .text('no budget — ', skin.hint)
        .text('set one', skin.link, { kind: 'action', name: 'budgets' })
    }
    rows.push(line.build())
  }
  rows.push(blank(inner))
  rows.push(
    row()
      .space()
      .text('Prices as pi reports them · runtime from an agent starting to exiting.', skin.hint)
      .build(),
  )

  return box('Spend', rows, width, skin, { corner: 'esc' })
}

function toneOf(pane: AgentPane, skin: Skin): (text: string) => string {
  return skin[MARK_TONES[markOf(pane)]]
}

function pad(text: string, width: number): string {
  const cut = [...text].slice(0, width).join('')
  return cut + ' '.repeat(Math.max(0, width - cut.length))
}

function money(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`
}

function tokenCount(count: number, unit = true): string {
  const suffix = unit ? ' tokens' : ''
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M${suffix}`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k${suffix}`
  return `${count}${suffix}`
}

function shortModel(model: string): string {
  return model.split('/').at(-1) ?? model
}
