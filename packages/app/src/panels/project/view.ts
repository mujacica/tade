import type { Hit } from '../../hits.ts'
import { blank, box, type Drawn, fit as fitRow, Row } from '../../ui.ts'
import { pad, tildeOf } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { nameFrom, type OpenProjectPanel } from './state.ts'

// What the Open project panel looks like: where you are as parts you can click
// back to, the folders on the left and what is known about one on the right.

export function openProject(panel: OpenProjectPanel, ctx: PanelContext): Drawn {
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
        .text(`${chosen.kind === 'here' ? 'This folder' : chosen.name} isn't a git repository.`)
        .build(),
    )
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
  rows.push(row().space().text('→ in · ← up · enter opens', skin.hint).build())
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
