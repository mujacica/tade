import { visibleWidth } from '@earendil-works/pi-tui'
import type { WorkflowField, WorkflowPlace } from '@tade/core'
import { treeStems } from '../../plan-graph.ts'
import type { Skin } from '../../skin.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import { wrapWords } from '../../view/text.ts'
import { cap, padTo } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { BAR, beside, column, itemSpan, type Line, listRow, panelSize, TWO_PANE } from '../frame.ts'
import { type WorkflowPanel, workflowControls } from './state.ts'

// Writing a stored workflow, drawn: the templates and their steps down the
// left, the form for the one you are on down the right, and under the form the
// preview.
//
// **The preview is the resolved tree, drawn the way the queue is drawn down
// the side** (`treeStems`) rather than as boxes. A column is a depth in the
// tree and work that can run side by side lines up under work that can run
// side by side, which is the whole of what the picture says; the boxes are for
// a pane, and this is a panel column. Folding the indent back at some level is
// the one thing that may never happen — it puts two steps that cannot run
// together in one column.
//
// **What refuses a draft is what is drawn under the preview.** Not a second
// reading of the same template: `templateProblems` is the function publishing
// refuses on, and its words are the words on the page, so a form can never
// show a clean draft that the publish then turns down.

/** The label column of the form, so the values line up down the page. */
const LABEL = 16

/** How wide the list down the left is: enough for a template name and a step's. */
const SIDE = 30

export function workflow(panel: WorkflowPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const { width, rows: tall } = panelSize(ctx, { max: TWO_PANE })
  const inner = width - 2
  const side = Math.min(SIDE, Math.max(12, Math.floor(inner / 3)))
  const right = inner - side - 1 - BAR
  const shown = ctx.workflow
  const row = (room: number) => new Row(room, skin, ctx.pointer)

  const list: Line[] = []
  for (const [at, one] of (shown?.rows ?? []).entries()) {
    const on = one.template === panel.template && one.step === panel.row
    const target = { kind: 'control' as const, id: `row:${one.id}` }
    const built = row(side)
      .space(one.step < 0 ? 1 : 3)
      .text(cap(one.label, Math.max(2, side - (one.step < 0 ? 3 : 5))), on ? skin.you : (t) => t)
      .build()
    const pointed =
      ctx.pointer.hover?.kind === 'control' && ctx.pointer.hover.id === `row:${one.id}`
    list.push(...listRow(built, { width: side, target, on, pointed }, skin))
    if (one.step < 0 && one.note) {
      list.push(
        row(side)
          .space(3)
          .text(cap(one.note, side - 4), skin.hint)
          .build(),
      )
    }
    void at
  }
  if (list.length === 0) {
    list.push(blank(side), row(side).space().text('no templates yet', skin.hint).build())
  }

  const form: Line[] = []
  const fields = shown?.fields ?? []
  const controls = workflowControls(fields)
  const at = controls[panel.index] ?? ''
  if (!shown || shown.problem) {
    form.push(
      blank(right),
      ...wrapWords(shown?.problem ?? (panel.busy ? 'Reading…' : 'Nothing to show.'), right - 3).map(
        (text) =>
          row(right)
            .space()
            .text(text, shown?.problem ? skin.bad : skin.hint)
            .build(),
      ),
    )
  } else {
    form.push(blank(right), ...heading(row, right, shown.title, shown.says, skin))
    for (const field of fields) {
      const here = at === `field:${field.id}`
      form.push(...fieldRows(row, right, field, panel, here, ctx))
    }
    form.push(blank(right), ...heading(row, right, 'WHAT IT WOULD MAKE', '', skin))
    form.push(...preview(row, right, shown.places, skin))
    for (const problem of shown.problems) {
      form.push(
        ...wrapWords(`refuses  ${problem}`, right - 4).map((text) =>
          row(right).space(2).text(text, skin.bad).build(),
        ),
      )
    }
    for (const warning of shown.warnings) {
      form.push(
        ...wrapWords(`warning  ${warning}`, right - 4).map((text) =>
          row(right).space(2).text(text, skin.waiting).build(),
        ),
      )
    }
    form.push(blank(right), ...heading(row, right, 'PUBLISHED', '', skin))
    form.push(
      row(right)
        .space(2)
        .text(
          shown.published.length === 0
            ? 'none yet — publishing takes a snapshot at its version, and a published version never changes'
            : `${shown.published.map((one) => `v${one}`).join(' · ')} — each one immutable`,
          skin.hint,
        )
        .build(),
    )
  }

  const chosen = at.startsWith('field:')
    ? itemSpan(
        Math.max(
          0,
          fields.findIndex((one) => `field:${one.id}` === at),
        ),
      )
    : null
  const body = column(
    {
      body: {
        lines: beside(list, form, side, skin),
        width: inner - BAR,
        scroll: panel.scroll,
        ...(panel.following && chosen ? { chosen } : {}),
      },
      foot: [said(row(inner - BAR), panel, skin, inner - BAR), foot(row(inner - BAR), panel, ctx)],
      rows: tall,
    },
    ctx,
  )
  return box(cap(panel.template || 'Workflows', width - 10), body.rows, width, skin, {
    corner: 'esc',
  })
}

/** One field of the form: its label, then the control, then what it means. */
function fieldRows(
  row: (room: number) => Row,
  width: number,
  field: WorkflowField,
  panel: WorkflowPanel,
  here: boolean,
  ctx: PanelContext,
): Line[] {
  const { skin } = ctx
  const value = panel.typing?.id === field.id ? panel.typing.value : field.value
  const target = { kind: 'control' as const, id: `field:${field.id}` }
  const r = row(width).space()
  r.text(padTo(field.label, LABEL), here ? skin.label : skin.hint)
  const room = Math.max(6, width - LABEL - 4)
  if (field.off) {
    r.text(cap(value || '—', room), skin.faded)
  } else if (field.kind === 'check') {
    r.check(value === 'true', field.value === 'true' ? 'yes' : 'no', target)
  } else if (field.kind === 'choice') {
    r.button(`${value || '—'} ▾`, target)
  } else {
    r.field(value, room, { caret: here && panel.typing?.id === field.id, target })
  }
  const lines = [r.build()]
  // Said only for the one the keyboard is on, and only where the consequence
  // is not guessable from the name: a sentence under every row of a form is a
  // page nobody reads twice.
  const under = here ? (field.off ?? field.means) : undefined
  if (under) {
    for (const text of wrapWords(under, Math.max(10, width - LABEL - 4))) {
      lines.push(
        row(width)
          .space(1 + LABEL)
          .text(text, field.off ? skin.faded : skin.hint)
          .build(),
      )
    }
  }
  return lines
}

/**
 * The preview: a column per depth in the resolved tree, with the stems the
 * queue's own drawing uses, and each step's reason for waiting hung off the
 * wait it explains.
 */
function preview(
  row: (room: number) => Row,
  width: number,
  places: readonly WorkflowPlace[],
  skin: Skin,
): Line[] {
  if (places.length === 0) {
    return [row(width).space(2).text('no steps yet — + adds one', skin.hint).build()]
  }
  // In the resolved order, so the stems hang off something already drawn.
  const order = [...places].sort((a, b) => a.depth - b.depth || a.at - b.at)
  const index = new Map(order.map((one, i) => [one.at, i]))
  const parents = order.map((one) => (one.parent < 0 ? -1 : (index.get(one.parent) ?? -1)))
  const stems = treeStems(
    parents,
    order.map((one) => one.depth),
  )
  const lines: Line[] = []
  for (const [i, one] of order.entries()) {
    const stem = stems[i]?.stem ?? ''
    const r = row(width).space(2).text(stem, skin.chrome)
    r.text(
      cap(one.name, Math.max(2, width - visibleWidth(stem) - 6)),
      one.circular ? skin.bad : (t) => t,
    )
    if (one.circular) r.space().text('in a cycle', skin.bad)
    lines.push(r.build())
    for (const wait of one.why) {
      const bars = stems[i]?.bars ?? ''
      lines.push(
        row(width)
          .space(2)
          .text(bars, skin.chrome)
          .text(
            cap(
              `after ${wait.on} — ${wait.why || 'no reason given, and a wait with no reason is one nobody can answer later'}`,
              Math.max(4, width - visibleWidth(bars) - 5),
            ),
            wait.why ? skin.hint : skin.waiting,
          )
          .build(),
      )
    }
  }
  return lines
}

/** The row above the buttons: the question, or what the page last said. */
function said(r: Row, panel: WorkflowPanel, skin: Skin, width: number): Line {
  if (panel.asking) {
    return r
      .space()
      .text(
        cap(
          'Publish it? It takes a snapshot at its version, and a published version never changes.  y / n',
          width - 3,
        ),
        skin.waiting,
      )
      .build()
  }
  const text = panel.problem ?? panel.said ?? ''
  return r
    .space()
    .text(cap(text, width - 3), panel.problem ? skin.bad : skin.hint)
    .build()
}

/** The acts, and the way out. */
function foot(r: Row, panel: WorkflowPanel, ctx: PanelContext): Line {
  const { skin } = ctx
  if (panel.asking) {
    r.space()
      .button('Yes', { kind: 'control', id: 'yes' }, 'primary')
      .space()
      .button('No', { kind: 'control', id: 'no' })
      .space()
    r.right((g) => g.text('escape is no', skin.hint).space())
    return r.build()
  }
  const shown = ctx.workflow
  if (shown && !shown.problem) {
    r.space().button('+ Step', { kind: 'control', id: 'add' })
    if (panel.row >= 0) r.space().button('× Step', { kind: 'control', id: 'remove' }, undefined)
    r.space().button('Publish', { kind: 'control', id: 'publish' }, 'primary')
  }
  r.space()
  r.right((g) =>
    g
      .text('← → steps · tab fields', skin.hint)
      .space(2)
      .button('Close', { kind: 'control', id: 'close' })
      .space(),
  )
  return r.build()
}

/** A heading: its name, a rule, and a note at the right. */
function heading(
  row: (room: number) => Row,
  width: number,
  label: string,
  note: string,
  skin: Skin,
): Line[] {
  const r = row(width)
    .space()
    .text(cap(label, Math.max(4, width - 6)), skin.label)
    .space()
  const text = note ? cap(note, Math.max(0, width - r.used - 4)) : ''
  r.text(
    '─'.repeat(Math.max(1, width - r.used - visibleWidth(text) - (text ? 2 : 0) - 1)),
    skin.chrome,
  )
  if (text) r.right((g) => g.text(text, skin.hint).space())
  return [r.build()]
}
