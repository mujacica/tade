import type { Target } from './hits.ts'
import {
  type AppState,
  focusBy,
  focusNumber,
  type KeyAction,
  notice,
  ORCHESTRATOR_TAB,
  openLine,
  projectNumber,
} from './model.ts'
import type { PanelOutcome } from './panels/outcome.ts'

// What a key the window claims does, as data: the half of a keystroke that is
// the same wherever the window is drawn.
//
// The window is drawn on the machine's own terminal and, since §10 T3 of the
// Duo plan, on a phone that draws its own copy from the state the machine
// sends. Both run this. What a key changes about where that face is looking —
// the agent in front, the project, the line opened, the leader held — is a new
// state, which each face takes for itself at once, so moving about a phone is
// as instant as it is here. What a key asks the machine to *do* — answer an
// agent, run what a button runs, stop a turn — is an `Intent`, which the
// machine's own keyboard carries out where it is pressed and a phone sends
// through the away door's one act (`wire/intents.ts` is the one place either
// is carried out).
//
// What only ever touches the line being typed on — finishing a command,
// throwing the line away, stepping off it — and the leader pressed twice, which
// hands a key to a lane, are not here: each face holds its own line and its own
// way into a lane, so `keyOutcome` answers null and the caller does them.
//
// Pure, like `model.ts`: no `node:` import, no clock (the moment is handed
// in), nothing async.

/**
 * Something the window does rather than shows: what a face asks the machine
 * for. Plain data, so it can cross the away door as it is.
 */
export type Intent =
  /** Do what a button of that name does (`Router.run`). */
  | { kind: 'run'; action: string }
  /** Answer the agent in front — or the device asking at the away door — yes or no. */
  | { kind: 'decide'; allow: boolean }
  /** Stop the turn that is thinking, and nothing else (`escapeMeans`). */
  | { kind: 'interrupt' }
  /** Open the box that finds anything. */
  | { kind: 'search' }
  /** Push-to-talk pressed or let go: the machine's own microphone. */
  | { kind: 'talk'; down: boolean }
  /** Close the window: only ever the machine's own keyboard's to ask. */
  | { kind: 'quit' }
  /** Keys for the lane with the keyboard, as a terminal would send them. */
  | { kind: 'type'; data: string; pasted: boolean }
  /** What was typed on the orchestrator's line, sent: a slash command, or words for Tade. */
  | { kind: 'say'; said: string }
  /** An open panel carried out, as its keys or a click left it (`Router.applyPanel`). */
  | { kind: 'panel'; outcome: PanelOutcome }
  /**
   * A press on something a phone drew that only the machine can answer —
   * a file to read, a menu to build, an agent to open — carried out by the
   * window's own click (`Mouse.clicked`) as that phone's face. What a press
   * only moves about the face, a phone does for itself (`FarFace.tap`).
   */
  | { kind: 'click'; target: Target; button: 'left' | 'right'; at: ClickAt }

/** The kinds of intent there are, as a list a door can check a body against. */
export const INTENT_KINDS = [
  'run',
  'decide',
  'interrupt',
  'search',
  'talk',
  'quit',
  'type',
  'say',
  'panel',
  'click',
] as const satisfies readonly Intent['kind'][]

/** Where a press landed: the cell, how far into its hit, and how many presses in a row. */
export interface ClickAt {
  readonly x: number
  readonly y: number
  readonly cell?: number
  readonly clicks?: number
}

/** What a claimed key comes to: the state it leaves this face in, and what it asks done. */
export interface KeyOutcome {
  /** Where this face is looking now, where the key moved it; absent where it did not. */
  readonly state?: AppState
  /** What the machine is asked to do; absent where the key only moved this face. */
  readonly does?: Intent
  /** Whether the face should draw again for it. */
  readonly draw: boolean
}

/** What `help` says, in the strip. */
export const KEYS_HELP = 'tab switches · ctrl+space talks · a/d answers · ctrl+c clears, then quits'

/**
 * What a key the window claimed (`keyAction`) does, or null for the ones the
 * caller does itself: the leader pressed twice, the line's own three, and a
 * key that means nothing. `now` is when it was pressed, for what is said.
 */
export function keyOutcome(action: KeyAction, state: AppState, now: number): KeyOutcome | null {
  switch (action.kind) {
    case 'lead':
      return { state: { ...state, leading: true }, draw: true }
    case 'focus-next':
      return { state: focusBy(state, 1), draw: true }
    case 'focus-previous':
      return { state: focusBy(state, -1), draw: true }
    case 'talk-start':
      // What you say goes to the orchestrator, so its tab comes to the front.
      return {
        ...(state.bottom !== ORCHESTRATOR_TAB && {
          state: { ...state, bottom: ORCHESTRATOR_TAB },
        }),
        does: { kind: 'talk', down: true },
        draw: false,
      }
    case 'talk-stop':
      return { does: { kind: 'talk', down: false }, draw: false }
    case 'approve':
      return { does: { kind: 'decide', allow: true }, draw: false }
    case 'deny':
      return { does: { kind: 'decide', allow: false }, draw: false }
    case 'help':
      return { state: notice(state, KEYS_HELP, now), draw: true }
    case 'search':
      return { does: { kind: 'search' }, draw: false }
    case 'orchestrator':
      // Back to the line, on whatever was left on it.
      return { state: { ...openLine(state), bottom: ORCHESTRATOR_TAB }, draw: true }
    case 'run':
      return { does: { kind: 'run', action: action.action }, draw: false }
    case 'agent-number':
      return { state: focusNumber(state, action.n), draw: true }
    case 'project-number':
      return { state: projectNumber(state, action.n), draw: true }
    case 'interrupt':
      return { does: { kind: 'interrupt' }, draw: false }
    case 'quit':
      return { does: { kind: 'quit' }, draw: false }
    case 'lead-through':
    case 'complete':
    case 'leave-line':
    case 'discard':
    case 'none':
      return null
  }
}
