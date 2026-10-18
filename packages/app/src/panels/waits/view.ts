import { printable } from '@tade/core'
import { sameTarget } from '../../hits.ts'
import type { Skin } from '../../skin.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import { cap } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { BAR, column, type Line, panelSize, rowLook, searchRow } from '../frame.ts'
import {
  gone,
  pickedOf,
  type WaitRow,
  type WaitStanding,
  type WaitsPanel,
  waitChoices,
} from './state.ts'

// What choosing what queued work waits on looks like. What a key does to it is
// beside this in `state.ts`.

const HEADINGS: Record<WaitRow['group'], string> = {
  now: 'WAITS ON NOW',
  working: 'AGENTS AT WORK',
  queued: 'QUEUED',
}

/** How a standing is painted: what is gone or went wrong is the one thing to act on. */
function tone(standing: WaitStanding, skin: Skin): (text: string) => string {
  if (standing === 'removed' || standing === 'failed') return skin.bad
  if (standing === 'needs you') return skin.waiting
  if (standing === 'working') return skin.busy
  if (standing === 'finished') return skin.done
  return skin.hint
}

/**
 * A task it could wait on, in two rows: ticked or not, its name, and its
 * project and where it stands at the right; under it, why it is waited on
 * where it is picked — a field, which the keyboard writes in on tab — or what
 * it is where it is not.
 */
function item(
  row: WaitRow,
  at: number,
  panel: WaitsPanel,
  width: number,
  ctx: PanelContext,
): Line[] {
  const { skin } = ctx
  const on = at === panel.index
  const target = { kind: 'control' as const, id: `row:${at}` }
  const pointed = sameTarget(ctx.pointer.hover, target)
  const wait = pickedOf(panel, row.task)
  const standing = row.standing === 'removed' ? 'removed — drop it' : row.standing
  const top = new Row(width, skin, ctx.pointer)
    .marker(on)
    .space()
    .check(wait !== undefined, cap(printable(row.name), Math.max(8, width - 30)), target)
    .right((r) =>
      r
        .text(`${printable(row.project)}  `, skin.hint)
        .text(standing, tone(row.standing, skin))
        .space(),
    )
    .build()
  const under = new Row(width, skin, ctx.pointer).marker(on).space(3)
  if (wait) {
    const editing = on && panel.editing
    under.text('why ', skin.label).field(printable(wait.why), width - 9, {
      caret: editing,
      target: { kind: 'control', id: `why:${at}` },
      ...(wait.why || editing ? {} : { ghost: 'tab to say why' }),
    })
  } else {
    under.text(cap(printable(row.about), width - 5), skin.hint)
  }
  const built = under.build()
  const whole = { row: 0, from: 0, to: width - 1, target }
  return [top, built].map((line) => ({
    text: rowLook(line.text, skin, { on, pointed }),
    hits: [whole, ...line.hits],
  }))
}

/**
 * What a piece of queued work waits on: what it waits on now first, ticked —
 * a wait on a task that has gone said so, since it holds the work for ever —
 * then the agents at work, then the rest of the queue. Typing narrows it,
 * space ticks, tab writes why, and enter saves the list as it stands.
 */
export function waits(panel: WaitsPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const view = ctx.waits ?? { task: panel.task, rows: [] }
  // The window's room, so the list keeps its height while typing narrows it.
  const { width, rows: tall } = panelSize(ctx, { max: 100 })
  const inner = width - 2 - BAR
  const choices = waitChoices(view.rows, panel.query)
  const lines: Line[] = []
  let chosen: { from: number; to: number } | null = null
  choices.forEach((row, at) => {
    if (choices[at - 1]?.group !== row.group) {
      if (at > 0) lines.push(blank(inner))
      lines.push(new Row(inner, skin).space().text(HEADINGS[row.group], skin.label).build())
    }
    if (at === panel.index) chosen = { from: lines.length, to: lines.length + 1 }
    lines.push(...item(row, at, panel, inner, ctx))
  })
  if (choices.length === 0) {
    lines.push(
      new Row(inner, skin)
        .space()
        .text(
          view.rows.length === 0
            ? 'Nothing else is queued or at work to wait on.'
            : 'No task like that.',
          skin.hint,
        )
        .build(),
    )
  }
  const stale = view.rows.filter((row) => gone(row) && pickedOf(panel, row.task)).length
  const name = panel.task.split('/').slice(1).join('/') || panel.task
  const keys = panel.busy
    ? 'Saving…'
    : panel.editing
      ? 'enter or tab · done writing why'
      : `space picks · tab why · enter saves · ${panel.picked.length} picked`
  const drawn = column(
    {
      head: [
        searchRow(inner, ctx, {
          text: panel.query,
          says: 'type to narrow',
          caret: !panel.editing,
          ...(panel.query ? {} : { ghost: 'type to narrow by name, project or state' }),
        }),
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
              .text(cap(`▲ ${printable(panel.error)}`, inner - 2), skin.waiting)
              .build()
          : blank(inner),
        new Row(inner, skin, ctx.pointer)
          .space()
          .text(keys, skin.hint)
          .right((r) => {
            if (stale > 0) r.button(`Drop ${stale} gone`, { kind: 'control', id: 'drop-gone' })
            r.space()
              .button('Cancel', { kind: 'control', id: 'cancel' })
              .space()
              .button('Save', { kind: 'control', id: 'save' }, 'primary')
              .space()
          })
          .build(),
      ],
      rows: tall,
    },
    ctx,
  )
  return box(`What ${printable(name)} waits on`, drawn.rows, width, skin, { corner: 'esc' })
}
