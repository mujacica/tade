import { pricesFrom, spendFrom } from '@tade/core'
import type { DeskRow, Frame } from '../frame.ts'
import { deskOf } from '../landing.ts'
import { focusTask } from '../model.ts'
import { landingPanel } from '../panels/landing/state.ts'
import type { PanelInputs } from '../panels.ts'
import type { Actions, Subject, Submits, Wiring } from './context.ts'
import { heldFindings } from './findings.ts'
import { Kept } from './kept.ts'

// The landing desk: every finished piece of work and every open review, every
// project's, in the order it is cheapest to trust — and the panel it is read in.
//
// A view and nothing more. Status's last look, the ACTIONS page's last look at
// each task, what the judges last said and what the journal says was spent:
// `deskOf` folds them, and nothing here is remembered but the fold itself, kept
// until something it was made of changes.
//
// **Only an open desk looks.** What the checks came to and what a change
// touched are a handful of `git`s a task, so they are looked at for every row
// while the panel is open, on the beat (`keepAsking`), and never otherwise: a
// closed desk is drawn from whatever the window had already looked at, and a
// task nobody has looked at says so.

export class Landing implements Subject {
  private readonly wire: Wiring
  private readonly desk = new Kept<readonly DeskRow[]>()
  /** What every task has cost over every run, refolded only when a usage line arrives. */
  private readonly spent = new Kept<Readonly<Record<string, number | null>>>()
  private readonly files = new Kept<Readonly<Record<string, readonly string[]>>>()

  constructor(wire: Wiring) {
    this.wire = wire
  }

  facts(): Partial<Frame> {
    const live = this.wire.live
    const world = live?.world
    if (!live || !world) return {}
    const findings = heldFindings(this.wire)
    const usd = this.usd()
    const landing = this.desk.of([world, live.revision, findings, usd, live.pending], () => {
      const facts = live.queueFacts()
      const waiting = new Set([
        ...live.tasks.filter((one) => one.waiting === true).map((one) => one.task),
        ...live.pending.map((one) => one.task),
      ])
      return deskOf({
        world,
        finished: new Set(facts.finished.keys()),
        waiting,
        work: (task) => live.seenActions(task),
        findings,
        usd: (task) => usd[task] ?? null,
      })
    })
    if (this.wire.state.panel?.kind === 'landing') this.lookAt(landing)
    return { landing }
  }

  inputs(): PanelInputs {
    const live = this.wire.live
    if (this.wire.state.panel?.kind !== 'landing' || !live) return {}
    const desk = this.facts().landing ?? []
    const deskFiles = this.files.of([desk, live.revision], () => {
      const out: Record<string, readonly string[]> = {}
      for (const row of desk) {
        const root = live.worktreeOf(row.task)
        const changes = root ? live.changesAt(root, live.baseOf(row.task)) : null
        if (changes) out[row.task] = changes.map((one) => one.path)
      }
      return out
    })
    return { desk, deskFiles }
  }

  actions(): Actions {
    const open = () => {
      this.wire.put({ ...this.wire.state, panel: landingPanel() })
      this.wire.draw()
    }
    return { landing: open, '/land': open }
  }

  submits(): Submits {
    return {
      landing: (_panel, choice) => {
        const task = choice?.startsWith('agent:') ? choice.slice('agent:'.length) : null
        if (!task) return
        this.wire.put({ ...focusTask(this.wire.state, task), panel: null })
      },
    }
  }

  /**
   * Every row's checks and changes, looked at on the beat while the desk is
   * open: the ACTIONS page's own look (`Live.actions`) and the changes git
   * counts from its base, each answered from the last look and asked again
   * only when that is stale.
   */
  private lookAt(desk: readonly DeskRow[]): void {
    const live = this.wire.live
    if (!live) return
    live.keepAsking('landing', () => {
      if (this.wire.state.panel?.kind !== 'landing') return
      for (const row of desk) {
        live.actions(row.task)
        const root = live.worktreeOf(row.task)
        if (root) live.changesAt(root, live.baseOf(row.task))
      }
    })
  }

  /**
   * What each task has cost over every run there has been: money where any was
   * recorded, null where none was — never a nought for a task whose harness
   * reported nothing.
   */
  private usd(): Readonly<Record<string, number | null>> {
    const live = this.wire.live
    if (!live) return {}
    return this.spent.of([live.spending.size], () => {
      const report = spendFrom(live.spending.events, {
        since: 0,
        prices: pricesFrom(this.wire.opts.config.prices),
      })
      return Object.fromEntries(
        Object.entries(report.byTask).map(([task, spend]) => [
          task,
          spend.hasCost ? spend.usd : null,
        ]),
      )
    })
  }
}
