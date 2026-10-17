import type { Race } from '@tade/core'
import type { Frame } from '../frame.ts'
import { focusTask } from '../model.ts'
import { racePanel } from '../panels/race/state.ts'
import type { PanelInputs } from '../panels.ts'
import { type Actions, flash, notify, type Subject, type Submits, type Wiring } from './context.ts'
import { heldFindings } from './findings.ts'
import { Kept } from './kept.ts'
import { pickPressed, racesHeld, usdByTask } from './races.ts'

// The races, and the panel they are compared in (`/race`): the entrants given
// one request, side by side, each by the facts the window already holds.
//
// A view and nothing more. Status's last look, the ACTIONS page's last look at
// each entrant, what the judges last said and what the journal says was spent:
// `racesHeld` folds them, and nothing here is remembered but the fold itself,
// kept until something it was made of changes.
//
// **Only an open panel looks.** What the checks came to and what a change
// touched are a handful of `git`s an entrant, so they are looked at for every
// one while the panel is open, on the beat (`keepAsking`), and never otherwise:
// a closed panel is drawn from whatever the window had already looked at, and
// an entrant nobody has looked at says so. Picking one is a press, said yes
// to, and carried out by `pickPressed`.

export class Races implements Subject {
  private readonly wire: Wiring
  /** What every task has cost over every run, refolded only when a usage line arrives. */
  private readonly spent = new Kept<Readonly<Record<string, number | null>>>()
  private readonly races = new Kept<readonly Race[]>()
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
    const races = this.races.of([world, live.revision, findings, usd], () =>
      racesHeld(this.wire, usd),
    )
    if (this.wire.state.panel?.kind === 'race') {
      this.lookAt(races.flatMap((one) => one.racers.map((r) => r.facts.task)))
    }
    return { races }
  }

  inputs(): PanelInputs {
    const live = this.wire.live
    if (!live || this.wire.state.panel?.kind !== 'race') return {}
    const races = this.facts().races ?? []
    const tasks = races.flatMap((one) => one.racers.map((r) => r.facts.task))
    return {
      races,
      raceFiles: this.files.of([races, live.revision], () => this.filesOf(tasks)),
    }
  }

  actions(): Actions {
    const open = () => {
      this.wire.put({ ...this.wire.state, panel: racePanel() })
      this.wire.draw()
    }
    return { race: open, '/race': open }
  }

  submits(): Submits {
    return {
      race: async (_panel, choice) => {
        if (!choice?.startsWith('pick:')) {
          const task = choice?.startsWith('agent:') ? choice.slice('agent:'.length) : null
          if (task) this.wire.put({ ...focusTask(this.wire.state, task), panel: null })
          return
        }
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
   * Every entrant's checks and changes, looked at on the beat while the panel
   * is open: the ACTIONS page's own look (`Live.actions`) and the changes git
   * counts from its base, each answered from the last look and asked again
   * only when that is stale.
   */
  private lookAt(tasks: readonly string[]): void {
    const live = this.wire.live
    if (!live) return
    live.keepAsking('races', () => {
      if (this.wire.state.panel?.kind !== 'race') return
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
