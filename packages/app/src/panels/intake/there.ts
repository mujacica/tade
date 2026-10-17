import { MATERIAL_LABEL } from '@tade/core'
import { inboxStateMark } from '../../intake-view.ts'
import type { RequestThere } from '../../machine-there.ts'
import type { Machine, Machines } from '../../machines.ts'
import { MARK_TONES, markGlyph } from '../../model.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import { wrapWords } from '../../view/text.ts'
import { cap, padTo } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { BAR, column, type Line, pageBy, panelSize } from '../frame.ts'
import { close, type PanelOutcome, stay } from '../outcome.ts'
import { heading, quoted, starts } from './view.ts'

// One request handed to **another** machine, in front of you: the page this
// machine draws for one of its own (`view.ts`), read-only, and labelled with
// the machine it is on in its title and its first line.
//
// **Approving it is that machine's.** Its grants, its templates, its keys and
// its money are what approving there spends, and the moment of approving is
// where that machine re-asks its own grant and its source — so this page offers
// no act at all, and says where the act is: that machine's tab here, or Tade
// asked to tell it (`tade_remote_tell`). A press here that approved there would
// be a second door around the one that re-asks.
//
// **Everything on it was written on another machine, and most of it by a
// stranger.** It is read out of `Machine.detail` (`machine-there.ts`), where
// every string was already reduced to text (`printable`), and the request's
// own words go under this machine's own `MATERIAL_LABEL` — never a label that
// machine sent, which is one more string it wrote — quoted down the left and
// never cut, as the page for a request here draws them.
//
// Live while it is open: it reads the machine as the frame holds it, so what
// moves there moves here, and while its link is down the page says as of when.

export interface RequestTherePanel {
  kind: 'request-there'
  /** The machine it is on, by its name here. */
  machine: string
  /** `<source>:<externalId>`, as that machine keys it. */
  item: string
  /** What the row called itself, so the box has a name before the machine is found. */
  title: string
  scroll: number
  busy: false
}

export function requestTherePanel(machine: string, item: string, title: string): RequestTherePanel {
  return { kind: 'request-there', machine, item, title, scroll: 0, busy: false }
}

/** The arrows read down it; escape and enter close it. There is nothing else to press. */
export function requestThereKey(panel: RequestTherePanel, key: string | undefined): PanelOutcome {
  if (key === 'escape' || key === 'enter') return close
  const by = pageBy(key)
  return by === null ? stay(panel) : stay({ ...panel, scroll: Math.max(0, panel.scroll + by) })
}

export function requestThereClick(panel: RequestTherePanel, control: string): PanelOutcome {
  return control === 'close' ? close : stay(panel)
}

/** The request, and the machine it is on: null for either where the frame no longer holds it. */
export function requestThere(
  machines: Machines | undefined,
  machine: string,
  item: string,
): { machine: Machine; request: RequestThere | null } | null {
  const there = machines?.remotes.find((one) => one.name === machine)
  if (there === undefined) return null
  return { machine: there, request: there.detail.requests.find((one) => one.item === item) ?? null }
}

/** Where the act is, said where somebody would look for the button. */
export function approvingThere(machine: string): string {
  return `Approving it is ${machine}’s: on its tab here, or ask Tade to tell ${machine}.`
}

/** The widest it is worth being, as the page for a request here. */
const WIDEST = 96
/** The label column of the facts. */
const LABEL = 18

export function requestThereView(panel: RequestTherePanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const { width, rows: tall } = panelSize(ctx, { max: WIDEST })
  const inner = width - 2 - BAR
  const row = () => new Row(inner, skin, ctx.pointer)
  const found = requestThere(ctx.machines, panel.machine, panel.item)
  const lines: Line[] = []
  const words = (text: string, tone: (text: string) => string, indent = 2) =>
    wrapWords(text, Math.max(8, inner - indent - 2)).map((one) =>
      row().space(indent).text(one, tone).build(),
    )

  const request = found?.request ?? null
  if (found === null || request === null) {
    const gone =
      found === null
        ? `${panel.machine} is not one of this machine’s remotes now`
        : `${panel.machine} no longer lists it`
    lines.push(blank(inner), ...words(gone, skin.hint, 1))
  } else {
    const { machine } = found
    const over =
      request.state === 'started' &&
      request.work.length > 0 &&
      request.work.every((one) => one.finished)
    const mark = over ? 'done' : inboxStateMark(request.state)
    const tone = mark === 'queued' ? skin.hint : skin[MARK_TONES[mark]]
    lines.push(blank(inner))
    lines.push(
      row()
        .space()
        .text(markGlyph(mark, ctx.now), tone)
        .space()
        .text(over ? 'finished' : request.state, tone)
        .space(2)
        .text(cap(request.because, Math.max(4, inner - 16)), skin.hint)
        .build(),
    )
    const asOf =
      machine.link === 'live' || machine.asOf === null ? '' : `as of ${ctx.date(machine.asOf)}`
    lines.push(blank(inner), ...heading(row, `ON ${machine.name.toUpperCase()}`, asOf, inner, skin))
    for (const [label, value] of factsOf(request, ctx.date)) {
      lines.push(
        row()
          .space()
          .text(padTo(label, LABEL), skin.hint)
          .text(cap(value, Math.max(4, inner - LABEL - 3)))
          .build(),
      )
    }
    if (request.would !== null) {
      lines.push(blank(inner), ...heading(row, 'WHAT APPROVING IT STARTS THERE', '', inner, skin))
      lines.push(...starts(row, request.would, inner, skin))
    }
    if (request.url !== null) {
      lines.push(
        blank(inner),
        row()
          .space()
          .text(cap(request.url, inner - 3), skin.link, { kind: 'link', url: request.url })
          .build(),
      )
    }
    lines.push(blank(inner), ...heading(row, MATERIAL_LABEL, '', inner, skin))
    const material = request.material
    if (material === null) {
      const why = request.materialSays ?? `${machine.name} sent none of its words`
      lines.push(blank(inner), ...words(why, skin.hint))
    } else {
      lines.push(blank(inner))
      for (const text of quoted(material.words, Math.max(8, inner - 5))) {
        lines.push(row().space().text('│', skin.chrome).space().text(text).build())
      }
      if (material.more) {
        lines.push(...words(`${machine.name} did not send the rest of it`, skin.hint))
      }
    }
  }

  const drawn = column(
    {
      body: { lines, width: inner, scroll: panel.scroll },
      foot: [
        row()
          .space()
          .text(cap(approvingThere(panel.machine), inner - 3), skin.hint)
          .build(),
        row()
          .space()
          .text('↑↓ reads', skin.hint)
          .right((g) => g.button('Close', { kind: 'control', id: 'close' }, 'primary').space())
          .build(),
      ],
      rows: tall,
    },
    ctx,
  )
  const title = `${request?.externalId || request?.item || panel.title} on ${panel.machine}`
  return box(cap(title, width - 10), drawn.rows, width, skin, { corner: 'esc' })
}

/** That machine's record of what arrived and what let it in, as label and value. */
function factsOf(request: RequestThere, date: (at: number) => string): [string, string][] {
  const facts: [string, string][] = [['source', request.source]]
  if (request.who !== null) facts.push(['asked by', `@${request.who}`])
  if (request.at !== null) facts.push(['arrived', date(request.at)])
  facts.push(['project', request.project])
  facts.push(['allowed by', request.grant ?? 'no grant'])
  if (request.stamp !== null) {
    facts.push(['stamped from', `${request.stamp.name}@${request.stamp.version}`])
  }
  if (request.watch !== '') facts.push(['came through', request.watch])
  if (request.revision !== '') {
    const moved = request.moved ? ' · moved since its work was made' : ''
    facts.push(['revision', `${request.revision}${moved}`])
  }
  if (request.tries > 0) facts.push(['failed', `${request.attempts} of ${request.tries} tries`])
  for (const one of request.work) {
    const how = one.finished
      ? 'finished'
      : (one.held ?? (one.started ? 'started' : one.parked ? 'parked' : 'waiting to start'))
    facts.push(['its work', `${one.task} · ${how}`])
  }
  return facts
}
