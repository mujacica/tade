import { chatTaskOf, HARNESS_CHOICES, isChatLane, type LaneId } from '@tade/core'
import { openChat } from '@tade/workbench'
import type { Frame, LaneView } from '../frame.ts'
import { halvesOf } from '../layout.ts'
import {
  type AppState,
  activeTerminal,
  laneShown,
  noteTyping,
  notice,
  setHeld,
  showTerminal,
} from '../model.ts'
import {
  bottomNewItems,
  chatMenuItems,
  laneMenuItems,
  terminalMenuItems,
} from '../panels/menu/state.ts'
import { findPanel, promptPanel } from '../panels/small/state.ts'
import type { PointerEvent } from '../pointer.ts'
import { initialRouter, pending, type RouterState, route } from '../router.ts'
import { cutFrom, type HeldLines, holding, keeping, settledAbove } from '../scroll.ts'
import type { Skin } from '../skin.ts'
import {
  splitActed,
  splitPane,
  splitShown,
  splitTerminal,
  terminalSplitActed,
  terminalSplitShown,
  typingLane,
  unsplitPane,
} from '../split.ts'
import {
  type Actions,
  type Menus,
  type Prompts,
  type Subject,
  type Wiring,
  why,
} from './context.ts'
import { Finding } from './finding.ts'
import { Fitting, type Size } from './fitting.ts'
import { Screens } from './shown.ts'

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
const SCROLL_OF = { pane: 'paneScroll', terminal: 'terminalScroll' } as const

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
   * The four screens in front — the pane, the terminal, and each one's second
   * half — as last read, each with the lane it was read from and what the
   * driver said beside it: how far back it goes, where typing lands. Read
   * beside the capture, because a scrollbar drawn from one frame's text and
   * another frame's depth jumps.
   */
  private readonly screens = new Screens()
  /**
   * The lines the pane and the terminal were last read as, and how deep the read
   * went, which the wheel cuts a new screen out of: replaced, never written into.
   */
  private held: ReadonlyMap<'pane' | 'terminal', HeldLines> = new Map()
  /** The lanes in front — the agent's, and the terminal's — watched so they redraw as they print. */
  private readonly watching = new Map<'pane' | 'terminal', { lane: string; stop: () => void }>()
  /** How each lane was last sized — once per size, and once it holds still; its height, what may be rewritten. */
  private readonly fitting: Fitting
  /** A terminal's scrollback, read for finding in it. */
  private readonly find = new Finding()
  private router: RouterState = initialRouter()
  /** Which agent the router's half-typed line belongs to. */
  private routerFor: string | null = null

  constructor(wire: Wiring, deps: LanesDeps) {
    this.wire = wire
    this.deps = deps
    this.fitting = new Fitting(wire, { size: () => deps.size(), told: () => deps.soonTick() })
  }

  /** The two screens, as the frame draws them. */
  facts(): Pick<
    Frame,
    'screen' | 'terminal' | 'paneScreen' | 'splitScreen' | 'splitTerminal' | 'held'
  > {
    this.owned()
    const pane = this.screens.of('pane')
    const terminal = this.screens.of('terminal')
    return {
      screen: pane.screen,
      // The lines behind those two screens: what a selection dragged over one
      // and scrolled reaches into. Which line of the lane the top of the screen
      // is, is the drawing's to work out, from the `cutAt` it was cut with.
      held: this.held,
      terminal: {
        screen: terminal.screen,
        find: this.findView(),
        view: terminal.view,
      },
      paneScreen: pane.view,
      splitScreen: this.screens.of('split').screen,
      splitTerminal: this.wire.state.terminalSplit
        ? { screen: this.screens.of('splitTerminal').screen, find: null }
        : undefined,
    }
  }

  /**
   * Every screen handed to the frame is the lane's in front of it, or nothing.
   *
   * A focus moves between two looks — a click, a tab, an agent raised — and
   * what the last look read is then somebody else's: drawn anyway, the pane
   * showed the agent you had left under the name of the one you had gone to,
   * for up to a beat. So an area whose lane moved shows that lane's own last
   * screen, or a blank one, and a look is asked for to read it now rather than
   * at the next beat. Here, where the frame is made, so every way the focus
   * can move is covered without each of them having to remember to say so.
   */
  private owned(): void {
    const state = this.wire.state
    const pane = state.panes.find((one) => one.task === state.focused)
    const moved = {
      pane: this.screens.front('pane', pane ? laneShown(state, pane) : null),
      split: this.screens.front('split', pane ? (splitShown(state, pane)?.lane ?? null) : null),
      terminal: this.screens.front('terminal', activeTerminal(state)?.id ?? null),
      below: this.screens.front('splitTerminal', terminalSplitShown(state)?.lane ?? null),
    }
    // Another lane's lines are not these: a selection anchored in them, or a
    // notch cut out of them, would be the lane just left.
    if (moved.pane) this.held = holding(this.held, 'pane', null)
    if (moved.terminal) this.held = holding(this.held, 'terminal', null)
    if (moved.pane || moved.split || moved.terminal || moved.below) this.deps.soonTick()
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
      'new-terminal': () => void this.openTerminal(),
      // Typed as well as clicked, in the default harness: the `+` is a menu now.
      'new-chat': () => void this.openChat(),
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
        const at = rest.lastIndexOf(':')
        this.acted(splitActed(this.wire.state, rest.slice(0, at), rest.slice(at + 1)))
      },
      'terminal-split:': (verb) => {
        this.acted(terminalSplitActed(this.wire.state, verb))
      },
    }
  }

  menus(): Menus {
    return {
      terminal: {
        title: (subject) =>
          this.wire.state.terminals.find((one) => one.id === subject.id)?.name ?? 'terminal',
        items: (subject) => {
          const split = terminalSplitShown(this.wire.state) !== null
          return isChatLane(subject.id) ? chatMenuItems(split) : terminalMenuItems(split)
        },
        choose: (subject, item) => this.fromTerminalMenu(subject.id, item),
      },
      'bottom-new': {
        title: () => 'Open below',
        items: () => bottomNewItems(HARNESS_CHOICES),
        choose: async (_subject, item) => {
          if (item === 'terminal') await this.openTerminal()
          else if (item.startsWith('chat:')) await this.openChat(item.slice('chat:'.length))
        },
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

  /**
   * Close a terminal, and say why not where it would not close.
   *
   * A chat's tab closes by stopping its agent, which is what closing one is:
   * the lane ends and the conversation stays where it was, in its harness's
   * own store, because Tade never kept it in the first place.
   */
  private async closeTerminal(id: string): Promise<void> {
    const client = this.wire.opts.client
    const closing = isChatLane(id) ? client.stopAgent(chatTaskOf(id)) : client.closeTerminal(id)
    await closing.catch((err) => this.wire.note(err))
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
        this.wire.outbox.write(id as LaneId, 'clear\r')
        break
      case 'split-beside':
      case 'split-below': {
        // A new terminal, beside or below this one, in the same project. The
        // one that was in front goes back in front, and `splitTerminal` is
        // what refuses the case where nothing new opened.
        const opened = await this.openTerminal()
        const made = this.wire.state.bottom
        const how = item === 'split-beside' ? 'beside' : 'below'
        if (opened) this.wire.put(splitTerminal(showTerminal(this.wire.state, id), made, how))
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

  /** Stop watching both lanes, and telling any a size: the window is closing. */
  stopWatching(): void {
    for (const watched of this.watching.values()) watched.stop()
    this.fitting.stop()
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
    if (lane) await this.fitting.fit(lane, size, true)
    this.watch(lane)
    if (split) {
      await this.fitting.fit(split.lane, halves.second, true)
      const second =
        (await this.wire.live?.capture(split.lane, halves.second.rows, this.deps.skin.colour)) ?? ''
      if (this.screens.read('split', { lane: split.lane, screen: second, view: null }, true))
        this.wire.draw()
    }
    this.fitting.behind()
    return {
      lane,
      split: split !== null,
      rows: this.fitting.laneRows('pane'),
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
    const was = this.screens.of('pane')
    // Only for the one screen the bar and the cursor are drawn on: a split is
    // two lanes and gets neither.
    const read = at.split ? null : ((await this.wire.live?.screen(at.lane)) ?? null)
    const view = was.lane === at.lane && same(read, was.view) ? was.view : read
    const screen = await this.laneScreen('pane', at.lane, at.rows, view)
    // Kept as the lane's own only where it was read at its newest line: coming
    // back to an agent is coming back to its end.
    const fresh = { lane: at.lane, screen, view }
    const changed = this.screens.read('pane', fresh, this.wire.state.paneScroll === 0)
    return changed || view !== was.view
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
      this.wire.outbox.write(lane as LaneId, routed.toLane)
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
    view: LaneView | null,
  ): Promise<string> {
    if (!lane) {
      this.held = holding(this.held, area, null)
      return ''
    }
    const which = SCROLL_OF[area]
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
    this.held = holding(this.held, area, keeping(view) ? read : null)
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
    this.owned()
    const view = this.screens.of(event.area).view
    if (!view || view.scrolling === undefined || view.scrolling === 'window') return false
    const lane =
      event.area === 'pane' ? this.paneLane() : (activeTerminal(this.wire.state)?.id ?? null)
    if (view.scrolling === 'lane' && lane) {
      this.wire.outbox.wheel(lane as LaneId, { rows: event.rows, ...event.at })
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
    // Only ever the lane in front's own lines: what a focus left behind is not.
    this.owned()
    const held = this.held.get(area)
    const shown = this.screens.of(area)
    if (!held || held.lane !== shown.lane) return false
    // A notch onto the live screen is answered by reading it, not from held.
    if (!this.settled(held.lane, this.wire.state[SCROLL_OF[area]])) return false
    const cut = cutFrom(
      held,
      this.fitting.laneRows(area),
      this.wire.state[SCROLL_OF[area]],
      shown.view?.lines ?? held.at,
    )
    if (cut === null) return false
    this.screens.read(area, { ...shown, screen: cut }, false)
    return true
  }

  /** `settledAbove`, against the screen this lane was actually made. */
  private settled(lane: string, back: number): boolean {
    const live = this.fitting.rows(lane)
    return live === undefined ? false : settledAbove(back, live)
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
      const shown = this.screens.of('terminal')
      if (shown.view) this.screens.read('terminal', { ...shown, view: null }, false)
      return false
    }
    const split = terminalSplitShown(this.wire.state)
    const halves = this.fitting.terminalHalves()
    const size = halves.first
    await this.fitting.fit(terminal.id, size, true)
    this.watch(terminal.id, 'terminal')
    let changed = false
    if (split) {
      await this.fitting.fit(split.lane, halves.second, true)
      const second =
        (await this.wire.live?.capture(split.lane, halves.second.rows, this.deps.skin.colour)) ?? ''
      const half = { lane: split.lane, screen: second, view: null }
      changed = this.screens.read('splitTerminal', half, true)
    }
    // The depth before the text, as an agent's pane reads them: what is held
    // is kept by which lines they are, and that is counted from the depth.
    const was = this.screens.of('terminal')
    const read = split ? null : ((await this.wire.live?.screen(terminal.id)) ?? null)
    const view = was.lane === terminal.id && same(read, was.view) ? was.view : read
    const screen = await this.laneScreen('terminal', terminal.id, size.rows, view)
    const fresh = { lane: terminal.id, screen, view }
    const moved = this.screens.read('terminal', fresh, this.wire.state.terminalScroll === 0)
    return moved || changed || view !== was.view
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

  /** How big a terminal opened here is made (`Fitting.terminalSize`). */
  terminalSize(): Size {
    return this.fitting.terminalSize()
  }

  /** A pure answer applied: the state, a look sooner than the next beat, and a frame. */
  private acted(next: AppState): void {
    this.wire.put(next)
    this.deps.soonTick()
    this.wire.draw()
  }

  /**
   * Open a chat — an agent with no task, in the lower pane — and put it in
   * front, where you can type at it.
   *
   * No project is asked for and none is used, which is why this does not
   * refuse the way `openTerminal` does when nothing is open. Where it stands
   * and what it is told are `openChat`'s: the one door every way in goes
   * through.
   */
  async openChat(harness?: string): Promise<string | null> {
    try {
      const opened = await openChat(this.wire.opts.client, harness ? { harness } : {})
      await this.showTerminal(opened.id)
      return opened.name
    } catch (err) {
      this.wire.put(notice(this.wire.state, why(err)))
      this.wire.draw()
      return null
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

  /** The agent's part of the window, as a lane is made (`Fitting.paneSize`). */
  paneSize(split = false): Size {
    return this.fitting.paneSize(split)
  }
}
