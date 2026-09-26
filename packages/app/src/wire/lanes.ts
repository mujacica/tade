import type { LaneId } from '@tade/core'
import type { Frame, LaneView } from '../frame.ts'
import { halvesOf, resolveLayout } from '../layout.ts'
import {
  activeTerminal,
  laneShown,
  noteTyping,
  notice,
  ORCHESTRATOR_TAB,
  setHeld,
  showTerminal,
} from '../model.ts'
import { laneMenuItems, terminalMenuItems } from '../panels/menu/state.ts'
import { findPanel, promptPanel } from '../panels/small/state.ts'
import type { PointerEvent } from '../pointer.ts'
import { initialRouter, pending, type RouterState, route } from '../router.ts'
import { cutFrom, type HeldLines, keeping, settledAbove } from '../scroll.ts'
import { BAR } from '../scrollbar.ts'
import type { Skin } from '../skin.ts'
import {
  splitPane,
  splitShown,
  swapSplit,
  terminalSplitShown,
  turnSplit,
  typingLane,
  unsplitPane,
} from '../split.ts'
import { carded, rowsRead } from '../view/lane.ts'
import {
  type Actions,
  type Menus,
  type Prompts,
  type Subject,
  type Wiring,
  why,
} from './context.ts'
import { Finding } from './finding.ts'

// The two screens in front of you, and the terminals they are.
//
// A lane's screen is read once and cut, not read again per notch: scrollback
// above the live screen cannot change — an agent appends, it never rewrites —
// so the lines are held with how deep the lane was when they were read, and
// the screen is cut out of them. Only the bottom is asked for again. That is
// also what puts the text and the bar beside it on the same frame.
//
// Whose the wheel is, is the lane's own to say and never the harness's: a
// shell with an editor open in it is the same situation as an agent that
// draws its own conversation, and a window that guessed from what it launched
// would be wrong the moment somebody opened one.

/**
 * How many lines past what is on screen a lane is read back, once it is being
 * scrolled: room for the wheel to move in before the driver has to be asked
 * again.
 *
 * A capture costs what it asks for — a tenth of a millisecond a line, so
 * twelve of them two thousand lines back — and it used to be paid again on
 * every look and again on every notch, for the same lines that had not
 * changed since the agent printed them. Scrollback above the live screen
 * never changes; only the bottom does. So the lines are kept, and the screen
 * the window draws is cut out of them.
 */
const HELD_LINES = 200

/** Which of the two screens an area is, and where each keeps how far back it is. */
const SCROLL_OF = {
  pane: 'paneScroll',
  terminal: 'terminalScroll',
} as const

/** Two readings of a lane's screen that say the same thing, and so redraw nothing. */
function same(a: LaneView | null, b: LaneView | null): boolean {
  if (!a || !b) return a === b
  return (
    a.lines === b.lines &&
    a.cursor.back === b.cursor.back &&
    a.cursor.column === b.cursor.column &&
    a.scrolling === b.scrolling &&
    a.pointing === b.pointing
  )
}

/** What this subject needs from the rest of the window. */
export interface LanesDeps {
  /** How big the terminal is: every lane is sized from it. */
  size(): { columns: number; rows: number }
  /** Where the panes and the strip are. */
  /** Whether a capture comes back coloured. */
  skin: Skin
  /** A lane printed something, or was typed into: look at it sooner than the next beat. */
  soonTick(): void
  /** A line addressed to Tade rather than to the agent it was typed at. */
  say(said: string): void
}

/** The pane's lanes as this look found them: what is in front, and how much of it fits. */
export interface PaneAt {
  lane: string | null
  /** It is showing two lanes, which get neither the bar nor the cursor. */
  split: boolean
  rows: number
}

export class Lanes implements Subject {
  private readonly wire: Wiring
  private readonly deps: LanesDeps
  /**
   * What the driver says about the two screens in front — how far back each
   * goes, and where typing lands in it. Read beside the capture, because a
   * scrollbar drawn from one frame's text and another frame's depth jumps.
   */
  private paneView: LaneView | null = null
  private terminalView: LaneView | null = null
  /**
   * The lines each of those two screens was last read as, and how deep the
   * read went — what the wheel cuts a new screen out of, through `cutFrom`.
   */
  private readonly held = new Map<'pane' | 'terminal', HeldLines>()
  /** The agent's pane and the terminal in front, as last captured. */
  private screen = ''
  private terminalScreen = ''
  /** The second half of a split pane, and of a split bottom panel, as last captured. */
  private splitScreen = ''
  private splitTerminalScreen = ''
  /** The lanes in front — the agent's, and the terminal's — watched so they redraw as they print. */
  private readonly watching = new Map<'pane' | 'terminal', { lane: string; stop: () => void }>()
  /** How each lane was last sized — once per change; its height, what may be rewritten. */
  private readonly fitted = new Map<string, { cols: number; rows: number }>()
  /** A terminal's scrollback, read for finding in it. */
  private readonly find = new Finding()
  private router: RouterState = initialRouter()
  /** Which agent the router's half-typed line belongs to. */
  private routerFor: string | null = null

  constructor(wire: Wiring, deps: LanesDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** The two screens, as the frame draws them. */
  facts(): Pick<
    Frame,
    'screen' | 'terminal' | 'paneScreen' | 'splitScreen' | 'splitTerminal' | 'held'
  > {
    return {
      screen: this.screen,
      // The lines behind those two screens: what a selection dragged over one
      // and scrolled reaches into. Which line of the lane the top of the screen
      // is, is the drawing's to work out, from the `cutAt` it was cut with.
      held: this.held,
      terminal: {
        screen: this.terminalScreen,
        find: this.findView(),
        view: this.terminalView,
      },
      paneScreen: this.paneView,
      splitScreen: this.splitScreen,
      splitTerminal: this.wire.state.terminalSplit
        ? { screen: this.splitTerminalScreen, find: null }
        : undefined,
    }
  }

  /** What the find box over a terminal has to say: how many lines match, and whose they are. */
  panel(): Frame['panel'] {
    const panel = this.wire.state.panel
    if (panel?.kind !== 'find') return {}
    return {
      found: this.findMatches().length,
      terminalName:
        this.wire.state.terminals.find((one) => one.id === panel.terminal)?.name ?? 'terminal',
    }
  }

  inputs() {
    return { found: this.findMatches().length }
  }

  actions(): Actions {
    return {
      'new-terminal': async () => {
        await this.openTerminal()
      },
      'find-terminal': async () => {
        const terminal = activeTerminal(this.wire.state)
        if (terminal) await this.openFind(terminal.id)
      },
      'close-terminal:': (id) => this.closeTerminal(id),
      'close-lane:': (lane) => this.closeLane(lane),
      'pane-end': () => {
        this.wire.put({ ...this.wire.state, paneScroll: 0 })
        // Back to the newest line, and the text goes there with the bar: the
        // lines held may already reach it, and the look catches up if not.
        if (!this.reslice('pane')) this.deps.soonTick()
      },
      'terminal-end': () => {
        this.wire.put({ ...this.wire.state, terminalScroll: 0 })
        if (!this.reslice('terminal')) this.deps.soonTick()
      },
      // `split:<task>:swap|turn|close`, and the task is what is between.
      'split:': (rest) => {
        const verb = rest.slice(rest.lastIndexOf(':') + 1)
        const task = rest.slice(0, rest.lastIndexOf(':'))
        this.wire.put(
          verb === 'swap'
            ? swapSplit(this.wire.state, task)
            : verb === 'turn'
              ? turnSplit(this.wire.state, task)
              : unsplitPane(this.wire.state, task),
        )
        this.deps.soonTick()
        this.wire.draw()
      },
      'terminal-split:': (verb) => {
        const split = this.wire.state.terminalSplit
        if (split && verb === 'swap' && this.wire.state.bottom !== ORCHESTRATOR_TAB) {
          this.wire.put({
            ...this.wire.state,
            bottom: split.lane,
            terminalSplit: { ...split, lane: this.wire.state.bottom },
            splitFocus: !this.wire.state.splitFocus,
          })
        } else if (split && verb === 'turn') {
          this.wire.put({
            ...this.wire.state,
            terminalSplit: {
              ...split,
              direction: split.direction === 'beside' ? 'below' : 'beside',
            },
          })
        } else {
          this.wire.put({ ...this.wire.state, terminalSplit: null, splitFocus: false })
        }
        this.deps.soonTick()
        this.wire.draw()
      },
    }
  }

  menus(): Menus {
    return {
      terminal: {
        title: (subject) =>
          this.wire.state.terminals.find((one) => one.id === subject.id)?.name ?? 'terminal',
        items: () => terminalMenuItems(terminalSplitShown(this.wire.state) !== null),
        choose: (subject, item) => this.fromTerminalMenu(subject.id, item),
      },
      lane: {
        title: (subject) => subject.name,
        items: (subject) =>
          laneMenuItems(
            this.wire.state.splits[subject.task]?.lane === subject.lane,
            this.wire.state.panes.find((one) => one.task === subject.task)?.lane != null,
          ),
        choose: (subject, item) =>
          this.fromLaneMenu(subject.task, subject.lane, subject.name, item),
      },
    }
  }

  prompts(): Prompts {
    return {
      'rename-lane': async (panel, text) => {
        if (!panel.target) return
        await this.wire.opts.client.setTitle(panel.target as LaneId, text)
        await this.wire.live?.refresh()
        this.wire.put(notice({ ...this.wire.state, panel: null }, `renamed to ${text}`))
      },
      'rename-terminal': async (panel, text) => {
        if (!panel.target) return
        await this.wire.opts.client.renameTerminal(panel.target, text)
        await this.wire.live?.refresh()
        this.wire.put(notice({ ...this.wire.state, panel: null }, `renamed to ${text}`))
      },
      'run-command': async (panel, text) => {
        if (!panel.target) return
        await this.wire.opts.client.runInTerminal(panel.target, text)
        this.wire.put({ ...showTerminal(this.wire.state, panel.target), panel: null })
      },
    }
  }

  /** Close a terminal, and say why not where it would not close. */
  private async closeTerminal(id: string): Promise<void> {
    await this.wire.opts.client.closeTerminal(id).catch((err) => this.wire.note(err))
    await this.wire.live?.refresh()
    this.wire.draw()
  }

  /** Close one shell beside an agent. */
  private async closeLane(lane: string): Promise<void> {
    await this.wire.opts.client.closeLane(lane as LaneId).catch((err) => this.wire.note(err))
    await this.wire.live?.refresh()
    this.wire.draw()
  }

  /** What a shell's menu does: rename it, show it beside or below the agent, or close it. */
  private async fromLaneMenu(
    task: string,
    lane: string,
    name: string,
    item: string,
  ): Promise<void> {
    switch (item) {
      case 'rename':
        this.wire.put({
          ...this.wire.state,
          panel: { ...promptPanel('rename-lane', 'Rename shell', 'NAME', name), target: lane },
        })
        break
      case 'split-beside':
      case 'split-below':
        this.wire.put(
          splitPane(this.wire.state, task, lane, item === 'split-beside' ? 'beside' : 'below'),
        )
        this.deps.soonTick()
        break
      case 'unsplit':
        this.wire.put(unsplitPane(this.wire.state, task))
        break
      case 'close':
        await this.closeLane(lane)
        return
      default:
        break
    }
    this.wire.draw()
  }

  /** What a terminal's tab offers: run something in it, find in it, rename it, split it, close it. */
  private async fromTerminalMenu(id: string, item: string): Promise<void> {
    const name = this.wire.state.terminals.find((one) => one.id === id)?.name ?? 'terminal'
    switch (item) {
      case 'run':
        this.wire.put({
          ...showTerminal(this.wire.state, id),
          panel: { ...promptPanel('run-command', `Run in ${name}`, 'COMMAND'), target: id },
        })
        break
      case 'find':
        await this.openFind(id)
        return
      case 'rename':
        this.wire.put({
          ...this.wire.state,
          panel: {
            ...promptPanel('rename-terminal', 'Rename terminal', 'NAME', name),
            target: id,
          },
        })
        break
      case 'clear':
        await this.wire.opts.client.write(id as LaneId, 'clear\r').catch(() => {})
        break
      case 'split-beside':
      case 'split-below': {
        // A new terminal, beside or below this one, in the same project.
        const front = id
        const opened = await this.openTerminal()
        const created = this.wire.state.bottom
        if (opened && created !== front) {
          this.wire.put({
            ...showTerminal(this.wire.state, front),
            terminalSplit: {
              lane: created,
              direction: item === 'split-beside' ? 'beside' : 'below',
              ratio: 0.5,
            },
            splitFocus: true,
          })
        }
        break
      }
      case 'unsplit':
        this.wire.put({ ...this.wire.state, terminalSplit: null, splitFocus: false })
        break
      case 'close':
        await this.closeTerminal(id)
        return
      default:
        break
    }
    this.wire.draw()
  }

  /** Stop watching both lanes: the window is closing. */
  /** The scrollback the find box is looking through, and the line it is on. */
  findView(): NonNullable<Frame['terminal']>['find'] {
    return this.find.view(this.wire.state.panel)
  }

  /** Look for text in a terminal's scrollback, with the find box over it. */
  async openFind(id: string, query = '', index = 0): Promise<void> {
    this.wire.put({ ...showTerminal(this.wire.state, id), panel: findPanel(id, query, index) })
    await this.find.read(id, (at) => this.wire.opts.client.readTerminal(at, 5_000))
    this.wire.draw()
  }

  /** The lines the find box matches, newest first, as line numbers into the scrollback read. */
  findMatches(): number[] {
    return this.find.matches(this.wire.state.panel)
  }

  stopWatching(): void {
    for (const watched of this.watching.values()) watched.stop()
  }

  /**
   * Make the pane's lanes the size of the pane, and watch what is in front of
   * you. Says what this look found there, which is what reads it.
   */
  async fitPane(): Promise<PaneAt> {
    const pane = this.wire.state.panes.find((p) => p.task === this.wire.state.focused)
    const lane = pane ? laneShown(this.wire.state, pane) : null
    const split = pane ? splitShown(this.wire.state, pane) : null
    const halves = halvesOf(this.paneSize(split !== null), split)
    const size = halves.first
    // The lane is made the size of the pane, because that is the terminal the
    // program thinks it is drawing for. What is *read back* is the rows the
    // pane shows, which an approval card takes five off — the clamp here and
    // the bar in the drawing have to be counting the same rows, or the look
    // pulls the view back five rows after the wheel has moved it.
    if (lane) await this.fitLane(lane, size)
    this.watch(lane)
    if (split) {
      await this.fitLane(split.lane, halves.second)
      const second =
        (await this.wire.live?.capture(split.lane, halves.second.rows, this.deps.skin.colour)) ?? ''
      if (second !== this.splitScreen) {
        this.splitScreen = second
        this.wire.draw()
      }
    }
    return {
      lane,
      split: split !== null,
      rows: this.laneRows('pane'),
    }
  }

  /**
   * Read what the pane is showing, and say whether it changed.
   *
   * How deep the lane is is read before its text: which lines are held is
   * counted from the depth, so a screen cut against a depth from the frame
   * before it is a screen cut in the wrong place.
   */
  async readPane(at: PaneAt): Promise<boolean> {
    // Only for the one screen the bar and the cursor are drawn on: a split is
    // two lanes and gets neither.
    const view = at.split ? null : ((await this.wire.live?.screen(at.lane)) ?? null)
    if (!same(view, this.paneView)) {
      this.paneView = view
      this.wire.draw()
    }
    const screen = await this.laneScreen('pane', at.lane, at.rows)
    const changed = screen !== this.screen
    this.screen = screen
    return changed
  }

  /** Type into the agent you are watching, and hold focus while you do. */
  toLane(data: string): void {
    const pane = this.wire.state.panes.find((p) => p.task === this.wire.state.focused)
    // Typing at an agent is looking at its newest line.
    this.wire.put({ ...noteTyping(this.wire.state, this.wire.now()), paneScroll: 0 })

    // A half-typed line belongs to the prompt it was started at, so switching
    // agents abandons it rather than carrying it across.
    if (this.routerFor !== this.wire.state.focused) {
      this.router = initialRouter()
      this.routerFor = this.wire.state.focused
    }

    // A line beginning "tade " is addressed to Tade, not to the agent.
    const routed = route(this.router, data)
    this.router = routed.state
    this.wire.put(setHeld(this.wire.state, pending(this.router)))

    const lane = pane ? typingLane(this.wire.state, pane) : null
    if (routed.toLane !== '' && lane) {
      void this.wire.opts.client.write(lane as LaneId, routed.toLane).catch(() => {})
    }
    if (routed.toTade !== null) this.deps.say(routed.toTade)
    this.wire.draw()
  }
  /**
   * A lane's screen, cut to where it is scrolled to — read back from the
   * driver only when what is already held does not reach that far.
   *
   * Scrollback is the one thing about a lane that cannot change: the agent
   * appends, it never rewrites what it printed an hour ago. So a screen read
   * two thousand lines back is read once, and the wheel moving through it is
   * an array slice. What still has to be asked every look is the bottom,
   * where the agent is typing, and that is the cheap end — which is what
   * `settledAbove` holds this to. Answering the bottom from held lines too, a
   * lane repainting in place never gets deeper, so the pane froze on the first
   * screen ever read of it and drew that for as long as you watched.
   */
  private async laneScreen(
    area: 'pane' | 'terminal',
    lane: string | null,
    rows: number,
  ): Promise<string> {
    if (!lane) {
      this.held.delete(area)
      return ''
    }
    const which = SCROLL_OF[area]
    const view = area === 'pane' ? this.paneView : this.terminalView
    const at = view?.lines ?? 0
    // Never further back than there is to read: the wheel is clamped against
    // what the last frame drew, and this is the same clamp against what the
    // driver says now, for a lane that shrank or was relaunched under us.
    const most = Math.max(0, at - rows)
    if (at > 0 && this.wire.state[which] > most)
      this.wire.put({ ...this.wire.state, [which]: most })
    const back = this.wire.state[which]
    const held = keeping(view) && this.settled(lane, back) ? this.held.get(area) : undefined
    if (held?.lane === lane && at >= held.at) {
      const cut = cutFrom(held, rows, back, at)
      if (cut !== null) return cut
    }
    // Room to move in before the driver has to be asked again — only once
    // there is scrollback in play, so a lane at its newest line costs what it
    // always did.
    const asked = rows + back + (back > 0 ? HELD_LINES : 0)
    const captured = (await this.wire.live?.capture(lane, asked, this.deps.skin.colour)) ?? ''
    const lines = captured.split('\n')
    // A capture ends at the newest line, so how many lines came back is what
    // says which lines they are. A lane with no depth of its own — half of a
    // split — has only its capture to count from.
    const read = { lane, lines, at: Math.max(at, lines.length), asked }
    if (keeping(view)) this.held.set(area, read)
    else this.held.delete(area)
    return cutFrom(read, rows, back, read.at) ?? lines.slice(-rows).join('\n')
  }

  /**
   * A wheel that is the lane's to answer rather than the window's: turned in
   * it, and true when it was.
   *
   * Which it is comes from the lane, never from which harness is in it: a
   * shell with an editor open in it is the same situation as an agent that
   * draws its own conversation, and only the lane's own screen knows. The
   * driver was asked on the last look (`scrolling`), so this costs nothing.
   *
   * `nobody` — a program that took the screen and does not want the mouse —
   * is still the lane's, and still true: there is nothing to scroll and
   * moving something else instead would be worse than doing nothing.
   */
  turnedInLane(event: Extract<PointerEvent, { kind: 'wheel' }>): boolean {
    if (event.area !== 'pane' && event.area !== 'terminal') return false
    const view = event.area === 'pane' ? this.paneView : this.terminalView
    if (!view || view.scrolling === undefined || view.scrolling === 'window') return false
    const lane =
      event.area === 'pane' ? this.paneLane() : (activeTerminal(this.wire.state)?.id ?? null)
    if (view.scrolling === 'lane' && lane) {
      void this.wire.live?.wheel(lane, { rows: event.rows, ...event.at })
      // What it drew in answer is a change to its screen, which the next look
      // reads as it reads every other: sooner, because somebody is watching.
      this.deps.soonTick()
    }
    return true
  }

  /** The lane the agent's pane is showing, if it is showing one. */
  private paneLane(): string | null {
    const pane = this.wire.state.panes.find((one) => one.task === this.wire.state.focused)
    return pane ? laneShown(this.wire.state, pane) : null
  }

  /**
   * Cut the lines already held to where the wheel has just put them, so the
   * text moves on the same frame as the bar beside it. True when they reached
   * that far, and then there is nothing to ask the driver: what a notch
   * changed is where the window is looking, not what the lane holds. False is
   * the only reason to go and look, and asking anyway cost a screen read a
   * notch in every lane in front of you — 81 ms of a 735 ms flick spent being
   * told that nothing had changed.
   */
  reslice(area: 'pane' | 'terminal'): boolean {
    const held = this.held.get(area)
    if (!held) return false
    // A notch onto the live screen is answered by reading it, not from held.
    if (!this.settled(held.lane, this.wire.state[SCROLL_OF[area]])) return false
    const view = area === 'pane' ? this.paneView : this.terminalView
    const cut = cutFrom(
      held,
      this.laneRows(area),
      this.wire.state[SCROLL_OF[area]],
      view?.lines ?? held.at,
    )
    if (cut === null) return false
    if (area === 'pane') this.screen = cut
    else this.terminalScreen = cut
    return true
  }

  /** `settledAbove`, against the screen this lane was actually made. */
  private settled(lane: string, back: number): boolean {
    const live = this.fitted.get(lane)?.rows
    return live === undefined ? false : settledAbove(back, live)
  }

  /**
   * How many rows of a lane are on screen: what a capture is cut to. Exactly
   * the lines the region shows, counted as the drawing counts them — the clamp
   * here and the bar it draws have to agree about where the end is, or the top
   * of a scrollback springs back a row under every notch.
   */
  private laneRows(area: 'pane' | 'terminal'): number {
    if (area === 'terminal') return this.terminalHalves().first.rows
    const pane = this.wire.state.panes.find((p) => p.task === this.wire.state.focused)
    const split = pane ? splitShown(this.wire.state, pane) : null
    const rows = halvesOf(this.paneSize(split !== null), split).first.rows
    const lane = pane ? laneShown(this.wire.state, pane) : null
    return rowsRead(rows, !split && carded(pane, lane), !split && this.wire.state.paneScroll > 0)
  }

  /**
   * The bottom panel's two halves, sized as the window draws them: its width
   * less the scrollbar's column, which the window draws and the lane must not
   * — a split has none and takes it back — and the strip less its own frame.
   * One answer, because a screen cut to the wrong number of rows jumps when
   * the look catches up with the wheel.
   */
  private terminalHalves(): ReturnType<typeof halvesOf> {
    const layout = this.resolved()
    const split = terminalSplitShown(this.wire.state)
    return halvesOf(
      {
        cols: Math.max(20, layout.sidebarWidth + layout.mainWidth + 1 - (split ? 0 : BAR)),
        rows: Math.max(1, layout.stripHeight - 2),
      },
      split,
    )
  }

  /**
   * Read the terminal in front of the bottom panel, sized to the panel. Says
   * whether what it shows has changed. Nothing is read while the panel is
   * folded or showing the orchestrator.
   */
  async captureTerminal(): Promise<boolean> {
    const terminal = activeTerminal(this.wire.state)
    if (!terminal || this.wire.state.bottomMode === 'min') {
      this.watch(null, 'terminal')
      this.terminalView = null
      return false
    }
    const split = terminalSplitShown(this.wire.state)
    const halves = this.terminalHalves()
    const size = halves.first
    await this.fitLane(terminal.id, size)
    this.watch(terminal.id, 'terminal')
    let changed = false
    if (split) {
      await this.fitLane(split.lane, halves.second)
      const second =
        (await this.wire.live?.capture(split.lane, halves.second.rows, this.deps.skin.colour)) ?? ''
      if (second !== this.splitTerminalScreen) {
        this.splitTerminalScreen = second
        changed = true
      }
    }
    // The depth before the text, as an agent's pane reads them: what is held
    // is kept by which lines they are, and that is counted from the depth.
    const view = split ? null : ((await this.wire.live?.screen(terminal.id)) ?? null)
    if (!same(view, this.terminalView)) {
      this.terminalView = view
      changed = true
    }
    const screen = await this.laneScreen('terminal', terminal.id, size.rows)
    if (screen === this.terminalScreen) return changed
    this.terminalScreen = screen
    return true
  }

  /** Put a terminal in front, once the window knows about it. For whoever opened it elsewhere. */
  async showTerminal(id: string): Promise<void> {
    // Just opened, it may take a refresh or two to be listed: it still comes to the front.
    for (let tries = 0; tries < 10; tries++) {
      if (this.wire.state.terminals.some((terminal) => terminal.id === id)) break
      await this.wire.live?.refresh()
      if (this.wire.state.terminals.some((terminal) => terminal.id === id)) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    this.wire.put(showTerminal(this.wire.state, id))
    this.wire.draw()
  }

  /**
   * How big a terminal opened here is made: the whole width under the window,
   * and the strip's height less its own two rows of frame. One answer, because
   * a terminal made one size and read at another is a screen that jumps.
   */
  terminalSize(): { cols: number; rows: number } {
    const layout = this.resolved()
    return {
      cols: layout.sidebarWidth + layout.mainWidth + 1,
      rows: Math.max(4, layout.stripHeight - 2),
    }
  }

  /** Open a terminal in a project — the one you are in unless told — and put it in front. */
  async openTerminal(name: string | null = null, cwd?: string): Promise<string | null> {
    const project = this.wire.state.project
    if (!project) {
      this.wire.put(
        notice(this.wire.state, 'open a project first: a terminal starts in its folder'),
      )
      this.wire.draw()
      return null
    }
    try {
      const opened = await this.wire.opts.client.openTerminal({
        project,
        ...(name ? { name } : {}),
        ...(cwd ? { cwd } : {}),
        ...this.terminalSize(),
      })
      await this.showTerminal(opened.id)
      return opened.name
    } catch (err) {
      this.wire.put(notice(this.wire.state, why(err)))
      this.wire.draw()
      return null
    }
  }

  /**
   * Watch the lane in front of you, so what it prints is on screen at once
   * rather than at the next quarter-second look. Typing waited for that look,
   * which is what made an agent feel slow to type into.
   */
  private watch(lane: string | null, slot: 'pane' | 'terminal' = 'pane'): void {
    if (this.watching.get(slot)?.lane === lane) return
    this.watching.get(slot)?.stop()
    this.watching.delete(slot)
    if (!lane) return
    const watching = { lane, stop: () => {} }
    this.watching.set(slot, watching)
    void this.wire.opts.client
      .watch(lane as LaneId, () => this.deps.soonTick(), { lines: 1 })
      .then((watched) => {
        if (this.watching.get(slot) === watching) watching.stop = watched.stop
        else watched.stop()
      })
      .catch(() => {})
  }

  /** The window as it is laid out now: what every lane in it is sized against. */
  private resolved(): ReturnType<typeof resolveLayout> {
    const { columns, rows } = this.deps.size()
    return resolveLayout(this.wire.layout(), { width: columns, height: Math.max(6, rows) })
  }

  /** The agent's part of the window: the pane, less its title and rule. */
  paneSize(split = false): { cols: number; rows: number } {
    const layout = this.resolved()
    // The scrollbar's column is the window's, not the lane's: a lane sized to
    // the whole pane would draw its last column under the bar.
    return {
      cols: Math.max(20, layout.mainWidth - (split ? 0 : BAR)),
      rows: Math.max(4, layout.bodyHeight - 2),
    }
  }

  /**
   * Make the lane the size of the pane it is drawn in.
   *
   * An agent draws for the terminal it thinks it has. Drawn into a pane of a
   * different size, its own layout wraps and clips in all the wrong places —
   * so the pane decides, once per size, not every frame.
   */
  private async fitLane(lane: string, size: { cols: number; rows: number }): Promise<void> {
    const was = this.fitted.get(lane)
    if (was?.cols === size.cols && was.rows === size.rows) return
    this.fitted.set(lane, { cols: size.cols, rows: size.rows })
    await this.wire.opts.client.resize(lane as LaneId, size.cols, size.rows).catch(() => {
      // A lane that just ended cannot be resized; the next tick will not ask.
    })
  }
}
