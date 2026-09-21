import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import type { Frame, LaneView } from '../frame.ts'
import { type Hit, pointingIn, rowHit, type ScrollArea, sameTarget, type Target } from '../hits.ts'
import { linkedRow } from '../links.ts'
import {
  type AgentPane,
  type AppState,
  laneShown,
  offsetOf,
  showingActions,
  shownName,
  splitShown,
} from '../model.ts'
import { BAR } from '../scrollbar.ts'
import type { Skin } from '../skin.ts'
import { blank, box, type Drawn, overlay, type Pointer, Row, stack } from '../ui.ts'
import { actionRows } from './actions.ts'
import { blockAt, scrolledBar, typingIn } from './lane.ts'
import { renderPlan, renderQueued } from './queue.ts'
import { barBeside } from './rows.ts'
import { renderSchedule } from './schedule.ts'
import { belowFirst, besideFirst, splitView } from './split.ts'
import { shortened, shortModel } from './text.ts'

// The middle: the agent you are watching.
//
// Its screen, tailing — the newest output is the point, so the rows are read
// from the bottom — with the tabs for its lanes, a shell beside it where one
// is open, and the approval it is waiting on drawn inside its own half. Where
// there is no agent, what to do about that.

export function renderMain(
  state: AppState,
  frame: Frame,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const pane = state.panes.find((p) => p.task === state.focused)
  if (!pane && state.showingPlan) return renderPlan(state, frame, width, height, skin, pointer)
  const schedule = frame.schedules?.find((one) => one.id === state.schedule)
  if (!pane && schedule) {
    return renderSchedule(state, frame, schedule, width, height, skin, pointer)
  }
  if (!pane) return renderWelcome(state, frame, width, height, skin, pointer)
  if (pane.queued) {
    return renderQueued(
      state,
      frame,
      { ...pane, queued: pane.queued },
      width,
      height,
      skin,
      pointer,
    )
  }

  const work = showingActions(state, pane.task)
  const shown = work ? null : laneShown(state, pane)
  // A tab per lane — the agent, and any shell beside it — then what it has
  // done, and + for another shell.
  const tabs = (r: Row) => {
    if (pane.lanes.length === 0) r.tab('agent', { kind: 'task', task: pane.task }, !work)
    for (const { id, label } of laneLabels(pane.lanes)) {
      const target: Target = { kind: 'lane', task: pane.task, lane: id }
      const kind = pane.lanes.find((lane) => lane.id === id)?.kind
      // The agent's own tab has no buttons: it is not a lane you close.
      if (kind === 'agent') {
        r.tab(label, target, id === shown)
        continue
      }
      // A shell's close and menu, as a terminal tab has them: drawn while the
      // pointer is anywhere in the tab, and the tab lit while it is on them.
      //
      // Their room is *not* kept here, where the bottom panel's tabs keep
      // theirs. This row is already full — what is to the right of the tabs is
      // the harness, the model, how hard it thinks and how much context is
      // left, and six columns held for buttons nobody is pointing at took the
      // thinking control and the context meter off it. A strip that grows by
      // six while you point at it costs less than a control you can no longer
      // read, and it is less than the ten these tabs moved by before, which
      // they moved by whenever the shell was simply the one in front.
      const menu: Target = {
        kind: 'menu',
        subject: { kind: 'lane', task: pane.task, lane: id, name: label },
      }
      const close: Target = { kind: 'action', name: `close-lane:${id}` }
      const pointed = pointingIn(state.hover, [target, menu, close])
      r.tab(label, target, id === shown, pointed)
      if (pointed) r.icon('×', close, 'danger').icon('≡', menu)
    }
    r.tab('actions', { kind: 'pane-tab', task: pane.task, tab: 'actions' }, work)
    r.space().button('+', { kind: 'action', name: 'new-shell' }, 'add')
  }

  const route = frame.route
  const vitals = frame.vitals
  // What the agent says it runs on beats what the config hoped for.
  const model = vitals?.model ?? route?.model
  // Its harness, its model and how hard it thinks are controls: click one to change it for this agent.
  const harness: Target = { kind: 'action', name: `harness:${pane.task}` }
  const switcher: Target = { kind: 'action', name: `model:${pane.task}` }
  const thinker: Target = { kind: 'action', name: `thinking:${pane.task}` }
  // How hard it thinks, as it said; before it has, what new agents are given.
  const thinking = vitals?.thinking ?? route?.thinking ?? null
  const percent = vitals?.contextPercent ?? null
  type Shown = { context: boolean; thinking: 'long' | 'short' | 'none'; harness: boolean }
  // A harness that cannot change them has no button for them: the model is
  // still said, as what it runs on.
  const offers = frame.offers
  const controls = (show: Shown) => (r: Row) => {
    if (show.harness) r.button(`${route?.harness ?? 'pi'} ▾`, harness).space()
    const named = `${model ? shortModel(model) : 'its default model'}`
    if (offers?.model.shown === false) r.text(named, skin.hint)
    else r.button(`${named} ▾`, switcher)
    if (show.thinking !== 'none' && offers?.thinking.shown !== false) {
      const label =
        show.thinking === 'long' ? `${thinking ?? 'thinking'} ▾` : `${thinking ?? 'think'} ▾`
      r.space().button(label, thinker)
    }
    if (show.context && percent !== null) {
      const tone = percent >= 85 ? skin.bad : percent >= 60 ? skin.waiting : skin.busy
      r.text(' ctx ', skin.hint)
        .meter(percent / 100, 6, tone)
        .text(` ${Math.round(percent)}%`, skin.hint)
    }
    r.space()
    // Close this agent, running or not: it stops, and goes from the list.
    r.button('×', { kind: 'action', name: `close-task:${pane.task}` }, 'danger').space()
  }
  const measure = (build: (r: Row) => void) => {
    const probe = new Row(width, skin)
    build(probe)
    return probe.used
  }
  const hasControls = Boolean(route || vitals)
  // The name gives way before the controls do: cut short, it still says whose
  // agent this is, and a model you cannot change is a control you lost.
  const least = hasControls
    ? measure(controls({ context: false, thinking: 'short', harness: false })) + 1
    : 0
  const header = new Row(width, skin, pointer).space()
  const forTitle = Math.max(8, width - 3 - measure(tabs) - least)
  // Short of room the project gives way before the agent's own name does:
  // which agent you are looking at is the one thing this line has to say.
  const full = `${pane.project} › ${shownName(pane)}`
  const title = visibleWidth(full) <= forTitle ? full : shownName(pane)
  header.text(shortened(title, forTitle), skin.you).space(2)
  tabs(header)
  if (hasControls) {
    // Where the header is short of room, shed in this order: the context
    // meter, the word "thinking", the harness — one agent in a hundred changes
    // it — and then the thinking level. The model and the close always stay.
    const tries: Shown[] = [
      { context: true, thinking: 'long', harness: true },
      { context: false, thinking: 'long', harness: true },
      { context: false, thinking: 'short', harness: true },
      { context: false, thinking: 'short', harness: false },
      { context: false, thinking: 'none', harness: false },
    ]
    const fits = tries.find((show) => header.used + measure(controls(show)) + 1 <= width)
    header.right(controls(fits ?? { context: false, thinking: 'none', harness: false }))
  }

  const rows: { text: string; hits: Hit[] }[] = [
    header.build(),
    { text: skin.chrome('─'.repeat(width)), hits: [] },
  ]
  const room = height - rows.length
  if (room <= 0) return stack(rows.slice(0, height))

  const split = shown ? splitShown(state, pane) : null
  // The bar down the right of the agent's screen, and the column it takes from
  // it. Only where there is one screen: a split is two, and its halves are
  // measured against the lane sizes the window asked the driver for.
  const lane = shown && !split ? (frame.paneScreen ?? null) : null
  const body = lane ? width - BAR : width
  if (work) {
    // Laid out in the room there is, then windowed: a page longer than its
    // pane scrolls, with a bar beside it, rather than losing its end.
    const full = actionRows(frame.actions ?? null, pane, state, frame, width, skin, pointer)
    if (full.length <= room) {
      rows.push(...full)
    } else {
      const body = width - BAR
      const page = actionRows(frame.actions ?? null, pane, state, frame, body, skin, pointer)
      const offset = offsetOf(state, 'actions', page.length, room)
      const seen = page.slice(offset, offset + room)
      while (seen.length < room) seen.push(blank(body))
      rows.push(
        ...barBeside(
          seen,
          { total: page.length, shown: room, offset, rows: room },
          'actions',
          body,
          state,
          skin,
        ),
      )
    }
    // The wheel over the page scrolls it, wherever on it the pointer is.
    rows.forEach((row, i) => {
      if (i >= 2) row.hits.unshift(rowHit(0, width, { kind: 'scroll', area: 'actions' }))
    })
  } else if (!shown) {
    rows.push(blank(width))
    rows.push(
      new Row(width, skin)
        .space(2)
        .text(`${describeState(pane)}.`, skin.hint)
        .build(),
    )
    rows.push(blank(width))
    rows.push(
      new Row(width, skin, pointer)
        .space(2)
        .button('Open its agent', { kind: 'action', name: 'open-agent' }, 'primary')
        .space()
        .text('picks the conversation up where it stopped', skin.hint)
        .build(),
    )
  } else if (split) {
    // Two lanes at once: the one in front, and a shell beside or below it.
    const kindOf = (lane: string) => pane.lanes.find((one) => one.id === lane)?.kind ?? 'shell'
    const label = laneLabels(pane.lanes).find((one) => one.id === split.lane)?.label ?? 'shell'
    const drawn = splitView({
      width,
      height: room,
      split,
      edge: 'split',
      lit:
        state.resizing === 'split' || sameTarget(state.hover, { kind: 'divider', edge: 'split' }),
      focus: state.splitFocus,
      label,
      actions: `split:${pane.task}`,
      skin,
      pointer,
      first: (w, h) =>
        underTargets(
          laneLines(
            frame.screen,
            kindOf(shown),
            w,
            // The agent's half ends above its approval card, exactly as the
            // whole pane does when there is no split: a screen drawn under
            // one is a sentence the card is sitting on.
            pane.approval && kindOf(shown) === 'agent' ? Math.max(1, h - APPROVAL_ROWS - 1) : h,
            skin,
            pointer,
            frame.linkers,
          ),
          w,
          { kind: 'pane' },
          'pane',
        ),
      second: (w, h) =>
        underTargets(
          laneLines(
            frame.splitScreen ?? '',
            kindOf(split.lane),
            w,
            h,
            skin,
            pointer,
            frame.linkers,
          ),
          w,
          { kind: 'pane', side: 'split' },
          null,
        ),
    })
    rows.push(
      ...drawn.rows.map((text, i) => ({
        text,
        hits: drawn.hits.filter((hit) => hit.row === i).map((hit) => ({ ...hit, row: 0 })),
      })),
    )
  } else if (state.paneScroll > 0) {
    // Scrolled back: exactly the lines asked for, and a way back to the newest.
    const lines = frame.screen.split('\n').slice(-(room - 1))
    for (let gap = room - 1 - lines.length; gap > 0; gap--) rows.push(blank(body))
    for (const line of lines) rows.push(linkedRow(line, body, skin, pointer, frame.linkers))
    rows.push(scrolledBar(state.paneScroll, 'pane-end', body, skin, pointer))
  } else {
    const kind = pane.lanes.find((one) => one.id === shown)?.kind
    // An approval card sits at the bottom; the conversation ends above it.
    const reading = kind === 'agent' && pane.approval ? Math.max(1, room - APPROVAL_ROWS - 1) : room
    rows.push(
      ...laneLines(
        frame.screen,
        kind ?? 'shell',
        body,
        reading,
        skin,
        pointer,
        frame.linkers,
        // The block where what you type lands, on the lane the keyboard is on.
        lane && typingIn(state) === 'pane' ? lane.cursor : null,
      ),
    )
  }
  // Anywhere on the agent's screen gives it the keyboard back, and the wheel
  // scrolls back through what it said. A split pane says which half it was.
  if (!split) {
    rows.forEach((row, i) => {
      if (i >= 2) {
        row.hits.unshift(rowHit(0, width, { kind: 'pane' }))
        row.hits.unshift(rowHit(0, width, { kind: 'scroll', area: 'pane' }))
      }
    })
  }

  while (rows.length < height) rows.push(blank(lane ? body : width))
  if (lane) {
    const seen = Math.max(0, height - 2)
    rows.splice(
      2,
      seen,
      ...barBeside(
        rows.slice(2, 2 + seen),
        {
          total: Math.max(lane.lines, seen),
          shown: seen,
          offset: Math.max(0, lane.lines - seen - state.paneScroll),
          rows: seen,
        },
        'pane',
        body,
        state,
        skin,
      ),
    )
  }
  const drawn = stack(rows.slice(0, height))
  // The approval card belongs to the agent's screen: over the ACTIONS tab it
  // would cover what somebody opened the tab to read, and in a split it stays
  // inside the agent's own half rather than laying itself over the shell
  // beside it — the divider is the edge of the agent's screen, not a line
  // drawn on top of one wide one.
  if (pane.approval && !work) {
    const half =
      split === null
        ? { width, height }
        : split.direction === 'beside'
          ? { width: width >= 24 ? besideFirst(width, split.ratio) : width, height }
          : { width, height: rows.length - room + belowFirst(room, split.ratio) }
    return withApproval(drawn, pane.approval, half, width, height, skin, pointer)
  }
  return drawn
}

/**
 * A lane's screen as rows, bottom-anchored for an agent. pi draws from the top
 * of a terminal and stops where its prompt is, which in a tall pane leaves the
 * prompt stranded half way down, so an agent's screen is read from the bottom,
 * like a conversation; a shell is left where it draws, because full-screen
 * programs count rows.
 */
function laneLines(
  screen: string,
  kind: string,
  width: number,
  rows: number,
  skin: Skin,
  pointer: Pointer,
  linkers: Frame['linkers'],
  cursor: LaneView['cursor'] | null = null,
): { text: string; hits: Hit[] }[] {
  const lines = screen.split('\n')
  const out: { text: string; hits: Hit[] }[] = []
  if (kind === 'agent') {
    while (lines.length > 0 && stripTerminalSequences(lines.at(-1) ?? '').trim() === '') lines.pop()
    for (let gap = rows - lines.length; gap > 0; gap--) out.push(blank(width))
  }
  // Which row the last line captured ended on: what the cursor is counted
  // back from, and the one thing the two anchorings above disagree about.
  const last = kind === 'agent' ? rows - 1 : Math.min(lines.length, rows) - 1
  for (const line of lines.slice(-rows)) out.push(linkedRow(line, width, skin, pointer, linkers))
  while (out.length < rows) out.push(blank(width))
  if (cursor) blockAt(out, last - cursor.back, cursor.column, width, skin)
  return out
}

/** Rows given what a click and the wheel anywhere on them mean, under what they already hold. */
function underTargets(
  rows: { text: string; hits: Hit[] }[],
  width: number,
  target: Target,
  scroll: ScrollArea | null,
): Drawn {
  return stack(
    rows.map((row) => ({
      text: row.text,
      hits: [
        ...(scroll ? [rowHit(0, width, { kind: 'scroll', area: scroll })] : []),
        rowHit(0, width, target),
        ...row.hits,
      ],
    })),
  )
}

/** How tall the approval card is: its border and two rows. */
const APPROVAL_ROWS = 4

/** A waiting approval, where the agent asked for it, answerable by click. */
function withApproval(
  pane: Drawn,
  approval: { tool: string; summary: string },
  /** The agent's own screen: where the card has to fit, and sit at the bottom of. */
  half: { width: number; height: number },
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const cardWidth = Math.min(half.width - 4, 64)
  if (cardWidth < 30) return pane
  const inner = cardWidth - 2
  const card = box(
    'wants approval',
    [
      new Row(inner, skin)
        .space()
        .text(approval.tool, skin.you)
        .space(2)
        .text(approval.summary)
        .build(),
      new Row(inner, skin, pointer)
        .space()
        .button('Allow once', { kind: 'action', name: 'approve' }, 'attention')
        .space()
        .button('Deny', { kind: 'action', name: 'deny' })
        .build(),
    ],
    cardWidth,
    skin,
    { tone: skin.chrome, title: skin.waiting, surface: false },
  )
  // Not modal: the agent's screen stays readable around it.
  return overlay(
    pane,
    card,
    { row: Math.max(2, Math.min(half.height, height) - card.rows.length - 1), col: 2 },
    width,
    skin,
    false,
  )
}

function renderWelcome(
  state: AppState,
  frame: Frame,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const voice = frame.voice ?? { keys: ['ctrl', 'space'], available: false }
  const project = state.project
  const rows = [
    blank(width),
    new Row(width, skin)
      .space(3)
      .text(project ? `Nothing is running in ${project}.` : 'No projects yet.', skin.you)
      .build(),
    blank(width),
    new Row(width, skin, pointer)
      .space(3)
      .button('+ New agent', { kind: 'action', name: 'new-agent' }, project ? 'primary' : 'off')
      .space()
      .button(
        'Open project',
        { kind: 'action', name: 'open-project' },
        project ? 'rest' : 'primary',
      )
      .build(),
    blank(width),
    new Row(width, skin)
      .space(3)
      .text('Or hold ', skin.hint)
      .keys(voice.keys)
      .text(' and say what you want done.', skin.hint)
      .build(),
  ]
  return stack(rows.slice(0, height))
}

function describeState(pane: AgentPane): string {
  switch (pane.state) {
    case 'review':
      return 'Ready for review, and no agent is running'
    case 'parked':
      return 'Parked'
    case 'failed':
      return 'Its last run failed'
    default:
      return 'No agent is running here'
  }
}

/** Tab names for a task's lanes: `agent`, `shell`, `shell 2`. */
export function laneLabels(
  lanes: readonly { id: string; kind: string; title?: string }[],
): { id: string; label: string }[] {
  const seen = new Map<string, number>()
  return lanes.map((lane) => {
    const n = (seen.get(lane.kind) ?? 0) + 1
    seen.set(lane.kind, n)
    // A shell you named is called what you called it.
    if (lane.kind !== 'agent' && lane.title) return { id: lane.id, label: lane.title }
    return { id: lane.id, label: n === 1 ? lane.kind : `${lane.kind} ${n}` }
  })
}
