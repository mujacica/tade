import { chatTaskOf, HARNESS_CHOICES, isChatLane, type LaneId } from '@tade/core'
import { openChat } from '@tade/workbench'
import { isAttachedLane } from '@tade/workbench/attached'
import { acknowledge } from '../flash.ts'
import type { Frame, LaneView } from '../frame.ts'
import { halvesOf } from '../layout.ts'
import {
  type AppState,
  activeTerminal,
  laneShown,
  noteTyping,
  setHeld,
  showTerminal,
} from '../model.ts'
import {
  attachedMenuItems,
  bottomNewItems,
  chatMenuItems,
  laneMenuItems,
  terminalMenuItems,
} from '../panels/menu/state.ts'
import { findPanel, promptPanel } from '../panels/small/state.ts'
import type { PointerEvent } from '../pointer.ts'
import { initialRouter, pending, type RouterState, route } from '../router.ts'
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
  notify,
  type Prompts,
  type Subject,
  type Wiring,
  why,
} from './context.ts'
import { Finding } from './finding.ts'
import { Fitting, type Size } from './fitting.ts'
import { Held } from './held.ts'
import { type Area, Screens } from './shown.ts'

// The two screens in front of you, and the terminals they are. What the wheel
// cuts them out of is `Held`.
//
// Whose the wheel is, is the lane's own to say and never the harness's: a
// shell with an editor open in it is the same situation as an agent that
// draws its own conversation, and a window that guessed from what it launched
// would be wrong the moment somebody opened one.

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
  /** Something was done to a lane — split, sized, sent to its end: look sooner than the next beat. */
  soonTick(): void
  /** A lane in front printed: look at it now, and no oftener than the floor (`Looks.printed`). */
  printed(): void
  /** A line addressed to Tade rather than to the agent it was typed at. */
  say(said: string): void
}

/** The pane's lanes as this look found them: what is in front, and how much of it fits. */
export interface PaneAt {
  lane: string | null
  /** The second lane it is showing, and its rows: two lanes get neither the bar nor the cursor. */
  split: { lane: string; rows: number } | null
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
  /** The lines the pane and the terminal were last read as, which the wheel cuts a screen out of. */
  private readonly held: Held
  /** The lanes in front — both halves of each, where split — watched so they redraw as they print. */
  private readonly watching = new Map<Area, { lane: string; born: string; stop: () => void }>()
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
    this.held = new Held(wire, this.fitting, deps.skin)
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
      held: this.held.lines,
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
    if (moved.pane) this.held.drop('pane')
    if (moved.terminal) this.held.drop('terminal')
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
      // Answered once the tab is there, so the control is held down till then (`Router.run`).
      'new-terminal': () => this.openTerminal().then(() => {}),
      // Typed as well as clicked, in the default harness: the `+` is a menu now.
      'new-chat': () => this.openChat().then(() => {}),
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
          if (isAttachedLane(subject.id)) return attachedMenuItems()
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
        this.wire.put(
          acknowledge({ ...this.wire.state, panel: null }, `renamed to ${text}`, this.wire.now()),
        )
      },
      'rename-terminal': async (panel, text) => {
        if (!panel.target) return
        await this.wire.opts.client.renameTerminal(panel.target, text)
        await this.wire.live?.refresh()
        this.wire.put(
          acknowledge({ ...this.wire.state, panel: null }, `renamed to ${text}`, this.wire.now()),
        )
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
    // A terminal to another machine's agent is a lane and no terminal of a project's.
    const closing = isChatLane(id)
      ? client.stopAgent(chatTaskOf(id))
      : isAttachedLane(id)
        ? client.closeLane(id as LaneId)
        : client.closeTerminal(id)
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
    this.watch(split?.lane ?? null, 'split')
    if (split) await this.fitting.fit(split.lane, halves.second, true)
    this.fitting.behind()
    return {
      lane,
      split: split ? { lane: split.lane, rows: halves.second.rows } : null,
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
    // Its second half beside it, and said in the same answer: drawn on its
    // own, it was a frame of the split's news ahead of the pane's.
    const [first, second] = await Promise.all([
      this.readFirst(at),
      at.split ? this.readHalf('split', at.split) : false,
    ])
    return first || second
  }

  /** The lane the pane is showing, or the first of two. */
  private async readFirst(at: PaneAt): Promise<boolean> {
    const was = this.screens.of('pane')
    // Only for the one screen the bar and the cursor are drawn on: a split is
    // two lanes and gets neither.
    const read = at.split ? null : ((await this.wire.live?.screen(at.lane)) ?? null)
    const view = was.lane === at.lane && same(read, was.view) ? was.view : read
    const screen = await this.held.read('pane', at.lane, at.rows, view)
    // Kept as the lane's own only where it was read at its newest line: coming
    // back to an agent is coming back to its end.
    const fresh = { lane: at.lane, screen, view }
    const changed = this.screens.read('pane', fresh, this.wire.state.paneScroll === 0)
    return changed || view !== was.view
  }

  /** The second half of a split, read whole: it scrolls with neither bar nor cursor. */
  private async readHalf(
    area: 'split' | 'splitTerminal',
    half: { lane: string; rows: number },
  ): Promise<boolean> {
    const screen =
      (await this.wire.live?.capture(half.lane, half.rows, this.deps.skin.colour)) ?? ''
    return this.screens.read(area, { lane: half.lane, screen, view: null }, true)
  }

  /** Type into the agent you are watching, and hold focus while you do. */
  toLane(data: string): void {
    const was = this.wire.state
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
    // Back to its newest line, and the text with the bar: the lines held may
    // reach it, and a look catches up if not.
    const scrolled = was.paneScroll !== 0
    if (scrolled && !this.reslice('pane')) this.deps.soonTick()
    // The key's own frame only where it changed something the window draws:
    // the echo is the lane's to print and a look's to draw, and a frame for
    // nothing arms pi-tui's throttle just as the echo comes back and needs it.
    if (scrolled || this.wire.state.held !== was.held || routed.toTade !== null) this.wire.draw()
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
      // What it draws in answer is the lane printing, which is what looks at
      // it (`watch`). A look asked for here landed before the program had
      // answered, found nothing, and held the answer a whole floor behind it.
      this.wire.outbox.wheel(lane as LaneId, { rows: event.rows, ...event.at })
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
   * text moves on the same frame as the bar beside it (`Held.cut`). True when
   * that is the whole answer and there is nothing to ask the driver; false is
   * the only reason to go and look — the lines do not reach, or they are the
   * live rows, drawn at once and read again behind it.
   */
  reslice(area: 'pane' | 'terminal'): boolean {
    // Only ever the lane in front's own lines: what a focus left behind is not.
    this.owned()
    const shown = this.screens.of(area)
    const cut = this.held.cut(area, shown)
    if (!cut) return false
    this.screens.read(area, { ...shown, screen: cut.screen }, false)
    return cut.whole
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
      this.watch(null, 'splitTerminal')
      const shown = this.screens.of('terminal')
      if (shown.view) this.screens.read('terminal', { ...shown, view: null }, false)
      return false
    }
    const split = terminalSplitShown(this.wire.state)
    const halves = this.fitting.terminalHalves()
    const size = halves.first
    await this.fitting.fit(terminal.id, size, true)
    this.watch(terminal.id, 'terminal')
    const half = split ? { lane: split.lane, rows: halves.second.rows } : null
    this.watch(half?.lane ?? null, 'splitTerminal')
    if (half) await this.fitting.fit(half.lane, halves.second, true)
    const [first, second] = await Promise.all([
      this.readTerminal(terminal.id, size.rows, half !== null),
      half ? this.readHalf('splitTerminal', half) : false,
    ])
    return first || second
  }

  /** The terminal in front, or the first of two. */
  private async readTerminal(id: string, rows: number, split: boolean): Promise<boolean> {
    // The depth before the text, as an agent's pane reads them: what is held
    // is kept by which lines they are, and that is counted from the depth.
    const was = this.screens.of('terminal')
    const read = split ? null : ((await this.wire.live?.screen(id)) ?? null)
    const view = was.lane === id && same(read, was.view) ? was.view : read
    const screen = await this.held.read('terminal', id, rows, view)
    const fresh = { lane: id, screen, view }
    const moved = this.screens.read('terminal', fresh, this.wire.state.terminalScroll === 0)
    return moved || view !== was.view
  }

  /**
   * Put a terminal or a chat in front the moment it is open, from wherever. Its
   * tab is read off the lane registry, which had it before the open answered,
   * as every look reads it (`tabsNow`) — not waited for from up to ten looks a
   * tenth of a second apart.
   */
  async showTerminal(id: string): Promise<void> {
    this.wire.live?.tabsNow()
    this.wire.put(showTerminal(this.wire.state, id))
    this.deps.soonTick()
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
      notify(this.wire, why(err))
      this.wire.draw()
      return null
    }
  }

  /** Open a terminal in a project — the one you are in unless told — and put it in front. */
  async openTerminal(name: string | null = null, cwd?: string): Promise<string | null> {
    const project = this.wire.state.project
    if (!project) {
      notify(this.wire, 'open a project first: a terminal starts in its folder')
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
      notify(this.wire, why(err))
      this.wire.draw()
      return null
    }
  }

  /**
   * Watch a lane in front of you, so what it prints is on screen at once
   * rather than at the next quarter-second look. Typing waited for that look,
   * which is what made an agent feel slow to type into — and what it prints
   * is the only thing that looks at it after a key, which is why both halves
   * of a split are watched: either can be the one being typed into.
   */
  private watch(lane: string | null, slot: Area = 'pane'): void {
    // Which lane under that name: a terminal to another machine run again in
    // the lane it lost its connection in (`remote-terminals.ts`) is another
    // lane, and one watched as the old would print without being looked at.
    const record = lane ? this.wire.opts.client.lane(lane as LaneId) : null
    const born = record ? `${record.startedAt}:${record.pid}` : ''
    const was = this.watching.get(slot)
    if (was?.lane === lane && (lane === null || was.born === born)) return
    was?.stop()
    this.watching.delete(slot)
    if (!lane) return
    const watching = { lane, born, stop: () => {} }
    this.watching.set(slot, watching)
    const printed = () => {
      if (slot === 'pane' || slot === 'terminal') this.held.printed(slot)
      this.deps.printed()
    }
    void this.wire.opts.client
      .watch(lane as LaneId, printed, { lines: 1 })
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
