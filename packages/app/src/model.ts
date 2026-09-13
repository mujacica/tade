import type { TaskState, WilcoEvent } from '@wilco/core'
import type { Turn } from '@wilco/voice-core'
import type { Target } from './hits.ts'
import type { Panel } from './panels.ts'

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

/** How much of the conversation to keep on screen. */
export const TURN_HISTORY = 50

export interface AgentPane {
  task: string
  project: string
  /** The task's own name, which is what people say out loud. */
  name: string
  /** Lane whose screen this pane draws, when the agent has one. */
  lane: string | null
  state: TaskState
  /** Something is waiting on a human here. */
  waiting: boolean
  /** What it is waiting for, when that is an approval. */
  approval: { tool: string; summary: string } | null
}

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
  turns: Turn[]
  /** Push-to-talk is held. */
  listening: boolean
  /** When you last typed into a pane, which is what holds focus still. */
  lastInputAt: number | null
  /** A question the resolver asked, waiting for you to pick one. */
  question: { question: string; candidates: string[] } | null
  /**
   * What is being dictated, or null when the line is closed. Typed today and
   * filled by a transcriber later: both feed the same sentence to the surface.
   */
  dictation: string | null
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
  /** When the microphone opened, while it is open. */
  talkingSince: number | null
  /** What was said is being turned into words. */
  hearing: boolean
  /** The panel floating over the window, if one is. */
  panel: Panel | null
}

/** Sections that start folded: the ones you look at on purpose, not all the time. */
export const FOLDED_AT_START = ['files', 'notes']

export function initialState(): AppState {
  return {
    panes: [],
    known: [],
    project: null,
    focused: null,
    turns: [],
    listening: false,
    lastInputAt: null,
    question: null,
    dictation: null,
    held: null,
    notice: null,
    chose: false,
    hover: null,
    pressed: null,
    folded: [...FOLDED_AT_START],
    talkingSince: null,
    hearing: false,
    panel: null,
  }
}

export interface TaskSnapshot {
  task: string
  state: TaskState
  lane?: string | null
  waiting?: boolean
  approval?: { tool: string; summary: string } | null
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
    lane: task.lane ?? null,
    state: task.state,
    waiting: task.waiting ?? false,
    approval: task.approval ?? null,
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
  const known = [...names].sort((a, b) => a.localeCompare(b))
  return { ...state, known, project: state.project ?? known[0] ?? null }
}

/** Every project, whether it came from the config or from a task. */
export function projects(state: AppState): string[] {
  const names = new Set(state.known)
  for (const pane of state.panes) names.add(pane.project)
  return [...names].sort((a, b) => a.localeCompare(b))
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
  return { ...state, project, focused: first?.task ?? null, chose: true }
}

/** The tasks down the side: the selected project's, in the order they come. */
export function tasksOf(state: AppState): Array<AgentPane & { focused: boolean }> {
  return state.panes
    .filter((pane) => pane.project === (state.project ?? pane.project))
    .map((pane) => ({ ...pane, focused: pane.task === state.focused }))
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
  return pane ? { ...state, focused: task, project: pane.project, chose: true } : state
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
  // `null` is the orchestrator, and it is always there.
  const ring: Array<string | null> = [...state.panes.map((pane) => pane.task), null]
  const at = ring.indexOf(state.focused)
  const next = ((((at < 0 ? 0 : at) + delta) % ring.length) + ring.length) % ring.length
  const focused = ring[next] ?? null
  const project = state.panes.find((pane) => pane.task === focused)?.project ?? state.project
  return { ...state, focused, project }
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
    { name: '/task', about: 'start work: /task what needs doing', ready: true },
    {
      name: '/agent',
      about: focused ? `another agent on ${focused.name}` : 'start an agent on a task',
      ready: state.panes.length > 0,
    },
    {
      name: '/stop',
      about: running.length > 0 ? 'stop an agent, keeping its task' : 'nothing is running',
      ready: running.length > 0,
    },
    {
      name: '/open',
      about: state.panes.length > 0 ? 'watch a task: /open name' : 'no tasks yet',
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
 * Most commands take the rest of the line as what they are for — `/task fix
 * the double charge` is a whole task, said in one go — so the two are split
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
 * Which project a new task belongs to, and what it is for.
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

/** Fold or unfold a sidebar section. */
export function toggleSection(state: AppState, section: string): AppState {
  const folded = state.folded.includes(section)
    ? state.folded.filter((name) => name !== section)
    : [...state.folded, section]
  return { ...state, folded }
}

/** The next task waiting on you after the one in front of you, across projects. */
export function nextWaiting(state: AppState): string | null {
  const waiting = state.panes.filter((pane) => pane.waiting || pane.state === 'blocked')
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

export function addTurn(state: AppState, turn: Turn): AppState {
  return { ...state, turns: [...state.turns, turn].slice(-TURN_HISTORY) }
}

export function setQuestion(state: AppState, question: AppState['question']): AppState {
  return { ...state, question }
}

/** Open, extend or close the dictation line. */
export function setDictation(state: AppState, dictation: string | null): AppState {
  return { ...state, dictation }
}

/** Show what is being held back at an agent's prompt. */
export function setHeld(state: AppState, held: string | null): AppState {
  return { ...state, held }
}

export function notice(state: AppState, notice: string | null): AppState {
  return { ...state, notice }
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

/** A glyph per state, so a column of them is readable at a glance. */
export function glyph(pane: AgentPane): string {
  if (pane.waiting || pane.state === 'blocked') return '●'
  if (pane.state === 'failed') return '◍'
  if (pane.state === 'review') return '◆'
  if (pane.state === 'working') return '○'
  if (pane.state === 'parked') return '◌'
  return '·'
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
  | { kind: 'quit' }
  | { kind: 'none' }

/**
 * Keys the shell claims. Everything it doesn't claim is typed into the focused
 * agent, so an agent's own keybindings keep working.
 */
export function keyAction(key: string, state: AppState): KeyAction {
  if (key === 'tab') return { kind: 'focus-next' }
  if (key === 'shift+tab') return { kind: 'focus-previous' }
  // Push to talk is claimed even while an agent has focus: it must never be
  // swallowed by whatever is running in a pane.
  if (key === 'talk-down') return { kind: 'talk-start' }
  if (key === 'talk-up') return state.listening ? { kind: 'talk-stop' } : { kind: 'none' }
  if (key === 'ctrl+c') return { kind: 'quit' }
  if (key === '?') return { kind: 'help' }
  // Answering an approval is a single key only while one is actually waiting.
  const focused = state.panes.find((pane) => pane.task === state.focused)
  if (focused?.waiting && key === 'a') return { kind: 'approve' }
  if (focused?.waiting && key === 'd') return { kind: 'deny' }
  return { kind: 'none' }
}

function short(task: string): string {
  return task.split('/').at(-1) ?? task
}
