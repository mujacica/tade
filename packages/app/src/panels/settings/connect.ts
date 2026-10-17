import { CONNECT_SOURCES, CONNECT_TITLES, type ConnectSource } from '@tade/core'
import { Row } from '../../ui.ts'
import { wrapTo } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import type { Line } from '../frame.ts'

// Where the guided pages that connect a source are, under the switch every
// source on Settings › Intake is behind: this machine's own address for them
// and how to reach it from another, with a press that opens it and one that
// copies it — or, where nothing here serves them, why, in the words `tade web
// connect` prints (`@tade/web`'s `connectWhere`). Drawn on the page of a
// source the pages connect, and on no other: the local door has nothing to
// connect.

/** What the row draws: `@tade/web`'s `ConnectWhere`, as the Away subject answers it. */
export type ConnectView = { url: string; how: string } | { url: null; why: string }

/** The row's two presses. `away-` because the Away subject owns the door they are on. */
export const CONNECT_CONTROLS = {
  open: 'away-connect-open',
  copy: 'away-connect-copy',
} as const

/** Whether the pages connect this source, so its page draws the row. */
export function connectsHere(scope: string | null): scope is ConnectSource {
  return (CONNECT_SOURCES as readonly string[]).includes(scope ?? '')
}

export function connectLines(
  view: ConnectView,
  source: ConnectSource,
  ctx: PanelContext,
  width: number,
): Line[] {
  const { skin } = ctx
  const row = (indent: number) => new Row(width, skin, ctx.pointer).space(indent)
  const top = row(1).text(`Connect ${CONNECT_TITLES[source]}`, skin.label)
  if (view.url !== null) {
    top.right((r) =>
      r
        .button('Open', { kind: 'control', id: CONNECT_CONTROLS.open })
        .space()
        .button('Copy', { kind: 'control', id: CONNECT_CONTROLS.copy })
        .space(),
    )
  }
  const out: Line[] = [top.build()]
  const said = (text: string, tone: (text: string) => string) =>
    wrapTo(text, width - 4, 3).map((part) => row(3).text(part, tone).build())
  if (view.url === null) {
    out.push(...said(view.why, skin.hint))
    return out
  }
  // The address whole, on a line of its own: an address cut to fit is one
  // somebody types in wrong.
  out.push(...said(view.url, skin.you), ...said(view.how, skin.hint))
  return out
}
