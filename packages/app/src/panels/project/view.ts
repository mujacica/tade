import { type Hit, sameTarget } from '../../hits.ts'
import { BAR } from '../../scrollbar.ts'
import { blank, box, type Drawn, fit as fitRow, Row } from '../../ui.ts'
import { bar, cap, listStart, pad, tildeOf } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { completedQuery, nameFrom, type OpenProjectPanel, type OpenRowView } from './state.ts'

// What the Open project panel looks like: where you are as parts you can click
// back to, and one list of everywhere you could work — the projects Tade
// already knows, then this folder and the folders in it, then the folder you
// typed the path of and Tade would make for you.
//
// One list, because two of them shared one index: the down key off the last
// folder landed in the other column, half the recent projects were never drawn
// at all, and the panel grew taller the more of them there were, which moved
// the row you were about to click. It is the window's own scroll area, so the
// wheel, the bar and the arrows are the one move the rest of Tade makes.

/** A line of the list: a heading, something to say about a section, or a row. */
type Line = { head: string } | { hint: string } | { view: OpenRowView; at: number }

/** Rows of the panel that are not the list: the bar, the notice, the two feet. */
const AROUND = 7

export function openProject(panel: OpenProjectPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  // Narrower than it was, because it is one column now rather than two: a
  // table whose last column is pinned forty blanks from its first is a table
  // nobody reads across.
  const width = Math.min(78, ctx.width - 4)
  const inner = width - 2
  // The list keeps a column for its bar, so the text never runs under one and
  // nothing reflows when there stops being anything to scroll.
  const listWidth = inner - BAR
  const pointer =
    ctx.pointer.hover || (panel.field !== 'init' && panel.field !== 'name')
      ? ctx.pointer
      : { ...ctx.pointer, hover: { kind: 'control' as const, id: panel.field } }
  const row = () => new Row(inner, skin, pointer)
  const rows: { text: string; hits: Hit[] }[] = []
  const control = (id: string) => ({ kind: 'control' as const, id })

  // ── back, forward, up, where you are, and a field to narrow or jump ──
  const nav = row()
    .space()
    .button('‹', control('back'), panel.back.length > 0 ? 'rest' : 'off')
    .button('›', control('forward'), panel.forward.length > 0 ? 'rest' : 'off')
    .button('↑', control('up'), panel.dir !== '/' ? 'rest' : 'off')
    .space(2)
  const fieldWidth = Math.min(34, Math.max(16, Math.floor(inner / 3)))
  const crumbs = crumbsOf(ctx.browsing ?? panel.dir, ctx.homeDir)
  const room = inner - nav.used - fieldWidth - 3
  // The end of the path is where you are; the start is what gives way.
  let from = 0
  const widthFrom = (at: number) =>
    crumbs.slice(at).reduce((n, crumb) => n + crumb.label.length + 3, 0) + (at > 0 ? 2 : 0)
  while (from < crumbs.length - 1 && widthFrom(from) > room) from++
  if (from > 0) nav.text('… ', skin.hint)
  crumbs.slice(from).forEach((crumb, i, shown) => {
    const last = i === shown.length - 1
    nav.text(crumb.label, last ? skin.you : skin.busy, control(`go:${crumb.path}`))
    if (!last) nav.text(' / ', skin.hint)
  })
  // What tab would finish the path with, said quietly after the caret.
  const completed = completedQuery(
    panel,
    ctx.openRows.map((one) => one.row),
  )
  // Empty, the field says what it is for — after the caret rather than in
  // place of the value, because the caret is in it the moment the panel opens
  // and a placeholder drawn as the value leaves it saying nothing at all.
  const ghost =
    completed?.startsWith(panel.query) && completed !== panel.query
      ? completed.slice(panel.query.length)
      : panel.query === ''
        ? 'filter, or a path'
        : undefined
  nav.right((r) =>
    r
      .field(panel.query, fieldWidth, {
        caret: panel.field === 'query',
        target: control('query'),
        ghost,
      })
      .space(),
  )
  rows.push(nav.build())
  rows.push(blank(inner))

  // ── the one list: recent projects, then here and what is in it ──
  // As tall as the window allows and never taller: a panel whose height is
  // read off what it holds moves under the pointer between two clicks.
  // The panel is the list, `AROUND`, and its border; what is left of the
  // window is the margin and the strip at the foot it must never cover.
  const list = Math.max(6, Math.min(16, ctx.height - AROUND - 2 - 5))
  const lines: Line[] = []
  let section: string | null = null
  ctx.openRows.forEach((view, at) => {
    const head = view.row.kind === 'recent' ? 'RECENT' : 'FOLDERS'
    if (head !== section) {
      lines.push({ head })
      section = head
    }
    lines.push({ view, at })
  })
  if (lines.length === 0) lines.push({ head: panel.query ? 'NOTHING LIKE THAT' : 'NOTHING HERE' })
  // A folder with nothing under it says so. The rows alone would say it by
  // leaving the section at one line, which is a thing you have to notice.
  // Not where a folder is being offered to make, though: what was typed
  // matching nothing there is what that offer is the answer to, and saying
  // both reads as the offer being a mistake.
  else if (!ctx.openRows.some((one) => one.row.kind === 'folder' || one.row.kind === 'new'))
    lines.push({ hint: panel.query ? 'no folder like that here' : 'no folders here' })
  const chosenLine = Math.max(
    0,
    lines.findIndex((line) => 'view' in line && line.at === panel.index),
  )
  const start = listStart(panel.scroll, lines.length, list, chosenLine)
  const nameWidth = Math.min(
    22,
    Math.max(13, ...ctx.openRows.map((one) => one.row.name.length + 2)),
  )
  // Where it is, for the two rows the crumb bar does not already say it for.
  const pathWidth = Math.max(0, Math.min(28, listWidth - nameWidth - 22))
  const bars = bar({ total: lines.length, shown: list, offset: start, rows: list }, 'panel', ctx)
  for (let i = 0; i < list; i++) {
    const line = lines[start + i]
    const drawn = line
      ? 'head' in line
        ? new Row(listWidth, skin).space().text(line.head, skin.label).build()
        : 'hint' in line
          ? new Row(listWidth, skin).space(3).text(line.hint, skin.hint).build()
          : lineOf(line, panel, ctx, listWidth, nameWidth, pathWidth)
      : blank(listWidth)
    const cell = bars[i]
    rows.push({
      text: `${fitRow(drawn.text, listWidth)}${cell?.cell ?? ' '}`,
      // The wheel is the window's own: it lays a `panel` scroll hit under every
      // row of whatever panel is open, so nothing here adds a second one.
      hits: [
        ...drawn.hits,
        ...(cell ? [{ row: 0, from: listWidth, to: listWidth, target: cell.target }] : []),
      ],
    })
  }
  rows.push(blank(inner))

  // ── what is in the way, and the one option about it ──
  // Always the same height, said or not: a panel that grew when a folder was
  // chosen would move under the pointer, and the second click would land on
  // the folder below the one you meant.
  const chosen = ctx.openRows[panel.index]?.row
  const notice: { text: string; hits: Hit[] }[] = []
  if (panel.error) {
    notice.push(
      row()
        .space()
        .text(cap(`▲ ${panel.error}`, inner - 2), skin.waiting)
        .build(),
    )
  } else if (chosen && !chosen.git && chosen.kind !== 'new') {
    notice.push(
      row()
        .space()
        .text('▲ ', skin.waiting)
        .text(`${chosen.kind === 'here' ? 'This folder' : chosen.name} has no git.`)
        .build(),
    )
    notice.push(
      row()
        .space(3)
        .check(panel.init, "git init, committing what's there", control('init'))
        .build(),
    )
  }
  for (let i = 0; i < 2; i++) rows.push(notice[i] ?? blank(inner))

  // ── the name it will be called, and the act ──
  const known = chosen?.kind === 'recent'
  const name = known ? chosen.name : (panel.name ?? (chosen ? nameFrom(chosen.path) : ''))
  const label = !chosen
    ? 'Choose a folder'
    : panel.busy
      ? chosen.kind === 'new'
        ? 'Creating…'
        : 'Opening…'
      : known
        ? `Go to ${chosen.name}`
        : `${chosen.kind === 'new' ? 'Create' : 'Open'} ${tildeOf(chosen.path, ctx.homeDir)}`
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
            cap(label, 34),
            control('open'),
            panel.busy || !chosen || (!chosen.git && chosen.kind !== 'new' && !panel.init)
              ? 'off'
              : 'primary',
          )
          .space(),
      )
      .build(),
  )
  rows.push(row().space().text('→ in · ← up · tab completes · enter opens', skin.hint).build())
  return box('Open a project', rows, width, skin, { corner: 'esc' })
}

/**
 * One place you could work: what it is, what it is called, and the one thing
 * worth knowing about it — when you last opened it, the branch it is on, or
 * that it is not there yet and Tade would make it.
 */
function lineOf(
  line: { view: OpenRowView; at: number },
  panel: OpenProjectPanel,
  ctx: PanelContext,
  width: number,
  nameWidth: number,
  pathWidth: number,
): { text: string; hits: Hit[] } {
  const { skin } = ctx
  const { view, at } = line
  const on = at === panel.index
  const target = { kind: 'control' as const, id: `row:${at}` }
  const lit = sameTarget(ctx.pointer.hover, target)
  const mark =
    view.row.kind === 'recent'
      ? skin.done('●')
      : view.row.kind === 'here'
        ? skin.signal('◆')
        : view.row.kind === 'new'
          ? skin.signal('+')
          : skin.busy('▸')
  const said =
    view.row.kind === 'here'
      ? 'this folder'
      : view.row.kind === 'recent'
        ? view.row.name
        : `${view.row.name}/`
  const row = new Row(width, skin, ctx.pointer)
    .marker(on, target)
    .text(mark, undefined, target)
    .space()
    .text(pad(cap(said, nameWidth), nameWidth), on || lit ? skin.you : (text) => text, target)
  // Where it is, for a project you already have and a folder that is not
  // there yet — the two the crumb bar above is not already saying it for.
  const where =
    view.row.kind === 'recent' || view.row.kind === 'new' ? tildeOf(view.row.path, ctx.homeDir) : ''
  row.text(pad(cap(where, pathWidth), pathWidth), skin.hint, target)
  if (view.row.kind === 'new') row.text('create · git init', skin.signal, target)
  else if (view.row.kind === 'recent') row.text(view.when ?? '', skin.hint, target)
  else if (view.row.git) row.text(`git · ${view.branch ?? '…'}`, skin.done, target)
  else row.text('no git', skin.hint, target)
  row.right((r) => {
    // A folder goes into on its own arrow, so reaching it never costs the
    // click that would have chosen it.
    if (view.row.kind === 'folder') r.text('›', skin.hint, { kind: 'control', id: `into:${at}` })
    else r.text(' ')
    r.space()
  })
  const built = row.build()
  return {
    text: on ? skin.selected(built.text) : lit ? skin.hovered(built.text) : built.text,
    hits: [{ row: 0, from: 0, to: width - 1, target }, ...built.hits],
  }
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
