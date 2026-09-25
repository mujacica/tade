import { sameTarget } from '../../hits.ts'
import { box, type Drawn, Row } from '../../ui.ts'
import type { PanelContext } from '../context.ts'
import { BAR, column, type Line, panelSize, rowLook } from '../frame.ts'
import type { MenuPanel } from './state.ts'

// One drawing for every menu there is: the items it was handed, the one the
// keyboard is on marked, and what is said beside each on the right.
//
// A menu is the one panel whose height is read off what it holds: its items
// are fixed the whole time it is open, so nothing moves under the pointer
// between two clicks. Past the room there is it scrolls, like everything else.

export function menu(panel: MenuPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  // As wide as its longest item and what is said beside it, within reason —
  // and never wider than the window it is opened over.
  const wanted = Math.max(
    30,
    panel.title.length + 8,
    ...ctx.items.map((item) => item.label.length + (item.off ?? item.note ?? '').length + 6),
  )
  const lines: Line[] = []
  /** Which line the item the keyboard is on ended up on, so it is kept in view. */
  let chosen = 0
  const { width, rows: tall } = panelSize(ctx, {
    max: Math.min(46, wanted) + BAR,
    // A divider is a line of its own, so the count is not the item count.
    needs: ctx.items.length + ctx.items.filter((item) => item.divider).length,
    least: 1,
  })
  const inner = width - 2 - BAR
  ctx.items.forEach((item, at) => {
    if (item.divider) lines.push({ text: skin.chrome('─'.repeat(inner)), hits: [] })
    const target = { kind: 'control' as const, id: `item:${item.id}` }
    // Chosen and pointed at are two different things, here as in every other
    // list: the marker says where the keyboard is, and the lighter ground says
    // what the mouse is over. Drawing a pointed item as chosen made the
    // keyboard look as though it had moved when only the mouse had.
    const on = at === panel.index && !item.off
    const pointed = sameTarget(ctx.pointer.hover, target) && !item.off
    const row = new Row(inner, skin).marker(on).space()
    const paint = item.off
      ? skin.faded
      : item.danger
        ? skin.bad
        : on || pointed
          ? skin.you
          : (t: string) => t
    row.text(item.label, paint, item.off ? undefined : target)
    const note = item.off ?? item.note
    if (note) row.right((r) => r.text(note, skin.hint).space())
    const built = row.build()
    if (at === panel.index) chosen = lines.length
    lines.push({
      text: rowLook(built.text, skin, { on, pointed }),
      hits: built.hits.map((hit) => ({ ...hit, from: 0, to: inner - 1 })),
    })
  })
  const drawn = column(
    {
      body: {
        lines,
        width: inner,
        scroll: panel.scroll,
        chosen: panel.following ? { from: chosen, to: chosen } : null,
      },
      rows: tall,
    },
    ctx,
  )
  return box(panel.title, drawn.rows, width, skin)
}
