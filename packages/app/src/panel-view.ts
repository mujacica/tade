import {
  compositeTuiLine,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import {
  duration,
  HARNESS_CHOICES,
  KEY_BINDINGS,
  masked,
  type Setting,
  type SettingGroup,
  shownValue,
} from '@tade/core'
import type { ParsedDiff } from './diff.ts'
import { type Hit, type ScrollArea, sameTarget, type Target } from './hits.ts'
import { checkTalkKey, keyCaps, TALK_SUGGESTIONS } from './keys.ts'
import { linkedRow } from './links.ts'
import { type AgentPane, glyph, MARK_TONES, markOf } from './model.ts'
import {
  ACCOUNTS,
  type AccountShown,
  accountActions,
  type BranchPanel,
  type BranchRow,
  branchChoices,
  type Choice,
  type CloseDonePanel,
  type ConfirmPanel,
  type ConfirmRemovePanel,
  choicesFor,
  chosenEntry,
  type DiffPanel,
  type ExtensionEntry,
  type ExtensionSetupPanel,
  type ExtensionsPanel,
  type ExtensionView,
  type ExtensionViewPanel,
  extensionControls,
  extensionEntries,
  type FileAsk,
  type FilePanel,
  type FindPanel,
  fileMatches,
  listStart,
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
import { BAR, barRows, type Scrolled } from './scrollbar.ts'
import { completed, GROUPS, parseQuery, SCOPES, type SearchEntry } from './search.ts'
import type { Skin } from './skin.ts'
import { SPEND_BY, SPEND_WINDOWS, type SpendView } from './spend.ts'
import {
  blank,
  box,
  type Drawn,
  fit as fitRow,
  keysWidth,
  NO_POINTER,
  type Pointer,
  Row,
} from './ui.ts'
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
  /**
   * Which of the panel's scrollbars is being dragged, so that one is drawn
   * lit. A panel with two of them — a list and what it is showing — lights
   * the one in your hand, not both.
   */
  scrolling?: ScrollArea | null
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
  /** Every account agents can run as, each harness's own sign-in first. */
  accounts: readonly AccountShown[]
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
      .marker(on)
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
 * How big the Extensions panel is, and how its two sides divide the room.
 *
 * Settings' shape, and not Settings' block: a form is as tall as its rows and
 * stops, while this holds an extension's own account of itself — sixty lines
 * for one of them — so it takes the window it is given, less the margin and
 * the strip at the foot it must never cover. Capped at 120 columns only
 * because prose read across a whole ultrawide is prose nobody reads.
 */
export function extensionsSize(
  width: number,
  height: number,
): {
  width: number
  height: number
  inner: number
  /** The list's whole region, the column its bar takes included. */
  side: number
  /** The right-hand side's whole region, the column its bar takes included. */
  body: number
  /** Rows of the right-hand side that scroll. */
  room: number
  /** Rows of the list that scroll. */
  listRoom: number
} {
  const w = Math.min(120, Math.max(32, width - 6))
  // The window's own strip at the bottom is four rows, and a panel drawn over
  // it is a panel whose foot — Done, and what it last said — is under it.
  const h = Math.max(14, height - 6)
  const inner = w - 2
  const side = sideWidth(inner) + BAR
  return {
    width: w,
    height: h,
    inner,
    side,
    body: inner - side - 1,
    // What is left after the border, the head that stays put and the two
    // rows at the foot.
    room: Math.max(1, h - 2 - HEAD - 2),
    // What is left after the border and the search field with its blank row.
    listRoom: Math.max(1, h - 2 - 2),
  }
}

/** Rows of the right-hand side that never scroll: which extension this is, and its shape. */
const HEAD = 3

/** What the Extensions panel draws from, and nothing more: the app counts lines with it too. */
export type ExtensionFacts = Pick<
  PanelContext,
  'skin' | 'extensions' | 'written' | 'harnessExtensions' | 'project'
>

/**
 * The extensions: the list of them down the side with a search field over it,
 * and the one you are on said properly beside it — what it is for in the work
 * you actually do, what you can change about it, every tool it brings with
 * what each is for, what it offers to watch, and what it still needs.
 *
 * It used to be one column of all of them end to end, which is how somebody
 * could look at the page and conclude that Jev reviews diffs and does nothing
 * else: its other seven tools were never on it. So the shape is Settings' —
 * one way of showing a list and a thing in the window, not two.
 */
function extensions(panel: ExtensionsPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const { width, height, side, body, room, listRoom } = extensionsSize(ctx.width, ctx.height)
  const entries = extensionEntries(ctx.extensions, ctx.written, ctx.harnessExtensions, panel.search)
  const here = chosenEntry(panel, entries)
  const controls = extensionControls(here?.id ?? null, ctx.extensions, ctx.written)
  const focused = panel.focus === 'body' ? (controls[panel.index] ?? null) : null
  // The control the keyboard is on is lit as the pointer's would be, so both
  // say the same thing; the pointer's own light always wins.
  const pointer =
    ctx.pointer.hover?.kind === 'control' ? ctx.pointer : withFocus(ctx.pointer, focused)
  // Each side keeps a column for its own bar, so the two are the same object
  // the rest of the window uses and the text never runs under one.
  const names = side - BAR
  const told = body - BAR

  // ── the side: search, then every extension the search leaves ──
  const aside: { text: string; hits: Hit[] }[] = []
  const asking = panel.search === '' && panel.focus !== 'search'
  aside.push(
    new Row(names, skin, pointer)
      .space()
      .field(asking ? 'search extensions' : panel.search, names - 2, {
        caret: panel.focus === 'search',
        hint: asking,
        target: { kind: 'control', id: 'search' },
      })
      .build(),
  )
  aside.push(blank(names))
  const at = Math.max(
    0,
    entries.findIndex((entry) => entry.id === here?.id),
  )
  const from = listStart(panel.listScroll, entries.length, listRoom, at)
  for (const entry of entries.slice(from, from + listRoom)) {
    const on = entry.id === here?.id
    const target = { kind: 'control' as const, id: `pick:${entry.id}` }
    const pointed = sameTarget(ctx.pointer.hover, target)
    const mark =
      entry.kind !== 'extension'
        ? skin.hint('·')
        : entry.state === 'ready'
          ? skin.done('●')
          : entry.state === 'broken'
            ? skin.bad('✗')
            : entry.state === 'off'
              ? skin.hint('○')
              : skin.waiting('◐')
    const row = new Row(names, skin, ctx.pointer)
      .marker(on && panel.focus === 'list', target)
      .text(mark, undefined, target)
      .space()
      .text(
        cap(entry.title, names - 7),
        entry.state === 'off' ? skin.hint : on || pointed ? skin.you : (text) => text,
        target,
      )
    row.right((r) => {
      // What wants you is the one thing shown here: a count beside every row
      // is noise, and the state is already the mark.
      if (entry.wants) r.text('!', skin.waiting)
      else if (entry.kind !== 'extension') r.text(String(entry.count), skin.hint)
      else r.text(' ')
      r.space()
    })
    const built = row.build()
    aside.push({
      text: on ? skin.selected(built.text) : pointed ? skin.hovered(built.text) : built.text,
      hits: [{ row: 0, from: 0, to: names - 1, target }],
    })
  }

  // ── the head, which stays put: which one this is, and the shape of it ──
  const view =
    here?.kind === 'extension' ? ctx.extensions.find((one) => one.name === here.id) : null
  const head: { text: string; hits: Hit[] }[] = []
  const heading = new Row(told, skin, pointer).space()
  if (view) {
    heading.text(cap(view.title, told - 24), skin.brand).text(`  ${view.source}`, skin.hint)
    heading.right((r) =>
      r
        .text(
          view.state,
          view.state === 'ready'
            ? skin.done
            : view.state === 'broken'
              ? skin.bad
              : view.state === 'off'
                ? skin.hint
                : skin.waiting,
        )
        .space(),
    )
  } else if (here) {
    heading.text(cap(here.title, told - 2), skin.brand)
  } else {
    heading.text(
      cap(panel.search ? `Nothing matches “${panel.search}”` : 'Extensions', told - 2),
      skin.brand,
    )
  }
  head.push(heading.build())
  // What it comes to, where nobody has to scroll for it: an extension whose
  // shape you can only find out by reading to the bottom of the page is how
  // one that brings eight tools gets taken for one that brings a watch.
  const counts = view
    ? [
        view.tools.length > 0 ? count(view.tools.length, 'tool') : '',
        view.watches.length > 0 ? count(view.watches.length, 'watch', 'watches') : '',
        view.options.length > 0 ? count(view.options.length, 'setting') : '',
      ].filter(Boolean)
    : here?.kind === 'written'
      ? [count(ctx.written.length, 'tool Tade wrote for itself', 'tools Tade wrote for itself')]
      : here?.kind === 'harness'
        ? [count(ctx.harnessExtensions.length, 'piece')]
        : []
  head.push(
    counts.length > 0
      ? new Row(told, skin)
          .space()
          .text(cap(counts.join(' · '), told - 2), skin.hint)
          .build()
      : blank(told),
  )
  head.push(blank(told))

  // ── the body, which scrolls ──
  const lines = extensionBody(ctx, here, told, pointer, focused)
  /** Where the control the keyboard is on ended up, so tabbing keeps it in view. */
  let focusFrom = 0
  let focusTo = 0
  lines.forEach((line, index) => {
    if (line.on !== true) return
    if (focusTo === 0 && focusFrom === 0) focusFrom = index
    focusTo = index
  })
  const most = Math.max(0, lines.length - room)
  let start = Math.max(0, Math.min(panel.scroll, most))
  if (panel.following && focused) {
    if (focusTo >= start + room) start = Math.min(most, focusTo - room + 1)
    if (focusFrom < start) start = focusFrom
  }
  const shown = lines.slice(start, start + room)

  // ── the foot ──
  const said = panel.said
    ? new Row(told, skin)
        .space()
        .text(cap(panel.said, told - 2), skin.busy)
        .build()
    : new Row(told, skin)
        .space()
        .text(
          cap(`yours go in ${ctx.extensionsRoot}/<name>/extension.ts, off until you say`, told - 2),
          skin.hint,
        )
        .build()
  // Done is pinned to the foot, which no part of the page scrolls over: a
  // button that reading past the fold takes away is a button that is gone.
  // Said as fully as there is room for, and never cut mid-word: a hint with
  // an ellipsis in it has stopped being a hint.
  const how =
    told >= 62
      ? 'tab moves · ↑↓ reads · enter presses · esc closes'
      : told >= 44
        ? 'tab moves · ↑↓ reads · enter presses'
        : '↑↓ reads · enter presses'
  const keys = new Row(told, skin, ctx.pointer)
    .space()
    .text(cap(how, told - 12), skin.hint)
    .right((r) => r.button('Done', { kind: 'control', id: 'close' }, 'primary').space())

  // ── the two of them, each with its own bar ──
  const listBar = bar(
    { total: entries.length, shown: listRoom, offset: from, rows: listRoom },
    'panel-side',
    ctx,
  )
  const bodyBar = bar({ total: lines.length, shown: room, offset: start, rows: room }, 'panel', ctx)
  const main = [...head, ...shown]
  const rowsOfBody = height - 2
  const rows: { text: string; hits: Hit[] }[] = []
  for (let i = 0; i < rowsOfBody; i++) {
    const left = aside[i] ?? blank(names)
    let right = main[i] ?? blank(told)
    if (i === rowsOfBody - 2) right = said
    if (i === rowsOfBody - 1) right = keys.build()
    // A bar runs beside what it scrolls and nowhere else: the search field
    // keeps its own row, and so do the two at the foot.
    const beside = listBar[i - 2]
    const along = i >= HEAD && i < HEAD + room ? bodyBar[i - HEAD] : null
    rows.push({
      text: `${fitTo(left.text, names)}${beside?.cell ?? ' '}${skin.chrome('│')}${fitTo(right.text, told)}${along?.cell ?? ' '}`,
      hits: [
        // The wheel over the list moves the list, and over the page the page.
        // Laid under everything on the row, so a click still presses what it
        // is on; the panel's own scroll hit is under this one in turn.
        { row: 0, from: 0, to: side, target: { kind: 'scroll', area: 'panel-side' } as Target },
        ...left.hits,
        ...(beside ? [{ row: 0, from: names, to: names, target: beside.target }] : []),
        ...right.hits.map((hit) => ({ ...hit, from: hit.from + side + 1, to: hit.to + side + 1 })),
        ...(along
          ? [{ row: 0, from: side + 1 + told, to: side + 1 + told, target: along.target }]
          : []),
      ],
    })
  }
  return box('Extensions', rows, width, skin, { corner: 'esc' })
}

/**
 * A scrollbar's cells for one of the panel's two sides, each with the hit that
 * turns a drag on it back into a line to scroll to. The same bar the rest of
 * the window uses — one thumb, painted cells — so the panel does not grow a
 * scrollbar of its own.
 *
 * Drawn whether or not there is anything to scroll: a column that comes and
 * goes moves everything beside it every time the page changes.
 */
function bar(
  view: Scrolled,
  area: 'panel' | 'panel-side',
  ctx: PanelContext,
): { cell: string; target: Target }[] {
  const held =
    ctx.scrolling === area ||
    (ctx.pointer.hover?.kind === 'scrollbar' && ctx.pointer.hover.area === area)
  const target: Target = { kind: 'scrollbar', area, total: view.total, shown: view.shown }
  return barRows(view, ctx.skin, held).map((cell) => ({ cell, target }))
}

/** `8 tools`, `1 watch`: a count said the way somebody would say it. */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** A line of the right-hand side, and whether the control the keyboard is on is on it. */
interface Told {
  text: string
  hits: Hit[]
  on?: boolean
}

/**
 * How much further each side of the panel could be scrolled, and how many
 * rows the list shows, for the keys and the wheel. Laid out exactly as it is
 * drawn — one layout, asked twice — because a second reading of how long the
 * page is drifts from the first.
 */
export function extensionsScrollable(
  panel: ExtensionsPanel,
  facts: ExtensionFacts,
  width: number,
  height: number,
): { body: number; list: number; listRoom: number } {
  const size = extensionsSize(width, height)
  const entries = extensionEntries(
    facts.extensions,
    facts.written,
    facts.harnessExtensions,
    panel.search,
  )
  const here = chosenEntry(panel, entries)
  const lines = extensionBody(facts, here, size.body - BAR, NO_POINTER, null)
  return {
    body: Math.max(0, lines.length - size.room),
    list: Math.max(0, entries.length - size.listRoom),
    listRoom: size.listRoom,
  }
}

/**
 * Everything the right-hand side says about what you are on: what it is for in
 * the work you do, what it needs, what you can press, what it can be given,
 * every tool with what each is for, and what it offers to watch.
 */
function extensionBody(
  facts: ExtensionFacts,
  here: ExtensionEntry | null,
  form: number,
  pointer: Pointer,
  focused: string | null,
): Told[] {
  const { skin } = facts
  const lines: Told[] = []
  const row = () => new Row(form, skin, pointer)
  const control = (id: string) => ({ kind: 'control' as const, id })
  const plain = (text: string) => text
  const wrap = (text: string, indent: number, tone: (text: string) => string = skin.hint) => {
    for (const piece of wrapTextWithAnsi(text, Math.max(10, form - indent - 1))) {
      lines.push(row().space(indent).text(piece, tone).build())
    }
  }
  const heading = (title: string, note = '') => {
    const room = Math.max(0, form - visibleWidth(title) - 4)
    lines.push(
      row()
        .space()
        .text(title, skin.label)
        .text(note ? `  ${cap(note, room)}` : '', skin.hint)
        .build(),
    )
  }
  /** Buttons over as many rows as they need, with a blank row between two of them. */
  const buttons = (
    items: readonly { id: string; label: string; look?: 'attention' | 'danger' | 'primary' }[],
  ) => {
    let current = row().space()
    let holds: string[] = []
    let first = true
    const put = () => {
      if (!first) lines.push(blank(form))
      lines.push({ ...current.build(), on: focused !== null && holds.includes(focused) })
      first = false
      holds = []
    }
    for (const item of items) {
      if (current.used + visibleWidth(item.label) + 5 > form && current.used > 1) {
        put()
        current = row().space()
      }
      current.button(item.label, control(item.id), item.look).space()
      holds.push(item.id)
    }
    if (items.length > 0) put()
  }

  if (!here) {
    lines.push(
      row()
        .space()
        .text(
          facts.extensions.length === 0
            ? 'No extensions are loaded.'
            : 'Nothing here matches. Clear the search to see them all.',
          skin.hint,
        )
        .build(),
    )
    return lines
  }

  if (here.kind === 'written') {
    wrap(
      'Tools Tade wrote for itself, for the orchestrator to use. One you turn on loads the next time Tade starts, and a lesson it proposes is a file you read before any of it runs.',
      1,
    )
    lines.push(blank(form))
    for (const tool of facts.written) {
      const title = row()
        .space()
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
        on: focused === `read:${tool.name}` || focused === `toggle:${tool.name}`,
      })
      if (tool.why) wrap(tool.why, 3)
      lines.push(blank(form))
    }
    return lines
  }

  if (here.kind === 'harness') {
    wrap(
      'What pi loads by itself, in every agent. Tade lists these and nothing more: they are not its to turn on, off or configure.',
      1,
    )
    lines.push(blank(form))
    for (const piece of facts.harnessExtensions) {
      lines.push(row().space().text(piece.name).text(`  ${piece.where}`, skin.hint).build())
    }
    return lines
  }

  const view = facts.extensions.find((one) => one.name === here.id)
  if (!view) return lines

  wrap(view.description, 1, plain)
  const trouble = view.state === 'needs setup' || view.state === 'broken'
  if (trouble && view.problem) {
    lines.push(blank(form))
    for (const [index, piece] of wrapTextWithAnsi(view.problem, Math.max(10, form - 4)).entries()) {
      lines.push(
        row()
          .space()
          .text(index === 0 ? '▲' : ' ', view.state === 'broken' ? skin.bad : skin.waiting)
          .space()
          .text(piece, view.state === 'broken' ? skin.bad : skin.waiting)
          .build(),
      )
    }
  }
  if (view.state === 'off') {
    lines.push(blank(form))
    wrap(
      view.source === 'yours'
        ? 'Turned off, so Tade lists it and never imports it — nothing in it has run. Turning it on takes effect the next time Tade starts, and only then can it say more than this.'
        : 'Turned off. Turning it on takes effect the next time Tade starts.',
      1,
    )
  }
  if (view.unknownSettings.length > 0) {
    lines.push(blank(form))
    wrap(
      `Not read: extensions.${view.name}.${view.unknownSettings.join(`, extensions.${view.name}.`)} — a typo, most likely.`,
      1,
      skin.bad,
    )
  }

  // What can be done from here, in the order `extensionControls` walks them:
  // what it is for first, and turning it off at the end.
  const items: { id: string; label: string; look?: 'attention' | 'danger' | 'primary' }[] = []
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
  if (view.state !== 'broken')
    items.push({ id: `toggle:${view.name}`, label: view.state === 'off' ? 'Turn on' : 'Turn off' })
  if (items.length > 0) {
    lines.push(blank(form))
    buttons(items)
  }

  // What it is for, in the work somebody actually does.
  if (view.workflow.length > 0) {
    lines.push(blank(form))
    heading('HOW IT IS USED')
    for (const line of view.workflow) {
      const pieces = wrapTextWithAnsi(line, Math.max(10, form - 5))
      pieces.forEach((piece, index) => {
        lines.push(
          row()
            .space()
            .text(index === 0 ? '·' : ' ', skin.hint)
            .space()
            .text(piece, plain)
            .build(),
        )
      })
    }
  }

  // Every tool, with what each is for. The header used to say "8 tools" and
  // never which, which is how a page can be read as saying an extension does
  // one thing.
  if (view.tools.length > 0) {
    lines.push(blank(form))
    heading('TOOLS', 'what the orchestrator and your agents can call')
    const named = Math.min(22, Math.max(10, Math.floor(form / 3)))
    for (const tool of view.tools) {
      // Who may call it, said only where it is not both: anything that changes
      // something outside a project is the orchestrator's alone.
      const only = tool.for.length === 1 ? `${tool.for[0]} only` : ''
      // The gap the pinned note needs, and the column it ends on: a row that
      // does not fit drops its right-hand group, and a tool whose audience
      // quietly disappeared is worse than one line less of what it does.
      const room = Math.max(4, form - 1 - named - (only ? visibleWidth(only) + 2 : 0))
      const line = row()
        .space()
        .text(padTo(cap(tool.name, named), named), skin.you)
      line.text(cap(tool.summary, room), skin.hint)
      if (only) line.right((r) => r.text(only, skin.hint).space())
      lines.push(line.build())
    }
  }

  // What it offers to watch: a schedule like any other, once it is on.
  const watches = view.state === 'broken' ? [] : view.watches
  if (watches.length > 0) {
    lines.push(blank(form))
    heading('WATCHES', 'offered; nothing is watched until you turn one on')
    for (const watch of watches) {
      const id = watchControl(view.name, watch)
      const every = `  every ${watch.every}`
      const press = id ? (watch.on ? 'Show' : `Watch ${watch.project ?? ''}`) : ''
      // What is pinned at the right, measured before the name is cut: a row
      // that does not fit drops its right-hand group, and the button that
      // turns a watch on is not something to lose to a long title.
      const pinned =
        (watch.on ? visibleWidth(`on in ${watch.project ?? ''}  `) : 0) +
        (press ? visibleWidth(press) + 4 : visibleWidth('open a project to watch it')) +
        2
      const title = row()
        .space()
        .text('◎', watch.on ? skin.done : skin.hint)
        .space()
        .text(cap(watch.title, Math.max(8, form - 3 - visibleWidth(every) - pinned)), skin.you)
        .text(every, skin.hint)
      title.right((r) => {
        if (watch.on) r.text(`on in ${watch.project ?? ''}  `, skin.done)
        if (press) {
          r.button(press, control(id as string))
        } else {
          r.text('open a project to watch it', skin.hint)
        }
        r.space()
      })
      lines.push({ ...title.build(), on: id !== null && id === focused })
      wrap(watch.means, 3)
    }
  }

  // What it can be given, and where each one stands. A credential is said as
  // a place — the keychain, an environment variable — and never drawn back.
  if (view.options.length > 0) {
    lines.push(blank(form))
    heading(
      'OPTIONS',
      view.configurable
        ? `change them in ${view.state === 'needs setup' ? 'Set up…' : 'Settings…'}`
        : '',
    )
    const named = Math.min(20, Math.max(8, Math.floor(form / 3)))
    for (const option of view.options) {
      // A credential is said as a place and never as a value; where there is
      // none, say where one is pasted, because the answer to "how do I give
      // it my key" must not be "export it in your shell profile".
      const value = option.secret
        ? option.have
          ? option.have.startsWith('$')
            ? `from ${option.have}`
            : `kept in ${option.have}`
          : view.configurable
            ? 'not set — paste one in Set up…'
            : 'not set'
        : option.value || 'not set'
      const set = option.secret ? option.have !== '' : option.value !== ''
      lines.push(
        row()
          .space()
          .text(padTo(cap(option.label, named - 1), named))
          .text(cap(value, Math.max(4, form - named - 3)), set ? skin.you : skin.hint)
          .build(),
      )
    }
  }

  if (view.folder) {
    lines.push(blank(form))
    wrap(`Yours, from ${view.folder}`, 1)
  }
  return lines
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
      // A key is bullets from the first character, here and everywhere else:
      // what is drawn is what ends up in a screen recording.
      const shown = field.kind === 'secret' ? masked(value) : value
      r.field(shown, Math.max(10, inner - label - 4), {
        caret: focused,
        target: { kind: 'control', id: `field:${field.key}` },
        ...(value === '' && field.kind === 'secret' && field.have
          ? { ghost: `kept — ${field.have}` }
          : value === '' && field.placeholder
            ? { ghost: field.placeholder }
            : {}),
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
  const r = new Row(width, skin).marker(on).space().text(entry.mark, tone).space()
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
      ctx.scrolling === 'panel' || ctx.pointer.hover?.kind === 'scrollbar',
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
  // What a key does, in whatever room its caps leave: capped a column short
  // of the edge, so a long one ends in an ellipsis instead of running into
  // the border of the box it is in.
  const means = (row: Row, text: string) =>
    row.text(cap(text, Math.max(0, inner - row.used - 1)), skin.hint).build()
  const talk = ctx.talkKey
  const rows: { text: string; hits: Hit[] }[] = [
    blank(inner),
    means(
      label('Push to talk').keys(keyCaps(talk)).space(2),
      ctx.releases && ctx.talkMode === 'hold' ? 'hold' : 'press, press again',
    ),
  ]
  // Every other key the window keeps, as it is set now.
  for (const binding of KEY_BINDINGS) {
    const bound = ctx.bindings[binding.key] ?? binding.fallback
    rows.push(means(label(binding.title).keys(keyCaps(bound)).space(2), binding.means))
  }
  rows.push(
    blank(inner),
    // Sending keeps the line, so say what leaves it: enter used to be both.
    means(
      label('On the orchestrator line')
        .keys(['↑'])
        .keys(['↓'])
        .space()
        .keys(['ctrl', 'r'])
        .space(2),
      'what you said before · esc leaves',
    ),
    means(
      label('In a panel')
        .keys(['enter'])
        .space()
        .keys(['esc'])
        .space()
        .keys(['↑'])
        .keys(['↓'])
        .space(2),
      'the wheel scrolls it',
    ),
    means(
      label('In a file you are reading')
        .keys(['ctrl', 'f'])
        .keys(['ctrl', 'g'])
        .keys(['ctrl', 's'])
        .space(2),
      'find · line · save',
    ),
    label('Quit').keys(['ctrl', 'c']).build(),
    blank(inner),
    new Row(inner, skin)
      .space()
      .text("Everything else goes to the agent or terminal you're typing at.", skin.hint)
      .build(),
    new Row(inner, skin, ctx.pointer)
      .right((r) => r.button('Change shortcuts…', { kind: 'control', id: 'change-keys' }).space())
      .build(),
  )
  return box('Shortcuts', rows, width, skin, { corner: 'esc' })
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
      .marker(on)
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
    const r = new Row(right, skin, pointer).marker(on)
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

/**
 * What an option is called where its own word is not a sentence — by the
 * setting it belongs to, because the same word means two things: `hold` is
 * how you talk, and it is also what a red check does to a push.
 */
const CHOICE_LABELS: Record<string, Record<string, string>> = {
  'surfaces.voice.talk.mode': {
    hold: 'Hold to talk',
    toggle: 'Press to start, press to stop',
  },
}

/**
 * How wide the list of categories is. Pared back rather than dropped: a panel
 * you cannot change category in is a panel with one category.
 */
export function sideWidth(inner: number): number {
  if (inner >= 76) return 24
  if (inner >= 58) return 18
  return 16
}

/** Columns kept blank between a setting's name and its control, at every width. */
const GAP = 2

/**
 * How a group's rows are laid out: what the name gets, what is left for the
 * control, and whether the two fit on one line at all.
 *
 * One layout for the whole group rather than one per row, because a column of
 * controls that each start somewhere else is the thing this panel was rebuilt
 * to stop. The name column is the longest name there is, and never more than
 * half of what there is, so a long name gives up columns rather than the
 * control it belongs to — and what is still too long is cut with an ellipsis,
 * which is what says a word was cut.
 */
export interface FormLayout {
  /** Columns the name gets, before the gap. */
  label: number
  /** Columns the control has, after the gap. */
  control: number
  /** What is said beside anything that waits for a restart; null where there is no room. */
  restart: string | null
  /** Columns that note takes, which a setting that does not wait may use. */
  note: number
  /** The control sits under its name, indented, rather than beside it. */
  stacked: boolean
}

export function formLayout(form: number, rows: readonly Setting[]): FormLayout {
  const waits = rows.some((setting) => !setting.live)
  // Said in words where they fit, and as the mark alone where they do not:
  // that a setting waits for a restart is not something to leave out.
  const restart = !waits ? null : form >= 56 ? '↻ on restart' : form >= 22 ? '↻' : null
  const note = restart ? visibleWidth(restart) + 3 : 0
  const longest = Math.max(0, ...rows.map((setting) => visibleWidth(setting.title)))
  const most = Math.max(8, Math.floor((form - 1 - GAP - note) / 2))
  const label = Math.max(8, Math.min(longest, most))
  const control = form - 1 - label - GAP - note
  if (control >= 16) return { label, control, restart, note, stacked: false }
  // Too narrow for two columns: the name takes the line and the control the
  // next one, which is the one shape that cannot overlap at any width.
  return {
    label: Math.max(4, form - 3 - (restart ? visibleWidth(restart) + 1 : 0)),
    control: Math.max(4, form - 4),
    restart,
    note: 0,
    stacked: true,
  }
}

/** What a control may use: its column, and the note's columns where it has no note. */
function roomFor(layout: FormLayout, setting: Setting): number {
  return layout.control + (setting.live ? layout.note : 0)
}

/** Whether the pointer is on this setting: its row, or any control of it. */
function onSetting(hover: Target | null, path: string): boolean {
  if (hover?.kind !== 'control') return false
  const arg = hover.id.split(':').slice(1).join(':')
  return arg === path || arg.startsWith(`${path}=`)
}

/** The first line of a list to show, so the one you are on is always in it. */
function scrolledTo(lines: number, room: number, from: number, to: number): number {
  if (lines <= room || room <= 0) return 0
  const most = lines - room
  const offset = to >= room ? Math.min(to - room + 1, most) : 0
  return Math.max(0, Math.min(from < offset ? from : offset, most))
}

function settings(panel: SettingsPanel, ctx: PanelContext): PanelDrawing {
  const { skin } = ctx
  const width = Math.min(104, Math.max(32, ctx.width - 6))
  const height = Math.max(14, Math.min(28, ctx.height - 4))
  const inner = width - 2
  const side = sideWidth(inner)
  const form = inner - side - 1
  const pointer = ctx.pointer
  const plain = (text: string) => text

  // ── the side: search, then categories ──
  const aside: { text: string; hits: Hit[] }[] = []
  const searching = panel.search === '' && panel.focus !== 'search'
  aside.push(
    new Row(side, skin, pointer)
      .space()
      .field(searching ? 'search settings' : panel.search, side - 2, {
        caret: panel.focus === 'search',
        // The field says what it is for until you use it.
        hint: searching,
        target: { kind: 'control', id: 'search' },
      })
      .build(),
  )
  aside.push(blank(side))
  const categories = [
    ...ctx.settings.map((group) => ({ id: group.id, title: group.title })),
    { id: ACCOUNTS, title: 'Accounts' },
  ]
  for (const category of categories) {
    const on = panel.search === '' && panel.category === category.id
    const target = { kind: 'control' as const, id: `category:${category.id}` }
    const pointed = sameTarget(pointer.hover, target)
    const row = new Row(side, skin, pointer)
      .marker(on, target)
      .space()
      .text(cap(category.title, side - 3), on ? skin.you : pointed ? skin.link : plain, target)
    row.right((r) => {
      const badge = badgeFor(category.id, ctx)
      if (badge) badge(r)
      r.space()
    })
    const built = row.build()
    aside.push({
      text: on ? skin.selected(built.text) : pointed ? skin.hovered(built.text) : built.text,
      hits: [{ row: 0, from: 0, to: side - 1, target }],
    })
  }

  // ── the head of the form: what this group is, and what it is about ──
  const group = ctx.settings.find((g) => g.id === panel.category)
  const title = panel.search
    ? `Matching “${panel.search}”`
    : panel.category === ACCOUNTS
      ? 'Accounts'
      : (group?.title ?? '')
  const about = panel.search
    ? 'Every setting whose name or meaning has those words.'
    : panel.category === ACCOUNTS
      ? "Who each harness's agents run as. Signing in is each harness's own, inside this window: what you give it goes where it keeps it, never through Tade. ▸ marks the account new agents use; an agent's own menu moves it to another."
      : (group?.about ?? '')
  const head: { text: string; hits: Hit[] }[] = [
    new Row(form, skin)
      .space()
      .text(cap(title, form - 2), skin.brand)
      .build(),
  ]
  // What the group is about, kept inside the panel: broken over lines rather
  // than cut off mid-word at whatever width the window happens to be.
  for (const line of wrapTo(about, form - 2, height >= 22 ? 3 : 2))
    head.push(new Row(form, skin).space().text(line, skin.hint).build())
  head.push(blank(form))

  // ── the form ──
  const rows =
    panel.category === ACCOUNTS && !panel.search ? [] : visibleSettings(panel, ctx.settings)
  const layout = formLayout(form, rows)
  const body: { text: string; hits: Hit[] }[] = []
  /** Where the focused setting's lines begin and end, so it is kept in view. */
  let focusFrom = 0
  let focusTo = 0
  /** Where a dropdown would open: the line under its control, and its column. */
  let anchor: { line: number; col: number } | null = null

  if (panel.category === ACCOUNTS && !panel.search) {
    const actions = accountActions(ctx.accounts)
    const focused = panel.focus === 'form' ? (actions[panel.row]?.id ?? null) : null
    const named = Math.min(22, Math.max(6, form - 30))
    /** The last line that was a row of buttons, so two never end up touching. */
    let lastButtons = -2
    // Buttons for one account, or for its harness when `account` is undefined,
    // laid out on as many rows as they need — with a blank line between two
    // rows of them, wherever they come from. A button is a label on its own
    // painted ground, so two rows with nothing between are one block of
    // colour: the gap is the same column that separates them sideways, going
    // down instead.
    const buttons = (harness: string, account: string | null | undefined) => {
      const mine = actions.filter(
        (action) =>
          action.harness === harness &&
          (account === undefined ? action.account === undefined : action.account === account),
      )
      if (mine.length === 0) return
      let row = new Row(form, skin, withFocus(pointer, focused)).space(3)
      let holds: string[] = []
      const put = () => {
        if (lastButtons === body.length - 1) body.push(blank(form))
        // Where the focused button ended up, read after the gap rather than
        // before it: a line counted before one is inserted is the line above.
        if (focused !== null && holds.includes(focused)) {
          focusFrom = body.length
          focusTo = body.length
        }
        body.push(row.build())
        lastButtons = body.length - 1
        holds = []
      }
      for (const action of mine) {
        const label = panel.confirm === action.id ? 'Press again to remove' : action.label
        const width = visibleWidth(label) + 3
        if (row.used + width > form - 1 && row.used > 3) {
          put()
          row = new Row(form, skin, withFocus(pointer, focused)).space(3)
        }
        holds.push(action.id)
        row.button(
          label,
          { kind: 'control', id: action.id },
          action.danger ? 'danger' : account === undefined ? 'add' : undefined,
        )
        row.space()
      }
      put()
    }
    const harnesses = [...new Set(ctx.accounts.map((one) => one.harness))]
    for (const harness of harnesses) {
      const title = HARNESS_CHOICES.find((one) => one.id === harness)?.title ?? harness
      body.push(
        new Row(form, skin)
          .space()
          .text(cap(title, form - 2), skin.brand)
          .build(),
      )
      const mine = ctx.accounts.filter((one) => one.harness === harness)
      for (const one of mine) {
        const status = one.status.signedIn
          ? [
              one.kind === 'api-key'
                ? '● paid with an API key'
                : `● ${one.status.who ?? 'signed in'}${one.status.plan ? ` · ${one.status.plan}` : ''}`,
              one.limits?.fiveHour ? `${Math.round(one.limits.fiveHour.used)}% of 5h` : null,
              one.agents > 0 ? `${one.agents} agent${one.agents === 1 ? '' : 's'}` : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : `○ ${one.status.problem ?? 'not signed in'}`
        body.push(
          new Row(form, skin)
            .space()
            .text(one.forNewAgents ? '▸ ' : '  ', skin.you)
            .text(padTo(cap(one.name ?? 'its own sign-in', named), named))
            .text(cap(status, form - named - 5), one.status.signedIn ? skin.done : skin.hint)
            .build(),
        )
        buttons(harness, one.name)
      }
      buttons(harness, undefined)
      const why = mine.find((one) => !one.canAdd)?.why
      if (why) {
        for (const line of wrapTo(`${title} ${why}.`, form - 4, 2)) {
          body.push(new Row(form, skin).space(3).text(line, skin.hint).build())
        }
      }
      body.push(blank(form))
    }
    if (ctx.accounts.length === 0)
      body.push(
        new Row(form, skin)
          .space()
          .text(cap('Asking each harness who it is signed in as…', form - 2), skin.hint)
          .build(),
      )
  } else if (rows.length === 0) {
    body.push(
      new Row(form, skin)
        .space()
        .text(cap('Nothing here matches.', form - 2), skin.hint)
        .build(),
    )
  }

  rows.forEach((setting, at) => {
    const focused = panel.focus === 'form' && at === panel.row
    // The focused row's control is drawn as though pointed at, so the keyboard
    // and the pointer say the same thing — the row's own light comes from the
    // real pointer, never from this.
    const keys = focused ? withFocus(pointer, controlOf(setting)) : pointer
    const rowTarget = { kind: 'control' as const, id: `row:${setting.path}` }
    const pointed = onSetting(pointer.hover, setting.path)
    const band = focused ? skin.selected : pointed ? skin.hovered : null
    const lines: { text: string; hits: Hit[] }[] = []
    const restart = !setting.live && layout.restart ? layout.restart : null

    // Clicking anywhere along a setting's line puts the keyboard on it, laid
    // under its controls so a click still presses what it is on.
    const wholeRow = (built: { text: string; hits: Hit[] }) => ({
      text: built.text,
      hits: [{ row: 0, from: 0, to: form - 1, target: rowTarget }, ...built.hits],
    })
    // A short list of options is radios, and where they would not fit beside
    // the name they go under it, one to a line, rather than off the edge.
    const room = layout.stacked ? layout.control : roomFor(layout, setting)
    const beside = !layout.stacked && fitsInline(setting, room)

    const line = new Row(form, skin, keys)
    line.marker(focused, rowTarget)
    line.text(padTo(setting.title, layout.label), focused || pointed ? skin.you : plain, rowTarget)
    let controlCol = line.used + GAP
    if (beside) {
      line.space(GAP)
      controlCol = line.used
      control(line, setting, panel, ctx, room)
    }
    if (restart) line.right((r) => r.text(restart, skin.hint).space())
    lines.push(wholeRow(line.build()))
    if (!beside) {
      if (spellsOut(setting)) {
        for (const option of optionsOf(setting)) {
          lines.push(
            new Row(form, skin, keys)
              .space(3)
              .radio(option.on, cap(option.label, form - 6), {
                kind: 'control',
                id: `set:${setting.path}=${option.value}`,
              })
              .build(),
          )
        }
      } else {
        const under = new Row(form, skin, keys).space(3)
        controlCol = under.used
        control(under, setting, panel, ctx, Math.max(4, form - 4))
        lines.push(under.build())
      }
    }
    if (setting.path === 'surfaces.voice.mic.device') {
      // Trying it is the only way to know the terminal may use it.
      const indent = layout.stacked ? 3 : 1 + layout.label + GAP
      const meter = new Row(form, skin, pointer).space(indent)
      const cells = Math.max(4, Math.min(14, form - indent - 12))
      const heard = ctx.levels.slice(-cells)
      const bars = '▁▂▃▄▅▆▇█'
      meter.text(
        heard.map((level) => bars[Math.max(0, Math.min(7, Math.round(level * 7)))]).join(''),
        skin.busy,
      )
      meter.text('▁'.repeat(Math.max(0, cells - heard.length)), skin.chrome).space(2)
      meter.button(
        panel.testing ? 'Listening…' : 'Test',
        { kind: 'control', id: 'mic-test' },
        panel.testing ? 'off' : 'rest',
      )
      lines.push(meter.build())
    }
    const listOpen = panel.dropdown?.path === setting.path
    if (listOpen) anchor = { line: body.length + lines.length - 1, col: controlCol }
    // The sentence under a setting, for the one you are on, and what the
    // terminal allows for the talk key, which is not something to guess.
    const talkKey = setting.path === 'surfaces.voice.talk.key'
    if (!listOpen && (focused || (talkKey && panel.search === ''))) {
      const note = talkKey
        ? ctx.releases
          ? { mark: '✓', text: 'Hold works here: this terminal reports releases.', tone: skin.done }
          : {
              mark: '▲',
              text: "This terminal can't report releases, so talking toggles.",
              tone: skin.waiting,
            }
        : { mark: '', text: setting.means, tone: skin.hint }
      // Said under the control where that leaves it room to be read, and
      // under the name where it does not.
      const aligned = 1 + layout.label + GAP
      const indent = !layout.stacked && form - aligned >= 32 ? aligned : 3
      const room = form - indent - 1 - (note.mark ? 2 : 0)
      wrapTo(note.text, room, 2).forEach((piece, i) => {
        const r = new Row(form, skin).space(indent)
        if (note.mark) r.text(i === 0 ? note.mark : ' ', note.tone).space()
        lines.push(r.text(piece, skin.hint).build())
      })
    }
    if (focused) {
      focusFrom = body.length
      focusTo = body.length + lines.length - 1
    }
    for (const built of lines)
      body.push(band ? { text: band(built.text), hits: built.hits } : built)
    // Settings that say more than one line's worth stand apart; plain ones stack.
    const roomy =
      setting.type.kind === 'key' || setting.type.kind === 'model' || setting.type.kind === 'choice'
    if ((roomy || layout.stacked) && at < rows.length - 1) body.push(blank(form))
  })

  // ── the foot of the form ──
  const foot = new Row(form, skin, pointer).space()
  if (panel.error) foot.text(cap(`▲ ${panel.error}`, form - 2), skin.waiting)
  else if (panel.saved) foot.text('● ', skin.done).text(cap(panel.saved, form - 4), skin.hint)
  else foot.text('● ', skin.done).text(cap('Saved as you change it.', form - 4), skin.hint)
  const buttons = new Row(form, skin, pointer).right((r) => {
    if (form >= 32) r.button('Open config.yaml', { kind: 'control', id: 'open-file' }).space()
    r.button('Done', { kind: 'control', id: 'done' }, 'primary').space()
  })

  // Rows beyond the panel used to be drawn and lost. The form follows the row
  // you are on instead, which is what the wheel over it moves.
  const room = Math.max(1, height - 2 - head.length - 2)
  const offset = scrolledTo(body.length, room, focusFrom, focusTo)
  const shown = body.slice(offset, offset + room)
  const main = [...head, ...shown]

  const popups: PanelDrawing['popups'] = []
  if (anchor !== null) {
    const { line, col } = anchor as { line: number; col: number }
    const at = line - offset
    if (at >= 0 && at < room) {
      const listWidth = Math.min(46, Math.max(24, inner - 2))
      const list = settingsDropdown(panel, rows[panel.row] as Setting, ctx, listWidth)
      const under = 1 + head.length + at + 1
      popups.push({
        drawn: list,
        // Under its control where the list fits below it, and over it where
        // it does not: a list that opens off the bottom of the panel is a
        // list with its far end on the window behind.
        row:
          under + list.rows.length <= height - 1
            ? under
            : Math.max(1, under - 1 - list.rows.length),
        col: Math.max(1, Math.min(1 + side + 1 + col, width - listWidth - 1)),
      })
    }
  }

  const rowsOfBody = height - 2
  const lines: { text: string; hits: Hit[] }[] = []
  for (let i = 0; i < rowsOfBody; i++) {
    const left = aside[i] ?? blank(side)
    let right = main[i] ?? blank(form)
    if (i === rowsOfBody - 2) right = foot.build()
    if (i === rowsOfBody - 1) right = buttons.build()
    lines.push({
      text: `${fitTo(left.text, side)}${skin.chrome('│')}${fitTo(right.text, form)}`,
      hits: [
        ...left.hits,
        ...right.hits.map((hit) => ({ ...hit, from: hit.from + side + 1, to: hit.to + side + 1 })),
      ],
    })
  }

  if (panel.capture) {
    const asked = capture(panel, ctx)
    const askedWidth = Math.max(0, ...asked.rows.map((row) => visibleWidth(row)))
    popups.push({
      drawn: asked,
      row: 3,
      col: Math.max(0, Math.floor((width - askedWidth) / 2)),
    })
  }
  // The file it writes, in the border, while the border has room for it: a
  // corner longer than the box it is drawn in is a box that is not its width.
  const said = `${ctx.configPath} · esc`
  const corner = visibleWidth(said) + visibleWidth(' Settings ') + 6 <= width ? said : 'esc'
  return {
    panel: box('Settings', lines, width, skin, { corner }),
    popups,
  }
}

/** A choice shown as radios rather than a list. */
function spellsOut(setting: Setting): boolean {
  return setting.type.kind === 'choice' && !usesDropdown(setting)
}

function optionsOf(setting: Setting): { value: string; label: string; on: boolean }[] {
  if (setting.type.kind !== 'choice') return []
  const value = setting.value || setting.fallback
  return setting.type.options.map((option) => ({
    value: option,
    label: CHOICE_LABELS[setting.path]?.[option] ?? option,
    on: value === option,
  }))
}

/** Whether a setting's radios fit on one line, spaced as they are drawn. */
function fitsInline(setting: Setting, room: number): boolean {
  const options = optionsOf(setting)
  if (options.length === 0) return true
  const width = options.reduce((sum, option) => sum + 2 + visibleWidth(option.label), 0)
  return width + 3 * (options.length - 1) <= room
}

/**
 * The control beside a setting, drawn for its kind and for the columns it has.
 *
 * Everything here is sized from `room` rather than from a number that was true
 * on the terminal it was written on: a control that runs past the panel edge
 * is the same bug as a name that runs into its control.
 */
function control(
  row: Row,
  setting: Setting,
  panel: SettingsPanel,
  ctx: PanelContext,
  room: number,
): void {
  const { skin } = ctx
  const type = setting.type
  const value = setting.value
  const lit = (target: Target, tone: (text: string) => string) =>
    sameTarget(row.pointer.hover, target) ? skin.link : tone
  switch (type.kind) {
    case 'key': {
      const target = { kind: 'control' as const, id: `capture:${setting.path}` }
      const caps = keyCaps(value || setting.fallback)
      const width = keysWidth(caps)
      // The keys themselves are the control; the button is what says so, and
      // is only there where it fits beside them.
      row.keys(caps, target)
      if (room - width >= 14) row.space(3).button('Change…', target)
      return
    }
    case 'flag':
      row.toggle((value || setting.fallback) === 'true', {
        kind: 'control',
        id: `toggle:${setting.path}`,
      })
      return
    case 'number': {
      if (panel.editing?.path === setting.path) {
        row.field(panel.editing.text, Math.max(6, Math.min(10, room)), {
          caret: true,
          target: { kind: 'control', id: `edit:${setting.path}` },
        })
        return
      }
      const shown = { kind: 'control' as const, id: `edit:${setting.path}` }
      row
        .icon('‹', { kind: 'control', id: `step:${setting.path}=-1` }, 'signal')
        .text(` ${value || setting.fallback} `, lit(shown, value ? skin.you : skin.hint), shown)
        .icon('›', { kind: 'control', id: `step:${setting.path}=1` }, 'signal')
      if (type.unit && room - row.used >= visibleWidth(type.unit) + 2)
        row.space(2).text(type.unit, skin.hint)
      return
    }
    case 'hours': {
      const target = { kind: 'control' as const, id: `edit:${setting.path}` }
      if (panel.editing?.path === setting.path) {
        row.field(panel.editing.text, Math.max(8, Math.min(16, room)), { caret: true, target })
        if (room - 16 >= 18) row.space(2).text('like 22:00-07:00', skin.hint)
        return
      }
      const [from, to] = value.split('-')
      if (!value || !from || !to) {
        row.field('none', Math.max(6, Math.min(9, room)), { hint: true, target })
        return
      }
      const each = Math.max(5, Math.min(9, Math.floor((room - 4) / 2)))
      row
        .field(from, each, { target })
        .space()
        .text('to', skin.hint)
        .space()
        .field(to, each, { target })
      return
    }
    case 'text': {
      const target = { kind: 'control' as const, id: `edit:${setting.path}` }
      const width = Math.max(8, Math.min(40, room))
      // A credential is bullets as it is typed and a sentence about where it
      // is when it is not: a key on a screen is a key in a recording.
      if (panel.editing?.path === setting.path) {
        const typed = setting.secret ? masked(panel.editing.text) : panel.editing.text
        row.field(typed, width, { caret: true, target })
      } else {
        const shown = setting.secret ? shownValue(setting) : value
        row.field(shown || setting.fallback, width, { hint: !shown, target })
      }
      return
    }
    case 'model':
    case 'choice':
      if (usesDropdown(setting)) {
        const shown =
          type.kind === 'choice'
            ? (type.about?.[value || setting.fallback]?.label ?? (value || setting.fallback))
            : value || setting.fallback
        row.field(shown, Math.max(8, Math.min(40, room)), {
          arrow: true,
          hint: !value,
          target: { kind: 'control', id: `drop:${setting.path}` },
        })
        return
      }
      optionsOf(setting).forEach((option, i) => {
        if (i > 0) row.space(3)
        row.radio(option.on, option.label, {
          kind: 'control',
          id: `set:${setting.path}=${option.value}`,
        })
      })
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
  const signedIn = ctx.accounts.filter((one) => one.status.signedIn).length
  if (id === ACCOUNTS && signedIn > 0) return (row) => row.text(`● ${signedIn}`, skin.done)
  return null
}

/** A setting's list, opened under it: grouped, narrowed by typing, the current one ticked. */
function settingsDropdown(
  panel: SettingsPanel,
  setting: Setting,
  ctx: PanelContext,
  width = 46,
): Drawn {
  const { skin } = ctx
  const inner = width - 2
  const pointer = ctx.pointer
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
      const heading = new Row(inner, skin)
        .space()
        .text(cap(group.toUpperCase(), inner - 2), skin.label)
      if (note) heading.right((r) => r.text(note, skin.hint).space())
      rows.push(heading.build())
    }
    const on = index === (panel.dropdown?.index ?? 0)
    const target = { kind: 'control' as const, id: `choose:${choice.value}` }
    const pointed = sameTarget(pointer.hover, target)
    const r = new Row(inner, skin, pointer)
      .marker(on)
      .space()
      .text(cap(choice.label, inner - 4), on ? skin.you : pointed ? skin.link : (t: string) => t)
    r.right((right) => {
      right
        .text(choice.value === (setting.value || setting.fallback) ? '✓' : ' ', skin.done)
        .space()
    })
    const built = r.build()
    rows.push({
      text: on ? skin.selected(built.text) : pointed ? skin.hovered(built.text) : built.text,
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
  // As wide as it was drawn, and never wider than the terminal it opens over.
  const width = Math.min(62, Math.max(30, ctx.width - 8))
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
            cap(
              talking
                ? 'Press the keys you want to hold to talk.'
                : `Press the keys for ${setting?.title ?? 'this'}.`,
              inner - 9,
            ),
            skin.you,
          )
          .space(8),
      )
      .build(),
    { text: ' '.repeat(inner), hits: [] },
  ]
  const caps = row()
  if (pressed) {
    const width = keysWidth(keyCaps(pressed))
    caps.space(Math.max(1, Math.floor((inner - width) / 2))).keys(keyCaps(pressed))
  } else {
    caps.space(Math.floor((inner - 13) / 2)).text('waiting for a key', skin.hint)
  }
  rows.push(caps.build())
  rows.push({ text: ' '.repeat(inner), hits: [] })
  if (check && !check.ok) {
    for (const line of wrapTo(`▲ ${check.reason}`, inner - 2, 2))
      rows.push(row().space().text(line, skin.bad).build())
  } else if (check?.ok && check.warning) {
    const [first, ...rest] = check.warning.split('. ')
    rows.push(
      row()
        .space()
        .text(cap(`▲ ${first}.`, inner - 2), skin.waiting)
        .build(),
    )
    if (rest.length > 0)
      for (const line of wrapTo(rest.join('. '), inner - 4, 2))
        rows.push(row().space(3).text(line, skin.hint).build())
  } else if (check?.ok) {
    rows.push(
      row()
        .space()
        .text(cap('✓ Nothing in pi or your shell uses this.', inner - 2), skin.done)
        .build(),
    )
  } else {
    rows.push({ text: ' '.repeat(inner), hits: [] })
  }
  rows.push({ text: ' '.repeat(inner), hits: [] })
  const suggested = row().space().text('Suggested: ', skin.hint)
  // Each suggestion is a click that picks it, at the columns the row itself
  // put it in — walking them a second time by hand is how the two answers
  // come to disagree the next time the caps change shape.
  const hits: Hit[] = []
  TALK_SUGGESTIONS.forEach((key, i) => {
    if (i > 0) suggested.space()
    const from = suggested.used
    suggested.keys(keyCaps(key))
    // Only the ones that were drawn: a hit past the edge of the box is a
    // click on a key cap nobody can see.
    if (suggested.used <= inner)
      hits.push({
        row: 0,
        from,
        to: suggested.used - 1,
        target: { kind: 'control', id: `capture-suggest:${key}` },
      })
  })
  rows.push({ text: suggested.build().text, hits })
  for (const line of wrapTo(
    'Never a key that types a character — you have to be able to type a space into your agent.',
    inner - 2,
    2,
  ))
    rows.push(row().space().text(line, skin.hint).build())
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
    const row = new Row(inner, skin).marker(on && !item.off).space()
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
      // A key is never drawn as typed: only that something was.
      .field(panel.purpose === 'account-key' ? masked(panel.text) : panel.text, inner - 2, {
        caret: true,
      })
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
    const r = new Row(inner, skin).marker(on).space()
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

  // What the money bought, beside what it cost: the two numbers are only
  // worth anything together, and a morning that spent forty dollars on three
  // commits is a different morning from one that spent it on thirty.
  rows.push(blank(inner))
  rows.push(row().space().text('PRODUCED', skin.label).build())
  const made = view?.produced
  if (!made || made.commits === 0) {
    rows.push(row().space(3).text('Nothing committed in this window.', skin.hint).build())
  } else {
    const nobody = made.commits - made.attributed
    const line = row().space()
    line.text(pad(`${made.commits} commit${made.commits === 1 ? '' : 's'}`, 13))
    line.text(`+${made.added}`, skin.done).space().text(`−${made.removed}`, skin.bad).space(2)
    line.text(`${made.files} file${made.files === 1 ? '' : 's'}`, skin.hint)
    // Unattributed is always an allowed answer: usually a person committing by
    // hand, sometimes an agent that was never told to write its trailer.
    if (nobody > 0) line.space(2).text(`${nobody} unattributed`, skin.hint)
    rows.push(line.build())
  }
  // Two, not the whole suite: the panel floats over the window and every row
  // it grows is a row of the work underneath that somebody cannot see. The
  // busiest two are the ones worth a glance; `tade spend` lists them all.
  for (const check of (view?.checks ?? []).slice(0, 2)) {
    const took = check.medianMs === null ? '' : `${(check.medianMs / 1000).toFixed(1)}s`
    rows.push(
      row()
        .space()
        .text(pad(check.check, 13))
        .text(pad(`${check.runs} run${check.runs === 1 ? '' : 's'}`, 9), skin.hint)
        .text(
          pad(check.failed > 0 ? `${check.failed} failed` : 'all green', 12),
          check.failed > 0 ? skin.bad : skin.done,
        )
        .text(took, skin.hint)
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

/**
 * As many columns as it is given, with an ellipsis where a word was cut.
 *
 * The difference from `pad` is the whole point: text that stops dead reads as
 * text that ran into what is beside it, which is what it used to do.
 */
export function cap(text: string, width: number): string {
  if (width <= 0) return ''
  if (visibleWidth(text) <= width) return text
  return `${truncateToWidth(text, Math.max(1, width - 1), '')}…`
}

/** `cap`, padded out: exactly `width` columns, so what follows starts where it should. */
function padTo(text: string, width: number): string {
  const short = cap(text, width)
  return short + ' '.repeat(Math.max(0, width - visibleWidth(short)))
}

/**
 * A sentence over at most so many lines, the last one ellipsised: a paragraph
 * that does not fit is shortened where it is read, never past the panel edge.
 */
function wrapTo(text: string, width: number, lines: number): string[] {
  if (width <= 0 || lines <= 0 || text.trim() === '') return []
  const all = wrapTextWithAnsi(text, width)
  if (all.length <= lines) return all
  const kept = all.slice(0, lines)
  kept[lines - 1] = cap(`${kept[lines - 1] ?? ''} ${all.slice(lines).join(' ')}`, width)
  return kept
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
