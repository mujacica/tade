import type { DomainLine } from '@tade/core'
import { Row } from '../../ui.ts'
import { wrapTo } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import type { Line } from '../frame.ts'

// The records a public name needs, under the Public name row: the same look as
// `tade host domain`, in the same words (`domainSays`), a line per record and
// the record to add or take away under it, written out whole — a record cut
// to fit is a record somebody types in wrong.

/** What the Public name row draws under it. */
export interface DomainView {
  name: string
  /** A look is under way. */
  looking: boolean
  /** The last look's line about the zone, and a line per record; null before one came back. */
  head: string | null
  lines: readonly DomainLine[]
}

/** The control that looks again. */
export const LOOK_AGAIN = 'domain-look'

export function domainLines(view: DomainView, ctx: PanelContext, width: number): Line[] {
  const { skin } = ctx
  const row = (indent: number) => new Row(width, skin, ctx.pointer).space(indent)
  const top = row(1)
    .text('Records', skin.label)
    .right((r) =>
      r
        .button(view.looking ? 'Looking…' : 'Look again', { kind: 'control', id: LOOK_AGAIN })
        .space(),
    )
  const out: Line[] = [top.build()]
  const said = (text: string, indent: number, tone: (text: string) => string, most: number) =>
    wrapTo(text, width - indent - 1, most).map((part) => row(indent).text(part, tone).build())
  if (view.head === null) {
    out.push(...said(`looking at the records for ${view.name} from here`, 3, skin.hint, 2))
    return out
  }
  out.push(...said(view.head, 3, skin.hint, 3))
  for (const one of view.lines) {
    const mark = one.loud ? '▲' : one.state === 'right' ? '✓' : '·'
    const tone = one.loud ? skin.bad : one.state === 'right' ? skin.done : skin.hint
    wrapTo(one.said, width - 6, 4).forEach((part, i) => {
      out.push(
        row(1)
          .text(i === 0 ? mark : ' ', tone)
          .space()
          .text(part, i === 0 ? tone : skin.hint)
          .build(),
      )
    })
    const records = [
      ...(one.add === null ? [] : [`add ${one.add}`]),
      ...one.remove.map((gone) => `remove ${gone}`),
    ]
    for (const record of records) out.push(...said(record, 5, skin.you, 8))
  }
  return out
}
