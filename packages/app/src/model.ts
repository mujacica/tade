import {
  type DoneRule,
  IDLE_REASON,
  type QueueState,
  type TaskState,
  type WilcoEvent,
} from '@wilco/core'
import type { Turn } from '@wilco/voice-core'
import type { Target } from './hits.ts'
import type { Panel } from './panels.ts'
import { emptyTranscript, fromTurn, type Transcript, wilcoDid } from './transcript.ts'

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

/** Which queued work the SMART QUEUE shows: all of it, what waits on agents, or what waits for a time. */
export type QueueFilter = 'all' | 'next' | 'timed'

export const QUEUE_FILTERS: readonly QueueFilter[] = ['all', 'next', 'timed']

export interface AppState {
  panes: AgentPane[]
  /**
   * Every project Wilco has been told about, whether or not it has tasks yet.
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
   * line addressed to Wilco. Shown, so they are never simply missing.
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
  /** Which queued work the SMART QUEUE shows. */
  queueFilter: QueueFilter
  /** The plan is drawn where an agent's screen would be, while no agent is in front. */
  showingPlan: boolean
  /** Folders opened in the FILES tree, relative to the folder it is of. */
  expanded: string[]
  /** How many rows the sidebar is scrolled down. */
  scroll: number
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
  /** Text saved from the orchestrator line when focus moves away, restored on refocus. */
  orchestratorDraft: string
  /** A divider being dragged. */
  resizing: 'sidebar' | 'bottom' | 'split' | 'terminal-split' | null
  /** A second lane shown with an agent's own, by task: a shell beside it, or below. */
  splits: Record<string, Split>
  /** A second terminal shown with the one in front of the bottom panel. */
  terminalSplit: Split | null
  /**
   * By project: the agents in the order you dragged them into. Any you have
   * not placed come after, in the order they came.
   */
  order: Record<string, string[]>
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
    queueFilter: 'all',
    showingPlan: false,
    expanded: [],
    scroll: 0,
    talkingSince: null,
    hearing: false,
    levels: [],
    panel: null,
    viewing: {},
    toasts: [],
    terminals: [],
    bottom: ORCHESTRATOR_TAB,
    bottomMode: 'open',
    keyboard: 'pane',
    sizes: {},
    resizing: null,
    splits: {},
    terminalSplit: null,
    order: {},
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
    ...(task.queued ? { queued: task.queued } : {}),
  }))
  const focused = refocus(state, panes)
  const project =
    panes.find((pane) => pane.task === focused)?.project ??
    state.project ??
    panes[0]?.project ??
    null
  return { ...state, panes, focused, project }
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
 * Go to a project.
 *
 * Focus follows, because a sidebar listing one project's tasks while the pane
 * shows another project's agent is two answers to "where am I". An empty
 * project puts you on the orchestrator, which is where you would start work.
 */
export function selectProject(state: AppState, project: string): AppState {
  const first = state.panes.find((pane) => pane.project === project)
  return { ...state, project, focused: first?.task ?? null, chose: true, scroll: 0 }
}

/** The tasks down the side: the selected project's, in the order they come. */
export function tasksOf(
  state: AppState,
): Array<AgentPane & { focused: boolean; dragging: boolean }> {
  // Queued work is not an agent yet: it waits in the SMART QUEUE until it starts.
  const here = state.panes.filter(
    (pane) => pane.project === (state.project ?? pane.project) && !pane.queued,
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

/** In what order queued work is listed: what needs deciding, then what starts soonest. */
const QUEUE_RANK: Readonly<Record<QueueState['kind'], number>> = {
  held: 0,
  ready: 1,
  waiting: 2,
  scheduled: 3,
  paused: 4,
}

/** Whether queued work is what a filter shows. */
export function shownBy(filter: QueueFilter, queued: QueuedView): boolean {
  if (filter === 'all') return true
  const timed = queued.at !== null || queued.state.kind === 'scheduled'
  return filter === 'timed' ? timed : !timed
}

/**
 * The queued work in the project in front of you, as the filter shows it:
 * what needs deciding first, then what starts soonest, then what is paused.
 */
export function queueOf(
  state: AppState,
): Array<AgentPane & { queued: QueuedView; focused: boolean }> {
  const here = state.panes.filter(
    (pane): pane is AgentPane & { queued: QueuedView } =>
      Boolean(pane.queued) && pane.project === (state.project ?? pane.project),
  )
  const at = (pane: { queued: QueuedView }) =>
    pane.queued.state.kind === 'scheduled' ? pane.queued.state.at : (pane.queued.at ?? 0)
  return here
    .map((pane, i) => ({ pane, i }))
    .filter(({ pane }) => shownBy(state.queueFilter, pane.queued))
    .sort(
      (a, b) =>
        QUEUE_RANK[a.pane.queued.state.kind] - QUEUE_RANK[b.pane.queued.state.kind] ||
        at(a.pane) - at(b.pane) ||
        a.i - b.i,
    )
    .map(({ pane }) => ({ ...pane, focused: pane.task === state.focused }))
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
 */
function refocus(state: AppState, panes: AgentPane[]): string | null {
  if (state.chose) {
    // A task that has gone cannot keep focus; the orchestrator always can.
    if (state.focused === null) return null
    return panes.some((pane) => pane.task === state.focused)
      ? state.focused
      : (panes[0]?.task ?? null)
  }
  return state.focused && panes.some((pane) => pane.task === state.focused)
    ? state.focused
    : (panes[0]?.task ?? null)
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
        showingPlan: false,
      }
    : state
}

/** The plan in front of you, where an agent's screen was: which work comes first, and what waits on what. */
export function showPlan(state: AppState): AppState {
  return { ...state, focused: null, chose: true, showingPlan: true }
}

/**
 * The project's plan, as tasks and waits: every task something waits on, and
 * everything that waits, started or not. Work nothing waits on and that waits
 * on nothing is not part of a plan.
 */
export function planOf(state: AppState): {
  tasks: AgentPane[]
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
  const inPlan = new Set(waits.flatMap((wait) => [wait.from, wait.to]))
  return { tasks: here.filter((pane) => inPlan.has(pane.task)), waits }
}

/** Move focus along the sidebar, wrapping at both ends. */
/**
 * Move focus, counting the orchestrator as one of the things you can focus.
 *
 * It is where you type to Wilco, so leaving it out of the cycle meant a window
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
  if (focused === null) return { ...state, dictation: state.dictation ?? state.orchestratorDraft }
  const project = state.panes.find((pane) => pane.task === focused)?.project ?? state.project
  return {
    ...state,
    focused,
    project,
    dictation: null,
    orchestratorDraft: state.dictation ?? state.orchestratorDraft,
  }
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
    { name: '/project', about: 'add a git repository Wilco can work in', ready: true },
    { name: '/settings', about: 'see and change what Wilco has been told', ready: true },
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
  return { ...focusTask(state, task), viewing: { ...state.viewing, [task]: lane } }
}

/** The second lane an agent's pane shows, while it is alive and not the one already shown. */
export function splitShown(state: AppState, pane: AgentPane): Split | null {
  const split = state.splits[pane.task]
  if (!split || !pane.lanes.some((lane) => lane.id === split.lane)) return null
  return split.lane === laneShown(state, pane) ? null : split
}

/** Show a lane beside or below the one a pane shows, half and half, with the keyboard on it. */
export function splitPane(
  state: AppState,
  task: string,
  lane: string,
  direction: Split['direction'],
): AppState {
  const pane = state.panes.find((one) => one.task === task)
  if (!pane) return state
  // Splitting the lane in front with itself means the agent goes in front.
  const shown = laneShown(state, pane)
  const next =
    shown === lane ? { ...state, viewing: { ...state.viewing, [task]: pane.lane ?? lane } } : state
  return {
    ...next,
    splits: { ...next.splits, [task]: { lane, direction, ratio: 0.5 } },
    splitFocus: true,
  }
}

/** One lane again. */
export function unsplitPane(state: AppState, task: string): AppState {
  const { [task]: _, ...rest } = state.splits
  return { ...state, splits: rest, splitFocus: false }
}

/** The two halves change places. */
export function swapSplit(state: AppState, task: string): AppState {
  const pane = state.panes.find((one) => one.task === task)
  const split = pane ? splitShown(state, pane) : null
  const shown = pane ? laneShown(state, pane) : null
  if (!pane || !split || !shown) return state
  return {
    ...state,
    viewing: { ...state.viewing, [task]: split.lane },
    splits: { ...state.splits, [task]: { ...split, lane: shown } },
    splitFocus: !state.splitFocus,
  }
}

/** Beside becomes below, and below beside. */
export function turnSplit(state: AppState, task: string): AppState {
  const split = state.splits[task]
  if (!split) return state
  const direction = split.direction === 'beside' ? 'below' : 'beside'
  return { ...state, splits: { ...state.splits, [task]: { ...split, direction } } }
}

/** How much of a split the first half takes, kept where both halves stay usable. */
export function splitRatio(ratio: number): number {
  return Math.min(0.8, Math.max(0.2, ratio))
}

/** The lane typing goes to in a pane: its second half when that has the keyboard. */
export function typingLane(state: AppState, pane: AgentPane): string | null {
  const split = splitShown(state, pane)
  return split && state.splitFocus ? split.lane : laneShown(state, pane)
}

/** Two terminals in the bottom panel: the one in front, and this one beside or below it. */
export function splitTerminal(
  state: AppState,
  id: string,
  direction: Split['direction'],
): AppState {
  if (id === state.bottom || !state.terminals.some((one) => one.id === id)) return state
  return { ...state, terminalSplit: { lane: id, direction, ratio: 0.5 }, splitFocus: true }
}

/** The second terminal in the bottom panel, while both are open and the first is in front. */
export function terminalSplitShown(state: AppState): Split | null {
  const split = state.terminalSplit
  if (!split || state.bottom === ORCHESTRATOR_TAB || split.lane === state.bottom) return null
  return state.terminals.some((one) => one.id === split.lane) ? split : null
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

/** The terminal in front, if the bottom panel is showing one. */
export function activeTerminal(state: AppState): TerminalTab | null {
  return state.terminals.find((terminal) => terminal.id === state.bottom) ?? null
}

/**
 * Put a terminal in front, with the keyboard in it: opening one is for typing
 * into. Unfolds the panel if it was folded, and closes the orchestrator's line.
 */
export function showTerminal(state: AppState, id: string): AppState {
  if (!state.terminals.some((terminal) => terminal.id === id)) return state
  return {
    ...state,
    bottom: id,
    keyboard: 'terminal',
    dictation: null,
    orchestratorDraft: state.dictation ?? state.orchestratorDraft,
    bottomMode: state.bottomMode === 'min' ? 'open' : state.bottomMode,
  }
}

/** The orchestrator's tab in front, its line open to type on. */
export function showOrchestrator(state: AppState): AppState {
  return {
    ...state,
    bottom: ORCHESTRATOR_TAB,
    keyboard: 'pane',
    dictation: state.dictation ?? state.orchestratorDraft,
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

/** Scroll the sidebar. `draw` keeps it from going past the end. */
export function scrollSidebar(state: AppState, rows: number): AppState {
  return { ...state, scroll: Math.max(0, state.scroll + rows) }
}

/** Fold or unfold a sidebar section. */
export function toggleSection(state: AppState, section: string): AppState {
  const folded = state.folded.includes(section)
    ? state.folded.filter((name) => name !== section)
    : [...state.folded, section]
  return { ...state, folded }
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

/** An exchange Wilco finished, into the conversation. */
export function addTurn(state: AppState, turn: Turn): AppState {
  return { ...state, transcript: fromTurn(state.transcript, turn) }
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

/** Scroll the conversation back (positive) or forward, never past either end. */
export function scrollTranscript(state: AppState, rows: number, total: number): AppState {
  const most = Math.max(0, total)
  return { ...state, transcriptScroll: Math.max(0, Math.min(most, state.transcriptScroll + rows)) }
}

export function setQuestion(state: AppState, question: AppState['question']): AppState {
  return { ...state, question }
}

/** Open, extend or close the dictation line. */
export function setDictation(state: AppState, dictation: string | null): AppState {
  return { ...state, dictation }
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
 * Something Wilco did or noticed, said in the conversation — where it stays,
 * rather than on a line the next one overwrote before it was read.
 */
export function notice(state: AppState, notice: string | null): AppState {
  if (notice === null) return { ...state, notice }
  return { ...state, notice, transcript: wilcoDid(state.transcript, notice, 0) }
}

/**
 * React to something that happened. A pane that needs a human raises itself,
 * unless you are mid-sentence somewhere else: the app never pulls the screen
 * out from under you.
 */
export function onEvent(state: AppState, event: WilcoEvent, now: number): AppState {
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
export function shouldRaise(state: AppState, event: WilcoEvent, now: number): boolean {
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
 */
export function glyph(pane: Marked, now = 0): string {
  switch (markOf(pane)) {
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
    default:
      return '○'
  }
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

export function keyAction(key: string, state: AppState): KeyAction {
  // A terminal with the keyboard gets tab for completion, ctrl+c to interrupt,
  // and every letter: only talking and search stay Wilco's.
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
  // Typing a command, tab finishes it rather than moving on.
  if (key === 'tab' && (state.dictation?.startsWith('/') ?? false)) return { kind: 'complete' }
  if (key === 'tab') return { kind: 'focus-next' }
  if (key === 'shift+tab') return { kind: 'focus-previous' }
  // Push to talk is claimed even while an agent has focus: it must never be
  // swallowed by whatever is running in a pane.
  if (key === 'talk-down') return { kind: 'talk-start' }
  if (key === 'talk-up') return state.listening ? { kind: 'talk-stop' } : { kind: 'none' }
  if (key === 'ctrl+c') return { kind: 'quit' }
  if (key === 'search') return { kind: 'search' }
  if (key === 'orchestrator') return { kind: 'orchestrator' }
  if (key === 'keys' || key === 'mute') return { kind: 'run', action: key }
  if (RUNS.has(key)) return { kind: 'run', action: key }
  const numbered = numberAction(key)
  if (numbered) return numbered
  // Answering an approval is a single key only while one is actually waiting,
  // and never while a line to Wilco is being typed.
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
