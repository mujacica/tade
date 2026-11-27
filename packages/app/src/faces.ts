import type { AppState } from './model.ts'

// A heart takes any number of faces (`heart.ts`), and this is what is whose.
//
// The window's state is one object, `AppState`, and most of it is a fact
// about the work: the agents and their panes, the conversation, the terminals,
// the approvals answered. That is the heart's, and every face draws the same
// one. The rest is where somebody is looking — the project they stand in, the
// agent in front of them, how far each region is scrolled, the panel open, how
// the dividers were dragged — and that is each face's own: a phone that opens
// Settings has not opened it on the Mac, and scrolling the conversation there
// scrolls nothing here.
//
// So the state a face draws is the heart's with the face's own fields laid
// over it (`seenBy`), and what a face writes is taken apart the same way: its
// own fields stay with it, and the rest is the heart's for every face
// (`sharedFrom`). The machine's own window keeps its own fields in the heart's
// state, as it always has, which is what keeps it exactly as it was.
//
// Every field of the state is in exactly one of the two lists, and a test holds
// that (`test/faces.test.ts`): a field added to `AppState` and to neither is a
// field nobody decided about, and that is how a phone would end up scrolling
// the Mac.
//
// Pure, like `model.ts`: no `node:` import, no clock, nothing async.

/** The fields that are where a face is looking: each face's own. */
export const FACE_OWN = [
  'project',
  'elsewhere',
  'focused',
  'transcriptScroll',
  'paneScroll',
  'actionsScroll',
  'terminalScroll',
  'historySearch',
  'chose',
  'hover',
  'pressed',
  'busy',
  'folded',
  'opened',
  'hidingDone',
  'queueViews',
  'showingPlan',
  'plans',
  'schedule',
  'expanded',
  'scroll',
  'across',
  'planAcross',
  'page',
  'panel',
  'viewing',
  'paneTab',
  'openCheck',
  'bottom',
  'bottomMode',
  'keyboard',
  'leading',
  'sizes',
  'resizing',
  'scrolling',
  'spots',
  'reordering',
  'splitFocus',
  'planShown',
] as const satisfies readonly (keyof AppState)[]

/**
 * The fields that are facts about the work, or about the machine's one
 * keyboard and microphone: the heart's, the same on every face.
 *
 * Some of these are worth a word, because they look like a face's:
 * - `orchestratorDraft` is the orchestrator's line, which belongs to the
 *   orchestrator rather than to a focus; a face that types will need a line of
 *   its own, and that is the face's input, which this does not take.
 * - `splits`, `terminalSplit` and `order` are how lanes are arranged and how
 *   the agents were dragged into order, written down and read by the lanes
 *   the machine reads: one arrangement, which every face draws.
 * - `toasts` and `flash` are said where the machine's own window is looking.
 * - `listening`, `talkingSince`, `hearing`, `levels`, `dictation`, `held`,
 *   `lastInputAt`, `lastKeyAt` and `presses` are the machine's keyboard and
 *   microphone: presence is the person's, wherever they are.
 */
export const FACE_SHARED = [
  'panes',
  'known',
  'titles',
  'projectOrder',
  'transcript',
  'attached',
  'listening',
  'lastInputAt',
  'lastKeyAt',
  'presses',
  'question',
  'dictation',
  'held',
  'notice',
  'flash',
  'answered',
  'hushed',
  'talkingSince',
  'hearing',
  'levels',
  'toasts',
  'terminals',
  'splits',
  'terminalSplit',
  'order',
  'orchestratorDraft',
  'talkBusy',
  'turnThere',
] as const satisfies readonly (keyof AppState)[]

/** Where one face is looking: its own fields of the state. */
export type FaceOwn = Pick<AppState, (typeof FACE_OWN)[number]>

/** A face's own fields, out of a state it was drawn from or wrote. */
export function ownOf(state: AppState): FaceOwn {
  const own: Partial<Record<keyof FaceOwn, unknown>> = {}
  for (const key of FACE_OWN) own[key] = state[key]
  return own as FaceOwn
}

/** The state a face draws: the heart's facts, and where that face is looking. */
export function seenBy(heart: AppState, own: FaceOwn): AppState {
  return { ...heart, ...own }
}

/**
 * What a face wrote, as the heart takes it: its facts, with where the
 * machine's own window is looking kept as it was. `kept` is the heart's state
 * before the write, whose own fields are the machine's window's.
 */
export function sharedFrom(written: AppState, kept: AppState): AppState {
  return { ...written, ...ownOf(kept) }
}

/**
 * Where a face that has just come starts looking: where the machine's own
 * window is, as a second window over the same home opens where the last one
 * was — but holding nothing. A pointer over a control, a divider held, a panel
 * open and a key that was leading are a hand on the other screen, never this
 * one's.
 */
export function ownFrom(state: AppState): FaceOwn {
  return {
    ...ownOf(state),
    hover: null,
    pressed: null,
    busy: null,
    resizing: null,
    scrolling: null,
    reordering: null,
    leading: false,
    panel: null,
  }
}

/**
 * What a face can do on the machine it is on, declared by whoever makes the
 * face and never sniffed from it (R3). The window on the machine's own
 * terminal can do all of it; a face drawn somewhere else — a phone — is on
 * another machine, where a link opened here opens on nobody's screen.
 */
export interface FaceCapabilities {
  /** A link it is handed opens in a browser in front of the person looking at it (`openerForLink`). */
  readonly links: boolean
  /** What it copies reaches the clipboard of the person looking at it (`copyText`, OSC 52). */
  readonly clipboard: boolean
  /** `$EDITOR` and the file viewer may take its screen for a while (`editor.ts`, `viewer.ts`). */
  readonly editor: boolean
  /**
   * Its frames are the ones the machine's own reading and keyboard follow:
   * which lane each area of the window reads (`Lanes.owned`), and where the
   * line's rows are for a click on it (`Keyboard.input`). Exactly one face
   * does — the machine's own window, where there is one — or two faces looking
   * at different agents would each turn the lanes the other was reading. Any
   * other face draws a lane's last screen that was read, or nothing, and never
   * another lane's.
   */
  readonly fronts: boolean
  /** Why, for each it cannot: the sentence said where somebody asked for it. */
  readonly why: Partial<Record<Exclude<keyof FaceCapabilities, 'why'>, string>>
}

/** The window on the machine's own terminal: everything is in front of the person at it. */
export const ON_THIS_MACHINE: FaceCapabilities = {
  links: true,
  clipboard: true,
  editor: true,
  fronts: true,
  why: {},
}

/** A heart with no face at all (`tade serve`): nobody is looking, so nothing is in front of anybody. */
export const NOBODY_LOOKING: FaceCapabilities = {
  links: false,
  clipboard: false,
  editor: false,
  fronts: false,
  why: {
    links: 'nothing draws here, so there is no browser in front of anybody to open it in',
    clipboard: 'nothing draws here, so there is no clipboard of anybody’s to put it on',
    editor: 'nothing draws here, so there is no screen for an editor to take',
    fronts: 'nothing draws here, so no frame decides which lane is read',
  },
}

/**
 * A face drawn on another machine than the heart's: a phone, a browser. What
 * the machine would open, copy or edit would happen on the machine, in front
 * of nobody, so it does none of it until that face has its own way to.
 */
export const ON_ANOTHER_MACHINE: FaceCapabilities = {
  links: false,
  clipboard: false,
  editor: false,
  fronts: false,
  why: {
    links: 'this face is on another machine, and a link opened here would open on nobody’s screen',
    clipboard:
      'this face is on another machine, and the clipboard here is not the one in front of you',
    editor:
      'this face is on another machine, and an editor started here would take nobody’s screen',
    fronts: 'the lanes are read for the machine’s own window; this face draws what was read',
  },
}

/** Null where a face can do it, or the sentence that says why it cannot. */
export function cannot(
  face: FaceCapabilities,
  what: Exclude<keyof FaceCapabilities, 'why'>,
): string | null {
  return face[what] ? null : (face.why[what] ?? `this face cannot do that (${what})`)
}
