import { duration } from '@tade/core'
import type { Frame } from '../frame.ts'
import { type Hit, rowHit, type Target } from '../hits.ts'
import { linkedRow } from '../links.ts'
import { ageThere, type Machine, type RemoteAgent, type RemoteScreen } from '../machines.ts'
import { type AppState, laneThere, MARK_TONES, markGlyph } from '../model.ts'
import { BAR } from '../scrollbar.ts'
import type { Regions } from '../selection.ts'
import type { Look, Skin } from '../skin.ts'
import { blank, type Drawn, fit, NO_POINTER, type Pointer, Row, stack } from '../ui.ts'
import { widthOf } from '../width.ts'
import { approvalRows } from './approval.ts'
import {
  laneLines,
  paneRegion,
  pointedIn,
  rowsRead,
  screenRows,
  scrolledBar,
  typingIn,
} from './lane.ts'
import { gutterBeside } from './rows.ts'
import { clockOf, shortened } from './text.ts'

// An agent on another machine, in the pane: what it is and how it stands
// there, what may be asked of it from here, and its screen.
//
// **Its screen is its lane, live, once a terminal here is it** (enter, or the
// first control): the pane draws that terminal as it draws an agent here —
// sized to the room under the controls (`THERE_TOP`), read on every look,
// typed into in place, with the cursor, the bar, scrolling and selecting the
// window's own. Until one is open — or where the panel below has it in front —
// it is that machine's own read of it, read-only and as old as it says.
//
// **Only what that machine says may be asked of it now is a control** (its
// `can`): a button nothing could carry out is a promise the window cannot
// keep. Nothing is offered while its link is down, which says so instead —
// an act needs the machine to answer it. Everything drawn here was read by
// `machines.ts`, so every word is text.

/** One control: its label, the action it names, and how it looks. */
export interface Control {
  label: string
  action: string
  look: Look
}

/** What may be asked of an agent there from here, in the order the controls are drawn. */
export function controlsOf(agent: RemoteAgent, machine: Machine): Control[] {
  if (machine.link !== 'live') return []
  const can = new Set(agent.can)
  const out: Control[] = []
  const add = (label: string, action: string, look: Look = 'rest') =>
    out.push({ label, action, look })
  if (agent.lane === 'running') add('⏎ type into it', 'remote-attach', 'primary')
  if (can.has('steer')) add('steer…', 'remote-steer')
  if (agent.queued && can.has('queue')) add('start', 'remote-start')
  if (can.has('reopen')) add('open again', 'remote-reopen')
  if (can.has('park'))
    add(agent.parked ? 'unpark' : 'park', agent.parked ? 'remote-unpark' : 'remote-park')
  if (can.has('stop')) add('stop', 'remote-stop')
  return out
}

/**
 * The rows above an agent there's lane, once it is live in the pane: its name,
 * its clause, its controls and the rule saying whose screen it is. What its
 * lane is made shorter by (`Fitting.thereSize`), so the two count the same.
 */
export const THERE_TOP = 4

/** The screen read for this agent, or null where what is held is about another. */
function screenFor(frame: Frame, agent: RemoteAgent): RemoteScreen | null {
  return frame.remoteScreen?.task === agent.id ? frame.remoteScreen : null
}

export function renderRemoteAgent(
  state: AppState,
  frame: Frame,
  machine: Machine,
  agent: RemoteAgent,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer = NO_POINTER,
): Drawn {
  const now = frame.now ?? 0
  // The terminal here that is it, in the pane (`laneThere`), or its screen there.
  const live = laneThere(state)
  const clock = clockOf(frame)
  const action = (name: string): Target => ({ kind: 'action', name })

  // Its name and mark, and where it is with how long since it moved.
  const age = ageThere(agent, machine, now)
  const where = [machine.name, age === null ? '' : duration(age)].filter(Boolean).join(' · ')
  const head = new Row(width, skin, pointer).space()
  head
    .text(markGlyph(agent.queued ? 'queued' : agent.mark, now), skin[MARK_TONES[agent.mark]])
    .space()
  head.text(shortened(agent.title ?? agent.name, Math.max(1, width - widthOf(where) - 6)), skin.you)
  head.right((right) => right.text(where, skin.hint).space())
  const clause = new Row(width, skin).space(3)
  clause.text(shortened(agent.reason || agent.name, Math.max(1, width - 4)), skin.hint)

  // What may be asked of it, or why nothing may.
  const controls = new Row(width, skin, pointer).space()
  // Typing into it is what the pane already is, once its lane is live there.
  const offered = controlsOf(agent, machine).filter(
    (one) => live === null || one.action !== 'remote-attach',
  )
  if (machine.link !== 'live') {
    controls
      .space(2)
      .text(`${machine.name} is not linked: nothing can be asked of it until it is`, skin.hint)
  }
  for (const one of offered) controls.button(one.label, action(one.action), one.look).space()

  // What it is held on, with the answer, where that machine says one may be given.
  const held: { text: string; hits: Hit[] }[] = []
  if (agent.approval !== null && machine.link === 'live' && agent.can.includes('answer')) {
    held.push(...approvalCard(agent.approval, machine.name, width, height, skin))
    const card = new Row(width, skin, pointer).space()
    card.button('allow', action('remote-allow'), 'primary').space()
    card.button('deny', action('remote-deny'), 'danger')
    held.push(card.build())
  }

  // Its screen there: a rule saying whose and how old, then its newest rows.
  const screen = screenFor(frame, agent)
  const said = (
    live !== null
      ? [`its lane on ${machine.name}`, 'live']
      : [
          `its screen on ${machine.name}`,
          'read-only',
          screen?.at == null ? null : `as of ${clock(screen.at)}`,
        ]
  )
    .filter(Boolean)
    .join(' · ')
  const label = ` ${shortened(said, Math.max(1, width - 6))} `
  const rest = skin.chrome('─'.repeat(Math.max(0, width - 2 - widthOf(label))))
  const rule = { text: fit(`${skin.chrome('──')}${skin.hint(label)}${rest}`, width), hits: [] }

  if (live !== null) {
    // As many rows above the lane as it was made shorter by, and the card
    // between them where it is held on something.
    const top = [head.build(), clause.build(), controls.build(), ...held, rule]
    return liveLane(state, frame, live, top, width, height, skin, pointer)
  }
  const top = [
    head.build(),
    clause.build(),
    blank(width),
    controls.build(),
    ...held,
    blank(width),
    rule,
  ]
  const room = Math.max(0, height - top.length)
  const body =
    screen === null || screen.why !== null
      ? [
          blank(width),
          new Row(width, skin)
            .space(3)
            .text(screen?.why ?? 'reading its screen…', skin.hint)
            .build(),
        ]
      : screen.lines.slice(-room).map((line) => ({ text: fit(line, width), hits: [] }))
  const drawn = stack([...top, ...body].slice(0, height))
  const shown = [...drawn.rows]
  while (shown.length < height) shown.push(' '.repeat(width))
  return { rows: shown, hits: drawn.hits }
}

/**
 * The terminal here that is the agent there, under the rows that say what it
 * is: drawn as an agent's lane here is (`main.ts`) — a full-screen program's
 * rows from the top, the cursor where typing lands while the pane has the
 * keyboard, the bar or the program's own mark beside it, a region a selection
 * anchors in, and the program's own cells where it answers the pointer. Every
 * row of it gives the pane the keyboard, and the wheel scrolls it.
 */
function liveLane(
  state: AppState,
  frame: Frame,
  lane: string,
  top: readonly { text: string; hits: Hit[] }[],
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const rows = [...top].slice(0, height).map((row) => ({ text: row.text, hits: [...row.hits] }))
  const from = rows.length
  const room = height - from
  if (room <= 0) return stack(rows)
  const view = frame.paneScreen ?? null
  const body = view ? width - BAR : width
  const back = state.paneScroll > 0
  const inView = rowsRead(room, 0, back)
  let regions: Regions = {}
  if (back) {
    // Scrolled back: exactly the lines asked for, and a way back to the newest.
    const screen = frame.screen.split('\n')
    const lines = screen.slice(-inView)
    const at = from + Math.max(0, inView - lines.length)
    for (let gap = inView - lines.length; gap > 0; gap--) rows.push(blank(body))
    for (const line of lines) rows.push(linkedRow(line, body, skin, pointer, frame.linkers))
    rows.push(scrolledBar(state.paneScroll, 'pane-end', body, skin, pointer))
    regions = paneRegion(state, frame, {
      screen: screen.length,
      dropped: screen.length - lines.length,
      shown: lines.length,
      top: lines[0] ?? '',
      row: at,
    })
  } else {
    const typing = typingIn(state) === 'pane'
    const pointed = pointedIn(view, typing)
    const drawn = laneLines(
      frame.screen,
      'shell',
      body,
      inView,
      skin,
      pointer,
      pointed ? null : frame.linkers,
      view && typing ? view.cursor : null,
    )
    rows.push(...drawn.rows)
    regions = paneRegion(state, frame, {
      screen: frame.screen.split('\n').length,
      dropped: drawn.dropped,
      shown: drawn.seen.length,
      top: drawn.seen[0] ?? '',
      row: from + drawn.pad,
    })
    if (pointed && view) {
      const screen = screenRows(view.lines, inView)
      const target: Target = {
        kind: 'screen',
        lane,
        from: screen.from,
        drags: view.pointing === 'drag',
      }
      for (let i = inView - screen.rows; i < inView; i++) {
        rows[from + i]?.hits.push(rowHit(0, body, target))
      }
    }
  }
  for (let i = from; i < rows.length; i++) {
    rows[i]?.hits.unshift(rowHit(0, width, { kind: 'pane' }))
    rows[i]?.hits.unshift(rowHit(0, width, { kind: 'scroll', area: 'pane' }))
  }
  while (rows.length < height) rows.push(blank(view ? body : width))
  if (view) {
    rows.splice(
      from,
      room,
      ...gutterBeside(
        rows.slice(from, from + room),
        view.scrolling ?? 'window',
        {
          total: Math.max(view.lines, inView),
          shown: inView,
          offset: Math.max(0, view.lines - inView - state.paneScroll),
          rows: room,
        },
        'pane',
        body,
        state,
        skin,
      ),
    )
  }
  return { ...stack(rows.slice(0, height)), regions }
}

/**
 * What it waits to run: the tool and the whole command, as the card at this
 * machine draws one (`approvalRows`) — every character kept, wrapped under
 * itself, its own line breaks kept, and what did not fit or that machine did
 * not send counted on the last row. The paths in it are as that machine
 * shortened them (`commandOut`), the same rule its phone reads them by. Where
 * it sent no command — a Tade older than that rule — that is said beside the
 * tool, rather than a yes asked for as though the tool's name were all of it.
 */
function approvalCard(
  approval: NonNullable<RemoteAgent['approval']>,
  machine: string,
  width: number,
  height: number,
  skin: Skin,
): { text: string; hits: Hit[] }[] {
  const inner = Math.max(1, width - 2)
  const head = new Row(width, skin).space().text('wants approval', skin.waiting).build()
  if (approval.command === null) {
    const row = new Row(width, skin).space(2).text(approval.tool, skin.you).space(2)
    row.text(
      shortened(`${machine} did not send the command`, Math.max(1, width - row.used - 1)),
      skin.hint,
    )
    return [head, row.build()]
  }
  // What it asks to run comes before its screen: every row of the pane but
  // those above the card, its buttons, the rule and one row of the screen,
  // as the card at this machine leaves one row of the agent's showing.
  const most = Math.max(1, height - 9)
  const said = approvalRows(
    { tool: approval.tool, summary: approval.command.text, notShown: approval.command.notShown },
    inner,
    most,
    skin,
  )
  return [
    head,
    ...said.map((one) => ({
      text: ` ${one.text} `,
      hits: one.hits.map((hit) => ({ ...hit, from: hit.from + 1, to: hit.to + 1 })),
    })),
  ]
}
