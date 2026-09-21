import type { LaneId } from '@tade/core'
import type { VoiceTerminals } from '@tade/voice-core'
import { matchingLines } from '@tade/workbench'
import type { Frame, LaneView } from '../frame.ts'
import { resolveLayout } from '../layout.ts'
import {
  activeTerminal,
  laneShown,
  noteTyping,
  notice,
  setHeld,
  showTerminal,
  splitShown,
  terminalSplitShown,
  typingLane,
} from '../model.ts'
import { findPanel } from '../panels/small/state.ts'
import type { PointerEvent } from '../pointer.ts'
import { initialRouter, pending, type RouterState, route } from '../router.ts'
import { cutFrom, type HeldLines } from '../scroll.ts'
import { BAR } from '../scrollbar.ts'
import type { Skin } from '../skin.ts'
import { type Wiring, why } from './context.ts'

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
    a.scrolling === b.scrolling
  )
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** What this subject needs from the rest of the window. */
export interface LanesDeps {
  /** How big the terminal is: every lane is sized from it. */
  size(): { columns: number; rows: number }
  /** Where the panes and the strip are. */
  layout(): Parameters<typeof resolveLayout>[0]
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

export class Lanes {
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
  /** The size each lane was last made, so resizing happens once per change. */
  private readonly fitted = new Map<string, string>()
  /** A terminal's scrollback, read for finding in it. */
  private findText: { id: string; lines: string[] } | null = null
  /** A command voice typed into a terminal, waiting for enter or "confirm". */
  private typed: { id: string; name: string; command: string } | null = null
  private router: RouterState = initialRouter()
  /** Which agent the router's half-typed line belongs to. */
  private routerFor: string | null = null

  constructor(wire: Wiring, deps: LanesDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** The two screens, as the frame draws them. */
  facts(): Pick<Frame, 'screen' | 'terminal' | 'paneScreen' | 'splitScreen' | 'splitTerminal'> {
    return {
      screen: this.screen,
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

  /** Stop watching both lanes: the window is closing. */
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
    const halves = this.halves(this.paneSize(split !== null), split)
    const size = halves.first
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
    return { lane, split: split !== null, rows: size.rows }
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
   * where the agent is typing, and that is the cheap end.
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
    const at = (area === 'pane' ? this.paneView : this.terminalView)?.lines ?? 0
    // Never further back than there is to read: the wheel is clamped against
    // what the last frame drew, and this is the same clamp against what the
    // driver says now, for a lane that shrank or was relaunched under us.
    const most = Math.max(0, at - rows)
    if (at > 0 && this.wire.state[which] > most)
      this.wire.put({ ...this.wire.state, [which]: most })
    const back = this.wire.state[which]
    const held = this.held.get(area)
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
    this.held.set(area, read)
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
   * text moves on the same frame as the bar beside it. What it cannot reach
   * waits for the look the wheel asked for, a few milliseconds behind.
   */
  reslice(area: 'pane' | 'terminal'): void {
    const held = this.held.get(area)
    if (!held) return
    const view = area === 'pane' ? this.paneView : this.terminalView
    const cut = cutFrom(
      held,
      this.laneRows(area),
      this.wire.state[SCROLL_OF[area]],
      view?.lines ?? held.at,
    )
    if (cut === null) return
    if (area === 'pane') this.screen = cut
    else this.terminalScreen = cut
  }

  /** How many rows of a lane are on screen: what a capture is cut to. */
  private laneRows(area: 'pane' | 'terminal'): number {
    if (area === 'pane') {
      const pane = this.wire.state.panes.find((p) => p.task === this.wire.state.focused)
      const split = pane ? splitShown(this.wire.state, pane) : null
      return this.halves(this.paneSize(split !== null), split).first.rows
    }
    const layout = resolveLayout(this.deps.layout(), {
      width: this.deps.size().columns,
      height: Math.max(6, this.deps.size().rows),
    })
    const split = terminalSplitShown(this.wire.state)
    // Sized exactly as `captureTerminal` sizes it: two readings of one layout
    // drift, and a screen cut to the wrong number of rows is a screen that
    // jumps when the look catches up with the wheel.
    return this.halves(
      {
        cols: Math.max(20, layout.sidebarWidth + layout.mainWidth + 1 - (split ? 0 : BAR)),
        rows: Math.max(1, layout.stripHeight - 2),
      },
      split,
    ).first.rows
  }

  /**
   * Read the terminal in front of the bottom panel, sized to the panel. Says
   * whether what it shows has changed. Nothing is read while the panel is
   * folded or showing the orchestrator.
   */
  async captureTerminal(): Promise<boolean> {
    const terminal = activeTerminal(this.wire.state)
    const layout = resolveLayout(this.deps.layout(), {
      width: this.deps.size().columns,
      height: Math.max(6, this.deps.size().rows),
    })
    if (!terminal || this.wire.state.bottomMode === 'min') {
      this.watch(null, 'terminal')
      this.terminalView = null
      return false
    }
    const split = terminalSplitShown(this.wire.state)
    const halves = this.halves(
      {
        // Less the scrollbar's column, which the window draws and the lane
        // must not: a split has none, and takes the width back.
        cols: Math.max(20, layout.sidebarWidth + layout.mainWidth + 1 - (split ? 0 : BAR)),
        rows: Math.max(1, layout.stripHeight - 2),
      },
      split,
    )
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

  /**
   * The sizes of the two halves of a split, as `splitView` lays them out — the
   * divider, and the second half's bar, taking their row or column.
   */
  private halves(
    whole: { cols: number; rows: number },
    split: { direction: 'beside' | 'below'; ratio: number } | null,
  ): { first: { cols: number; rows: number }; second: { cols: number; rows: number } } {
    if (!split) return { first: whole, second: whole }
    if (split.direction === 'beside' && whole.cols >= 24) {
      const first = Math.max(
        10,
        Math.min(whole.cols - 11, Math.round((whole.cols - 1) * split.ratio)),
      )
      return {
        first: { cols: first, rows: whole.rows },
        second: { cols: whole.cols - 1 - first, rows: Math.max(1, whole.rows - 1) },
      }
    }
    const first = Math.max(1, Math.min(whole.rows - 2, Math.round((whole.rows - 1) * split.ratio)))
    return {
      first: { cols: whole.cols, rows: first },
      second: { cols: whole.cols, rows: Math.max(1, whole.rows - 1 - first) },
    }
  }

  /** The scrollback the find box is looking through, and the line it is on. */
  findView(): NonNullable<Frame['terminal']>['find'] {
    const panel = this.wire.state.panel
    if (panel?.kind !== 'find' || this.findText?.id !== panel.terminal) return null
    const matches = this.findMatches()
    return {
      lines: this.findText.lines,
      line: matches.length > 0 ? (matches[panel.index % matches.length] ?? null) : null,
      query: panel.query,
    }
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
    const layout = resolveLayout(this.deps.layout(), {
      width: this.deps.size().columns,
      height: Math.max(6, this.deps.size().rows),
    })
    try {
      const opened = await this.wire.opts.client.openTerminal({
        project,
        ...(name ? { name } : {}),
        ...(cwd ? { cwd } : {}),
        cols: layout.sidebarWidth + layout.mainWidth + 1,
        rows: Math.max(4, layout.stripHeight - 2),
      })
      await this.showTerminal(opened.id)
      return opened.name
    } catch (err) {
      this.wire.put(notice(this.wire.state, why(err)))
      this.wire.draw()
      return null
    }
  }

  /** Look for text in a terminal's scrollback, with the find box over it. */
  async openFind(id: string, query = '', index = 0): Promise<void> {
    this.wire.put({ ...showTerminal(this.wire.state, id), panel: findPanel(id, query, index) })
    const text = await this.wire.opts.client.readTerminal(id, 5_000).catch(() => '')
    this.findText = { id, lines: text.split('\n') }
    this.wire.draw()
  }

  /** The lines the find box matches, newest first, as line numbers into the scrollback read. */
  findMatches(): number[] {
    const panel = this.wire.state.panel
    if (panel?.kind !== 'find' || this.findText?.id !== panel.terminal || panel.query === '')
      return []
    return matchingLines(this.findText.lines.join('\n'), panel.query, 10_000)
      .map((match) => match.line - 1)
      .reverse()
  }

  /** What voice does with terminals: each answers in the sentence it says back. */
  voiceTerminals(): VoiceTerminals {
    const project = () => this.wire.state.project ?? undefined
    // Said with no name, it is the terminal in front, or the only one in the project.
    const which = (name: string | null) => {
      const front = activeTerminal(this.wire.state)
      if (!name && front) return this.wire.opts.client.terminal(front.id)
      return this.wire.opts.client.terminal(name, project())
    }
    const attempt = async (act: () => Promise<string>) => {
      try {
        return await act()
      } catch (err) {
        return `${capitalise(why(err))}.`
      }
    }
    return {
      open: (name) =>
        attempt(async () => {
          const opened = await this.openTerminal(name)
          return opened ? `Opened ${opened}.` : 'I could not open a terminal here.'
        }),
      show: (name) =>
        attempt(async () => {
          const terminal = which(name)
          await this.showTerminal(terminal.id)
          return `Showing ${terminal.name}.`
        }),
      close: (name) =>
        attempt(async () => {
          const closed = await this.wire.opts.client.closeTerminal(which(name).id)
          await this.wire.live?.refresh()
          return `Closed ${closed.name}.`
        }),
      rename: (name, to) =>
        attempt(async () => {
          const renamed = await this.wire.opts.client.renameTerminal(which(name).id, to)
          await this.wire.live?.refresh()
          return `Renamed it ${renamed.name}.`
        }),
      run: (name, command) =>
        attempt(async () => {
          const terminal = await this.wire.opts.client.runInTerminal(which(name).id, command, {
            submit: false,
          })
          this.typed = { id: terminal.id, name: terminal.name, command }
          await this.showTerminal(terminal.id)
          return `Typed ${command} into ${terminal.name}. Press enter, or say confirm and the command, to run it.`
        }),
      search: (name, text) =>
        attempt(async () => {
          const { terminal, matches } = await this.wire.opts.client.searchTerminal(
            which(name).id,
            text,
          )
          await this.openFind(terminal.id, text)
          return matches.length === 0
            ? `Nothing in ${terminal.name} says ${text}.`
            : `${matches.length} line${matches.length === 1 ? '' : 's'} in ${terminal.name} mention ${text}.`
        }),
      confirm: async (phrase) => {
        const typed = this.typed
        if (!typed) return null
        const words = phrase.toLowerCase().split(/\s+/).filter(Boolean)
        const command = typed.command.toLowerCase()
        if (words.length === 0 || !words.every((word) => command.includes(word))) return null
        this.typed = null
        await this.wire.opts.client.write(typed.id as LaneId, '\r')
        return `Ran ${typed.command} in ${typed.name}.`
      },
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

  /** The agent's part of the window: the pane, less its title and rule. */
  paneSize(split = false): { cols: number; rows: number } {
    const layout = resolveLayout(this.deps.layout(), {
      width: this.deps.size().columns,
      height: Math.max(6, this.deps.size().rows),
    })
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
    const want = `${size.cols}x${size.rows}`
    if (this.fitted.get(lane) === want) return
    this.fitted.set(lane, want)
    await this.wire.opts.client.resize(lane as LaneId, size.cols, size.rows).catch(() => {
      // A lane that just ended cannot be resized; the next tick will not ask.
    })
  }
}
