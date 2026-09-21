import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Frame } from '../frame.ts'
import { asRemembered, type LayoutPrefs, type RememberedWindow } from '../layout.ts'
import {
  type AgentMark,
  conversing,
  FOLDED_AT_START,
  focusTask,
  markOf,
  shownName,
  toggleDone,
} from '../model.ts'
import { windowTitle } from '../title.ts'
import { type Actions, clockOf, type Subject, tilde, type Wiring, whenShort } from './context.ts'

// The window as a window: how big its regions are, what it says in the
// terminal's own title, and where you were last time.
//
// Opening Tade starts nothing new and brings back what was working, and this
// is the small end of that — the pane you were watching, the dividers you
// dragged, the sections you folded. None of it is state Tade owns: it is one
// file beside the journal, and a window that has never been opened reads it
// as "no preferences", which is exactly right.

/** How long the title is left alone before it is written again. */
const RETITLE_MS = 2_000

/** What this subject needs from the rest of the window. */
export interface WindowDeps {
  /** Write the terminal's own title. */
  setTitle(title: string): void
  /** Close it. The answer to having asked, or to there being nothing to ask about. */
  stop(): Promise<void>
}

export class Window implements Subject {
  private readonly wire: Wiring
  private readonly deps: WindowDeps
  /** Where you were last time, applied once the tasks are known. */
  private kept: RememberedWindow | null = null
  private restored = false
  private titled = ''
  /** When the title was last written, so a stolen one is taken back. */
  private titledAt = 0

  constructor(wire: Wiring, deps: WindowDeps) {
    this.wire = wire
    this.deps = deps
  }

  /**
   * The window's own: how it is divided, where Tade's home is, which keys it
   * was given, and how a moment is said. The clock is here because the window
   * owns the one there is — a subject that read its own would answer a
   * different time in the same frame.
   */
  facts(): Partial<Frame> {
    return {
      layout: this.layout(),
      home: tilde(this.wire.opts.home),
      bindings: this.wire.opts.config.surfaces.window.keys,
      now: this.wire.now(),
      clock: (at: number) => whenShort(at, this.wire.now()),
      date: (at: number) => this.dateOf(at),
    }
  }

  actions(): Actions {
    return {
      'toggle-done': () => {
        this.wire.put(toggleDone(this.wire.state))
        // Written here and not only on the way out: the window you press this
        // in is the window you leave open for days, and one that was killed
        // rather than closed would forget it every time.
        this.remember()
        this.wire.draw()
      },
      'bottom-max': () => this.showBottom('max'),
      'bottom-min': () => this.showBottom('min'),
    }
  }

  /**
   * Close, asking first only when closing would stop something: agents that
   * live inside this window and cannot be found again once it is gone.
   */
  quit(): void {
    if (this.wouldStop(0)) {
      this.wire.put({ ...this.wire.state, panel: { kind: 'quit', field: 'cancel', busy: false } })
      this.wire.draw()
      return
    }
    void this.deps.stop()
  }

  /**
   * Reload, asking first for the same reason — and counting the terminals too,
   * which a close leaves running and a reload does not.
   */
  reload(): void {
    if (this.wouldStop(this.wire.state.terminals.length)) {
      this.wire.put({ ...this.wire.state, panel: { kind: 'reload', field: 'cancel', busy: false } })
      this.wire.draw()
      return
    }
    void this.wire.opts.reloadWindow?.()
  }

  /** Whether going now would end work nobody could find again. */
  private wouldStop(besides: number): boolean {
    const running = this.wire.state.panes.reduce((n, pane) => n + pane.lanes.length, 0) + besides
    return running > 0 && !this.wire.opts.client.driver.capabilities.detach
  }

  /** The bottom panel at that size, or back to the size it was. */
  private showBottom(mode: 'max' | 'min'): void {
    this.wire.put({
      ...this.wire.state,
      bottomMode: this.wire.state.bottomMode === mode ? 'open' : mode,
    })
    this.wire.draw()
  }

  /** Where the window writes down what it wants back next time. */
  private get memoryFile(): string {
    return join(this.wire.opts.home, 'window.json')
  }

  /** What was written down last time, read once as the window opens. */
  recall(): RememberedWindow | null {
    this.kept = this.read()
    return this.kept
  }

  private read(): RememberedWindow | null {
    try {
      return asRemembered(JSON.parse(readFileSync(this.memoryFile, 'utf8')))
    } catch {
      // Never opened before, or a file we cannot read. Neither is a problem.
      return null
    }
  }

  remember(): void {
    try {
      const kept: RememberedWindow = {
        focused: this.wire.state.focused,
        ...this.wire.state.sizes,
        // Only what is not what a window starts at, exactly as a dragged size
        // is: a file that wrote down today's defaults would freeze them, and
        // the day `FOLDED_AT_START` changes nobody who had ever moved a
        // divider would see it. So `[]` is written down — you opened the one
        // section that starts folded, and that is a choice — while `['notes']`
        // is not, because it is not one.
        ...(this.wire.state.hidingDone ? { hidingDone: true } : {}),
        ...(sameSections(this.wire.state.folded, FOLDED_AT_START)
          ? {}
          : { folded: this.wire.state.folded }),
        ...(this.wire.state.opened.length > 0 ? { opened: this.wire.state.opened } : {}),
        ...(Object.keys(this.wire.state.order).length > 0 ? { order: this.wire.state.order } : {}),
      }
      writeFileSync(this.memoryFile, `${JSON.stringify(kept, null, 2)}\n`)
    } catch {
      // Coming back to the same pane is a convenience, not a reason to fail
      // on the way out.
    }
  }

  /**
   * Stand where you were standing, once there are panes to stand in.
   *
   * Tried at every look until it takes, because the tasks arrive after the
   * first frame: a window that gave up on the first empty list would open on
   * whatever happened to be first.
   */
  restoreFocus(): void {
    if (this.restored || !this.kept?.focused) return
    this.wire.put(focusTask(this.wire.state, this.kept.focused))
    this.restored = this.wire.state.panes.length > 0
  }

  /** The config's sizes, then the ones you dragged the dividers to, then how the bottom is shown. */
  layout(): LayoutPrefs {
    const window = this.wire.opts.config.surfaces.window
    const sizes = this.wire.state.sizes
    const sidebarWidth = sizes.sidebarWidth ?? window.sidebar_width
    const stripHeight = sizes.stripHeight ?? window.strip_height
    return {
      ...(sidebarWidth ? { sidebarWidth } : {}),
      ...(stripHeight ? { stripHeight } : {}),
      bottom: this.wire.state.bottomMode,
      grow: conversing(this.wire.state),
    }
  }

  /**
   * Say what is happening in the window's own title.
   *
   * Tade owns the title outright: everything it starts on a timer or in the
   * background runs detached, so no child of ours can name the terminal after
   * itself. Written when it changes — which, while anything works, is every
   * look, because the indicator turns — and otherwise re-asserted on the same
   * slow beat as the repaint, so a title something else took is taken back.
   */
  title(where: string | null): void {
    const now = this.wire.now()
    const count = (mark: AgentMark) =>
      this.wire.state.panes.filter((pane) => markOf(pane) === mark).length
    const title = windowTitle({
      working: count('working'),
      waiting: count('needs-you'),
      failed: count('failed'),
      agents: this.wire.state.panes.length,
      orchestrator:
        this.wire.state.listening && this.wire.state.talkingSince !== null
          ? 'listening'
          : this.wire.state.transcript.thinking !== null
            ? 'thinking'
            : 'quiet',
      where,
      now,
    })
    if (title === this.titled && now - this.titledAt < RETITLE_MS) return
    this.titled = title
    this.titledAt = now
    this.deps.setTitle(title)
  }

  /** Where you are, as the title says it: the project and the agent in front. */
  titleHere(): void {
    const pane = this.wire.state.panes.find((one) => one.task === this.wire.state.focused)
    this.title(pane ? `${pane.project} › ${shownName(pane)}` : this.wire.state.project)
  }

  /** A time as a person reads one: the day, the date and the clock. */
  dateOf(at: number): string {
    const time = new Date(at)
    const month = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ]
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][time.getDay()] ?? ''
    return `${day} ${time.getDate()} ${month[time.getMonth()] ?? ''} ${clockOf(at)}`
  }
}

/**
 * The same set of sections, whatever order they were folded in: what is
 * written down is a set, and folding two and unfolding one of them is not a
 * different answer from having folded the other first.
 */
function sameSections(folded: readonly string[], others: readonly string[]): boolean {
  return folded.length === others.length && folded.every((name) => others.includes(name))
}
