import {
  compositeTuiLine,
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'
import {
  duration,
  HARNESS_CHOICES,
  masked,
  type Priced,
  type Setting,
  shownValue,
} from '@tade/core'
import { type Hit, sameTarget, type Target } from './hits.ts'
import { onLine, type Place, placeOf } from './input.ts'
import { checkTalkKey, keyCaps, TALK_SUGGESTIONS } from './keys.ts'
import { linkedRow } from './links.ts'
import { type AgentPane, glyph, MARK_TONES, markOf } from './model.ts'
import {
  bar,
  cap,
  count,
  fitTo,
  pad,
  padTo,
  sideWidth,
  tildeOf,
  withFocus,
  wrapTo,
} from './panels/cells.ts'
import type { PanelContext, PanelDrawing } from './panels/context.ts'
import {
  ACCOUNTS,
  accountActions,
  choicesFor,
  chosenEntry,
  type ExtensionEntry,
  type ExtensionSetupPanel,
  type ExtensionsPanel,
  type ExtensionViewPanel,
  extensionControls,
  extensionEntries,
  type FileAsk,
  type FilePanel,
  fileMatches,
  fileSelection,
  listStart,
  matchingChoices,
  type SettingsPanel,
  type SpendPanel,
  setupControls,
  UPDATES,
  updateActions,
  usesDropdown,
  visibleSettings,
  watchControl,
} from './panels.ts'
import { BAR, barRows } from './scrollbar.ts'
import type { Look, Skin } from './skin.ts'
import { SPEND_BY, SPEND_WINDOWS, type SpendBy, type SpendView } from './spend.ts'
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
} from './viewer.ts'

// How each panel looks. The model of what a panel holds and what a key does to
// it is in `panels.ts`; this only draws it, and names each control so a click
// can find its way back there.
//
// What it is handed and which drawing answers which panel are in
// `panels/context.ts`; the cells they are all built out of are in
// `panels/cells.ts`. This file is what is left while the panels move into
// `panels/<name>/` one at a time, and goes when the last of them has.

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

/**
 * What a command like `npx -y …` does, said once beside it.
 *
 * A reading of what somebody wrote, not a refusal: their command is theirs.
 * The catalogue ships none of these, which is why this only ever appears
 * beside one a person wrote themselves.
 */
const FETCHES = 'This fetches code from the network every time it starts.'

/** What the Extensions panel draws from, and nothing more: the app counts lines with it too. */
export type ExtensionFacts = Pick<
  PanelContext,
  'skin' | 'extensions' | 'written' | 'harnessExtensions' | 'servers' | 'project' | 'date'
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
export function extensions(panel: ExtensionsPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const { width, height, side, body, room, listRoom } = extensionsSize(ctx.width, ctx.height)
  const entries = extensionEntries(
    ctx.extensions,
    ctx.written,
    ctx.harnessExtensions,
    panel.search,
    ctx.servers,
  )
  const here = chosenEntry(panel, entries)
  const controls = extensionControls(here?.id ?? null, ctx.extensions, ctx.written, ctx.servers)
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
        : here?.kind === 'servers'
          ? [
              count(
                ctx.servers.length,
                'server nobody has turned on',
                'servers nobody has turned on',
              ),
            ]
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
    facts.servers,
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
      'What each harness loads by itself, in every agent: its own extensions, its own skills, its own MCP servers. Tade lists these and nothing more — they are not its to turn on, off or configure, and their tools are not Tade’s.',
      1,
    )
    lines.push(blank(form))
    for (const piece of facts.harnessExtensions) {
      lines.push(row().space().text(piece.name).text(`  ${piece.where}`, skin.hint).build())
    }
    return lines
  }

  if (here.kind === 'servers') {
    wrap(
      'Tool servers Tade knows about, none of them on. A server is somebody else’s code with tools your agents will call, so turning one on is yours alone — and then its tools are handed to every agent and to the orchestrator, named by Tade, through this window.',
      1,
    )
    for (const server of facts.servers) {
      lines.push(blank(form))
      const title = row()
        .space()
        .text('○', skin.hint)
        .space()
        // The room the buttons pinned at the right need, measured before the
        // name is cut: a row that does not fit drops its right-hand group,
        // and the button that turns a server on is not one to lose.
        .text(cap(server.title, Math.max(8, form - (server.install ? 36 : 22))), skin.you)
        .text(`  ${server.name}`, skin.hint)
      title.right((r) => {
        // The line that installs it is run in a lane you are looking at, and
        // never behind a spinner.
        if (server.install) r.button('Install…', control(`install:${server.name}`)).space()
        r.button('Turn on', control(`server:${server.name}`), 'primary').space()
      })
      lines.push({
        ...title.build(),
        on: focused === `server:${server.name}` || focused === `install:${server.name}`,
      })
      wrap(server.description, 3)
      wrap(server.how, 3, skin.hint)
      if (server.needs) wrap(server.needs, 3, skin.waiting)
      if (server.fetches) wrap(FETCHES, 3, skin.waiting)
      if (server.install) wrap(`to install: ${server.install}`, 3, skin.hint)
      if (server.note) wrap(server.note, 3, skin.hint)
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
  if (view.server?.install && view.state !== 'ready') {
    items.push({ id: `install:${view.server.name}`, label: 'Install…' })
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
      // What the server itself calls it, so a person reading its own
      // documentation can tell which tool this is.
      const theirs = view.server?.theirs[tool.name]
      if (only) line.right((r) => r.text(only, skin.hint).space())
      else if (theirs && theirs !== tool.name) {
        line.right((r) => r.text(theirs, skin.hint).space())
      }
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

  // What is true of a server and of nothing else: where it is, when anybody
  // last asked it what it offers, and what of that Tade will not hand on. A
  // server that is off was never connected, so there is none of it to say.
  if (view.server) {
    lines.push(blank(form))
    heading('THE SERVER', 'somebody else’s, reached from this window alone')
    wrap(view.server.how, 1, skin.hint)
    // When it was asked, as a person reads a time — and as it was written
    // down where that cannot be read, rather than a guess at what it meant.
    const at = Date.parse(view.server.asked ?? '')
    const asked = Number.isNaN(at) ? view.server.asked : facts.date(at)
    wrap(
      view.server.on
        ? asked
          ? `Last asked what it offers ${asked}.`
          : 'Nothing has asked it what it offers yet.'
        : 'Off, so it has never been connected and there is nothing else to say about it.',
      1,
      skin.hint,
    )
    if (view.server.fetches) wrap(FETCHES, 1, skin.waiting)
    if (view.server.install) wrap(`to install: ${view.server.install}`, 1, skin.hint)
    if (view.server.note) wrap(view.server.note, 1, skin.hint)
    for (const dropped of view.server.dropped) {
      wrap(`${dropped.name} is not offered: ${dropped.why}`, 1, skin.waiting)
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
export function extensionView(panel: ExtensionViewPanel, ctx: PanelContext): Drawn {
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
export function extensionSetup(panel: ExtensionSetupPanel, ctx: PanelContext): Drawn {
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

export function fileView(panel: FilePanel, ctx: PanelContext): Drawn {
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
  // What is selected, placed in the lines once: every row of the body then
  // asks about itself with a comparison, rather than counting the file from
  // the top again on each of them.
  const chosen = edit ? fileSelection(panel) : null
  const selection =
    chosen && edit
      ? { from: placeOf(edit.lines, chosen.from), to: placeOf(edit.lines, chosen.to) }
      : null
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
          ...(selection ? { selection } : {}),
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
          ? selection
            ? '  ctrl+shift+c copies · ctrl+s saves · esc leaves'
            : '  ctrl+s saves · ctrl+f finds · esc leaves'
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
  /** What is selected, as its two ends in the lines: this row may be in it. */
  selection?: { from: Place; to: Place }
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
  // `keep` takes the cells as they were drawn, colour and all, for a paint
  // that only lays a ground under them: a selection is a background the code
  // sits on, and stripping it would take the syntax colouring off everything
  // inside it. A match and the caret are the other way round — they are meant
  // to stand out — so they take the text plain and repaint it.
  const lay = (cell: number, cells: number, paint: (text: string) => string, keep = false) => {
    const from = over.gutter + cell - over.left
    if (cells <= 0 || from < over.gutter || from + cells > over.width) return
    const cut = sliceByColumn(out, from, cells, true)
    const under = keep ? cut : stripTerminalSequences(cut)
    // Half of a wide character is not a cell anything can be laid on, and a
    // paint that came back a different width would tear the row it is in.
    if (visibleWidth(under) > cells) return
    const painted = paint(visibleWidth(under) === 0 ? ' '.repeat(cells) : under)
    if (visibleWidth(painted) !== cells) return
    out = compositeTuiLine(out, painted, from, cells, over.width)
  }
  // Under everything else: a selection is a ground the text sits on, and the
  // matches and the caret are still read where they fall inside it.
  const covered = over.selection ? onLine(over.selection, over.at, over.line.length) : null
  if (covered) {
    const start = cellOf(over.line, covered.from)
    // The break at the end of the line, where the selection runs over it: a
    // cell of its own, so an empty line inside one is not a hole in it.
    const stop = cellOf(over.line, covered.to) + (covered.eol ? 1 : 0)
    // Only the part of it on screen: the body has slid left to keep the caret
    // in view, and a long line reaches past both edges of what is drawn.
    const from = Math.max(start, over.left)
    const to = Math.min(stop, over.left + over.width - over.gutter)
    lay(from, to - from, (text) => skin.selected(text), true)
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

export function settings(panel: SettingsPanel, ctx: PanelContext): PanelDrawing {
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
    { id: UPDATES, title: 'Updates' },
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
      : panel.category === UPDATES
        ? 'Updates'
        : (group?.title ?? '')
  const about = panel.search
    ? 'Every setting whose name or meaning has those words.'
    : panel.category === ACCOUNTS
      ? "Who each harness's agents run as. Signing in is each harness's own, inside this window: what you give it goes where it keeps it, never through Tade. ▸ marks the account new agents use; an agent's own menu moves it to another."
      : panel.category === UPDATES
        ? 'The programs Tade runs, and Tade itself: what is here, how it got here — which is what decides how it moves forward — and what is current. Asking what is current is the one thing here that reaches the network, and it happens when you press it. Nothing installs anything: the exact command is here to read, and running it opens a terminal you can watch.'
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
  } else if (panel.category === UPDATES && !panel.search) {
    drawUpdates(panel, ctx, form, body, (from, to) => {
      focusFrom = from
      focusTo = to
    })
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
    /**
     * A line of the setting you are on, begun the way the first one is: the
     * marker, then the indent it would have had.
     *
     * A setting is as many lines as it needs — its radios, the sentence under
     * it, the meter beside the microphone — and the band that marks it covers
     * all of them, so the bar down its left has to as well. Marking only the
     * first line left a band that stopped a third of the way down the row it
     * was marking, which reads as a drawing that went wrong rather than as one
     * row picked out. The column is taken whether or not the setting is the
     * one you are on, so nothing moves sideways as the keyboard walks down.
     */
    const beneath = (indent: number, pointerOf: Pointer = keys) =>
      new Row(form, skin, pointerOf).marker(focused).space(indent - 1)
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
            beneath(3)
              .radio(option.on, cap(option.label, form - 6), {
                kind: 'control',
                id: `set:${setting.path}=${option.value}`,
              })
              .build(),
          )
        }
      } else {
        const stacked = beneath(3)
        controlCol = stacked.used
        control(stacked, setting, panel, ctx, Math.max(4, form - 4))
        lines.push(stacked.build())
      }
    }
    if (setting.path === 'surfaces.voice.mic.device') {
      // Trying it is the only way to know the terminal may use it.
      const indent = layout.stacked ? 3 : 1 + layout.label + GAP
      const meter = beneath(indent, pointer)
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
        const r = beneath(indent, NO_POINTER)
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
    // A clear line between every setting and the next, the same one every
    // time. Almost every control here is a label or a knob on its own painted
    // ground, so two settings with nothing between them run into one block of
    // colour — the same reason the rows of buttons on the Accounts page are
    // given a gap. Sparing it for the shorter kinds only made the top of a
    // group breathe and the bottom of it crowd, which is what made the page
    // read as unconsidered: a rhythm that changes half way down is one nobody
    // chose. A group longer than the panel scrolls rather than closing up —
    // the form already follows the row you are on, and a list of fifteen key
    // caps with nothing between them is one nobody can read anyway.
    if (at < rows.length - 1) body.push(blank(form))
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

/**
 * The Updates page: the programs Tade runs, and Tade itself.
 *
 * Which programs those are is read off what every driver, harness and forge
 * declares, so nothing here knows there is such a thing as tmux. Each says
 * what is here, how it got here — because that is what decides how it moves
 * forward — and what is current, once somebody has pressed the one button
 * that touches the network. A version nobody could read is drawn as a version
 * nobody could read.
 */
function drawUpdates(
  panel: SettingsPanel,
  ctx: PanelContext,
  form: number,
  body: { text: string; hits: Hit[] }[],
  keepInView: (from: number, to: number) => void,
): void {
  const { skin } = ctx
  const look = ctx.updates ?? null
  const actions = updateActions(look, ctx.updatesBusy === true)
  const focused = panel.focus === 'form' ? (actions[panel.row]?.id ?? null) : null
  const keys = withFocus(ctx.pointer, focused)
  const plain = (text: string) => text

  const say = (text: string, tone = skin.hint, indent = 3, lines = 3) => {
    for (const line of wrapTo(text, Math.max(8, form - indent - 1), lines)) {
      body.push(new Row(form, skin).space(indent).text(line, tone).build())
    }
  }
  const heading = (text: string) =>
    body.push(
      new Row(form, skin)
        .space()
        .text(cap(text, form - 2), skin.brand)
        .build(),
    )
  /** A row of buttons, with the focused one's line remembered so it stays in view. */
  const putButtons = (ids: readonly string[], look_: Look = 'rest', indent = 3) => {
    const mine = actions.filter((action) => ids.includes(action.id))
    if (mine.length === 0) return
    const row = new Row(form, skin, keys).space(indent)
    for (const action of mine) {
      row.button(action.label, { kind: 'control', id: action.id }, look_).space()
    }
    if (focused !== null && mine.some((action) => action.id === focused)) {
      keepInView(body.length, body.length)
    }
    body.push(row.build())
  }
  /**
   * The exact command, drawn where a person reads it before anything runs it —
   * and where there is none, what is in the way of there being one.
   */
  const command = (update: { command: string } | { cannot: string }, indent = 3) =>
    'command' in update
      ? say(update.command, skin.busy, indent, 2)
      : say(`No command: ${update.cannot}.`, skin.hint, indent, 3)

  putButtons(['updates:check'], 'primary')
  say(
    look === null
      ? 'Reading what is installed on this machine…'
      : look.asked
        ? 'Checked just now. Nothing was asked of anybody until you pressed it.'
        : 'Nothing has been asked of the network yet — this is what is installed here.',
  )
  body.push(blank(form))
  if (look === null) return

  // ── Tade itself ──
  heading('Tade')
  const tade = look.tade
  const said = [
    tade.version,
    tade.branch,
    tade.commit,
    tade.from === 'checkout'
      ? `a git checkout at ${tade.where}`
      : (tade.install?.said ?? tade.where),
  ].filter(Boolean)
  say(said.join(' · '), plain)
  // Before anything has been asked, the page has already said so once at the
  // top; saying it again under every line is noise that reads as a problem.
  if (tade.newer) say(`● ${tade.newer}`, skin.waiting)
  else if (!look.asked) say('')
  else if (tade.cannotTell) say(`· ${tade.cannotTell}`, skin.hint)
  else say('✓ This is the newest there is.', skin.done)
  command(tade.update)
  putButtons(['updates:update:tade', 'updates:reload'], 'attention')
  // What reloading costs is the driver's answer, never the driver's name:
  // where lanes outlive the window, restarting it stops nothing.
  const kept = 'Worktrees, branches, the journal, queued work and schedules all survive.'
  say(
    ctx.lanesSurvive
      ? `Reloading restarts the window; agents run outside it and go on working. ${kept}`
      : ctx.running > 0
        ? `Reloading restarts the window, and the ${ctx.running} agent${ctx.running === 1 ? '' : 's'} running inside it stop with it — their conversations are kept, and they open again where they stopped. ${kept}`
        : `Reloading restarts the window. Agents run inside it here, so any at work would stop; there are none. ${kept}`,
    skin.hint,
    3,
    4,
  )
  body.push(blank(form))

  // ── the programs it runs ──
  heading('Programs it runs')
  const named = Math.min(16, Math.max(6, form - 40))
  for (const program of look.programs) {
    const from = body.length
    // The row the keyboard stops on for this program: its button where it
    // has one, and the row itself where it has not.
    const rowId = actions.find((action) => action.about === program.need.command)?.id ?? ''
    const version = program.version ?? (program.install ? 'no version' : '—')
    const mark = !program.install
      ? {
          text: program.need.optional ? '○ not installed, and optional' : '▲ not installed',
          tone: program.need.optional ? skin.hint : skin.waiting,
        }
      : !look.asked
        ? { text: '', tone: skin.hint }
        : program.behind && program.latest
          ? { text: `● ${program.latest} is out`, tone: skin.waiting }
          : program.latest
            ? { text: '✓ current', tone: skin.done }
            : { text: '· cannot tell', tone: skin.hint }
    const target = { kind: 'control' as const, id: rowId }
    // The row the keyboard is on is marked down its left, the same bar every
    // other marked row in the window gets — and the column is taken whether or
    // not it is marked, so nothing shifts as the keyboard walks down the page.
    const name = new Row(form, skin, keys)
      .marker(focused === rowId)
      .space(2)
      .text(padTo(cap(program.need.title, named), named), plain, target)
      .text(padTo(cap(version, 12), 12), program.install ? plain : skin.hint)
      .text(cap(mark.text, Math.max(0, form - named - 17)), mark.tone)
      .build()
    body.push(focused === rowId ? { text: skin.selected(name.text), hits: name.hits } : name)
    // Everything about one program sits under its name: how it got here,
    // which is what decides how it moves forward, then what needs it, then
    // the exact command and the button that runs it.
    const under = 3 + named
    if (program.install) {
      body.push(
        new Row(form, skin)
          .space(under)
          .text(
            cap(
              `${program.install.said} · ${program.install.where}`,
              Math.max(8, form - under - 1),
            ),
            skin.hint,
          )
          .build(),
      )
    }
    say(
      program.need.needed.map((one) => `${one.what}: ${one.why}`).join(' · '),
      skin.hint,
      under,
      2,
    )
    if (!program.need.inUse) say('Nothing Tade is set up to use needs it.', skin.hint, under, 1)
    if (look.asked && program.cannotTell && program.install) {
      say(program.cannotTell, skin.hint, under, 2)
    }
    // The exact command is always on the page, whether or not anything has
    // been asked: what a button would run is read before it is pressed.
    command(program.update, under)
    putButtons([`updates:update:${program.need.command}`], 'rest', under)
    body.push(blank(form))
    // Everything about one program is kept in view together, so walking down
    // the page scrolls past the whole of each rather than its first line.
    if (focused === rowId) keepInView(from, body.length - 1)
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

/** Whether a setting's control fits on the line beside its name. */
function fitsInline(setting: Setting, room: number): boolean {
  // What a setting that opens a list puts on the line is a field, cut to the
  // room it has — never the options, which are in the list. Measuring those
  // sent a setting under its own name for having wordy options it was not
  // going to draw, and left one column of controls with two in it.
  if (usesDropdown(setting)) return room >= 8
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
  if (id === UPDATES && ctx.updates) {
    // Only what was actually asked about counts: a program nobody could ask
    // after is not a program that is up to date, and neither is it one behind.
    const behind =
      ctx.updates.programs.filter((one) => one.behind).length + (ctx.updates.tade.newer ? 1 : 0)
    if (behind > 0) return (row) => row.text(`● ${behind}`, skin.waiting)
  }
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

/**
 * The Spend panel: what it cost, what is left of each plan, what it bought.
 *
 * The table is laid out from the room there is rather than from numbers
 * somebody typed once. A name is the widest thing on the page and the only one
 * that cannot be abbreviated without lying — `openrouter/anthropic/claude-…`
 * and `anthropic/claude-…` are two different bills — so the name column takes
 * whatever the fixed columns leave, wraps onto a second line when that is not
 * enough, and ellipsises only past that. Everything that is cut is cut with
 * `cap`, which says so, and every column has a clear gap before the next:
 * text that stops dead reads as text that ran into its neighbour, which is
 * exactly how two unreadable rows got reported.
 *
 * `MODEL` appears in the Agent view alone. Beside a model, a harness, a
 * sign-in or a provider it either repeats the name column or averages over
 * rows that ran on many models — and in both cases it is spending the width
 * the name needs to say nothing.
 */
export function spend(panel: SpendPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const width = Math.min(SPEND_WIDTH, ctx.width - 4)
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

  // Six facets is more than a narrow panel fits on one line, and a tab that
  // ran off the edge is a grouping nobody can reach. So they wrap, under the
  // word that introduces them.
  let by = row().space().text('by ', skin.hint)
  for (const option of SPEND_BY) {
    if (by.used + visibleWidth(option.label) + 4 > inner) {
      rows.push(by.build())
      by = row().space(4)
    }
    by.tab(option.label, { kind: 'control', id: `by:${option.id}` }, panel.by === option.id)
  }
  rows.push(by.build())
  rows.push(blank(inner))

  const { name, model, meter } = spendColumns(inner, panel.by)
  rows.push(
    row()
      .space(LEAD)
      .text(padTo(SPEND_HEADS[panel.by], name), skin.label)
      .space(SPEND_GAP)
      .text(model > 0 ? `${padTo('MODEL', model)}${' '.repeat(SPEND_GAP)}` : '', skin.label)
      .text('TOKENS'.padStart(TOKENS_W), skin.label)
      .space(SPEND_GAP)
      .text(padTo('SHARE', meter), skin.label)
      .space()
      .text('RUNTIME'.padStart(RUNTIME_W), skin.label)
      .text('COST'.padStart(COST_W), skin.label)
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
  // Counted in lines rather than in rows, because a row is one line or three:
  // the panel floats over the work, and every line it grows is a line of the
  // work underneath that somebody cannot see. Biggest first, so what stops is
  // the tail — and what it left out is said, never quietly dropped.
  let used = 0
  let unshown = 0
  for (const entry of entries) {
    const pane = ctx.panes.find((p) => p.task === entry.label)
    const mark =
      entry.kind === 'orchestrator'
        ? skin.brand('◆')
        : pane
          ? toneOf(pane, skin)(glyph(pane))
          : skin.hint('·')
    const label = pane && pane.project === ctx.project ? pane.name : entry.label
    const said = nameLines(label, entry.note, name)
    if (used + said.length > SPEND_LINES) {
      unshown = entries.length - entries.indexOf(entry)
      break
    }
    const first = said[0] ?? { text: '', note: false }
    const cost = view?.hasCost ? `${pricedMark(entry.priced)}${money(entry.usd)}` : '—'
    rows.push(
      row()
        .space()
        .text(`${mark} `)
        .text(padTo(first.text, name))
        .space(SPEND_GAP)
        .text(model > 0 ? padTo(entry.model ? shortModel(entry.model) : '', model) : '', skin.hint)
        .space(model > 0 ? SPEND_GAP : 0)
        .text(tokenCount(entry.tokens, false).padStart(TOKENS_W))
        .space(SPEND_GAP)
        .meter(entry.tokens / total, meter)
        .space()
        .text(
          (entry.runtime && entry.runtime.ms > 0 ? duration(entry.runtime.ms) : '—').padStart(
            RUNTIME_W,
          ),
          entry.runtime?.running ? skin.busy : undefined,
        )
        // Money nobody priced is marked where it is read, not only in the
        // footer: a column of dollars that quietly mixes the two is the one
        // thing this page may never draw.
        .text(cost.padStart(COST_W), entry.priced === 'exact' ? undefined : skin.hint)
        .build(),
    )
    // The rest of a name too long for its column, and what the row is when its
    // name alone would be read as a thing that exists.
    for (const rest of said.slice(1)) {
      rows.push(
        row()
          .space(LEAD)
          .text(padTo(rest.text, name), rest.note ? skin.hint : undefined)
          .build(),
      )
    }
    used += said.length
  }
  if (unshown > 0) {
    rows.push(
      row()
        .space(3)
        .text(`${unshown} more row${unshown === 1 ? '' : 's'} not shown.`, skin.hint)
        .build(),
    )
  }

  // What a subscription has left, under what it cost: money and a plan are
  // different currencies with no rate between them, so this is its own list
  // and nothing here is added to anything above it. Always now, whichever
  // window the tabs are on — there is no such thing as last Tuesday's plan.
  rows.push(blank(inner))
  rows.push(row().space().text('PLAN', skin.label).build())
  const whose = 17
  const sentence = inner - whose - 2
  // What can be said comes first. A reason is worth reading, and worth
  // reading after the figures somebody opened this to see.
  const standings = [...(view?.plan ?? [])].sort(
    (a, b) => Number(b.windows.length > 0) - Number(a.windows.length > 0),
  )
  if (standings.length === 0) {
    rows.push(row().space(3).text('No harness here has a plan to report.', skin.hint).build())
  }
  // The panel floats over the work, so the section is bounded — and what it
  // left out is said, because a list that stops without saying so reads as a
  // list of everything there is.
  const PLAN_LINES = 9
  let lines = 0
  let dropped = 0
  for (const standing of standings) {
    const drawn: { text: string; hits: Hit[] }[] = []
    if (standing.cannotTell === null) {
      let top = true
      for (const window of standing.windows) {
        const used = Math.round(window.used)
        const tone = used >= 90 ? skin.bad : used >= 75 ? skin.waiting : skin.done
        const left = window.resetsIn
        const line = row()
          .space()
          .text(padTo(top ? standing.label : '', whose))
          .space()
          .text(pad(window.label, 4), skin.hint)
          .meter(Math.min(1, used / 100), 10, tone)
          .space()
          .text(`${used}%`.padStart(4), tone)
          .space(2)
          .text(
            padTo(left === null ? 'no reset given' : `resets in ${duration(left)}`, 17),
            skin.hint,
          )
        // When the harness last said it. The figure is only ever as fresh as
        // the last agent that ran, and a share that has not moved in an hour
        // is an hour-old share rather than one that stopped growing.
        if (top && standing.saidAgo !== null) {
          line.text(`said ${duration(standing.saidAgo)} ago`, skin.hint)
        }
        drawn.push(line.build())
        top = false
      }
    } else {
      // The harness's own sentence, whole: what a person reads is a sentence
      // somebody wrote, never a blank or a zero standing in for one.
      const said = wrapTo(`cannot tell — ${standing.cannotTell}`, sentence, 2)
      said.forEach((part, at) => {
        drawn.push(
          row()
            .space()
            .text(padTo(at === 0 ? standing.label : '', whose))
            .space()
            .text(part, skin.hint)
            .build(),
        )
      })
    }
    if (lines + drawn.length > PLAN_LINES) {
      dropped += 1
      continue
    }
    rows.push(...drawn)
    lines += drawn.length
  }
  if (dropped > 0) {
    rows.push(
      row()
        .space(3)
        .text(`${dropped} more account${dropped === 1 ? '' : 's'} not shown.`, skin.hint)
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
  // Laid out from the room there is, like the table above it: `set one` is a
  // link, and a link cut in half — `no budget — s` — is one nobody can press
  // and nobody can read.
  const bar = inner >= 62 ? 12 : inner >= 50 ? 8 : 6
  const verdictW = Math.max(bar + 6, visibleWidth('no budget — set one'))
  const whoseBudget = Math.min(14, Math.max(8, Math.floor(inner / 5)))
  const spentW = Math.min(28, Math.max(8, inner - 1 - whoseBudget - SPEND_GAP - verdictW))
  for (const budget of budgets.slice(0, 5)) {
    const line = row().space().text(padTo(budget.project, whoseBudget)).space(SPEND_GAP)
    const limit = budget.budget?.usd_per_day
    const spent = limit
      ? `${money(budget.usd)} of ${money(limit)} a day`
      : budget.budget?.tokens_per_day
        ? `${tokenCount(budget.tokens, false)} of ${tokenCount(budget.budget.tokens_per_day, false)} a day`
        : money(budget.usd)
    line.text(padTo(spent, spentW))
    if (budget.share !== null) {
      const tone =
        budget.verdict === 'over' ? skin.bad : budget.verdict === 'warn' ? skin.waiting : skin.done
      line
        .meter(Math.min(1, budget.share), bar, tone)
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
  // What kind of money this page has been adding up. Priced and estimated are
  // both real dollars and both go in the total, but never in silence: a
  // harness that can only estimate says so every turn, and this is where that
  // reaches whoever is reading the total.
  for (const line of wrapTo(pricedFooter(view), inner - 1, 2)) {
    rows.push(row().space().text(line, skin.hint).build())
  }

  return box('Spend', rows, width, skin, { corner: 'esc' })
}

/** As wide as the table wants, and never wider than the window it floats over. */
const SPEND_WIDTH = 84

/** A space, the state mark, and the space after it: where every name starts. */
const LEAD = 3
/** The clear column between one column and the next. Never zero: that was the bug. */
const SPEND_GAP = 2
const TOKENS_W = 6
const RUNTIME_W = 7
/** Room for the figure and the mark that says whether anybody priced it. */
const COST_W = 9

/** How many lines the table may take before it starts saying what it left out. */
const SPEND_LINES = 10

/** What the first column is, in the words of the facet it is grouped by. */
const SPEND_HEADS: Readonly<Record<SpendBy, string>> = {
  agent: 'AGENT',
  project: 'PROJECT',
  model: 'MODEL',
  harness: 'HARNESS',
  account: 'SIGN-IN',
  provider: 'PROVIDER',
}

/**
 * How the table's width is divided, given the room there is.
 *
 * The fixed columns are figures and take what a figure takes. Everything left
 * over is the name's, except the share meter, which is decoration and gives
 * ground first — it is the one column that says nothing a number beside it
 * does not already say.
 */
export function spendColumns(
  inner: number,
  by: SpendBy,
): { name: number; model: number; meter: number } {
  const figures = LEAD + SPEND_GAP + TOKENS_W + SPEND_GAP + 1 + RUNTIME_W + COST_W
  let room = inner - figures
  // The model column is worth its width in the Agent view — and only while
  // there is still a name left beside it. A panel narrow enough that both
  // cannot be read is a panel where the name wins: it is the only column here
  // whose value is the whole of it.
  let model = 0
  if (by === 'agent') {
    const want = inner >= 82 ? 18 : inner >= 66 ? 14 : 10
    if (room - want - SPEND_GAP >= MIN_NAME + 6) {
      model = want
      room -= want + SPEND_GAP
    }
  }
  // The meter gives ground first and disappears last: it is the one column
  // that says nothing the number beside it does not already say.
  const meter = room >= 40 ? 10 : room >= 30 ? 8 : room >= 22 ? 6 : 0
  return { name: Math.max(4, room - meter), model, meter }
}

/** Below this a name is not a name, so the column beside it gives way instead. */
const MIN_NAME = 10

/**
 * A name over the lines it needs, with what the row is underneath it.
 *
 * Two lines for the name, because twice a column holds every model id and task
 * name there is, and the last of them ellipsised — a name cut without saying
 * so is a name a person misreads rather than looks up. The note is its own
 * line in its own tone: `not recorded` is not an agent called that.
 */
export function nameLines(
  label: string,
  note: string | null,
  width: number,
): { text: string; note: boolean }[] {
  const lines = wrapTo(label, width, 2).map((text) => ({ text, note: false }))
  if (lines.length === 0) lines.push({ text: cap(label, width), note: false })
  if (note) lines.push({ text: cap(note, width), note: true })
  return lines
}

/** The one character that says this figure holds money nobody priced. */
function pricedMark(priced: Priced): string {
  return priced === 'estimate' || priced === 'mixed' ? '~' : ''
}

/** What the page says, at the bottom, about the kind of money it has been adding. */
export function pricedFooter(view: SpendView | null): string {
  const plan = 'a plan is a share, never money'
  if (!view || view.priced === 'none') {
    // Zero dollars from a subscription is not the same as free.
    return `No harness here reported a price — a subscription bills you, not per token · ${plan}.`
  }
  const exact = `${money(view.usdExact)} priced by the harness`
  const guessed = `${money(view.usdEstimated)} estimated (~)`
  if (view.priced === 'mixed') return `${money(view.usd)}: ${exact}, ${guessed} · ${plan}.`
  if (view.priced === 'estimate') {
    return `${guessed} — this harness cannot price a turn, only guess at it · ${plan}.`
  }
  return `${exact}, against its own catalog · ${plan}.`
}

function toneOf(pane: AgentPane, skin: Skin): (text: string) => string {
  return skin[MARK_TONES[markOf(pane)]]
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
