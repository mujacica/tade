import { isKeyRelease, parseKey } from '@earendil-works/pi-tui/dist/keys.js'
import { type FaceOwn, ownOf } from './faces.ts'
import {
  type FarExtras,
  type FarHeart,
  type FarMessage,
  type FarWindow,
  frameFrom,
  takeFar,
} from './far.ts'
import type { Frame } from './frame.ts'
import { type Hit, hitBoxAt, scrollAt, type Target } from './hits.ts'
import { type Intent, keyOutcome } from './keymap.ts'
import { appKey, forLane } from './keys.ts'
import { goElsewhere } from './machines.ts'
import {
  type AppState,
  focusTask,
  keyAction,
  laneWithKeyboard,
  leaveLine,
  ORCHESTRATOR_TAB,
  openLine,
  panelMoved,
  scrollBy,
  selectProject,
  setListening,
  showOrchestrator,
  showTerminal,
  toggleCheck,
  toggleFolder,
  toggleSection,
  viewActions,
  viewLane,
} from './model.ts'
import type { PanelOutcome } from './panels/outcome.ts'
import { panelClick, panelDismiss, panelKey } from './panels.ts'
import { reachOf } from './scroll.ts'
import { PLAIN, type Skin } from './skin.ts'
import { isTalkTab, showTalk } from './talk-tab.ts'
import { isThere } from './there.ts'
import type { Drawn } from './ui.ts'
import type { LastFrame } from './view/last-frame.ts'
import { draw } from './view.ts'

// The window as a phone draws it: its own copy, from the state the machine
// sends (`far.ts`), at the phone's own size (§10 T3 of the Duo plan).
//
// Everything about *where this phone is looking* happens here, at once: which
// agent is in front, the project, a panel opened and moved through, the
// leader held, the line typed on. That is the face's own (`faces.ts`), and the
// phone holds it. What the window would *do* — answer an agent, run what a
// button runs, type into a lane, send what is on the line, carry a panel out —
// is an `Intent`, which this hands back for the page to send through the away
// door's one act, where the machine carries it out as this face
// (`wire/far-faces.ts`). Where this face is looking is told to the machine
// too, as a look (`looked`), because the frame — which agent's files, which
// lane's screen — is folded for where a face looks.
//
// The line this phone types on is its own, and so is how it is drawn: the
// machine's is pi's editor at the machine's width, which the phone neither
// has nor wants (`far.ts` does not send it).
//
// When the connection drops the last window stays, marked stale (`lost`), and
// the next message that can be built on takes the mark off.
//
// Pure, like `view.ts`: no `node:` import, no clock (moments are handed in),
// nothing async — and loaded by a browser through `browser.ts`.

/** What one key did on this phone. */
export interface FarPress {
  /** What the machine is asked to do, in order. */
  readonly intents: readonly Intent[]
  /** Where this face looks moved, so the machine should be told (`look`). */
  readonly looked: boolean
  /** Whether to draw again. */
  readonly draw: boolean
}

/**
 * What a tap on this phone did: a key's answer, and what the page does on its
 * own screen — a link opened there, never on the machine (`ON_A_PHONE`).
 */
export interface FarTap extends FarPress {
  /** A link the tap landed on, for the page to open. */
  readonly link?: string
}

/** What a phone's face is made with. */
export interface FarFaceOptions {
  /** The machine's name, for what is said when the connection drops. */
  readonly machine?: string
  /** How this page reports key releases, which is what holding to talk needs. */
  readonly kitty?: boolean
}

const NOTHING: FarPress = { intents: [], looked: false, draw: false }

export class FarFace {
  private readonly options: FarFaceOptions
  private window: FarWindow | null = null
  private own: FaceOwn | null = null
  /** This phone's line: null while closed, its text and where the caret is while open. */
  private line: { text: string; caret: number } | null = null
  /** What was left on this phone's line when it was closed, put back when it opens. */
  private draft = ''
  /** Facts this phone changed for itself, until the machine next says otherwise (`help`'s words). */
  private said: Partial<FarHeart> = {}
  /** The hits the last frame drew, which a scroll's reach is read off (`reachOf`). */
  private hits: readonly Hit[] = []
  /** Since when the connection has been down, or null while it is up. */
  private down: number | null = null
  /** The moment the page last drew for, which it hands in: the machine's clock does not cross. */
  private drawnAt: number | null = null
  /** Where the page put the sidebar's edge for itself (`holdSidebar`), or null for the window's own. */
  private sidebar: number | null = null

  constructor(options: FarFaceOptions = {}) {
    this.options = options
  }

  /** The revision held, or null for nothing yet: what a look says it can build on. */
  get rev(): number | null {
    return this.window?.rev ?? null
  }

  /** Since when what is drawn has been stale, or null while it is current. */
  get stale(): number | null {
    return this.down
  }

  /**
   * A message from the machine. False where it could not be built on — a
   * change against a revision this phone does not hold — and a whole must be
   * asked for (a look with no revision).
   */
  take(message: FarMessage): boolean {
    const taken = takeFar(this.window, message)
    if (taken === null) return false
    this.window = taken.window
    this.said = {}
    this.down = null
    // A whole carries every field of where the machine has this face; a change, those it moved.
    this.own = { ...(this.own ?? {}), ...taken.own } as FaceOwn
    return true
  }

  /** The connection dropped at `at`: the last window stays, and says it is stale. */
  lost(at: number): void {
    this.down ??= at
  }

  /** Where this face is looking, for the machine (`look`); null before anything arrived. */
  looking(): FaceOwn | null {
    return this.own
  }

  /** The state this face draws: the machine's facts, where it looks, and its own line. */
  state(): AppState | null {
    if (this.window === null || this.own === null) return null
    return {
      ...this.window.heart,
      ...this.said,
      ...this.own,
      dictation: this.line?.text ?? null,
      // What was left on this phone's line when it was stepped off: its own,
      // never the machine's half-written message.
      orchestratorDraft: this.draft,
    } as AppState
  }

  /** The frame it draws at its size and in its skin, with its own line in it. */
  frame(base: Pick<Frame, 'width' | 'height' | 'skin'> & Partial<Frame>): Frame | null {
    if (this.window === null) return null
    const input =
      this.line === null
        ? undefined
        : { lines: lineRows(this.line, base.width, base.skin ?? PLAIN) }
    return frameFrom(this.window, { ...base, ...(input && { input }) })
  }

  /**
   * Draw the window at `width` × `height`, as the machine's own `draw` does,
   * or null before the first window has arrived. Stale is said over the foot.
   */
  draw(
    base: Pick<Frame, 'width' | 'height' | 'skin'> & Partial<Frame>,
    last: LastFrame | null = null,
  ): Drawn | null {
    const state = this.state()
    const frame = this.frame(base)
    if (state === null || frame === null) return null
    if (base.now !== undefined) this.drawnAt = base.now
    // Stale is said on the rule over the foot, where the window says what
    // just happened (`flash`), for as long as it is true.
    const shown =
      this.down === null
        ? frame
        : {
            ...frame,
            flash: `${this.options.machine ?? 'the machine'} cannot be reached: this is the window as it last was`,
          }
    // The sidebar's edge where the page put it — on the fold, in book pose —
    // and the hits come from the same drawing, so a tap lands where it looks.
    const laid =
      this.sidebar === null
        ? state
        : { ...state, sizes: { ...state.sizes, sidebarWidth: this.sidebar } }
    const drawn = draw(laid, shown, last)
    this.hits = drawn.hits
    return drawn
  }

  /**
   * Put the sidebar's edge at `width` columns, whatever the window was set
   * to, or give it back with null. The page's alone: on the large screen
   * sideways the fold is the centre line, and the edge goes on it (§10 T4).
   * Never sent: where this phone's fold is is nothing the machine needs.
   */
  holdSidebar(width: number | null): void {
    this.sidebar = width
  }

  /**
   * A tap on the cell at column `x`, row `y` of what was last drawn: a click,
   * looked up in the hit map that drawing returned (`hits.ts`). What only
   * moves this face — an agent looked at, a project, a section opened, a
   * panel's own control — is done here at once; a link is handed back for the
   * page to open; what only the machine can answer — a file to read, a menu,
   * an agent to open — goes as a `click` the window's own mouse carries out.
   */
  tap(x: number, y: number, how: { clicks?: number; button?: 'left' | 'right' } = {}): FarTap {
    const state = this.state()
    const hit = state === null ? null : hitBoxAt(this.hits, x, y)
    if (state === null || hit === null) return NOTHING
    const { target } = hit
    const button = how.button ?? 'left'
    const at = { x, y, cell: x - hit.from, clicks: how.clicks ?? 1 }
    const there = (moved: AppState | null = null): FarTap => {
      const looked = moved === null ? false : this.become(moved, state)
      return { intents: [{ kind: 'click', target, button, at }], looked, draw: looked }
    }
    if (target.kind === 'link') return { ...NOTHING, link: target.url }
    if (target.kind === 'scroll' || target.kind === 'inert' || target.kind === 'divider') {
      return NOTHING
    }
    // This phone's own line is drawn here, and its caret is its own.
    if (target.kind === 'input') return NOTHING
    if (state.panel) {
      const inputs = this.extras().inputs ?? {}
      if (target.kind === 'control')
        return this.panel(state, panelClick(state.panel, target.id, inputs))
      if (target.kind === 'dismiss') return this.panel(state, panelDismiss(state.panel, inputs))
      return there()
    }
    if (button === 'right') return there()
    const moved = movedBy(state, target)
    if (moved === null) return there()
    if (target.kind === 'task') {
      // Looking at an agent is this phone's; opening one that is not running
      // resumes its session, which is the machine's to do.
      const pane = moved.panes.find((one) => one.task === target.task)
      if (pane && !pane.queued && !pane.lane && pane.state !== 'parked') return there(moved)
    }
    return { intents: [], looked: this.become(moved, state), draw: true }
  }

  /**
   * An agent opened from the overview (`/draw/?agent=`, §10 T5 of the Duo
   * plan): exactly what a tap on its row in the sidebar does — looked at here
   * at once, and what only the machine can answer (another machine's agent, or
   * one whose session has to be resumed) sent as that row's click. Nothing
   * where no pane is that agent, which the page says.
   */
  open(task: string): FarPress {
    const state = this.state()
    if (state === null || !state.panes.some((one) => one.task === task)) return NOTHING
    const target: Target = { kind: 'task', task }
    const click = (looked: boolean): FarPress => ({
      intents: [{ kind: 'click', target, button: 'left', at: { x: 0, y: 0, cell: 0, clicks: 1 } }],
      looked,
      draw: looked,
    })
    const moved = movedBy(state, target)
    if (moved === null) return click(false)
    const pane = moved.panes.find((one) => one.task === task)
    if (pane && !pane.queued && !pane.lane && pane.state !== 'parked') {
      return click(this.become(moved, state))
    }
    return { intents: [], looked: this.become(moved, state), draw: true }
  }

  /**
   * A swipe over the cell at `x`, `y`: `rows` lines through the one move
   * every surface makes (`scrollBy`), against what the region under it was
   * last drawn as. Positive is further down, as a notch of the wheel is.
   */
  swipe(x: number, y: number, rows: number): FarPress {
    const state = this.state()
    const area = state === null ? null : scrollAt(this.hits, x, y)
    if (state === null || area === null || rows === 0) return NOTHING
    const next = scrollBy(state, area, rows, reachOf(this.hits, area))
    if (next === state) return NOTHING
    return { intents: [], looked: this.become(next, state), draw: true }
  }

  /**
   * One keystroke, as a terminal would send it: what the window keeps is
   * answered here, and what it asks done is handed back to be sent. The order
   * is the machine's own keyboard's (`Keyboard.onInput`), for what a phone has:
   * no clipboard to read on ctrl+v and no window to close, which the page and
   * the machine say for themselves.
   */
  key(data: string): FarPress {
    const state = this.state()
    if (state === null) return NOTHING
    // A panel has the keyboard while it is open: answered here, with what the
    // machine said the panel needs, and only carried out over there.
    if (state.panel) {
      const key = parseKey(data)
      if (key === 'ctrl+c' || isKeyRelease(data)) return NOTHING
      const extras = this.extras()
      const reach = reachOf(this.hits, 'panel')
      const inputs = { ...(extras.inputs ?? {}), drawnFrom: reach.at }
      const answer = panelMoved(state, panelKey(state.panel, key, data, inputs), reach)
      return this.panel(state, answer)
    }
    const keys = this.extras().keys
    const key = appKey(data, {
      kitty: this.options.kitty ?? false,
      listening: state.listening,
      ...(keys?.talk !== undefined && { talk: keys.talk }),
      ...(keys?.bindings !== undefined && { bindings: keys.bindings }),
    })
    const action = key ? keyAction(key, state) : { kind: 'none' as const }
    const led = state.leading && !isKeyRelease(data)
    const from = led ? { ...state, leading: false } : state
    const outcome = keyOutcome(action, from, this.now(state))
    if (outcome) {
      const moved = outcome.state ?? from
      const looked = this.become(moved, state)
      return { intents: outcome.does ? [outcome.does] : [], looked, draw: outcome.draw || looked }
    }
    switch (action.kind) {
      case 'lead-through': {
        const looked = this.become(from, state)
        return {
          intents: [{ kind: 'type', data: forLane(data), pasted: false }],
          looked,
          draw: true,
        }
      }
      case 'leave-line':
        this.line = null
        return {
          intents: [],
          looked: this.become(setListening(leaveLine(from), false), state),
          draw: true,
        }
      case 'discard':
        if (this.line) this.line = { text: '', caret: 0 }
        return { intents: [], looked: false, draw: true }
      case 'complete':
        return NOTHING
      default:
        break
    }
    if (led) return { intents: [], looked: this.become(from, state), draw: true }
    // A lane with the keyboard gets every key the window did not keep.
    const lanes = forLane(data)
    if (lanes === '') return NOTHING
    if (laneWithKeyboard(from) !== null) {
      return { intents: [{ kind: 'type', data: lanes, pasted: false }], looked: false, draw: false }
    }
    // Typing on this phone's own line.
    if (this.line !== null) return this.typed(data)
    // Nothing focused means the orchestrator is, and it is a thing you type at.
    if (from.focused === null && (printable(data) || parseKey(data) === 'up')) {
      const opened = this.become(openLine(from), state)
      this.line ??= { text: '', caret: 0 }
      const typed = this.typed(data)
      return { ...typed, looked: opened || typed.looked }
    }
    return { intents: [{ kind: 'type', data: lanes, pasted: false }], looked: false, draw: false }
  }

  /**
   * A press on something the window drew: a click on a panel's control, a
   * button. The page looks the hit up in what was drawn (`hits.ts`) and hands
   * over what the window would do with it.
   */
  press(outcome: PanelOutcome): FarPress {
    const state = this.state()
    if (state === null) return NOTHING
    return this.panel(state, outcome)
  }

  /** What is on this phone's line now, or null while it is closed. */
  typing(): string | null {
    return this.line?.text ?? null
  }

  /** Put words on this phone's line, as a page's own text box hands them over. */
  write(text: string): void {
    this.line = { text, caret: text.length }
  }

  /** A panel moved: kept here, and carried out over there only where it was submitted. */
  private panel(state: AppState, answer: PanelOutcome): FarPress {
    const looked = this.become({ ...state, panel: answer.panel }, state)
    if (!answer.submit) return { intents: [], looked, draw: true }
    return { intents: [{ kind: 'panel', outcome: answer }], looked, draw: true }
  }

  /** Take a state this face moved to: where it looks, and its line. Whether where it looks moved. */
  private become(next: AppState, was: AppState): boolean {
    const own = ownOf(next)
    const moved = this.own === null || !sameOwn(this.own, own)
    this.own = own
    if (next.dictation === null) this.line = null
    else if (this.line === null) this.line = { text: next.dictation, caret: next.dictation.length }
    this.draft = next.orchestratorDraft
    if (next.notice !== was.notice) this.said = { ...this.said, notice: next.notice }
    return moved
  }

  /** A key on this phone's line: the few a line needs, and Enter sends it. */
  private typed(data: string): FarPress {
    const line = this.line ?? { text: '', caret: 0 }
    if (isKeyRelease(data)) return NOTHING
    const key = parseKey(data)
    const { text, caret } = line
    if (key === 'enter') {
      this.line = { text: '', caret: 0 }
      const said = text.trim()
      return { intents: said === '' ? [] : [{ kind: 'say', said }], looked: false, draw: true }
    }
    if (key === 'backspace') {
      if (caret > 0)
        this.line = { text: text.slice(0, caret - 1) + text.slice(caret), caret: caret - 1 }
    } else if (key === 'delete') {
      this.line = { text: text.slice(0, caret) + text.slice(caret + 1), caret }
    } else if (key === 'left') {
      this.line = { text, caret: Math.max(0, caret - 1) }
    } else if (key === 'right') {
      this.line = { text, caret: Math.min(text.length, caret + 1) }
    } else if (key === 'home' || key === 'ctrl+a') {
      this.line = { text, caret: 0 }
    } else if (key === 'end' || key === 'ctrl+e') {
      this.line = { text, caret: text.length }
    } else if (printable(data) || (data.length > 1 && !data.startsWith('\x1b'))) {
      this.line = {
        text: text.slice(0, caret) + data + text.slice(caret),
        caret: caret + data.length,
      }
    } else {
      return NOTHING
    }
    return { intents: [], looked: false, draw: true }
  }

  /** What the machine added for a face that answers its own keys. */
  private extras(): FarExtras {
    return this.window?.frame ?? {}
  }

  /** The moment, as the page last said it drawing (`draw`'s `now`), for what a key says. */
  private now(state: AppState): number {
    return this.drawnAt ?? state.lastKeyAt ?? 0
  }
}

/**
 * Where a press moves a face that it can work out for itself, as the window's
 * own mouse moves it (`Mouse.clicked`); null for a press only the machine can
 * answer, or one on another machine's agent, which that machine answers.
 */
function movedBy(state: AppState, target: Target): AppState | null {
  switch (target.kind) {
    case 'task':
      return isThere(target.task) ? null : focusTask(state, target.task)
    case 'lane': {
      if (isThere(target.task)) return null
      const split = state.splits[target.task]
      return split?.lane === target.lane
        ? { ...focusTask(state, target.task), keyboard: 'pane', splitFocus: true }
        : { ...viewLane(state, target.task, target.lane), splitFocus: false }
    }
    case 'pane-tab':
      return isThere(target.task) ? null : viewActions(state, target.task)
    case 'check':
      return toggleCheck(state, target.task, target.check)
    case 'project':
      return selectProject(state, target.project)
    case 'remote-project':
      return goElsewhere(state, { machine: target.machine, project: target.project })
    case 'section':
      return toggleSection(state, target.section, target.quiet === true)
    case 'bottom-tab':
      return target.tab === ORCHESTRATOR_TAB
        ? showOrchestrator(state)
        : isTalkTab(target.tab)
          ? showTalk(state, target.tab)
          : showTerminal(state, target.tab)
    case 'terminal':
      return { ...leaveLine(state), keyboard: 'terminal', splitFocus: target.side === 'split' }
    case 'pane':
      return { ...leaveLine(state), keyboard: 'pane', splitFocus: target.side === 'split' }
    case 'folder':
      return toggleFolder(state, target.path)
    case 'orchestrator':
      return openLine(state)
    default:
      return null
  }
}

/** A printable key, which is somebody starting to type rather than a shortcut. */
function printable(data: string): boolean {
  return data.length === 1 && data >= ' ' && data !== '\x7f'
}

/** Two places a face looks, the same: field by field, as text. */
function sameOwn(a: FaceOwn, b: FaceOwn): boolean {
  for (const key of Object.keys(b) as (keyof FaceOwn)[]) {
    if (a[key] !== b[key] && JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false
  }
  return true
}

/**
 * This phone's line as rows: a rule above and below, as the machine's line is
 * drawn, the text between them wrapped to the width with a column of ground
 * either side, and the caret shown as the character under it, reversed.
 */
export function lineRows(
  line: { text: string; caret: number },
  width: number,
  skin: Skin,
): string[] {
  const room = Math.max(1, width - 2)
  const chars = [...line.text, ' ']
  const rows: string[] = []
  for (let at = 0; at < chars.length; at += room) {
    const cut = chars.slice(at, at + room)
    const drawn = cut
      .map((char, i) => (at + i === line.caret ? `\x1b[7m${char}\x1b[27m` : char))
      .join('')
    rows.push(` ${drawn}${' '.repeat(Math.max(0, room - cut.length))} `)
  }
  const rule = skin.signal('─'.repeat(Math.max(1, width)))
  return [rule, ...rows, rule]
}
