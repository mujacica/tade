import { visibleWidth } from '@earendil-works/pi-tui'
import { MATERIAL_LABEL } from '@tade/core'
import { inboxMark } from '../../intake-view.ts'
import type { Skin } from '../../skin.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import { wrapWords } from '../../view/text.ts'
import { cap, padTo } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { BAR, column, type Line, panelSize } from '../frame.ts'
import type { IntakePanel } from './state.ts'

// One request from outside this machine, drawn.
//
// Four regions, in this order, and the order is the argument:
//
// 1. **Where it came from** — the provenance, as label-and-value facts. This
//    machine's own record of what arrived and what allowed it, including the
//    dotted path of the grant, because "which policy allowed this" is only
//    honestly answerable as the key somebody can go and remove.
// 2. **What approving it would start** — the tasks, their waits, what bounds
//    them. Nothing is started by looking.
// 3. **The request itself**, under `MATERIAL_LABEL`, with the whole wording of
//    what material means inside what is drawn, in the same bytes the agent
//    working on it reads.
// 4. **The acts**, pinned at the foot, where a button reading past the fold
//    takes away is a button that is gone.
//
// **The label over region 3 is not this file's to choose.** A drawing that
// wrote its own words for it would be one edit away from softening them, and a
// drawing with no label at all is a page that hands somebody a stranger's
// instructions as though Tade had written them.
//
// **A judge's reading, where there is one, is marked as advice and is never
// the reason given for anything.** There is none wired in yet; when there is,
// it goes beside the question in the judge's own words, and the button copy
// still never mentions it.

/** The widest it is worth being: facts and short names, with room for a quoted request. */
const WIDEST = 96

/** The label column of the facts, so the values line up down the page. */
const LABEL = 18

export function intake(panel: IntakePanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const { width, rows: tall } = panelSize(ctx, { max: WIDEST })
  const inner = width - 2 - BAR
  const row = () => new Row(inner, skin, ctx.pointer)
  const shown = ctx.intake
  const lines: Line[] = []

  if (!shown) {
    lines.push(
      blank(inner),
      row()
        .space()
        .text(
          panel.problem ?? (panel.busy ? 'Reading…' : 'Nothing is known about it.'),
          panel.problem ? skin.bad : skin.hint,
        )
        .build(),
    )
  } else {
    const mark = inboxMark(shown.row)
    lines.push(blank(inner))
    lines.push(
      row()
        .space()
        .text(mark.glyph, toneFor(mark.tone, skin))
        .space()
        .text(mark.word, toneFor(mark.tone, skin))
        .space(2)
        .text(cap(shown.row.because, Math.max(4, inner - 16)), skin.hint)
        .build(),
    )
    lines.push(blank(inner), ...heading(row, 'WHERE IT CAME FROM', '', inner, skin))
    for (const fact of shown.facts) {
      lines.push(
        row()
          .space()
          .text(padTo(fact.label, LABEL), skin.hint)
          .text(cap(fact.value, Math.max(4, inner - LABEL - 3)))
          .build(),
      )
    }
    if (shown.would) {
      const would = shown.would
      lines.push(blank(inner), ...heading(row, 'WHAT APPROVING IT STARTS', '', inner, skin))
      for (const line of starts(row, would, inner, skin)) lines.push(line)
    }
    // Where it lives at its source, as the link it is: clicking a url is the
    // window's own act everywhere, so this page grows no button of its own for
    // it. Only `http` and `https` — a source's reference is not always
    // something a browser should be handed.
    if (/^https?:\/\//.test(shown.row.url)) {
      lines.push(
        blank(inner),
        row()
          .space()
          .text(cap(shown.row.url, inner - 3), skin.link, { kind: 'link', url: shown.row.url })
          .build(),
      )
    }
    lines.push(blank(inner), ...heading(row, MATERIAL_LABEL, '', inner, skin))
    const material = shown.material
    lines.push(
      row()
        .space()
        .text(
          cap(material.where ?? material.ref ?? 'nowhere Tade wrote it down', inner - 3),
          skin.hint,
        )
        .build(),
    )
    if (material.body === null) {
      lines.push(
        blank(inner),
        ...wrapWords(material.problem ?? 'there is nothing to read', inner - 4).map((text) =>
          row().space(2).text(text, skin.hint).build(),
        ),
      )
    } else {
      lines.push(blank(inner))
      // Quoted down its left edge, every line of it, and never cut: a request
      // whose last paragraph was dropped is a request somebody answered half
      // of. The body scrolls, as the whole page does.
      for (const text of quoted(material.body, Math.max(8, inner - 5))) {
        lines.push(row().space().text('│', skin.chrome).space().text(text).build())
      }
    }
  }

  const drawn = column(
    {
      body: { lines, width: inner, scroll: panel.scroll },
      foot: [said(row(), panel, skin, inner), foot(row(), panel, ctx)],
      rows: tall,
    },
    ctx,
  )
  return box(cap(shown?.row.externalId ?? panel.title, width - 10), drawn.rows, width, skin, {
    corner: 'esc',
  })
}

/**
 * The request's own lines, wrapped to the room there is — worked out once per
 * body and width rather than four times a second.
 *
 * A page is drawn every frame while it is open, and a request is as long as
 * whoever wrote it made it: re-wrapping a few thousand lines on every frame is
 * the shape of slowness the window is held away from, and the fix is the one
 * the transcript and the file viewer already use — cache what is formatted,
 * never cap what is drawn.
 */
let wrapped: { body: string; width: number; lines: readonly string[] } | null = null

function quoted(body: string, width: number): readonly string[] {
  if (wrapped && wrapped.body === body && wrapped.width === width) return wrapped.lines
  const lines = body
    .replace(/\s+$/, '')
    .split('\n')
    .flatMap((text) => (text === '' ? [''] : wrapWords(text, width)))
  wrapped = { body, width, lines }
  return lines
}

/** What approving it would start, as rows: the task, how it is finished, what it waits on. */
function starts(
  row: () => Row,
  would: NonNullable<PanelContext['intake']>['would'],
  inner: number,
  skin: Skin,
): Line[] {
  if (!would) return []
  const lines: Line[] = []
  if (would.problems.length > 0) {
    for (const problem of would.problems) {
      lines.push(
        ...wrapWords(problem, inner - 4).map((t) => row().space(2).text(t, skin.bad).build()),
      )
    }
    return lines
  }
  const widest = Math.max(0, ...would.starts.map((one) => visibleWidth(one.task)))
  for (const start of would.starts) {
    const bits = [
      start.workspace,
      `done: ${start.done}`,
      ...(start.produces ? [`produces ${start.produces}`] : []),
      ...(start.parked ? [] : ['already picked up']),
    ]
    lines.push(
      row()
        .space(2)
        .text(padTo(start.task, widest + 2))
        .text(cap(bits.join('  '), Math.max(4, inner - widest - 5)), skin.hint)
        .build(),
    )
    for (const dep of start.after) {
      lines.push(
        row()
          .space(2)
          .text(' '.repeat(widest + 2))
          .text(cap(`after ${dep.task} — ${dep.why}`, Math.max(4, inner - widest - 5)), skin.hint)
          .build(),
      )
    }
  }
  for (const warning of would.warnings) {
    lines.push(
      ...wrapWords(`warning  ${warning}`, inner - 4).map((t) =>
        row().space(2).text(t, skin.waiting).build(),
      ),
    )
  }
  for (const one of [...would.grant, ...would.limits]) {
    lines.push(...wrapWords(one, inner - 4).map((t) => row().space(2).text(t, skin.hint).build()))
  }
  return lines
}

/**
 * The row above the buttons: the question being asked, or what the page last
 * said. Its room is kept whether there is anything in it or not, so a panel
 * that answers does not move under the pointer.
 */
function said(r: Row, panel: IntakePanel, skin: Skin, inner: number): Line {
  if (panel.asking) {
    return r
      .space()
      .text(cap(asks(panel.asking), inner - 3), skin.waiting)
      .build()
  }
  const text = panel.problem ?? panel.said ?? ''
  return r
    .space()
    .text(cap(text, inner - 3), panel.problem ? skin.bad : skin.hint)
    .build()
}

/**
 * What each question actually asks, in the terms a person is deciding in:
 * agents, money and somebody else's words. Never "are you sure".
 */
function asks(asking: NonNullable<IntakePanel['asking']>): string {
  if (asking === 'refuse') {
    return 'Refuse it? Written down here, nothing posted anywhere, and no agent stopped.  y / n'
  }
  if (asking === 'start') {
    return 'Approve and start it now? That starts agents on somebody else’s words, with your keys.  y / n'
  }
  return 'Approve it? The queue starts its agents when there is room, on somebody else’s words.  y / n'
}

/** The acts, and the way out. */
function foot(r: Row, panel: IntakePanel, ctx: PanelContext): Line {
  const { skin } = ctx
  const shown = ctx.intake
  if (panel.asking) {
    r.space()
      .button('Yes', { kind: 'control', id: 'yes' }, 'primary')
      .space()
      .button('No', { kind: 'control', id: 'no' })
      .space()
    r.right((g) => g.text('escape is no', skin.hint).space())
    return r.build()
  }
  const acts = new Map((shown?.acts ?? []).map((one) => [one.act, one.off]))
  const offer = (id: string, label: string, look?: 'primary') => {
    // A control with nothing to act on is not drawn: the page says why in its
    // own words above, and a button that refuses when pressed is worse than a
    // button that is not there.
    if (acts.get(id as never) !== null) return
    r.space().button(label, { kind: 'control', id }, look)
  }
  offer('approve', 'a Approve', 'primary')
  offer('start', 's Approve and start')
  offer('refuse', 'r Refuse')
  offer('retry', 't Try again')
  r.space()
  r.right((g) =>
    g
      .text('↑↓ reads', skin.hint)
      .space(2)
      .button('Close', { kind: 'control', id: 'close' })
      .space(),
  )
  return r.build()
}

/** A group's heading: its name, then a rule to the edge. */
function heading(row: () => Row, label: string, note: string, inner: number, skin: Skin): Line[] {
  const r = row()
    .space()
    .text(cap(label, Math.max(4, inner - 6)), skin.label)
    .space()
  const said = note ? cap(note, Math.max(0, inner - r.used - 4)) : ''
  r.text(
    '─'.repeat(Math.max(1, inner - r.used - visibleWidth(said) - (said ? 2 : 0) - 1)),
    skin.chrome,
  )
  if (said) r.right((g) => g.text(said, skin.hint).space())
  return [r.build()]
}

/** One of the five tones an inbox mark wears, as the skin paints it. */
function toneFor(
  tone: 'busy' | 'hint' | 'waiting' | 'bad' | 'done',
  skin: Skin,
): (text: string) => string {
  if (tone === 'waiting') return skin.waiting
  if (tone === 'bad') return skin.bad
  if (tone === 'done') return skin.done
  if (tone === 'busy') return skin.busy
  return skin.hint
}
