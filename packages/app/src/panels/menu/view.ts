import type { Hit } from '../../hits.ts'
import { box, type Drawn, Row } from '../../ui.ts'
import type { PanelContext } from '../context.ts'
import type { MenuPanel } from './state.ts'

// One drawing for every menu there is: the items it was handed, the one the
// keyboard is on marked, and what is said beside each on the right.

export function menu(panel: MenuPanel, ctx: PanelContext): Drawn {
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
