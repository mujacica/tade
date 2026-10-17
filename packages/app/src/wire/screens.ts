import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { Terminal } from '@earendil-works/pi-tui'
import type { AppState } from '../model.ts'
import { runScreen, ScreenCancelled, type Ui } from '../screen.ts'
import { PLAIN } from '../skin.ts'
import { transcriptLines } from '../transcript-view.ts'
import { editRecorded, writeRecorded } from './config-written.ts'
import { notify, type Wiring, why } from './context.ts'

// The terminal the window draws on, lent to a form for a moment, and the
// conversation kept where you were reading it while it grows.
//
// Both are the screen's and nothing else's, so they are the face's: the
// conversation itself is the heart's (`Orchestrator`, `heart.ts`), which runs
// with no screen at all under `tade serve`, and reaches this only through
// `anchored`.
//
// The screen is borrowed rather than shared: two things drawing at once is the
// bug the whole design avoids, so while a form has the terminal the window
// stops drawing and starts again where it left off.

/** What lending the screen needs of the window. */
export interface ScreensDeps {
  /** The terminal a borrowed screen is drawn on. */
  terminal: Terminal
  /** Stop drawing, and start again: the screen is somebody else's for a moment. */
  suspend(): void
  resume(): void
}

export class Screens {
  private readonly wire: Wiring
  private readonly deps: ScreensDeps
  /** Another screen has the terminal, so this window must not draw over it. */
  private borrowing = false

  constructor(wire: Wiring, deps: ScreensDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** Another screen has the terminal: nothing here may draw over it. */
  borrowed(): boolean {
    return this.borrowing
  }

  /**
   * Scrolled back, the lines you are reading stay where they are while new
   * ones arrive below: the distance from the bottom grows by what was added.
   */
  anchored(next: AppState): AppState {
    const before = this.wire.state
    if (next.transcriptScroll === 0 || next.transcript === before.transcript) return next
    const count = (transcript: AppState['transcript']) =>
      transcriptLines(
        transcript,
        this.deps.terminal.columns,
        PLAIN,
        { hover: null, pressed: null },
        0,
      ).length
    const grown = count(next.transcript) - count(before.transcript)
    return { ...next, transcriptScroll: Math.max(0, next.transcriptScroll + grown) }
  }

  /** Borrow the terminal for a flow on the shared screen, then put the window back. */
  async onScreenWith(flow: (ui: Ui) => Promise<void>): Promise<void> {
    if (this.borrowing) return
    this.borrowing = true
    this.deps.suspend()
    try {
      await runScreen({ title: 'Tade', terminal: this.deps.terminal }, flow)
    } catch (err) {
      if (!(err instanceof ScreenCancelled)) {
        notify(this.wire, why(err))
      }
    } finally {
      this.borrowing = false
      this.deps.resume()
      this.wire.draw()
    }
  }

  /** Ask, on a screen of its own, and put the window back afterwards. */
  async onScreen(command: string): Promise<void> {
    if (this.borrowing) return
    this.borrowing = true
    this.deps.suspend()
    try {
      await runScreen(
        {
          title: command,
          context: [join(this.wire.opts.home, 'config.yaml')],
          terminal: this.deps.terminal,
        },
        async (ui) => {
          try {
            const done = await this.runCommand(command, ui)
            if (done) notify(this.wire, done)
          } catch (err) {
            // Shown here and waited on, rather than thrown out to a window
            // that is about to redraw over it: an explanation that leaves with
            // the screen is an explanation nobody read.
            if (err instanceof ScreenCancelled) throw err
            await ui.pause(`  ${err instanceof Error ? err.message : String(err)}`)
          }
        },
      )
    } catch (err) {
      // ctrl+c closes the form, not Tade.
      if (!(err instanceof ScreenCancelled)) {
        notify(this.wire, err instanceof Error ? err.message : String(err))
      }
    } finally {
      this.borrowing = false
      this.deps.resume()
      this.wire.draw()
    }
  }

  /** What each command actually does, once it has a screen to ask on. */
  async runCommand(command: string, ui: Ui): Promise<string> {
    switch (command) {
      case '/settings':
        await editRecorded(this.wire, ui)
        return 'settings closed'
      case '/project': {
        const root = resolve(await ui.ask('repository path', this.wire.opts.cwd ?? process.cwd()))
        if (!existsSync(join(root, '.git'))) throw new Error(`${root} is not a git repository`)
        const fallback = basename(root)
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
        const name = await ui.ask('call it what?', fallback)
        writeRecorded(this.wire, `projects.${name}.root`, root)
        return `added ${name} → ${root}, from the next time Tade starts`
      }
      default:
        return ''
    }
  }
}
