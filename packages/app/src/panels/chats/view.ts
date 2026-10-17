import { printable } from '@tade/core'
import { sameTarget } from '../../hits.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import { cap } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { BAR, column, type Line, panelSize, rowLook } from '../frame.ts'
import type { ChatRow, ChatsPanel } from './state.ts'

// What bringing a chat back looks like. What a key does to it is beside this
// in `state.ts`.

/** A heading over one of the two lists. */
function heading(text: string, width: number, ctx: PanelContext): Line {
  return new Row(width, ctx.skin).space().text(text, ctx.skin.label).build()
}

/**
 * A conversation, in two rows: what it is called, where it stands and when,
 * then the first thing said in it — which is how a person tells one from
 * another, since every chat in a harness is called the same thing.
 */
function item(
  row: ChatRow,
  at: number,
  panel: ChatsPanel,
  width: number,
  ctx: PanelContext,
): Line[] {
  const { skin } = ctx
  const on = at === panel.index
  const target = { kind: 'control' as const, id: `row:${at}` }
  const pointed = sameTarget(ctx.pointer.hover, target)
  const when = row.at === null ? '' : `${row.kind === 'closed' ? 'closed ' : ''}${ctx.date(row.at)}`
  const top = new Row(width, skin)
    .marker(on)
    .space()
    .text(cap(printable(row.name), 24), on || pointed ? skin.you : skin.busy)
    .text(`  ${printable(row.cwd)}`, skin.hint)
    .right((r) => r.text(when, skin.hint).space())
    .build()
  const said = row.first ? printable(row.first) : 'nothing said in it yet'
  const under = new Row(width, skin)
    .marker(on)
    .space(3)
    .text(cap(said, width - 5), row.first ? (text: string) => text : skin.hint)
    .build()
  const hits = [{ row: 0, from: 0, to: width - 1, target }]
  return [top, under].map((line) => ({ text: rowLook(line.text, skin, { on, pointed }), hits }))
}

/**
 * Bringing a chat back: the chats that were closed whose harness kept the
 * conversation, newest closed first, then the other conversations a harness
 * keeps for the folder a chat opens in. While the harnesses are being asked
 * it says so, and a harness that could not be read is named rather than
 * passed over: an empty list must mean there was nothing.
 */
export function chats(panel: ChatsPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const view = ctx.chats ?? { looking: true, rows: [], problems: [] }
  const { width, rows: tall } = panelSize(ctx, { max: 96 })
  const inner = width - 2 - BAR
  const lines: Line[] = []
  let chosen: { from: number; to: number } | null = null
  view.rows.forEach((row, at) => {
    const before = view.rows[at - 1]
    if (row.kind === 'closed' && at === 0) lines.push(heading('Closed chats', inner, ctx))
    if (row.kind === 'other' && before?.kind !== 'other') {
      if (at > 0) lines.push(blank(inner))
      lines.push(heading('Other conversations, kept by their harness', inner, ctx))
    }
    if (at === panel.index) chosen = { from: lines.length, to: lines.length + 1 }
    lines.push(...item(row, at, panel, inner, ctx))
  })
  if (view.rows.length === 0) {
    lines.push(
      new Row(inner, skin)
        .space()
        .text(
          view.looking
            ? 'Asking each harness what it kept…'
            : 'No closed chat whose conversation was kept, and no other conversation here.',
          skin.hint,
        )
        .build(),
    )
  }
  for (const problem of view.problems) {
    lines.push(
      new Row(inner, skin)
        .space()
        .text(cap(`▲ ${printable(problem)}`, inner - 2), skin.waiting)
        .build(),
    )
  }
  const drawn = column(
    {
      head: [
        new Row(inner, skin)
          .space()
          .text('Each comes back on its own conversation, in its harness and folder.', skin.hint)
          .build(),
        blank(inner),
      ],
      body: {
        lines,
        width: inner,
        scroll: panel.scroll,
        chosen: panel.following ? chosen : null,
      },
      foot: [
        panel.error
          ? new Row(inner, skin)
              .space()
              .text(`▲ ${printable(panel.error)}`, skin.waiting)
              .build()
          : view.looking && view.rows.length > 0
            ? new Row(inner, skin).space().text('asking each harness again…', skin.hint).build()
            : blank(inner),
        new Row(inner, skin, ctx.pointer)
          .space()
          .text(panel.busy ? 'Bringing it back…' : '↑↓ choose · enter brings it back', skin.hint)
          .right((r) => r.button('Cancel', { kind: 'control', id: 'cancel' }).space())
          .build(),
      ],
      rows: tall,
    },
    ctx,
  )
  return box('Bring a chat back', drawn.rows, width, skin, { corner: 'esc' })
}
