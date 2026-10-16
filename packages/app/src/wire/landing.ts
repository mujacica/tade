import type { Race } from '@tade/core'
import type { DeskRow, Frame } from '../frame.ts'
import { deskOf } from '../landing.ts'
import { focusTask } from '../model.ts'
import { landingPanel } from '../panels/landing/state.ts'
import { racePanel } from '../panels/race/state.ts'
import type { PanelInputs } from '../panels.ts'
import { type Actions, flash, notify, type Subject, type Submits, type Wiring } from './context.ts'
import { heldFindings } from './findings.ts'
import { Kept } from './kept.ts'
import { pickPressed, racesHeld, usdByTask } from './races.ts'

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
//
// **And the races**, which are the same facts about a different set of tasks:
// the entrants given one request, compared side by side (`/race`), each looked
// at the same way only while that panel is open. Picking one is a press, said
// yes to, and carried out by `pickPressed`.

export class Landing implements Subject {
  private readonly wire: Wiring
  private readonly desk = new Kept<readonly DeskRow[]>()
  /** What every task has cost over every run, refolded only when a usage line arrives. */
  private readonly spent = new Kept<Readonly<Record<string, number | null>>>()
  private readonly files = new Kept<Readonly<Record<string, readonly string[]>>>()
  private readonly races = new Kept<readonly Race[]>()
  private readonly raceFiles = new Kept<Readonly<Record<string, readonly string[]>>>()

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
    const races = this.races.of([world, live.revision, findings, usd], () =>
      racesHeld(this.wire, usd),
    )
    const open = this.wire.state.panel?.kind
    if (open === 'landing') this.lookAt(landing.map((row) => row.task))
    if (open === 'race') this.lookAt(races.flatMap((one) => one.racers.map((r) => r.facts.task)))
    return { landing, races }
  }

  inputs(): PanelInputs {
    const live = this.wire.live
    const open = this.wire.state.panel?.kind
    if (!live || (open !== 'landing' && open !== 'race')) return {}
    if (open === 'race') {
      const races = this.facts().races ?? []
      const tasks = races.flatMap((one) => one.racers.map((r) => r.facts.task))
      return {
        races,
        raceFiles: this.raceFiles.of([races, live.revision], () => this.filesOf(tasks)),
      }
    }
    const desk = this.facts().landing ?? []
    const deskFiles = this.files.of([desk, live.revision], () =>
      this.filesOf(desk.map((row) => row.task)),
    )
    return { desk, deskFiles }
  }

  actions(): Actions {
    const open = () => {
      this.wire.put({ ...this.wire.state, panel: landingPanel() })
      this.wire.draw()
    }
    const race = () => {
      this.wire.put({ ...this.wire.state, panel: racePanel() })
      this.wire.draw()
    }
    return { landing: open, '/land': open, race, '/race': race }
  }

  submits(): Submits {
    const toAgent = (choice: string | undefined) => {
      const task = choice?.startsWith('agent:') ? choice.slice('agent:'.length) : null
      if (task) this.wire.put({ ...focusTask(this.wire.state, task), panel: null })
    }
    return {
      landing: (_panel, choice) => toAgent(choice),
      race: async (_panel, choice) => {
        if (!choice?.startsWith('pick:')) return toAgent(choice)
        // A pick is answered where it was pressed: done, or why not, in words.
        try {
          await pickPressed(this.wire, choice.slice('pick:'.length))
          flash(this.wire, `picked ${choice.split('/').at(-1) ?? choice}`)
        } catch (err) {
          notify(this.wire, err instanceof Error ? err.message : String(err))
        }
        this.wire.draw()
      },
    }
  }

  /** What each task changed, by file, from the last look; a task missing has not been looked at. */
  private filesOf(tasks: readonly string[]): Readonly<Record<string, readonly string[]>> {
    const live = this.wire.live
    const out: Record<string, readonly string[]> = {}
    for (const task of tasks) {
      const root = live?.worktreeOf(task)
      const changes = root ? live?.changesAt(root, live.baseOf(task)) : null
      if (changes) out[task] = changes.map((one) => one.path)
    }
    return out
  }

  /**
   * Every row's checks and changes, looked at on the beat while the desk or a
   * race is open: the ACTIONS page's own look (`Live.actions`) and the changes
   * git counts from its base, each answered from the last look and asked again
   * only when that is stale.
   */
  private lookAt(tasks: readonly string[]): void {
    const live = this.wire.live
    if (!live) return
    const open = this.wire.state.panel?.kind
    live.keepAsking('landing', () => {
      if (this.wire.state.panel?.kind !== open) return
      for (const task of tasks) {
        live.actions(task)
        const root = live.worktreeOf(task)
        if (root) live.changesAt(root, live.baseOf(task))
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
    return this.spent.of([live.spending.size], () => usdByTask(this.wire))
  }
}
