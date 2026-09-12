import type { TaskState, WilcoEvent } from '@wilco/core'
import type { Turn } from '@wilco/surface-voice'

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
}

export interface AppState {
  panes: AgentPane[]
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
  /** One line of transient news for the footer. */
  notice: string | null
}

export function initialState(): AppState {
  return {
    panes: [],
    focused: null,
    turns: [],
    listening: false,
    lastInputAt: null,
    question: null,
    dictation: null,
    notice: null,
  }
}

export interface TaskSnapshot {
  task: string
  state: TaskState
  lane?: string | null
  waiting?: boolean
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
  }))
  const focused =
    state.focused && panes.some((pane) => pane.task === state.focused)
      ? state.focused
      : (panes[0]?.task ?? null)
  return { ...state, panes, focused }
}

export function focusTask(state: AppState, task: string): AppState {
  return state.panes.some((pane) => pane.task === task) ? { ...state, focused: task } : state
}

/** Move focus along the sidebar, wrapping at both ends. */
export function focusBy(state: AppState, delta: number): AppState {
  if (state.panes.length === 0) return state
  const at = state.panes.findIndex((pane) => pane.task === state.focused)
  const next = at < 0 ? 0 : (at + delta + state.panes.length) % state.panes.length
  return { ...state, focused: state.panes[next]?.task ?? state.focused }
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
