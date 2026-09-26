import {
  type DoneRule,
  IDLE_REASON,
  type QueueState,
  type TadeEvent,
  type TaskState,
  type WatchFinding,
  type WatchLook,
} from '@tade/core'
import type { Turn } from '@tade/voice-core'
import type { ScrollArea, Target } from './hits.ts'
import { type Spot, standingIn, whereYouWere } from './layout.ts'
import type { Panel } from './panels.ts'
import { onAClock, type QueueView, shownBy, WHOLE_QUEUE } from './queue-view.ts'
import { endOf, type Reach, scrollable } from './scroll.ts'
import { offsetAt, thumbOf } from './scrollbar.ts'
import { emptyTranscript, fromTurn, type Transcript, tadeDid } from './transcript.ts'

// What the app is showing, as data.
//
// Everything that decides behaviour lives here and is pure: which pane has
// focus, whether a pane may take it, what the sidebar lists, what a key does.
// Drawing is a separate, thin layer, so the rules can be tested without a
// terminal attached.

/** The orchestrator strip is always present and cannot be closed. */
export const ORCHESTRATOR = 'orchestrator'

/** Nothing may steal focus while you have been typing this recently. */
export const FOCUS_GUARD_MS = 30_000

export interface AgentPane {
  task: string
  project: string
  /** The task's own name, which is what people say out loud. */
  name: string
  /** What the work is called, once the agent has said: shown in place of the name. */
  title: string | null
  /**
   * What was asked for, verbatim, as its task file has it. Not drawn — the
   * sidebar has room for a name — and what search matches a sentence against,
   * because "the agent on test coverage" is in nobody's name and in exactly
   * one of these.
   */
  intent?: string
  /** Its branch; empty until an agent that started without one changes something. */
  branch: string
  /** Lane whose screen this pane draws, when the agent has one. */
  lane: string | null
  state: TaskState
  /** Why it is in that state, as status says it. */
  reason?: string
  /** Something is waiting on a human here. */
  waiting: boolean
  /** What it is waiting for, when that is an approval. */
  approval: { tool: string; summary: string } | null
  /** Every live lane the task has: its agent, and any shells beside it. */
  lanes: { id: string; kind: string; title?: string }[]
  /** It finished, as the journal says: who said so, and what was done. */
  finished?: { by: string; summary: string } | null
  /** How it counts as finished, when a rule was chosen for it. */
  done?: DoneRule
  /** Who asked for it, as its task file says. */
  by?: string
  /** It is queued work: made, and waiting to start. Shown in the SMART QUEUE, not with agents. */
  queued?: QueuedView | null
  /** What it was planned to wait on, started or not: what draws it into its plan. */
  waitsOn?: readonly { task: string; why: string }[]
  /**
   * The change it is one repository's share of. Two unrelated streams in one
   * repository are two efforts, which is what the sidebar groups by when there
   * is more than one — and what makes them readable at all.
   */
  effort?: string
}

/** Queued work, as the window shows it: where it stands, and what it is waiting to do. */
export interface QueuedView {
  state: QueueState
  after: readonly { task: string; why: string }[]
  prompt: string
  touches: readonly string[]
  /** Not before this moment, when it waits for one. */
  at: number | null
}

/** A schedule, as the SMART QUEUE shows it. */
export interface ScheduleView {
  id: string
  name: string
  project: string
  /** What was said to make it, verbatim. */
  said: string
  kind: 'agent' | 'ask' | 'watch'
  /** What it does each time, in words. */
  does: string
  /** What its agent is told, or the orchestrator asked. */
  prompt: string
  /** When it runs, in words. */
  when: string
  /** It runs once, not again. */
  once: boolean
  /** Its next few runs. Empty once it has nothing left to run. */
  next: readonly number[]
  paused: boolean
  /** Who made it, as `TaskOrigin` says it; a watch is its extension's. */
  by: string
  missed: 'once' | 'skip'
  /** What it did each time it came due, newest first. */
  runs: readonly { due: number; ran: boolean; missed: number; task: string | null }[]
  /** For a watch: what it looks with, and what its looks found, newest first. */
  watch?: {
    /** `<extension>.<id>`. */
    id: string
    /** Who turned it on, as `TaskOrigin` says it: the schedule's own `by` is its extension. */
    turnedOnBy: string
    /** What each new finding becomes. */
    found: 'agent' | 'ask'
    /** At most this many acted on from one look. */
    most: number
    looks: readonly WatchLook[]
    findings: readonly WatchFinding[]
  }
}

export interface AppState {
  panes: AgentPane[]
  /**
   * Every project Tade has been told about, whether or not it has tasks yet.
   * A project with nothing in it still has to be somewhere you can go: that is
   * where the first task in it gets made.
   */
  known: string[]
  /** The project whose tasks are down the side. */
  project: string | null
  /** Task id of the focused pane, or null when only the orchestrator is up. */
  focused: string | null
  /** The conversation with the orchestrator, step by step as it happens. */
  transcript: Transcript
  /** How many rows the conversation is scrolled back from its newest line. */
  transcriptScroll: number
  /** Pictures that go to the orchestrator with the next thing you say. */
  attached: string[]
  /** Push-to-talk is held. */
  listening: boolean
  /** When you last typed into a pane, which is what holds focus still. */
  lastInputAt: number | null
  /** A question the resolver asked, waiting for you to pick one. */
  question: { question: string; candidates: string[] } | null
  /** How far back the focused agent's screen is scrolled, in lines; 0 follows its newest. */
  paneScroll: number
  /** How far down the ACTIONS tab is scrolled, in rows: a page, counted from the top. */
  actionsScroll: number
  /** How far back the terminal in front is scrolled, in lines; 0 follows its newest. */
  terminalScroll: number
  /**
   * What is being dictated, or null when the line is closed. Typed today and
   * filled by a transcriber later: both feed the same sentence to the surface.
   */
  dictation: string | null
  /** Searching back through what you said, as ctrl+r does in a shell. */
  historySearch: { query: string; skip: number; draft: string; missing: boolean } | null
  /**
   * Keystrokes held back at an agent's prompt while they might still spell a
   * line addressed to Tade. Shown, so they are never simply missing.
   */
  held: string | null
  /** One line of transient news for the footer. */
  notice: string | null
  /**
   * You have moved focus yourself, so nothing may move it for you again. Until
   * then the first task is a better opening view than an empty pane.
   */
  chose: boolean
  /** What the pointer is over and what it is holding down, for hover and press. */
  hover: Target | null
  pressed: Target | null
  /** Sidebar sections folded shut. */
  folded: string[]
  /**
   * Sections you opened that would be shut on their own: the SMART QUEUE with
   * nothing in it, and anything else that comes to fold itself away when it
   * has nothing to say. The pair is a choice, and a section is in at most one
   * of them — what is in neither does what it does on its own.
   */
  opened: string[]
  /**
   * Agents that have finished are kept out of the list, until `H` beside
   * AGENTS puts them back. They are still there, and still `X`'s to close —
   * hiding one is a view, never a decision about it.
   */
  hidingDone: boolean
  /**
   * What the SMART QUEUE shows, by project. A project is a place you come back
   * to, so it comes back showing what you left it showing — the same courtesy
   * the pane you were on and the sections you folded already get. Keyed by
   * project name, with `''` for a window that has no project at all.
   */
  queueViews: Record<string, QueueView>
  /** The plan is drawn where an agent's screen would be, while no agent is in front. */
  showingPlan: boolean
  /** The schedule open where an agent's screen would be, while no agent is in front. */
  schedule: string | null
  /** Folders opened in the FILES tree, relative to the folder it is of. */
  expanded: string[]
  /** How many rows the sidebar is scrolled down. */
  scroll: number
  /**
   * How many columns the sidebar is scrolled across, where a chain of queued
   * work is drawn deeper than it is wide. Its own number and not a share of
   * the width, so the tree stays where you put it as the window resizes.
   */
  across: number
  /** How many columns the picture of a plan is scrolled across, where it is wider than its pane. */
  planAcross: number
  /** When the microphone opened, while it is open. */
  talkingSince: number | null
  /** What was said is being turned into words. */
  hearing: boolean
  /** How loud the microphone heard you, a tenth of a second apart, while you talk. */
  levels: number[]
  /** The panel floating over the window, if one is. */
  panel: Panel | null
  /** By task: the lane tab you chose, when it is not the agent. */
  viewing: Record<string, string>
  /**
   * By task: the pane shows what it has done instead of a lane. Absent means
   * a lane, as it always has — `viewing` is not overloaded with a sentinel,
   * which would collide the day somebody names a shell `actions`.
   */
  paneTab: Record<string, 'actions'>
  /**
   * By task: which check on the ACTIONS tab is open, showing what it printed.
   * One at a time — a page where every failure is unfolded is a page you
   * scroll rather than read.
   */
  openCheck: Record<string, string>
  /** Agents elsewhere that asked for you while you were looking at something else. */
  toasts: { task: string; at: number }[]
  /** The terminals open along the bottom, in every project. */
  terminals: TerminalTab[]
  /** Which tab of the bottom panel is in front: `orchestrator`, or a terminal's lane id. */
  bottom: string
  /** How the bottom panel is shown: at its size, filling the window, or folded to its tabs. */
  bottomMode: 'open' | 'max' | 'min'
  /** Where typing goes when no line is open: the agent in the middle, or the terminal below. */
  keyboard: 'pane' | 'terminal'
  /** Sizes you dragged the dividers to, over the ones the config gives. */
  sizes: { sidebarWidth?: number; stripHeight?: number }
  /**
   * What is on the orchestrator's line, open or not: it belongs to the
   * orchestrator rather than to the focus, so moving away keeps it and coming
   * back finds it. `leaveLine` and `openLine` are the only two doors.
   */
  orchestratorDraft: string
  /** A divider being dragged. */
  resizing: 'sidebar' | 'bottom' | 'split' | 'terminal-split' | null
  /**
   * A scrollbar being dragged: which region's, where its track is on the
   * screen, what it was drawn from, and where in the thumb it was taken hold
   * of — so what it does next is a sum, not a jump to wherever the pointer is.
   */
  scrolling: {
    area: ScrollArea
    top: number
    rows: number
    total: number
    shown: number
    /** Rows between the top of the thumb and where it was pressed. */
    grab: number
    /** The bar lying down: its track is columns, and it is dragged by x. */
    across?: boolean
  } | null
  /** A second lane shown with an agent's own, by task: a shell beside it, or below. */
  splits: Record<string, Split>
  /** A second terminal shown with the one in front of the bottom panel. */
  terminalSplit: Split | null
  /**
   * By project: the agents in the order you dragged them into. Any you have
   * not placed come after, in the order they came.
   */
  order: Record<string, string[]>
  /** By project: where you were standing in it — `whereYouWere` folds in the one you are in. */
  spots: Record<string, Spot>
  /** An agent being dragged to a new place in the list: where it would land if let go now. */
  reordering: { project: string; task: string; to: number } | null
  /** The keyboard is on the second half of a split, not the first. */
  splitFocus: boolean
}

/** Two lanes in one place: which is the second, which way it sits, and how much the first takes. */
export interface Split {
  lane: string
  direction: 'beside' | 'below'
  /** The first half's share, 0.2 to 0.8. */
  ratio: number
}

/** A terminal, as its tab shows it. */
export interface TerminalTab {
  id: string
  project: string
  name: string
}

/** The orchestrator's tab in the bottom panel, which cannot be closed. */
export const ORCHESTRATOR_TAB = 'orchestrator'

/** Sections that start folded: the ones you look at on purpose, not all the time. */
export const FOLDED_AT_START = ['notes']

export function initialState(): AppState {
  return {
    panes: [],
    known: [],
    project: null,
    focused: null,
    transcript: emptyTranscript(),
    transcriptScroll: 0,
    paneScroll: 0,
    actionsScroll: 0,
    terminalScroll: 0,
    attached: [],
    listening: false,
    lastInputAt: null,
    question: null,
    dictation: null,
    historySearch: null,
    held: null,
    notice: null,
    chose: false,
    hover: null,
    pressed: null,
    folded: [...FOLDED_AT_START],
    opened: [],
    hidingDone: false,
    queueViews: {},
    showingPlan: false,
    schedule: null,
    expanded: [],
    scroll: 0,
    across: 0,
    planAcross: 0,
    talkingSince: null,
    hearing: false,
    levels: [],
    panel: null,
    viewing: {},
    paneTab: {},
    openCheck: {},
    toasts: [],
    terminals: [],
    bottom: ORCHESTRATOR_TAB,
    bottomMode: 'open',
    keyboard: 'pane',
    sizes: {},
    resizing: null,
    scrolling: null,
    splits: {},
    terminalSplit: null,
    order: {},
    spots: {},
    reordering: null,
    splitFocus: false,
    orchestratorDraft: '',
  }
}

export interface TaskSnapshot {
  task: string
  state: TaskState
  reason?: string
  title?: string | null
  /** What was asked for, verbatim, as its task file has it. */
  intent?: string
  branch?: string
  lane?: string | null
  waiting?: boolean
  approval?: { tool: string; summary: string } | null
  lanes?: { id: string; kind: string; title?: string }[]
  finished?: { by: string; summary: string } | null
  done?: DoneRule
  by?: string
  queued?: QueuedView | null
  waitsOn?: readonly { task: string; why: string }[]
  /** What it was planned to change: what a plan made later is checked against. */
  touches?: readonly string[]
  /** The change it is one repository's share of, as its task file says. */
  effort?: string
}

/**
 * Replace what we know about tasks. Focus survives a refresh: losing your
 * place every time status is polled would make the app unusable.
 */
export function withTasks(state: AppState, tasks: TaskSnapshot[]): AppState {
  const panes = tasks.map((task) => ({
    task: task.task,
    project: task.task.split('/')[0] ?? task.task,
    name: task.task.split('/').at(-1) ?? task.task,
    title: task.title ?? null,
    ...(task.intent ? { intent: task.intent } : {}),
    branch: task.branch ?? '',
    lane: task.lane ?? null,
    state: task.state,
    ...(task.reason ? { reason: task.reason } : {}),
    waiting: task.waiting ?? false,
    approval: task.approval ?? null,
    ...(task.waitsOn ? { waitsOn: task.waitsOn } : {}),
    lanes: task.lanes ?? (task.lane ? [{ id: task.lane, kind: 'agent' }] : []),
    ...(task.finished ? { finished: task.finished } : {}),
    ...(task.done ? { done: task.done } : {}),
    ...(task.by ? { by: task.by } : {}),
    ...(task.effort ? { effort: task.effort } : {}),
    ...(task.queued ? { queued: task.queued } : {}),
  }))
  const focused = refocus(state, panes)
  const project =
    panes.find((pane) => pane.task === focused)?.project ??
    state.project ??
    panes[0]?.project ??
    null
  // Tabbing and a search walk you into another project without its tab, so
  // where you were is caught up with here, not at each place focus can move.
  const next = { ...state, panes, focused, project }
  return { ...next, spots: whereYouWere(next) }
}

/** The projects from the config, which is the only place empty ones exist. */
export function withProjects(state: AppState, names: readonly string[]): AppState {
  const known = [...names]
  return { ...state, known, project: state.project ?? known[0] ?? null }
}

/**
 * Every project, in the order your config lists them — the tabs are yours to
 * arrange — then any a task belongs to that the config does not name.
 */
export function projects(state: AppState): string[] {
  const extra = new Set<string>()
  for (const pane of state.panes) if (!state.known.includes(pane.project)) extra.add(pane.project)
  return [...state.known, ...[...extra].sort((a, b) => a.localeCompare(b))]
}

/**
 * Go to a project, and stand where you left it (`standingIn`).
 *
 * Focus follows, because a sidebar listing one project's tasks while the pane
 * shows another project's agent is two answers to "where am I" — and it follows
 * to the agent you were on here rather than to the top of the list, which was
 * somebody else's idea of where you were. The tab below comes with it; one that
 * is not this project's is the orchestrator's, the keyboard back on the pane.
 *
 * Arriving is `focusTask`, so coming back to an agent is the same act as
 * clicking it, its pane read from its newest line and not from wherever the
 * last project's was scrolled to. A plan or a schedule you had in front of you
 * instead stays behind, being as much one project's as an agent is — left
 * open, an empty project landed on `infra › plan  0 tasks`, which is nothing
 * anybody asked for — and the sidebar, another list, is read from its top and
 * its left.
 */
export function selectProject(state: AppState, project: string): AppState {
  const left = { ...state, spots: whereYouWere(state) }
  const stand = standingIn(left.spots[project], project, left)
  const arrived = stand.focused
    ? focusTask(left, stand.focused)
    : { ...left, focused: null, paneScroll: 0 }
  return {
    ...arrived,
    project,
    bottom: stand.bottom ?? ORCHESTRATOR_TAB,
    ...(stand.bottom ? {} : { keyboard: 'pane' as const }),
    chose: true,
    scroll: 0,
    across: 0,
    showingPlan: false,
    planAcross: 0,
    schedule: null,
  }
}

/**
 * Every agent in the project in front of you, hidden or not. What the list is
 * drawn from, and what its count is out of: a list showing three of fourteen
 * has to know the fourteen to say so.
 */
export function agentsHere(state: AppState): AgentPane[] {
  // Queued work is not an agent yet: it waits in the SMART QUEUE until it starts.
  return state.panes.filter(
    (pane) => pane.project === (state.project ?? pane.project) && !pane.queued,
  )
}

/** The tasks down the side: the selected project's, in the order they come. */
export function tasksOf(
  state: AppState,
): Array<AgentPane & { focused: boolean; dragging: boolean }> {
  const here = agentsHere(state).filter(
    // Finished and hidden — except the one you are watching, because a list
    // that leaves out what is on the screen is a list that disagrees with it.
    (pane) => !(state.hidingDone && markOf(pane) === 'done' && pane.task !== state.focused),
  )
  const order = state.reordering
    ? { ...state.order, [state.reordering.project]: dragged(state, state.reordering) }
    : state.order
  return inOrder(here, order).map((pane) => ({
    ...pane,
    focused: pane.task === state.focused,
    dragging: pane.task === state.reordering?.task,
  }))
}

/** One group down the side: an effort, or the tasks in none. */
export interface EffortGroup {
  /**
   * Its name, or null for the tasks in no effort — which get no header at
   * all, because a heading that says "no effort" is noise in the common case
   * where nothing has one.
   */
  effort: string | null
  tasks: Array<AgentPane & { focused: boolean; dragging: boolean }>
}

/**
 * The tasks down the side, grouped by effort where there is more than one.
 *
 * Two unrelated streams in one repository — search performance and billing
 * emails, say — are one flat list of agents interleaved, which says nothing
 * about which is which. Two efforts is what says they are separate, so that is
 * what the list is grouped by, and only once there are two: with one effort or
 * none the side looks exactly as it looks today, which is the common case.
 *
 * Drawing only. `tasksOf` is unchanged and still decides the order, so what
 * you dragged is kept within each group.
 */
export function groupedTasks(state: AppState): EffortGroup[] {
  const tasks = tasksOf(state)
  const efforts: string[] = []
  for (const task of tasks) {
    if (task.effort && !efforts.includes(task.effort)) efforts.push(task.effort)
  }
  if (efforts.length < 2) return [{ effort: null, tasks }]
  const groups = efforts.map((effort) => ({
    effort,
    tasks: tasks.filter((task) => task.effort === effort),
  }))
  const rest = tasks.filter((task) => !task.effort)
  return rest.length > 0 ? [...groups, { effort: null, tasks: rest }] : groups
}

/** In what order the front of a path is listed: what needs deciding, then what starts soonest. */
const QUEUE_RANK: Readonly<Record<QueueState['kind'], number>> = {
  held: 0,
  ready: 1,
  waiting: 2,
  scheduled: 3,
  paused: 4,
}

/**
 * Queued work where the resolved path puts it: what it still waits on, how far
 * down the path it sits, and which queued work it hangs from.
 */
export interface QueueRow {
  pane: AgentPane & { queued: QueuedView; focused: boolean }
  /** How many things still have to happen before it. 0 is directly next. */
  depth: number
  /** The queued work it hangs from — the last of its waits — or null at the front of a path. */
  parent: string | null
}

/**
 * What queued work is still behind, as the queue reads it now rather than as
 * it was planned: work that waits says what it waits on itself; work held or
 * ready is behind nothing — a decision, or room, is all it needs; work paused
 * or waiting for a clock is read from its plan, because pausing it hid what it
 * waits on.
 */
function stillAfter(
  pane: AgentPane & { queued: QueuedView },
  panes: readonly AgentPane[],
): string[] {
  const state = pane.queued.state
  if (state.kind === 'waiting') return [...state.on]
  if (state.kind === 'held' || state.kind === 'ready') return []
  return pane.queued.after
    .map((dep) => panes.find((one) => one.task === dep.task))
    .filter((one): one is AgentPane => one !== undefined && markOf(one) !== 'done')
    .map((one) => one.task)
}

/**
 * The project's queued work as the resolved tree has it: what comes next
 * first, and under each piece whatever waits on it, however deep. Work at the
 * front of a path is ordered by what needs deciding, then by what starts
 * soonest; the whole of one path is listed before the next one starts.
 */
export function queueTree(state: AppState): QueueRow[] {
  const here = state.panes.filter(
    (pane): pane is AgentPane & { queued: QueuedView } =>
      Boolean(pane.queued) && pane.project === (state.project ?? pane.project),
  )
  const byTask = new Map(here.map((pane) => [pane.task, pane]))
  const queued = new Set(byTask.keys())
  const after = new Map(here.map((pane) => [pane.task, stillAfter(pane, state.panes)]))
  const depths = new Map<string, number>()
  const depthOf = (task: string, seen: Set<string>): number => {
    const found = depths.get(task)
    if (found !== undefined) return found
    // A plan that waits on itself is a plan nobody can order: it stops here.
    if (seen.has(task)) return 0
    seen.add(task)
    const waits = after.get(task) ?? []
    // A wait on an agent already running is one hop, whatever it is doing.
    const at =
      waits.length === 0
        ? 0
        : 1 + Math.max(...waits.map((dep) => (queued.has(dep) ? depthOf(dep, seen) : 0)))
    depths.set(task, at)
    return at
  }
  for (const pane of here) depthOf(pane.task, new Set())

  const order = new Map(here.map((pane, i) => [pane.task, i]))
  const at = (pane: { queued: QueuedView }) =>
    pane.queued.state.kind === 'scheduled' ? pane.queued.state.at : (pane.queued.at ?? 0)
  const first = (a: string, b: string) => {
    const one = byTask.get(a)
    const two = byTask.get(b)
    if (!one || !two) return 0
    return (
      QUEUE_RANK[one.queued.state.kind] - QUEUE_RANK[two.queued.state.kind] ||
      at(one) - at(two) ||
      (order.get(a) ?? 0) - (order.get(b) ?? 0)
    )
  }
  // What it hangs from is the last of its waits: the deepest piece of queued
  // work it is behind. Waiting only on running agents puts it at the front.
  const under = new Map<string | null, string[]>()
  for (const pane of here) {
    const parent =
      (after.get(pane.task) ?? [])
        .filter((dep) => queued.has(dep) && dep !== pane.task)
        .sort(
          (a, b) =>
            (depths.get(b) ?? 0) - (depths.get(a) ?? 0) ||
            (order.get(a) ?? 0) - (order.get(b) ?? 0),
        )[0] ?? null
    under.set(parent, [...(under.get(parent) ?? []), pane.task])
  }
  for (const tasks of under.values()) tasks.sort(first)

  const rows: QueueRow[] = []
  const listed = new Set<string>()
  const walk = (task: string, parent: string | null) => {
    if (listed.has(task)) return
    const pane = byTask.get(task)
    if (!pane) return
    listed.add(task)
    rows.push({
      pane: { ...pane, focused: pane.task === state.focused },
      depth: depths.get(task) ?? 0,
      parent,
    })
    for (const child of under.get(task) ?? []) walk(child, task)
  }
  for (const task of under.get(null) ?? []) walk(task, null)
  // Work a ring of waits kept out of the walk is still work: it is listed too.
  for (const pane of [...here].sort((a, b) => first(a.task, b.task))) walk(pane.task, null)
  return rows
}

/**
 * The queued work the SMART QUEUE shows, in the resolved tree's order, as the
 * filter has it — and whatever you are looking at, filter or no filter: a list
 * that leaves out the thing in front of you is a list you cannot trust.
 */
export function queueRows(state: AppState): QueueRow[] {
  const view = queueViewOf(state)
  return queueTree(state).filter(
    (row) => row.pane.focused || shownBy(view, { queued: row.pane.queued, parent: row.parent }),
  )
}

/**
 * Whether anything in the project in front of you waits for a clock rather
 * than for us — queued work with a time on it, or a schedule. What the `timed`
 * switch is about, and so whether there is any point drawing it.
 */
export function clocksHere(state: AppState, schedules: readonly { project: string }[]): boolean {
  const mine = (project: string) => project === (state.project ?? project)
  return (
    schedules.some((one) => mine(one.project)) ||
    queueTree(state).some((row) => onAClock(row.pane.queued))
  )
}

/** What the SMART QUEUE shows in the project in front of you. */
export function queueViewOf(state: AppState): QueueView {
  return state.queueViews[state.project ?? ''] ?? WHOLE_QUEUE
}

/**
 * The same, changed: half of it at a time, since the scope and the switch are
 * two controls. The choice is that project's and outlives the window.
 */
export function showQueue(state: AppState, change: Partial<QueueView>): AppState {
  return {
    ...state,
    queueViews: {
      ...state.queueViews,
      [state.project ?? '']: { ...queueViewOf(state), ...change },
    },
  }
}

/**
 * The queued work in the project in front of you, as the filter shows it, in
 * the order the resolved tree puts it.
 */
export function queueOf(
  state: AppState,
): Array<AgentPane & { queued: QueuedView; focused: boolean }> {
  return queueRows(state).map((row) => row.pane)
}

/** How much queued work there is in the project in front of you, whatever the filter. */
export function queuedCount(state: AppState): number {
  return state.panes.filter(
    (pane) => pane.queued && pane.project === (state.project ?? pane.project),
  ).length
}

/**
 * Agents in the order you put them, project by project: the ones you dragged
 * where you dragged them, the rest after, in the order they came. Projects
 * keep the order they came in.
 */
export function inOrder<T extends { task: string; project: string }>(
  panes: readonly T[],
  order: Readonly<Record<string, readonly string[]>>,
): T[] {
  const first = new Map<string, number>()
  panes.forEach((pane, i) => {
    if (!first.has(pane.project)) first.set(pane.project, i)
  })
  const placed = (pane: T) => {
    const at = order[pane.project]?.indexOf(pane.task) ?? -1
    return at < 0 ? Number.MAX_SAFE_INTEGER : at
  }
  return panes
    .map((pane, i) => ({ pane, i }))
    .sort(
      (a, b) =>
        (first.get(a.pane.project) ?? 0) - (first.get(b.pane.project) ?? 0) ||
        placed(a.pane) - placed(b.pane) ||
        a.i - b.i,
    )
    .map((one) => one.pane)
}

/** A project's agents in the order they would have if the one being dragged were let go now. */
function dragged(state: AppState, move: { project: string; task: string; to: number }): string[] {
  const tasks = inOrder(
    state.panes.filter((pane) => pane.project === move.project),
    state.order,
  ).map((pane) => pane.task)
  const without = tasks.filter((task) => task !== move.task)
  const to = Math.max(0, Math.min(move.to, without.length))
  return [...without.slice(0, to), move.task, ...without.slice(to)]
}

/** Take hold of an agent to move it: it would land at place `to` in its project's list. */
export function dragAgent(state: AppState, task: string, to: number): AppState {
  const project = state.panes.find((pane) => pane.task === task)?.project
  if (!project) return state
  return { ...state, reordering: { project, task, to } }
}

/** Let go of the agent being moved: it stays where it was dropped, and is remembered there. */
export function dropAgent(state: AppState): AppState {
  const move = state.reordering
  if (!move) return state
  return {
    ...state,
    order: { ...state.order, [move.project]: dragged(state, move) },
    reordering: null,
  }
}

/**
 * Where focus goes after the tasks change.
 *
 * Once you have chosen, it stays where you put it — including on the
 * orchestrator, which is a real place to be and not merely the absence of a
 * pane. Before you have chosen anything, the first task is a better opening
 * view than an empty one. The distinction matters because this runs on a
 * timer: without it, tabbing to the orchestrator would last about two seconds.
 *
 * And falling back is always *within the project you are standing in*. Where
 * you are is a place, and closing an agent is not asking to be somewhere else
 * — but the fallback was the first pane there was, of any project, so closing
 * the last agent in one moved the window to whatever happened to be open in
 * the next. An empty project is a perfectly good place to be standing: with
 * nothing here to fall back to the answer is nothing, which is the same
 * `null` the orchestrator is, and `withTasks` then keeps the project you were
 * in. Only the person switches projects.
 */
function refocus(state: AppState, panes: AgentPane[]): string | null {
  // Before there is a project there is nothing to be inside, so everything
  // counts — which is the first look, where the first pane names the project.
  const here =
    state.project === null ? panes : panes.filter((pane) => pane.project === state.project)
  if (state.chose) {
    if (state.focused === null) {
      // Nothing in front of you is what a plan or a schedule you opened looks
      // like, and what an empty project looks like — and only the second of
      // those ends. An agent arriving in the project you are standing in is
      // the thing you were waiting for, so it goes in front of you: asking
      // the orchestrator for work and being left looking at the empty
      // project's own screen is the wrong end of the same bug.
      return state.showingPlan || state.schedule !== null ? null : (here[0]?.task ?? null)
    }
    return panes.some((pane) => pane.task === state.focused)
      ? state.focused
      : (here[0]?.task ?? null)
  }
  return state.focused && panes.some((pane) => pane.task === state.focused)
    ? state.focused
    : (here[0]?.task ?? null)
}

export function focusTask(state: AppState, task: string): AppState {
  const pane = state.panes.find((one) => one.task === task)
  return pane
    ? {
        ...state,
        focused: task,
        project: pane.project,
        chose: true,
        paneScroll: 0,
        // A different chain is a different picture: it is read from its front.
        planAcross: 0,
        showingPlan: false,
        schedule: null,
      }
    : state
}

/** The plan in front of you, where an agent's screen was: which work comes first, and what waits on what. */
export function showPlan(state: AppState): AppState {
  return {
    ...state,
    focused: null,
    chose: true,
    showingPlan: true,
    schedule: null,
    planAcross: 0,
  }
}

/** A schedule in front of you, where an agent's screen was. */
export function openSchedule(state: AppState, id: string): AppState {
  return { ...state, focused: null, chose: true, showingPlan: false, schedule: id }
}

/**
 * The schedules the SMART QUEUE shows for the project in front of you, as the
 * view has it: soonest first, then paused ones, then ones with nothing left to
 * run. A schedule is the clearest thing there is waiting for a clock, so the
 * switch is the whole of what decides whether it is drawn — and at `next` as
 * much as at `all`, because a schedule stands behind nothing and starts by
 * itself, which is what `next` asks. It was the scope that hid a schedule
 * before, and having two controls answer the one question is what left the
 * ordinary case with no control at all.
 */
export function schedulesShown(
  schedules: readonly ScheduleView[],
  state: AppState,
): ScheduleView[] {
  if (!queueViewOf(state).timed) return []
  const rank = (one: ScheduleView) => (one.next.length === 0 ? 2 : one.paused ? 1 : 0)
  return schedules
    .filter((one) => one.project === (state.project ?? one.project))
    .map((one, i) => ({ one, i }))
    .sort(
      (a, b) =>
        rank(a.one) - rank(b.one) ||
        (a.one.next[0] ?? Number.POSITIVE_INFINITY) - (b.one.next[0] ?? Number.POSITIVE_INFINITY) ||
        a.i - b.i,
    )
    .map(({ one }) => one)
}

/**
 * The project's plan, as tasks and waits: every task something waits on, and
 * everything that waits, started or not. Work nothing waits on and that waits
 * on nothing is not part of a plan.
 */
export function planOf(state: AppState): Plan {
  const { here, waits } = planned(state)
  const inPlan = new Set(waits.flatMap((wait) => [wait.from, wait.to]))
  return { tasks: here.filter((pane) => inPlan.has(pane.task)), waits }
}

/** A plan, or a piece of one: the work in it, and what waits on what. */
export interface Plan {
  tasks: AgentPane[]
  waits: { from: string; to: string; why: string }[]
}

/** The project in front of you and every wait planned in it, started or not. */
function planned(state: AppState): {
  here: AgentPane[]
  waits: { from: string; to: string; why: string }[]
} {
  const here = state.panes.filter((pane) => pane.project === (state.project ?? pane.project))
  const waits = here.flatMap((pane) =>
    (pane.waitsOn ?? pane.queued?.after ?? []).map((dep) => ({
      from: dep.task,
      to: pane.task,
      why: dep.why,
    })),
  )
  return { here, waits }
}

/**
 * The whole dependency chain one piece of work sits on: everything it waits
 * on, however far back, everything that waits on it, however far forward, and
 * the waits between them. Its neighbours' neighbours are somebody else's path
 * and are left out — what is drawn is the path this work is on.
 */
export function chainOf(state: AppState, task: string): Plan {
  const { here, waits } = planned(state)
  const kept = new Set([task])
  const walk = (back: boolean) => {
    const edge = [task]
    while (edge.length > 0) {
      const one = edge.pop()
      for (const wait of waits) {
        if ((back ? wait.to : wait.from) !== one) continue
        const next = back ? wait.from : wait.to
        if (kept.has(next)) continue
        kept.add(next)
        edge.push(next)
      }
    }
  }
  walk(true)
  walk(false)
  return {
    tasks: here.filter((pane) => kept.has(pane.task)),
    waits: waits.filter((wait) => kept.has(wait.from) && kept.has(wait.to)),
  }
}

/** Move focus along the sidebar, wrapping at both ends. */
/**
 * Move focus, counting the orchestrator as one of the things you can focus.
 *
 * It is where you type to Tade, so leaving it out of the cycle meant a window
 * with no tasks had nothing at all to type into — which is exactly the window
 * everybody sees first.
 */
export function focusBy(state: AppState, delta: number): AppState {
  // `null` is the orchestrator, and it is always there. Being at it means its
  // line is open; the agent you were watching stays in view behind it. Agents
  // come in the order the list shows them.
  const ring: Array<string | null> = [
    ...inOrder(state.panes, state.order).map((pane) => pane.task),
    null,
  ]
  const here = state.dictation !== null ? null : state.focused
  const at = ring.indexOf(here)
  const next = ((((at < 0 ? 0 : at) + delta) % ring.length) + ring.length) % ring.length
  const focused = ring[next] ?? null
  if (focused === null) return openLine(state)
  const project = state.panes.find((pane) => pane.task === focused)?.project ?? state.project
  return { ...leaveLine({ ...state, spots: whereYouWere(state) }), focused, project }
}

/** What an agent is shown as: what its work is called, once it has said, else its name. */
export function shownName(pane: { name: string; title: string | null }): string {
  return pane.title ?? pane.name
}

/** What you can ask for by name, rather than by remembering a phrase. */
export interface Action {
  name: string
  about: string
  /** False when it cannot be done right now, with `about` saying why. */
  ready: boolean
}

/**
 * The slash commands, and whether each one can be done at the moment.
 *
 * Listed rather than hidden when they cannot: a menu that changes shape as
 * you work is one you have to re-read every time, and "no agent is running
 * here" is more use than an option that silently is not there.
 */
export function actions(state: AppState): Action[] {
  const focused = state.panes.find((pane) => pane.task === state.focused)
  const running = state.panes.filter((pane) => pane.lane !== null)
  return [
    {
      name: '/new',
      about: focused
        ? `a new agent beside ${focused.name}: /new what it should do`
        : 'a new agent: /new what it should do',
      ready: true,
    },
    {
      name: '/stop',
      about: running.length > 0 ? 'stop an agent, keeping its work' : 'nothing is running',
      ready: running.length > 0,
    },
    {
      name: '/open',
      about: state.panes.length > 0 ? 'go to an agent: /open name' : 'no agents yet',
      ready: state.panes.length > 0,
    },
    { name: '/project', about: 'add a git repository Tade can work in', ready: true },
    { name: '/settings', about: 'see and change what Tade has been told', ready: true },
    { name: '/help', about: 'what the keys do', ready: true },
    { name: '/quit', about: 'close the window; agents carry on if they can', ready: true },
  ]
}

/**
 * A typed command line: the word, and whatever was said after it.
 *
 * Most commands take the rest of the line as what they are for — `/new fix
 * the double charge` is a whole piece of work, said in one go — so the two are split
 * once, here, rather than by each caller guessing.
 */
export function parseCommand(typed: string): { name: string; rest: string } {
  const line = typed.trim()
  const space = line.search(/\s/)
  if (space < 0) return { name: line, rest: '' }
  return { name: line.slice(0, space), rest: line.slice(space + 1).trim() }
}

/** The actions matching what has been typed after the slash. */
export function matchActions(state: AppState, typed: string): Action[] {
  // Only the first word chooses the command: the words after it are what the
  // command is *for*, and they must not narrow the list to nothing while you
  // are still typing them.
  const want = parseCommand(typed).name.replace(/^\//, '').toLowerCase()
  const all = actions(state)
  if (want === '') return all
  return all.filter((action) => action.name.slice(1).startsWith(want))
}

/**
 * Which project a new agent belongs to, and what it is for.
 *
 * In order: a project named as the first word, the one you are looking at, or
 * the only one there is. Naming it is how you start work somewhere other than
 * where you are standing, and everything after the name is kept as said.
 */
export function whichProject(
  said: string,
  projects: readonly string[],
  current: string | null,
): { project: string | null; intent: string } {
  const { name, rest } = parseCommand(said)
  if (projects.includes(name)) return { project: name, intent: rest }
  const only = projects.length === 1 ? (projects[0] ?? null) : null
  const here = current && projects.includes(current) ? current : null
  return { project: here ?? only, intent: said.trim() }
}

/** Look at one of a task's lanes. */
export function viewLane(state: AppState, task: string, lane: string): AppState {
  const paneTab = { ...state.paneTab }
  // Clicking a lane's tab is leaving the actions tab: the two are one row of
  // tabs, and only one of them is in front.
  delete paneTab[task]
  return { ...focusTask(state, task), paneTab, viewing: { ...state.viewing, [task]: lane } }
}

/**
 * Show what a task has done — its commits, what is not committed, its review
 * and how its checks stand — in its pane, instead of a lane.
 */
export function viewActions(state: AppState, task: string): AppState {
  return {
    ...focusTask(state, task),
    paneTab: { ...state.paneTab, [task]: 'actions' },
    actionsScroll: 0,
  }
}

/** Whether the pane for this task is showing what it has done rather than a lane. */
export function showingActions(state: AppState, task: string | null): boolean {
  return task !== null && state.paneTab[task] === 'actions'
}

/**
 * Open a check on the ACTIONS tab, showing what it printed — or shut it, if it
 * is the one already open. Reading a failure is what the page is for, so it
 * happens here rather than in the conversation.
 */
export function toggleCheck(state: AppState, task: string, check: string): AppState {
  const open = state.openCheck[task] === check
  const openCheck = { ...state.openCheck }
  if (open) delete openCheck[task]
  else openCheck[task] = check
  return { ...state, openCheck }
}

/**
 * The lane a pane draws: the tab you chose while it is still alive, else the
 * agent. A shell you closed does not leave you looking at nothing.
 */
export function laneShown(state: AppState, pane: AgentPane): string | null {
  const chosen = state.viewing[pane.task]
  if (chosen && pane.lanes.some((lane) => lane.id === chosen)) return chosen
  return pane.lane
}

/**
 * The terminals, as the registry has them now. A tab whose terminal has gone
 * gives the front back to the orchestrator, and typing back to the agent.
 */
export function withTerminals(state: AppState, terminals: readonly TerminalTab[]): AppState {
  const gone =
    state.bottom !== ORCHESTRATOR_TAB && !terminals.some((one) => one.id === state.bottom)
  return {
    ...state,
    terminals: [...terminals],
    ...(gone ? { bottom: ORCHESTRATOR_TAB, keyboard: 'pane' as const } : {}),
  }
}

/** The terminals of the project you are in, in the order their tabs were opened. */
export function terminalsOf(state: AppState): TerminalTab[] {
  return state.terminals.filter(
    (terminal) => terminal.project === (state.project ?? terminal.project),
  )
}

/**
 * The terminal in front, and only ever one of the project you are in, whatever
 * `bottom` still names — the panel went on showing the one of the project you
 * came from, under a row of this project's tabs with none of them lit.
 */
export function activeTerminal(state: AppState): TerminalTab | null {
  return terminalsOf(state).find((terminal) => terminal.id === state.bottom) ?? null
}

/**
 * Put a terminal in front, with the keyboard in it: opening one is for typing
 * into. Unfolds the panel if it was folded, and closes the orchestrator's line.
 */
export function showTerminal(state: AppState, id: string): AppState {
  if (!state.terminals.some((terminal) => terminal.id === id)) return state
  return {
    ...leaveLine(state),
    bottom: id,
    keyboard: 'terminal',
    bottomMode: state.bottomMode === 'min' ? 'open' : state.bottomMode,
  }
}

/** The orchestrator's tab in front, its line open to type on. */
export function showOrchestrator(state: AppState): AppState {
  return {
    ...openLine(state),
    bottom: ORCHESTRATOR_TAB,
    keyboard: 'pane',
    bottomMode: state.bottomMode === 'min' ? 'open' : state.bottomMode,
  }
}

/**
 * Drag a divider to a cell. The sidebar is as wide as the column you let go
 * at; the bottom panel as tall as the rows from there to the buttons. `draw`
 * clamps both to what the window can hold.
 */
export function resizeTo(
  state: AppState,
  at: { x: number; y: number },
  window: { height: number },
): AppState {
  if (state.resizing === 'sidebar') {
    return { ...state, sizes: { ...state.sizes, sidebarWidth: Math.max(1, at.x) } }
  }
  if (state.resizing === 'bottom') {
    // Two rows at the foot are the rule and the buttons.
    const stripHeight = Math.max(1, window.height - 2 - at.y)
    return { ...state, bottomMode: 'open', sizes: { ...state.sizes, stripHeight } }
  }
  return state
}

/** Open or close a folder in the FILES tree. Closing one closes what is inside it too. */
export function toggleFolder(state: AppState, path: string): AppState {
  const expanded = state.expanded.includes(path)
    ? state.expanded.filter((open) => open !== path && !open.startsWith(`${path}/`))
    : [...state.expanded, path]
  return { ...state, expanded }
}

/** Columns left of the first one in view, for a region that moves sideways. */
export function acrossOf(state: AppState, area: ScrollArea, total: number, shown: number): number {
  const most = Math.max(0, total - shown)
  if (area === 'plan') return Math.min(state.planAcross, most)
  if (area === 'sidebar') return Math.min(state.across, most)
  return 0
}

/**
 * Lines above the first one in view, for a region that scrolls. Each keeps it
 * its own way — a sidebar counts down from the top, a screen counts back from
 * the newest line — and a scrollbar is drawn from the one number they have in
 * common.
 */
export function offsetOf(state: AppState, area: ScrollArea, total: number, shown: number): number {
  const back = (lines: number) => Math.max(0, total - shown - lines)
  switch (area) {
    case 'sidebar':
      return Math.max(0, Math.min(state.scroll, total - shown))
    // A page rather than a screen: it counts down from the top, as the
    // sidebar does, because its first row is where you start reading.
    case 'actions':
      return Math.max(0, Math.min(state.actionsScroll, total - shown))
    case 'pane':
      return back(state.paneScroll)
    case 'terminal':
      return back(state.terminalScroll)
    case 'transcript':
      return back(state.transcriptScroll)
    case 'panel':
      return state.panel && 'scroll' in state.panel
        ? Math.max(0, Math.min(state.panel.scroll, Math.max(0, total - shown)))
        : 0
    case 'panel-side':
      return state.panel && 'listScroll' in state.panel
        ? Math.max(0, Math.min(state.panel.listScroll, Math.max(0, total - shown)))
        : 0
    // A picture of a chain is as tall as it is; it only ever moves sideways.
    case 'plan':
      return 0
  }
}

/**
 * Take hold of a scrollbar, at a row of the window — or at a column of it,
 * for the one lying down. Grabbed on the thumb it moves with the pointer from
 * there; grabbed on the track the thumb comes to the pointer, which is what
 * every other scrollbar does.
 */
export function grabBar(
  state: AppState,
  bar: { area: ScrollArea; total: number; shown: number; across?: boolean },
  track: { top: number; rows: number },
  y: number,
): AppState {
  const view = {
    total: bar.total,
    shown: bar.shown,
    rows: track.rows,
    offset:
      bar.across === true
        ? acrossOf(state, bar.area, bar.total, bar.shown)
        : offsetOf(state, bar.area, bar.total, bar.shown),
  }
  const thumb = thumbOf(view)
  const at = y - track.top
  const size = thumb?.size ?? 1
  const grab =
    thumb && at >= thumb.from && at < thumb.from + size
      ? at - thumb.from
      : Math.floor((size - 1) / 2)
  return scrollBarTo({ ...state, scrolling: { ...bar, ...track, grab } }, y)
}

/**
 * Drag the bar being held to a row of the window — or, lying down, to a column
 * of it — and move what it belongs to.
 */
export function scrollBarTo(state: AppState, y: number): AppState {
  const bar = state.scrolling
  if (!bar) return state
  const view = { total: bar.total, shown: bar.shown, rows: bar.rows, offset: 0 }
  const offset = offsetAt(view, y - bar.top - bar.grab)
  return atOffset(state, bar.area, offset, bar, bar.across === true)
}

/**
 * Scroll a region from where it is by `by` rows — or, `across`, by that many
 * columns — and never past either end.
 *
 * The one move every surface makes. A notch of the wheel, a key, a drag on
 * the bar: each works out where it means to land and lands there through
 * `atOffset`, so the three of them can never disagree about where the end is.
 * Which they used to: an agent's screen and a terminal had no end at all and
 * went on counting past the last line there was, so a flick past the bottom
 * bought a handful of notches that did nothing on the way back.
 *
 * `reach` is what the drawing said the region is. Nothing here lays anything
 * out to find that: the bar beside it carries the numbers already.
 */
export function scrollBy(
  state: AppState,
  area: ScrollArea,
  by: number,
  reach: Reach,
  across = false,
): AppState {
  if (by === 0 || !scrollable(reach)) return state
  const most = endOf(reach)
  const from = across
    ? acrossOf(state, area, reach.total, reach.shown)
    : offsetOf(state, area, reach.total, reach.shown)
  const to = Math.max(0, Math.min(most, from + by))
  return to === from ? state : atOffset(state, area, to, reach, across)
}

/**
 * Put a region at an offset: `offset` lines above the first one in view, or
 * columns left of it.
 *
 * The other half of `offsetOf`, and the only writer. Where a region keeps its
 * place differs — a sidebar counts down from the top, a screen counts back
 * from its newest line — and this is the one place that difference is
 * written, as `offsetOf` is the one place it is read.
 */
export function atOffset(
  state: AppState,
  area: ScrollArea,
  offset: number,
  reach: Reach,
  across = false,
): AppState {
  if (across) {
    if (area === 'plan') return { ...state, planAcross: offset }
    if (area === 'sidebar') return { ...state, across: offset }
    return state
  }
  const back = Math.max(0, reach.total - reach.shown - offset)
  switch (area) {
    case 'sidebar':
      return { ...state, scroll: offset }
    case 'actions':
      return { ...state, actionsScroll: offset }
    case 'pane':
      return { ...state, paneScroll: back }
    case 'terminal':
      return { ...state, terminalScroll: back }
    case 'transcript':
      return { ...state, transcriptScroll: back }
    case 'panel':
      // A page being dragged by its bar is not following anything: what the
      // keyboard was last on must not pull it back under the pointer.
      return state.panel && 'scroll' in state.panel
        ? {
            ...state,
            panel: {
              ...state.panel,
              scroll: offset,
              ...('following' in state.panel ? { following: false } : {}),
            },
          }
        : state
    case 'panel-side':
      return state.panel && 'listScroll' in state.panel
        ? { ...state, panel: { ...state.panel, listScroll: offset } }
        : state
    case 'plan':
      return state
  }
}

/**
 * The agents in the project in front of you that have finished: what `X`
 * closes, and what `H` hides. Read from every pane rather than from the list,
 * so hiding them never changes what `X` would close.
 */
export function doneTasks(state: AppState): AgentPane[] {
  return agentsHere(state).filter((pane) => markOf(pane) === 'done')
}

/**
 * Whether anything is working, which is what makes a frame news.
 *
 * A spinner turns, so while the orchestrator is thinking, one of its tools is
 * running or an agent in this project is working, every look is worth drawing
 * even though no lane printed anything. A rule rather than a reading of the
 * screen: the window asks it four times a second.
 */
export function anythingWorking(state: AppState): boolean {
  if (state.transcript.thinking !== null) return true
  if (state.transcript.entries.some((one) => one.kind === 'tool' && one.state === 'running'))
    return true
  return state.panes.some((pane) => pane.project === state.project && markOf(pane) === 'working')
}

/** Show or hide the agents that have finished. */
export function toggleDone(state: AppState): AppState {
  return { ...state, hidingDone: !state.hidingDone }
}

/**
 * Whether a sidebar section is drawn open. Most are, unless you folded them;
 * one with nothing in it (`quiet`) is shut unless you opened it — which is how
 * the SMART QUEUE is there whether or not there is work waiting, and costs the
 * side a heading rather than a list of nothing.
 */
export function sectionOpen(state: AppState, section: string, quiet: boolean): boolean {
  if (state.opened.includes(section)) return true
  if (state.folded.includes(section)) return false
  return !quiet
}

/**
 * Fold or unfold a sidebar section.
 *
 * Only what differs from what the section does on its own is written down, so
 * folding one and opening it again leaves it following its own rule rather
 * than pinned to what it happened to be doing that minute.
 */
export function toggleSection(state: AppState, section: string, quiet = false): AppState {
  const want = !sectionOpen(state, section, quiet)
  const folded = state.folded.filter((name) => name !== section)
  const opened = state.opened.filter((name) => name !== section)
  if (want === !quiet) return { ...state, folded, opened }
  return want
    ? { ...state, folded, opened: [...opened, section] }
    : { ...state, folded: [...folded, section], opened }
}

/** The next task waiting on you after the one in front of you, across projects. */
export function nextWaiting(state: AppState): string | null {
  const waiting = inOrder(state.panes, state.order).filter((pane) => markOf(pane) === 'needs-you')
  if (waiting.length === 0) return null
  const at = waiting.findIndex((pane) => pane.task === state.focused)
  return waiting[(at + 1) % waiting.length]?.task ?? null
}

/** The project you are looking at, if you are looking at anything. */
export function focusedProject(state: AppState): string | null {
  return state.panes.find((pane) => pane.task === state.focused)?.project ?? null
}

/** Whether what is being typed is reaching for a command rather than words. */
export function isAction(typed: string | null): boolean {
  return typed?.startsWith('/') === true
}

export function noteTyping(state: AppState, at: number): AppState {
  return { ...state, lastInputAt: at }
}

export function setListening(state: AppState, listening: boolean): AppState {
  return { ...state, listening }
}

/** An exchange Tade finished, into the conversation. */
export function addTurn(state: AppState, turn: Turn): AppState {
  return { ...state, transcript: fromTurn(state.transcript, turn) }
}

/**
 * Nothing in the project you are standing in: no agent, and nothing queued
 * that would become one. What its screen shows is the wordmark and a line to
 * type on (`view/empty.ts`).
 *
 * Read of the project rather than of the window, because the window is never
 * empty — there is always another project with something in it, and that is
 * exactly what used to be shown to somebody who had just closed their last
 * agent here.
 */
export function emptyProject(state: AppState): boolean {
  return !state.panes.some((pane) => pane.project === state.project)
}

/**
 * Where the orchestrator's line is drawn.
 *
 * There is one line and one editor behind it. It lives at the foot, under the
 * conversation, and every screen with something in the pane keeps it there.
 * A project with no agents has nothing in the pane, so it draws the line in
 * the middle of the screen instead, under the wordmark, where somebody with
 * nothing to look at is looking — and the foot draws none, because two boxes
 * saying `Ask Tade anything` is the window asking twice.
 *
 * Only while the bottom panel is on the orchestrator's own tab: with a
 * terminal in front, what you type goes to the terminal, and a box drawn
 * away from where the keystrokes land is a lie about where they land. And
 * only while the pane really is drawing that screen — a plan or a schedule
 * you opened is in front of you in a project that has nothing else in it,
 * and answering `splash` there would take the line off both regions.
 *
 * Both regions read this, and so does the editor, which wraps at the width it
 * is rendered at: three answers to where the line is would be three widths.
 */
export function linePlace(state: AppState): 'strip' | 'splash' {
  const nothingInFront =
    !state.panes.some((pane) => pane.task === state.focused) &&
    !state.showingPlan &&
    state.schedule === null
  return nothingInFront && emptyProject(state) && activeTerminal(state) === null
    ? 'splash'
    : 'strip'
}

/**
 * Whether the conversation with the orchestrator is going on — being typed or
 * spoken to, or answering — so the bottom panel should make room to read it.
 */
export function conversing(state: AppState): boolean {
  if (state.bottom !== ORCHESTRATOR_TAB) return false
  // Not for typing: opening the line must not move everything above it. A
  // command being chosen needs the room for its list.
  return (
    state.listening ||
    (state.dictation?.startsWith('/') ?? false) ||
    state.transcript.thinking !== null ||
    state.transcript.entries.some((entry) => entry.kind === 'tool' && entry.state === 'running')
  )
}

/**
 * Change the conversation. It follows the newest line — unless you have
 * scrolled back to read, which something arriving must not undo; saying
 * something yourself brings you back down.
 */
export function withTranscript(state: AppState, transcript: Transcript): AppState {
  const yours = transcript.entries.at(-1)?.kind === 'you'
  return {
    ...state,
    transcript,
    transcriptScroll: yours ? 0 : state.transcriptScroll,
  }
}

export function setQuestion(state: AppState, question: AppState['question']): AppState {
  return { ...state, question }
}

/**
 * Open, extend or close the dictation line.
 *
 * Closing it goes through `leaveLine`, so what was half-written is kept
 * whoever closes it — the one thing a window may never throw away.
 */
export function setDictation(state: AppState, dictation: string | null): AppState {
  if (dictation === null) return leaveLine(state)
  return { ...state, dictation }
}

/**
 * Leave the orchestrator's line, keeping what is on it.
 *
 * What you typed at Tade is the orchestrator's, not the focus's: moving to an
 * agent, a terminal, a picture's question or anywhere else may change where
 * the keyboard is and may never change what is on the line. So the text lives
 * in `orchestratorDraft` whether or not the line is open, and `dictation`
 * being null says only that it is closed.
 *
 * This and `openLine` are the only two doors, because a half-written message
 * lost on the way to an agent is the same bug from the other side as one lost
 * to escape — and a rule each of a dozen call sites has to remember is a rule
 * half of them forgot.
 */
export function leaveLine(state: AppState): AppState {
  return {
    ...state,
    dictation: null,
    orchestratorDraft: state.dictation ?? state.orchestratorDraft,
  }
}

/** Open the orchestrator's line, on whatever was last left on it. */
export function openLine(state: AppState): AppState {
  return { ...state, dictation: state.dictation ?? state.orchestratorDraft }
}

/** The line a search finds: the newest that contains it, or older ones for each ctrl+r again. */
export function historyMatch(
  history: readonly string[],
  search: { query: string; skip: number },
): string | null {
  const query = search.query.toLowerCase()
  let skipped = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const line = history[i] ?? ''
    if (!line.toLowerCase().includes(query)) continue
    if (skipped === search.skip) return line
    skipped++
  }
  return null
}

/**
 * A key while searching back: typing narrows, ctrl+r looks further back,
 * enter or an arrow keeps what it found on the line, escape puts back what was
 * there. The line shows the match as it is found. Returns whether enter should
 * also send it.
 */
export function searchKey(
  state: AppState,
  history: readonly string[],
  key: string | undefined,
  data: string,
): { state: AppState; send: boolean } {
  const search = state.historySearch
  if (!search) return { state, send: false }
  const looking = (next: { query: string; skip: number }): AppState => {
    const found = historyMatch(history, next)
    return {
      ...state,
      historySearch: { ...search, ...next, missing: found === null },
      dictation: found ?? state.dictation,
    }
  }
  if (key === 'ctrl+r') {
    const further = { query: search.query, skip: search.skip + 1 }
    return {
      state: historyMatch(history, further) === null ? state : looking(further),
      send: false,
    }
  }
  if (key === 'escape' || key === 'ctrl+g') {
    return { state: { ...state, historySearch: null, dictation: search.draft }, send: false }
  }
  const keep = (send: boolean) => ({
    state: {
      ...state,
      historySearch: null,
      dictation: search.missing ? search.draft : state.dictation,
    },
    send: send && !search.missing,
  })
  if (key === 'enter') return keep(true)
  if (key === 'left' || key === 'right' || key === 'up' || key === 'down' || key === 'tab')
    return keep(false)
  if (key === 'backspace') {
    return { state: looking({ query: search.query.slice(0, -1), skip: 0 }), send: false }
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a control key is not something to search for
  if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) {
    return { state: looking({ query: search.query + data, skip: 0 }), send: false }
  }
  return { state, send: false }
}

/** Start searching back through what you said, keeping the line as it was to return to. */
export function startHistorySearch(state: AppState, history: readonly string[]): AppState {
  const draft = state.dictation ?? ''
  const found = historyMatch(history, { query: '', skip: 0 })
  return {
    ...state,
    historySearch: { query: '', skip: 0, draft, missing: found === null },
    dictation: found ?? draft,
  }
}

/** Show what is being held back at an agent's prompt. */
export function setHeld(state: AppState, held: string | null): AppState {
  return { ...state, held }
}

/**
 * Something Tade did or noticed, said in the conversation — where it stays,
 * rather than on a line the next one overwrote before it was read.
 */
export function notice(state: AppState, notice: string | null): AppState {
  if (notice === null) return { ...state, notice }
  return { ...state, notice, transcript: tadeDid(state.transcript, notice, 0) }
}

/**
 * React to something that happened. A pane that needs a human raises itself,
 * unless you are mid-sentence somewhere else: the app never pulls the screen
 * out from under you.
 */
export function onEvent(state: AppState, event: TadeEvent, now: number): AppState {
  const waiting = event.type === 'permission_request'
  const settled = event.type === 'permission_granted' || event.type === 'permission_denied'

  let next = state
  if (event.task && (waiting || settled)) {
    next = {
      ...next,
      panes: next.panes.map((pane) => (pane.task === event.task ? { ...pane, waiting } : pane)),
    }
  }

  // Somewhere you are not looking needs you: say so where you will see it,
  // without taking the screen.
  if (waiting && event.task && event.task !== state.focused) {
    next = {
      ...next,
      toasts: [...next.toasts.filter((t) => t.task !== event.task), { task: event.task, at: now }],
    }
  }
  if (settled && event.task)
    next = { ...next, toasts: next.toasts.filter((t) => t.task !== event.task) }
  if (!shouldRaise(next, event, now)) return next
  return { ...next, focused: event.task, notice: `${short(event.task ?? '')} needs you` }
}

/** Only something waiting on a human earns the screen, and only if you're idle. */
export function shouldRaise(state: AppState, event: TadeEvent, now: number): boolean {
  if (!event.task || event.urgency !== 'blocking') return false
  if (!state.panes.some((pane) => pane.task === event.task)) return false
  if (state.focused === event.task) return false
  if (state.lastInputAt !== null && now - state.lastInputAt < FOCUS_GUARD_MS) return false
  return true
}

export interface SidebarGroup {
  project: string
  tasks: Array<AgentPane & { focused: boolean }>
}

/** The sidebar: projects in name order, each with its tasks. */
export function sidebar(state: AppState): SidebarGroup[] {
  const groups = new Map<string, SidebarGroup>()
  for (const pane of state.panes) {
    const group = groups.get(pane.project) ?? { project: pane.project, tasks: [] }
    group.tasks.push({ ...pane, focused: pane.task === state.focused })
    groups.set(pane.project, group)
  }
  return [...groups.values()].sort((a, b) => a.project.localeCompare(b.project))
}

/**
 * What an agent is doing, as its mark says at a glance: working right now,
 * idle with its session open, waiting on you, failed, finished, not running,
 * or parked.
 */
export type AgentMark = 'working' | 'idle' | 'needs-you' | 'failed' | 'done' | 'stopped' | 'parked'

/** What a mark is read from: an agent's state and why, and whether anything waits on you. */
type Marked = Pick<AgentPane, 'state' | 'reason'> & {
  waiting?: boolean
  approval?: AgentPane['approval']
  finished?: AgentPane['finished']
  queued?: AgentPane['queued']
}

export function markOf(pane: Marked): AgentMark {
  // Held queued work is a decision nobody has made yet, like an approval.
  if (pane.waiting || pane.approval || pane.queued?.state.kind === 'held') return 'needs-you'
  // Finished is what its rule says, or what someone said: an agent that ended
  // its turn after saying so is done, not idle. Put back to work, it is working.
  if (pane.finished && pane.state !== 'working' && pane.state !== 'parked') return 'done'
  switch (pane.state) {
    case 'working':
      return 'working'
    case 'failed':
      return 'failed'
    case 'parked':
      return 'parked'
    case 'review':
    case 'merged':
      return 'done'
    // Its turn is over. Only waiting to be told something is not a decision to make.
    case 'blocked':
      return pane.reason === IDLE_REASON ? 'idle' : 'needs-you'
    default:
      return 'stopped'
  }
}

/** Which of the skin's tones each mark is drawn in. */
export const MARK_TONES: Readonly<Record<AgentMark, 'busy' | 'hint' | 'waiting' | 'bad' | 'done'>> =
  {
    working: 'busy',
    idle: 'hint',
    'needs-you': 'waiting',
    failed: 'bad',
    done: 'done',
    stopped: 'hint',
    parked: 'hint',
  }

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

/** Which spinner frame to show at a moment: a tenth of a second each. */
export function spinner(now: number): string {
  return SPINNER[Math.floor(now / 100) % SPINNER.length] ?? '⠋'
}

/**
 * The one character that shows what an agent is doing, by its shape as well
 * as its colour: colour is decoration, and eight dots in five colours are eight
 * identical dots to anyone who cannot tell the colours apart. Working turns.
 *
 * Queued work is not an agent and has no mark of its own — `markOf` reads it
 * as stopped — so it is named here beside them: the project tabs count it, and
 * two drawings of one vocabulary drift apart.
 */
export function markGlyph(mark: AgentMark | 'queued', now = 0): string {
  switch (mark) {
    case 'working':
      return spinner(now)
    case 'idle':
      return '●'
    case 'needs-you':
      return '!'
    case 'failed':
      return '✕'
    case 'done':
      return '✓'
    case 'parked':
      return '‖'
    case 'queued':
      return '◌'
    default:
      return '○'
  }
}

export function glyph(pane: Marked, now = 0): string {
  return markGlyph(markOf(pane), now)
}

export function paneTitle(pane: AgentPane): string {
  const parts = [pane.project, pane.name]
  if (pane.lane) parts.push(pane.lane.split('/').at(-1) ?? '')
  return parts.filter(Boolean).join(' · ')
}

/** What the top-right of the window says. */
export function headline(state: AppState): string {
  const waiting = state.panes.filter((pane) => pane.waiting).length
  const parts = [state.listening ? '⏺ listening' : '']
  if (waiting > 0) parts.push(`${waiting} waiting`)
  return parts.filter(Boolean).join(' · ')
}

export type KeyAction =
  | { kind: 'focus-next' }
  | { kind: 'focus-previous' }
  | { kind: 'talk-start' }
  | { kind: 'talk-stop' }
  | { kind: 'approve' }
  | { kind: 'deny' }
  | { kind: 'help' }
  | { kind: 'search' }
  | { kind: 'quit' }
  /** Stop the turn the orchestrator is on, and leave what you typed alone. */
  | { kind: 'interrupt' }
  /** Step off the orchestrator's line, which only ever happens with nothing on it. */
  | { kind: 'leave-line' }
  /** Throw away what you were about to send: the line, and the pictures with it. */
  | { kind: 'discard' }
  /** Put the keyboard on the orchestrator's line. */
  | { kind: 'orchestrator' }
  /** Do what a button of that name does. */
  | { kind: 'run'; action: string }
  /** Finish the command being typed on the orchestrator line. */
  | { kind: 'complete' }
  /** The agent in this place in the sidebar, counting from one. */
  | { kind: 'agent-number'; n: number }
  /** The project in this place along the top, counting from one. */
  | { kind: 'project-number'; n: number }
  | { kind: 'none' }

/**
 * Keys the shell claims. Everything it doesn't claim is typed into the focused
 * agent, so an agent's own keybindings keep working.
 */
/** Keys that do what a button does. */
const RUNS = new Set([
  'next-waiting',
  'new-agent',
  'new-terminal',
  'open-project',
  'extensions',
  'settings',
  'bottom-max',
  'reload',
])

/** `agent-3` and `project-2`, as the key names them. */
function numberAction(key: string): KeyAction | null {
  const match = /^(agent|project)-([1-9])$/.exec(key)
  if (!match) return null
  const n = Number(match[2])
  return match[1] === 'agent' ? { kind: 'agent-number', n } : { kind: 'project-number', n }
}

/** The agent in a place in the sidebar: the project in front's agents, in the order shown. */
export function focusNumber(state: AppState, n: number): AppState {
  const task = tasksOf(state)[n - 1]
  return task ? focusTask(state, task.task) : state
}

/** The project in a place along the top. */
export function projectNumber(state: AppState, n: number): AppState {
  const name = projects(state)[n - 1]
  return name ? selectProject(state, name) : state
}

/**
 * What escape means where you are. Exactly one of these, never two: "escape
 * closed the picker *and* stopped the model" is the bug this exists to make
 * impossible, so the precedence is written down once and read everywhere.
 *
 * A panel first, because it has the keyboard; then whatever you are typing
 * into that is not Tade's own line, because pi interrupts on escape and vim
 * leaves insert mode on it and a window that ate the key would break both;
 * then searching back through what you said, which escape ends; and only
 * then the orchestrator's turn. What is typed on the line is never touched by
 * any of them — losing a half-written message because you wanted to stop the
 * model is the worst version of this key.
 */
export type EscapeMeans = 'panel' | 'lane' | 'search' | 'interrupt' | 'leave' | 'nothing'

export function escapeMeans(state: AppState): EscapeMeans {
  if (state.panel) return 'panel'
  // A terminal or an agent with the keyboard answers escape itself.
  if (state.dictation === null) {
    if (state.keyboard === 'terminal' && activeTerminal(state)) return 'lane'
    if (state.focused !== null) return 'lane'
  }
  if (state.historySearch) return 'search'
  if (state.transcript.thinking !== null) return 'interrupt'
  // Stepping off the line, and only ever with nothing on it to lose: escape
  // backs out of where you are everywhere else, and here there is nothing for
  // it to back out of until the line is empty. With something typed it does
  // nothing at all, which is the whole point of the key.
  if (state.dictation !== null && !somethingTyped(state)) return 'leave'
  return 'nothing'
}

/** Whether there is anything on the orchestrator's line to throw away. */
export function somethingTyped(state: AppState): boolean {
  if (state.dictation === null) return false
  return state.dictation !== '' || state.attached.length > 0 || state.historySearch !== null
}

export function keyAction(key: string, state: AppState): KeyAction {
  // A terminal with the keyboard gets tab for completion, ctrl+c to interrupt,
  // and every letter: only talking and search stay Tade's.
  if (state.keyboard === 'terminal' && state.dictation === null && activeTerminal(state)) {
    if (key === 'talk-down') return { kind: 'talk-start' }
    if (key === 'talk-up') return state.listening ? { kind: 'talk-stop' } : { kind: 'none' }
    if (key === 'search') return { kind: 'search' }
    if (key === 'orchestrator') return { kind: 'orchestrator' }
    // A shell keeps tab, and a letter while nothing waits; the rest are the window's.
    const numbered = numberAction(key)
    if (numbered) return numbered
    if (RUNS.has(key) || key === 'mute' || key === 'keys') return { kind: 'run', action: key }
    return { kind: 'none' }
  }
  // Escape is only ever the window's where the window is what you are typing
  // at, and only ever one thing: `escapeMeans` says which.
  if (key === 'escape') {
    const means = escapeMeans(state)
    if (means === 'interrupt') return { kind: 'interrupt' }
    if (means === 'leave') return { kind: 'leave-line' }
    return { kind: 'none' }
  }
  // Typing a command, tab finishes it rather than moving on.
  if (key === 'tab' && (state.dictation?.startsWith('/') ?? false)) return { kind: 'complete' }
  if (key === 'tab') return { kind: 'focus-next' }
  if (key === 'shift+tab') return { kind: 'focus-previous' }
  // Push to talk is claimed even while an agent has focus: it must never be
  // swallowed by whatever is running in a pane.
  if (key === 'talk-down') return { kind: 'talk-start' }
  if (key === 'talk-up') return state.listening ? { kind: 'talk-stop' } : { kind: 'none' }
  // ctrl+c throws away what you were about to send, and quits once there is
  // nothing left to throw away — which is what pi, Claude Code and Codex all
  // do, and why "press it again" needs no timer here: the second press has
  // nothing to clear, so it quits however long you took over it.
  if (key === 'ctrl+c') return somethingTyped(state) ? { kind: 'discard' } : { kind: 'quit' }
  if (key === 'search') return { kind: 'search' }
  if (key === 'orchestrator') return { kind: 'orchestrator' }
  if (key === 'keys' || key === 'mute') return { kind: 'run', action: key }
  if (RUNS.has(key)) return { kind: 'run', action: key }
  const numbered = numberAction(key)
  if (numbered) return numbered
  // Answering an approval is a single key only while one is actually waiting,
  // and never while a line to Tade is being typed.
  const focused = state.panes.find((pane) => pane.task === state.focused)
  if (state.dictation === null && focused?.waiting && key === 'a') return { kind: 'approve' }
  if (state.dictation === null && focused?.waiting && key === 'd') return { kind: 'deny' }
  return { kind: 'none' }
}

export function removeAttachment(state: AppState, path: string): AppState {
  return { ...state, attached: state.attached.filter((p) => p !== path) }
}

function short(task: string): string {
  return task.split('/').at(-1) ?? task
}
