import type { Hit } from '../../hits.ts'
import { completed, GROUPS, parseQuery, SCOPES, type SearchEntry } from '../../search.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import type { PanelContext } from '../context.ts'
import type { SearchPanel } from './state.ts'

// What search looks like. What a key does to it is beside this in `state.ts`.

export function search(panel: SearchPanel, ctx: PanelContext): Drawn {
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
            ? 'Three letters to search inside files.'
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
