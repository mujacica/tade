import { sliceByColumn, visibleWidth } from '@earendil-works/pi-tui'
import { DONE_RULE_MEANS, type QueueState } from '@tade/core'
import type { Frame } from '../frame.ts'
import { type Hit, pointingIn, type Target } from '../hits.ts'
import {
  type AgentPane,
  type AppState,
  chainOf,
  glyph,
  MARK_TONES,
  markOf,
  planOf,
  QUEUE_FILTERS,
  type QueuedView,
  type QueueFilter,
  type QueueRow,
  queueEmptySays,
  queueRows,
  schedulesShown,
  shownName,
} from '../model.ts'
import { drawPlan, drawWhy, layoutPlan, type PlanBox, treeStems } from '../plan-graph.ts'
import type { Band, Skin } from '../skin.ts'
import { blank, type Drawn, fit, type Pointer, Row, slid, stack } from '../ui.ts'
import { planPicture, planTone } from './plan.ts'
import {
  doing,
  type ListItem,
  QUEUE_ICONS,
  type Section,
  secondRow,
  TAB_EDGES,
  TAB_ICONS,
  tabbed,
  tabList,
  toneOf,
} from './rows.ts'
import { scheduleRow } from './schedule.ts'
import {
  askedBy,
  askedMark,
  clockOf,
  dollars,
  inProject,
  shortened,
  tokens,
  wrapWords,
} from './text.ts'

// The SMART QUEUE: work that has been made and has not started.
//
// Down the side it is tabs in the tree's own columns — what comes next first,
// and under each piece whatever waits on it, shifted right of it and joined to
// it by a line. In front of you it is the piece itself: where it stands, the
// chain it is in drawn as boxes, every wait's reason, what its agent will be
// told, and how it will count as finished. Looking at it is never starting it.
//
// The agents that are working are tabs here too, since the side is one list:
// the work going on, and the work behind it.

/**
 * An agent down the side, as a tab: what it is doing, its name — cut short
 * with `…` rather than pushing anything off the edge — and what it has cost.
 * Under the pointer, a close and a menu take the cost's place, each lit in
 * turn: close in red, since it is a close.
 */
export function taskRow(
  width: number,
  skin: Skin,
  pointer: Pointer,
  task: AgentPane & { focused: boolean; dragging?: boolean },
  spent: { tokens: number; usd: number } | undefined,
  now: number,
): ListItem {
  const target: Target = { kind: 'task', task: task.task }
  const close: Target = { kind: 'action', name: `close-task:${task.task}` }
  const menu: Target = { kind: 'task-menu', task: task.task }
  const pointed = pointingIn(pointer.hover, [target, close, menu])
  // Only where they are drawn: an invisible button is a trap. Not on the one in your hand.
  const buttons = pointed && !task.dragging
  const cost =
    !buttons && spent && (spent.usd > 0 || spent.tokens > 0)
      ? spent.usd > 0
        ? dollars(spent.usd)
        : tokens(spent.tokens)
      : ''
  // The one being dragged is lit wherever it would land.
  const band: Band | null = task.focused || task.dragging ? 'selected' : pointed ? 'hovered' : null
  const inner = new Row(Math.max(0, width - TAB_EDGES), skin, pointer).space()
  inner.text(glyph(task, now), toneOf(task, skin), target).space()
  const right = (cost ? visibleWidth(cost) + 1 : 0) + (buttons ? TAB_ICONS : 0)
  const room = Math.max(1, inner.width - inner.used - right - 1)
  inner.text(shortened(shownName(task), room), task.focused ? skin.you : (t) => t, target)
  inner.right((r) => {
    if (cost) r.text(cost, skin.hint, target).space()
    if (buttons) r.icon('×', close, 'danger').icon('≡', menu).space()
  })
  return {
    rows: [
      tabbed(width, skin, band, inner.build(), target),
      // What it is doing, in words, under its name.
      secondRow(width, skin, pointer, band, doing(task), target, 3),
    ],
    band,
  }
}

/**
 * How queued work is marked: its shape, its colour, and what the right of its
 * tab says.
 *
 * Work at the front of the tree says how much has to happen before it, since
 * that is the whole answer to when it starts: `next` for the one only waiting
 * for room, `1 ahead` for the one behind a single agent. Deeper in a chain it
 * says nothing — the column it sits in already says how far back it is, and a
 * count on every row would cost every name the columns it is read in.
 */
function queueLook(
  queued: QueuedView,
  skin: Skin,
  frame: Frame,
  front = false,
): {
  glyph: string
  tone: (text: string) => string
  when: string
  whenTone: (text: string) => string
} {
  switch (queued.state.kind) {
    case 'held':
      return { glyph: '!', tone: skin.waiting, when: 'held', whenTone: skin.waiting }
    case 'ready':
      return { glyph: '◌', tone: skin.busy, when: 'next', whenTone: skin.busy }
    case 'waiting': {
      const ahead = queued.state.on.length
      return {
        glyph: '◌',
        tone: skin.hint,
        when: front && ahead > 0 ? `${ahead} ahead` : '',
        whenTone: skin.hint,
      }
    }
    case 'scheduled':
      return {
        glyph: '◷',
        tone: skin.hint,
        when: clockOf(frame)(queued.state.at),
        whenTone: skin.hint,
      }
    case 'paused':
      return { glyph: '‖', tone: skin.faded, when: 'paused', whenTone: skin.faded }
  }
}

/**
 * Who asked, then what queued work is waiting for, for the row under its name.
 * Who asked goes first: it is short, and a long reason cut with `…` must not
 * take it with it.
 */
function queueSays(pane: AgentPane & { queued: QueuedView }): string {
  const mark = askedMark(pane.by)
  const from = [...mark].length === 1 ? `${mark} ` : `${mark} · `
  const state = pane.queued.state
  switch (state.kind) {
    case 'held':
      return `${from}${inProject(pane.project, state.because)}`
    case 'waiting': {
      const [first, ...rest] = state.on.map((task) => inProject(pane.project, task))
      return `${from}after ${first ?? ''}${rest.length > 0 ? ` +${rest.length}` : ''}`
    }
    case 'ready':
      return `${from}waiting for room`
    case 'scheduled':
      return `${from}waits for its time`
    case 'paused':
      return `${from}paused`
  }
}

/**
 * The SMART QUEUE: work made and waiting to start, under the agents that are
 * working, with a filter over it once there is more than one to filter.
 *
 * In the order the resolved tree gives — what comes next first, and under each
 * piece whatever waits on it — each piece shifted right of what it waits on
 * and joined to it by a line, so the side says the same shape the plan does.
 *
 * It is drawn whether or not there is anything in it. With nothing waiting it
 * folds itself away, and then its heading is what says so — in the words of
 * the reason there is nothing, because a heading saying only its own name is
 * the section not being there at all, which is what this stopped being.
 */
export function queueSection(
  state: AppState,
  frame: Frame,
  width: number,
  skin: Skin,
  pointer: Pointer,
  tree: QueueTree,
  all: number,
  open: boolean,
): Section {
  const quiet = all === 0
  return {
    id: 'queue',
    label: 'SMART QUEUE',
    count: all,
    banded: true,
    quiet,
    // The plan it came from, drawn where an agent's screen would be. Small,
    // because it opens what is already there rather than making another of
    // something — and because a narrow side gives it up before the count.
    ...(planOf(state).waits.length > 0
      ? {
          actions: [
            { label: 'plan', target: { kind: 'action' as const, name: 'queue-plan' }, small: true },
          ],
        }
      : {}),
    // Folded with nothing in it, the heading is the only place left to say
    // why there is nothing, so that is what it says.
    ...(quiet && !open ? { note: queueEmptySays(state), brief: 'none' } : {}),
    rows: (row) => {
      const entries = queueRows(state)
      const schedules = schedulesShown(frame.schedules ?? [], state)
      const filters = all > 1 ? [queueFilters(row(), state.queueFilter)] : []
      if (entries.length === 0 && schedules.length === 0) {
        // Why there is nothing, in the words of the reason there is nothing:
        // wrapped rather than cut, because the reason is the whole of what
        // this row is for.
        const none = wrapWords(queueEmptySays(state), Math.max(10, width - 6)).slice(0, 4)
        return [
          ...filters,
          blank(width),
          ...none.map((text) => row().space(3).text(text, skin.hint).build()),
          blank(width),
        ]
      }
      // Where the tree puts each piece, so the side reads like the plan does.
      const stems = queueStems(entries)
      return [
        ...filters,
        ...tabList(
          [
            ...entries.map((one, i) =>
              queueRow(width, skin, pointer, one, stems[i] ?? { stem: '', bars: '' }, frame, tree),
            ),
            ...schedules.map((one) =>
              scheduleRow(width, skin, pointer, one, state.schedule === one.id, frame),
            ),
          ],
          width,
        ),
      ]
    },
  }
}

/**
 * The filters over the SMART QUEUE: the set of small controls every other
 * heading has, and the one showing is filled in the brand's amber — what
 * being on looks like everywhere else in the window, taken from the skin so
 * it moves when the palette does. They light under the pointer as chips do,
 * because a control that never answers the pointer reads as a label.
 *
 * Nothing here pauses anything: pausing is something you do to one piece of
 * work, beside its name — in its tab, its menu, or on the card it opens — so
 * it is never in doubt which one you are pausing.
 */
function queueFilters(row: Row, current: QueueFilter): { text: string; hits: Hit[] } {
  row.space(2)
  QUEUE_FILTERS.forEach((filter, i) => {
    if (i > 0) row.space()
    row.chip(
      filter,
      { kind: 'action', name: `queue-filter:${filter}` },
      filter === current ? 'primary' : 'rest',
    )
  })
  return row.build()
}

/**
 * The lines drawn to the left of queued work, so the side says the same tree
 * the plan does: each piece shifted right of what it waits on, hanging from it
 * by a turn, and the lines of whatever is still to come carried down past it.
 *
 * A piece sits in the column its depth in the resolved tree gives it — not
 * in one counted off the rows above it — so work that can run side by side
 * lines up under work that can run side by side, and a filter that hides a
 * parent does not pull its children back to the front. The shallowest thing
 * shown starts at the left: the columns say what waits on what within the
 * queue, and the queue is what the side is a list of.
 *
 * `stem` goes before its mark; `bars` is what carries on under it, drawn both
 * on its second row and in the room beneath, so a two-row tab never breaks a
 * line in half. The lines themselves are `treeStems`', the same ones every
 * wait's reason is drawn with.
 */
export function queueStems(rows: readonly QueueRow[]): { stem: string; bars: string }[] {
  const index = new Map(rows.map((row, i) => [row.pane.task, i]))
  // Only work that is shown can be hung from: a filter may leave a parent out.
  const parent = rows.map((row) => (row.parent === null ? -1 : (index.get(row.parent) ?? -1)))
  const front = rows.length === 0 ? 0 : Math.min(...rows.map((row) => row.depth))
  return treeStems(
    parent,
    rows.map((row) => row.depth - front),
  )
}

/**
 * Enough of a queued task's name, and of the reason under it, to be worth
 * reading. The tree is always laid out with this much room past its deepest
 * stem — further right than the side is wide, if that is what it takes — and
 * the side is a window onto it.
 */
const QUEUE_ROOM = 16

/** How far the tree of queued work reaches, and how much of it the side shows. */
export interface QueueTree {
  /** Columns the deepest piece of it needs: what the side is a window onto. */
  wide: number
  /** Columns of it in view at once. */
  shown: number
  /** Columns of it scrolled past, off the left. */
  across: number
}

/**
 * How wide the queue's tree came out against the room the side has for it:
 * the deepest stem, its mark, and enough of a name to read.
 *
 * `wide` equal to `shown` is a tree that fits, and then nothing is drawn to
 * scroll it — a bar along the bottom of a side that fits costs a row to say
 * there is more when there is not — and each tab goes back to being laid out
 * in its own room, cut with an `…` as it always was.
 *
 * `shown` is the room a tab with nothing pinned at its right has. What the
 * pointer is on, and the couple of columns a `next` or a clock costs the row
 * it is on, are left out of the sums on purpose: a tree that reflowed as the
 * mouse moved across it would be worse than one you cannot read, and one
 * row's badge is no reason to say the whole list is too narrow.
 */
export function queueSpread(
  stems: readonly { stem: string; bars: string }[],
  width: number,
): { wide: number; shown: number } {
  const shown = Math.max(1, width - TAB_EDGES - 1)
  const wide = stems.reduce(
    // A leading space, the stem, the mark and a space, then room for a name.
    (widest, one) => Math.max(widest, 4 + visibleWidth(one.stem) + QUEUE_ROOM),
    shown,
  )
  return { wide, shown }
}

/**
 * Queued work down the side, as a tab like an agent's: its mark, its name, and
 * when it starts; under it, what it waits for and who asked. It sits right of
 * what it waits on, hanging from it by a line. Under the pointer, pause (or
 * resume), remove and a menu take the place of when.
 *
 * The tree and the name are laid out in the room the tree needs and shown
 * through the room the side has, scrolled together by `tree.across`, so every
 * row moves by the same columns and a column goes on meaning what it meant.
 * What is pinned at the right — when it starts, and the controls under the
 * pointer — is pinned to the side and not to the tree: a button you cannot
 * reach because the chain is deep is a button that is gone.
 */
function queueRow(
  width: number,
  skin: Skin,
  pointer: Pointer,
  row: QueueRow,
  stems: { stem: string; bars: string },
  frame: Frame,
  tree: QueueTree,
): ListItem {
  const pane = row.pane
  const target: Target = { kind: 'task', task: pane.task }
  const paused = pane.queued.state.kind === 'paused'
  const toggle: Target = {
    kind: 'action',
    name: `queue-${paused ? 'resume' : 'pause'}:${pane.task}`,
  }
  const remove: Target = { kind: 'action', name: `queue-remove:${pane.task}` }
  const menu: Target = { kind: 'task-menu', task: pane.task }
  const pointed = pointingIn(pointer.hover, [target, toggle, remove, menu])
  const band: Band | null = pane.focused ? 'selected' : pointed ? 'hovered' : null
  const look = queueLook(pane.queued, skin, frame, row.parent === null)
  const shift = visibleWidth(stems.stem)
  const edge = Math.max(0, width - TAB_EDGES)
  const right = pointed ? QUEUE_ICONS : look.when ? visibleWidth(look.when) + 1 : 0
  const room = Math.max(1, edge - right - 1)
  // A tree that fits has no room of its own: every tab is laid out in the
  // room it has and cut with an `…`, exactly as it was before any of this.
  const canvas = tree.wide > tree.shown ? tree.wide : 0

  // Laid out in the tree's own room, then shown through the side's.
  const laid = new Row(Math.max(room, canvas), skin, pointer).space()
  if (stems.stem) laid.text(stems.stem, skin.chrome, target)
  laid.text(look.glyph, look.tone, target).space()
  const nameTone = pane.focused ? skin.you : paused ? skin.faded : (text: string) => text
  laid.text(shortened(shownName(pane), Math.max(1, laid.width - laid.used)), nameTone, target)
  const reach = laid.used
  const seen = edged(
    slid([laid.build()], tree.across, room)[0] ?? blank(room),
    room,
    reach > tree.across + room,
    skin,
  )

  const inner = new Row(edge, skin, pointer)
  inner.text(seen.text)
  inner.right((r) => {
    if (pointed) {
      r.icon(paused ? '▶' : '‖', toggle)
        .icon('×', remove, 'danger')
        .icon('≡', menu)
        .space()
    } else if (look.when) {
      r.text(look.when, look.whenTone, target).space()
    }
  })
  const first = inner.build()
  first.hits.push(...seen.hits)

  const laidSaid = new Row(Math.max(edge, canvas), skin, pointer).space()
  if (stems.bars) laidSaid.text(stems.bars, skin.chrome, target)
  // Level with the name above it, whatever lines pass under the mark.
  laidSaid.space(Math.max(1, shift + 3 - laidSaid.used))
  laidSaid.text(
    shortened(queueSays(pane), Math.max(1, laidSaid.width - laidSaid.used - 1)),
    skin.hint,
    target,
  )
  const said = edged(
    slid([laidSaid.build()], tree.across, edge)[0] ?? blank(edge),
    edge,
    laidSaid.used > tree.across + edge,
    skin,
  )

  return {
    rows: [tabbed(width, skin, band, first, target), tabbed(width, skin, band, said, target)],
    band,
    // The lines of what is still to come carry on through the room beneath it.
    ...(stems.bars
      ? {
          under:
            slid(
              [
                new Row(Math.max(width, canvas + TAB_EDGES / 2 + 1), skin)
                  .space(3)
                  .text(stems.bars, skin.chrome)
                  .build(),
              ],
              tree.across,
              width,
            )[0] ?? blank(width),
        }
      : {}),
  }
}

/**
 * A tab's row, cut at the side's edge with an `…` where its name carries on
 * past it. What is past it is scrolled to and not lost — but a name that
 * stops mid-letter with nothing to say why reads like the side broke, and
 * that is the reading this whole thing is here to end.
 */
function edged(
  row: { text: string; hits: Hit[] },
  width: number,
  more: boolean,
  skin: Skin,
): { text: string; hits: Hit[] } {
  if (!more || width < 1) return row
  const kept = fit(sliceByColumn(row.text, 0, width - 1), width - 1)
  return { ...row, text: `${kept}${skin.hint('…')}` }
}

/**
 * The project's plan where an agent's screen would be: a column per step, a
 * box per task with its mark and what it is doing, an arrow for every wait,
 * and under it every wait's reason. Wider than the pane, it scrolls sideways.
 */
export function renderPlan(
  state: AppState,
  frame: Frame,
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const { tasks, waits } = planOf(state)
  const working = tasks.filter((pane) => !pane.queued && markOf(pane) === 'working').length
  const queued = tasks.filter((pane) => pane.queued).length
  const header = new Row(width, skin, pointer).space()
  header.text(`${state.project ?? ''} › plan`, skin.you).space(2)
  header.text(`${tasks.length} tasks · ${working} working · ${queued} waiting to start`, skin.hint)
  const rows: { text: string; hits: Hit[] }[] = [
    header.build(),
    { text: skin.chrome('─'.repeat(width)), hits: [] },
    blank(width),
  ]
  const line = (build: (r: Row) => void) => {
    const r = new Row(width, skin, pointer).space(2)
    build(r)
    rows.push(r.build())
  }
  if (tasks.length === 0) {
    line((r) => r.text('Nothing here waits on anything.', skin.hint))
  }

  const boxes = planBoxes(tasks, frame, skin, null)
  const drawing = drawPlan(boxes, waits, Math.max(0, width - 4), (column) =>
    column === 0 ? 'FIRST' : 'THEN',
  )
  rows.push(
    ...planPicture(state, skin, pointer, width, [
      { rows: drawing.rows },
      ...(waits.length > 0
        ? [{ label: 'WHY THIS ORDER', rows: drawWhy(boxes, waits, Math.max(8, width - 4)) }]
        : []),
    ]),
  )

  const shown = stack(rows.slice(0, height))
  const filled = [...shown.rows]
  while (filled.length < height) filled.push(' '.repeat(width))
  return { rows: filled, hits: shown.hits }
}

/**
 * A box per piece of work, for a plan or for one path through it: its mark,
 * its name, what it cost or when it starts, and what it is doing — or, queued,
 * what it is waiting for. `here` is the one you are looking at, drawn heavier.
 */
function planBoxes(
  tasks: readonly AgentPane[],
  frame: Frame,
  skin: Skin,
  here: string | null,
): PlanBox[] {
  const spend = frame.spend?.byTask ?? {}
  const now = frame.now ?? 0
  return tasks.map((pane) => {
    const mine = pane.task === here ? { here: true } : {}
    if (pane.queued) {
      const look = queueLook(pane.queued, skin, frame)
      return {
        task: pane.task,
        mark: look.glyph,
        name: shownName(pane),
        right: look.when,
        note: queueSays({ ...pane, queued: pane.queued }),
        tone: planTone(
          pane.queued.state.kind === 'held'
            ? 'waiting'
            : pane.queued.state.kind === 'ready'
              ? 'busy'
              : pane.queued.state.kind === 'paused'
                ? 'faded'
                : 'hint',
        ),
        ...mine,
      }
    }
    const spent = spend[pane.task]
    return {
      task: pane.task,
      mark: glyph(pane, now),
      name: shownName(pane),
      right: spent && spent.usd > 0 ? dollars(spent.usd) : '',
      note: doing(pane),
      tone: planTone(MARK_TONES[markOf(pane)]),
      ...mine,
    }
  })
}

/** A queued task's state, in a word, for its card. */
function queueWord(state: QueueState): string {
  switch (state.kind) {
    case 'held':
      return 'held'
    case 'ready':
      return 'next'
    case 'waiting':
      return 'waiting'
    case 'scheduled':
      return 'at a time'
    case 'paused':
      return 'paused'
  }
}

/**
 * Queued work in front of you, where an agent's screen would be: where it
 * stands and what to do about it, the whole chain it is in drawn as boxes with
 * every wait's reason under it, what its agent will be told, and how it will
 * count as finished. This is what clicking it shows — looking at queued work
 * is not starting it, which is the Start now beside its name.
 */

export function renderQueued(
  state: AppState,
  frame: Frame,
  pane: AgentPane & { queued: QueuedView },
  width: number,
  height: number,
  skin: Skin,
  pointer: Pointer,
): Drawn {
  const queued = pane.queued
  const look = queueLook(queued, skin, frame)
  const clock = clockOf(frame)
  const start: Target = { kind: 'action', name: `queue-start:${pane.task}` }
  const paused = queued.state.kind === 'paused'
  const toggle: Target = {
    kind: 'action',
    name: `queue-${paused ? 'resume' : 'pause'}:${pane.task}`,
  }
  const remove: Target = { kind: 'action', name: `queue-remove:${pane.task}` }
  const controls = (r: Row) => {
    r.button('Start now', start, 'primary')
      .space()
      .button(paused ? '▶ Resume' : '‖ Pause', toggle)
      .space()
      .button('×', remove, 'danger')
      .space()
  }
  const probe = new Row(width, skin)
  controls(probe)
  const header = new Row(width, skin, pointer).space()
  const word = `${look.glyph} ${queueWord(queued.state)}`
  const title = `${pane.project} › ${shownName(pane)}`
  header
    .text(shortened(title, Math.max(8, width - probe.used - visibleWidth(word) - 5)), skin.you)
    .space(2)
    .text(word, look.tone)
  header.right(controls)

  const rows: { text: string; hits: Hit[] }[] = [
    header.build(),
    { text: skin.chrome('─'.repeat(width)), hits: [] },
    blank(width),
  ]
  const line = (build: (r: Row) => void) => {
    const r = new Row(width, skin, pointer).space(2)
    build(r)
    rows.push(r.build())
  }
  const name = (task: string) => inProject(pane.project, task)
  const said = (text: string) => shortened(text, Math.max(1, width - 6))
  switch (queued.state.kind) {
    case 'held': {
      const because = inProject(pane.project, queued.state.because)
      line((r) =>
        r
          .text('!', skin.waiting)
          .space()
          .text(said(`Held: ${because}.`), skin.you),
      )
      rows.push(blank(width))
      line((r) =>
        r
          .button(
            'Wait for a retry',
            { kind: 'action', name: `queue-wait:${pane.task}` },
            'attention',
          )
          .space()
          .button('Start anyway', start)
          .space()
          .button('Remove', remove, 'danger'),
      )
      break
    }
    case 'waiting': {
      const on = queued.state.on.map(name)
      line((r) =>
        r
          .text('◌', skin.hint)
          .space()
          .text(said(`Waits on ${on.join(', ')}.`)),
      )
      break
    }
    case 'ready':
      line((r) => r.text('◌', skin.busy).space().text(said('Waiting for room.')))
      break
    case 'scheduled': {
      const at = queued.state.at
      line((r) =>
        r
          .text('◷', skin.hint)
          .space()
          .text(said(`Starts at ${clock(at)}.`)),
      )
      break
    }
    case 'paused':
      line((r) => r.text('‖', skin.faded).space().text(said('Paused.')))
      break
  }

  // The whole path it is on, drawn: everything it waits on however far back,
  // everything that waits on it, a box each, and an arrow for every wait. Its
  // own box is the heavy one. Wider than the pane, it is scrolled along — a
  // chain that loses its boxes the moment it gets long loses them exactly
  // when there was something to see.
  const chain = chainOf(state, pane.task)
  const boxes = planBoxes(chain.tasks, frame, skin, pane.task)
  const laid = layoutPlan(
    chain.tasks.map((one) => one.task),
    chain.waits,
  )
  const at = laid.columns.findIndex((column) => column.includes(pane.task))
  const drawing =
    chain.waits.length > 0
      ? drawPlan(boxes, chain.waits, Math.max(0, width - 4), (column) =>
          column === at ? 'THIS ONE' : column > at ? 'AFTER IT' : column === 0 ? 'FIRST' : 'THEN',
        )
      : null
  if (drawing || chain.waits.length > 0) {
    rows.push(
      ...planPicture(state, skin, pointer, width, [
        ...(drawing ? [{ label: 'THE CHAIN IT IS IN', rows: drawing.rows }] : []),
        ...(chain.waits.length > 0
          ? [
              {
                label: 'WHY IT WAITS',
                rows: drawWhy(boxes, chain.waits, Math.max(8, width - 4)),
              },
            ]
          : []),
      ]),
    )
  } else if (queued.after.length > 0) {
    rows.push(blank(width))
    line((r) => r.text('WAITS ON', skin.label))
    for (const dep of queued.after) {
      const other = state.panes.find((one) => one.task === dep.task)
      const to: Target = { kind: 'task', task: dep.task }
      line((r) => {
        r.text(other ? glyph(other, frame.now ?? 0) : '✕', other ? toneOf(other, skin) : skin.bad)
        r.space()
          .text(name(dep.task), (text) => text, to)
          .space(2)
        // What it waits on may itself be waiting: then that is what it is doing.
        const now = !other
          ? 'gone'
          : other.queued
            ? queueSays({ ...other, queued: other.queued })
            : doing(other)
        r.text(said(now), skin.hint)
      })
      if (dep.why) line((r) => r.space(2).text(said(dep.why), skin.hint))
    }
  }

  if (queued.prompt.trim()) {
    rows.push(blank(width))
    line((r) => r.text('WILL BE TOLD', skin.label))
    const told = wrapWords(queued.prompt.trim(), Math.max(10, width - 6))
    for (const text of told.slice(0, 6)) line((r) => r.text('│', skin.chrome).space().text(text))
    if (told.length > 6) line((r) => r.text('│', skin.chrome).space().text('…', skin.hint))
  }

  rows.push(blank(width))
  const fact = (label: string, value: string) =>
    line((r) => r.text(label.padEnd(10), skin.label).space().text(said(value), skin.hint))
  if (queued.touches.length > 0) fact('TOUCHES', queued.touches.join(', '))
  fact('FINISHES', DONE_RULE_MEANS[pane.done ?? 'said'])
  const from = askedBy(pane.by)
  fact('FROM', from === 'you' ? 'you' : from === 'orchestrator' ? 'the orchestrator' : from)

  const shown = stack(rows.slice(0, height))
  const filled = [...shown.rows]
  while (filled.length < height) filled.push(' '.repeat(width))
  return { rows: filled, hits: shown.hits }
}
