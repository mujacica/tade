import { visibleWidth } from '@earendil-works/pi-tui'
import { KEYS_AND_AGENTS } from '@tade/core'
import { type Hit, sameTarget } from '../../hits.ts'
import { linkedRow } from '../../links.ts'
import { blank, box, type Drawn, NO_POINTER, Row } from '../../ui.ts'
import { markdownLines } from '../../viewer.ts'
import { cap, count, sideWidth, withFocus, wrapTo } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { BAR, beside, column, type Line, panelSize, searchRow, startOf } from '../frame.ts'
import { type ExtensionFacts, extensionBody } from './body.ts'
import { type ExtensionSetupPanel, type ExtensionViewPanel, setupControls } from './setup.ts'
import { chosenEntry, type ExtensionsPanel, extensionControls, extensionEntries } from './state.ts'

// What the Extensions page looks like: the list down the side, one of them in
// full beside it, and the two panels that open out of it. What it says about
// the one you are on is in `body.ts`.

/**
 * How big the Extensions panel is, and how its two sides divide the room.
 *
 * The size is `panelSize`, like every other panel's: the room there is, less
 * the margin and the strip at the foot it must never cover. Capped at 120
 * columns only because prose read across a whole ultrawide is prose nobody
 * reads. What is its own is the split — a list down the left, an extension's
 * own account of itself on the right, each with its own bar.
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
  const size = panelSize({ width, height }, { max: 120 })
  const side = sideWidth(size.inner) + BAR
  return {
    width: size.width,
    height: size.height,
    inner: size.inner,
    side,
    body: size.inner - side - 1,
    // What is left after the head that stays put and the two rows at the foot.
    room: Math.max(1, size.rows - HEAD - 2),
    // What is left after the search field with its blank row.
    listRoom: Math.max(1, size.rows - 2),
  }
}

/** Rows of the right-hand side that never scroll: which extension this is, and its shape. */
const HEAD = 3

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
  const { width, height, side, body } = extensionsSize(ctx.width, ctx.height)
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
  const asideHead: Line[] = [
    searchRow(names, ctx, {
      text: panel.search,
      says: 'search extensions',
      caret: panel.focus === 'search',
    }),
    blank(names),
  ]
  const aside: Line[] = []
  const at = Math.max(
    0,
    entries.findIndex((entry) => entry.id === here?.id),
  )
  for (const entry of entries) {
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

  // ── the foot ──
  // Only what is happening. Where an extension of your own goes is said by
  // `tade extensions --help` and by the folder the page already names beside
  // one; under every extension there is, it was a line of instructions nobody
  // was reading.
  const said = panel.said
    ? new Row(told, skin)
        .space()
        .text(cap(panel.said, told - 2), skin.busy)
        .build()
    : blank(told)
  // Done is pinned to the foot, which no part of the page scrolls over: a
  // button that reading past the fold takes away is a button that is gone.
  // Said as fully as there is room for, and never cut mid-word: a hint with
  // an ellipsis in it has stopped being a hint.
  const how = told >= 44 ? 'tab moves · ↑↓ reads · enter presses' : '↑↓ · enter'
  const keys = new Row(told, skin, ctx.pointer)
    .space()
    .text(cap(how, told - 12), skin.hint)
    .right((r) => r.button('Done', { kind: 'control', id: 'close' }, 'primary').space())

  // ── the two of them, each with its own bar ──
  // A bar runs beside what it scrolls and nowhere else: the search field keeps
  // its own row, and so do the two at the foot.
  const tall = height - 2
  const left = column(
    {
      head: asideHead,
      body: {
        lines: aside,
        width: names,
        scroll: panel.listScroll,
        chosen: { from: at, to: at },
        area: 'panel-side',
      },
      rows: tall,
    },
    ctx,
  )
  const right = column(
    {
      head,
      body: {
        lines,
        width: told,
        scroll: panel.scroll,
        chosen: panel.following && focused ? { from: focusFrom, to: focusTo } : null,
      },
      foot: [said, keys.build()],
      rows: tall,
    },
    ctx,
  )
  return box('Extensions', beside(left.rows, right.rows, side, skin), width, skin, {
    corner: 'esc',
  })
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
 * What an extension shows when its status is clicked: its document, formatted,
 * as tall as the window allows and scrolled with the arrows. It is asked again
 * while it is open, so what it shows stays current.
 */
export function extensionView(panel: ExtensionViewPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const { width, rows: tall } = panelSize(ctx, { max: 110 })
  // The page keeps a column for its bar: it is somebody else's document and
  // there is no telling how long it is until it has been laid out.
  const inner = width - 2 - BAR
  const lines = ctx.extensionView
    ? markdownLines(ctx.extensionView.markdown, inner - 2, !skin.colour).map((line) =>
        linkedRow(` ${line}`, inner, skin, ctx.pointer),
      )
    : [new Row(inner, skin).space().text('Looking…', skin.hint).build()]
  // Where it ended up, worked out once and handed to the column: the bar says
  // it as a picture, and the foot says it in figures, because a document of
  // somebody else's is one you want to be able to say where you are in.
  const room = Math.max(1, tall - 1)
  const start = startOf(panel.scroll, lines.length, room)
  const drawn = column(
    {
      body: { lines, width: inner, scroll: start },
      foot: [
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
      ],
      rows: tall,
    },
    ctx,
  )
  return box(ctx.extensionView?.title ?? 'Extension', drawn.rows, width, skin, { corner: 'esc' })
}

/**
 * Setting an extension up: what it needs, in steps; links worth opening; the
 * fields to fill in, with what they can be chosen from; and what saving came
 * to — ready, or what is still missing.
 */
export function extensionSetup(panel: ExtensionSetupPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const { width, rows: tall } = panelSize(ctx, { max: 96 })
  // The guide keeps a column for its bar. It used to be cut at the panel's
  // height with `rows.slice` — so an extension with a long guide lost its own
  // Save button off the bottom, which is the one thing a foot may never do.
  const inner = width - 2 - BAR
  const setup = ctx.setup
  const controls = setupControls(setup?.fields ?? [])
  const chosen = controls[panel.index] ?? null
  const pointer =
    ctx.pointer.hover?.kind === 'control'
      ? ctx.pointer
      : { ...ctx.pointer, hover: chosen ? { kind: 'control' as const, id: chosen } : null }
  const row = () => new Row(inner, skin, pointer)
  const rows: Line[] = []
  /** Where the control the keyboard is on ended up, so tabbing keeps it in view. */
  let focusFrom = 0
  let focusTo = 0
  const marking = (id: string) => {
    if (chosen === id) {
      focusFrom = rows.length
      focusTo = rows.length
    }
  }
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
  // Said where the key is about to be pasted, because that is where the
  // decision is, and it is the one thing about a credential that is not on
  // the page: the field says what it is for, the value says what it is, and
  // neither says who else can read it. Once above the fields rather than
  // under each of them — it is the same fact about all of them.
  if (setup.fields.some((field) => field.kind === 'secret')) {
    // As many lines as it takes, like the guide above it and unlike a note
    // under a control: what is cut here is the way out, which is the half
    // that turns this from a warning into something to do about it. Three
    // lines on an ordinary terminal, nine on one nobody should be using.
    for (const line of wrapTo(KEYS_AND_AGENTS, inner - 2, 12)) {
      rows.push(row().space().text(line, skin.hint).build())
    }
    rows.push(blank(inner))
  }
  const label = 16
  for (const field of setup.fields) {
    const focused = chosen === `field:${field.key}`
    marking(`field:${field.key}`)
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
      // A key is drawn as itself, here and everywhere else: it is in the
      // config in plain text, and one you cannot read is one you cannot check
      // against the console that issued it.
      r.field(value, Math.max(10, inner - label - 4), {
        caret: focused,
        target: { kind: 'control', id: `field:${field.key}` },
        ...(value === '' && field.kind === 'secret' && field.have
          ? { ghost: `in use — ${field.have}` }
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
        marking(`pick:${field.key}:${choice}`)
        picks.button(choice, { kind: 'control', id: `pick:${field.key}:${choice}` }).space()
      }
      rows.push(picks.build())
    }
  }
  const drawn = column(
    {
      body: {
        lines: rows,
        width: inner,
        scroll: panel.scroll,
        chosen: panel.following && chosen ? { from: focusFrom, to: focusTo } : null,
      },
      foot: [
        panel.error
          ? row().space().text(`▲ ${panel.error}`, skin.waiting).build()
          : panel.said
            ? row().space().text(panel.said, skin.done).build()
            : blank(inner),
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
      ],
      rows: tall,
    },
    ctx,
  )
  return box(`Set up ${setup.title}`, drawn.rows, width, skin, { corner: 'esc' })
}
