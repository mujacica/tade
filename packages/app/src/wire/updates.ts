import { randomBytes } from 'node:crypto'
import {
  type LaneId,
  LINES_LOOKED_BACK,
  RELOAD_REACH,
  reloadNamedBy,
  UPDATE_REACH,
  updateCheckEvery,
  updateNamedBy,
} from '@tade/core'
import {
  lastUpdates,
  lookAtUpdates,
  rememberUpdates,
  type UpdateLook,
} from '@tade/workbench/programs'
import type { Frame } from '../frame.ts'
import { updateActions } from '../panels/settings/state.ts'
import type { ReloadPanel } from '../panels/small/state.ts'
import {
  behindIn,
  endedIn,
  failureLines,
  mayOffer,
  type Outcome,
  outcomeSays,
  type Step,
  stepsNamed,
  typedFor,
} from '../updates.ts'
import { type Actions, notify, type Subject, saidLately, type Wiring, why } from './context.ts'

// Keeping what Tade runs current, from the window: what the Updates page reads,
// the check the window makes on a clock, the strip's chip, and the one way an
// update is run — the chip, the page's buttons and the orchestrator all come
// through `run`.
//
// Reading the machine is free and asking the world is not. What is installed
// is read when somebody opens the page; what is *current* is asked when the
// button is pressed, and on a clock (`surfaces.window.check_updates`) only
// where the window was handed a way to ask (`AppOptions.updates`), which a
// test suite is not. The answer is kept in Tade's home, so a window that opens
// knows what the last one found without asking again.
//
// Nothing installs anything behind anybody's back: running an update types its
// exact command — the one the page draws before it is pressed — into the
// `updates` terminal, put in front first, and reads how it ended out of what
// that terminal printed (`typedFor`, `endedIn`).

/** The terminal every update runs in, so a second run finds the first's output above it. */
export const UPDATES_TERMINAL = 'updates'

/** How long after the window opens a check on the clock may start: never on the way up. */
const FIRST_LOOK_MS = 60_000
/** A check that failed is not tried again on every beat. */
const RETRY_MS = 60 * 60_000
/** How long one step may run before Tade stops waiting and says where it is. */
const STEP_MS = 30 * 60_000
/** How long the orchestrator's tool waits for a run before saying it is still going. */
const TOOL_WAIT_MS = 60_000
/** A reload asked for by the orchestrator waits this long, so its answer reaches it first. */
const ANSWERED_MS = 500
/** How much of what a step printed is kept to find its ending in. */
const TAIL = 4_096

/** What this subject needs from the rest of the window. */
export interface UpdatesDeps {
  /** Start Tade again, the way every reload goes: asking first where it would stop something. */
  reload(): void
  /** How many lanes a reload would stop: none where the driver's lanes outlive the window. */
  reloadStops(): number
  /** The terminal of that name, opened if it is not there and put in front; null with no project. */
  terminal(name: string): Promise<string | null>
  /** Tell the orchestrator, with the next thing somebody says. */
  news(said: string): void
}

/** What the orchestrator's update tools do, answered from this window. */
export interface UpdateTools {
  read(check: boolean): Promise<string>
  run(req: { which: readonly string[]; said: string }): Promise<string>
  reload(req: { said: string }): Promise<string>
}

export class Updates implements Subject {
  private readonly wire: Wiring
  private readonly deps: UpdatesDeps
  /**
   * What was last read: which of the programs Tade runs are here, and — once
   * somebody or the clock asked — what is current. Null until something has
   * been read or kept, because none of it is worth reading before.
   */
  private look: UpdateLook | null = null
  /** A look is going. Asking what is current is the only one that touches the network. */
  private busy = false
  /** When a check on the clock last started, so one that failed waits before the next. */
  private triedAt = 0
  /** The run going now: its steps, and how many have ended. */
  private going: { steps: readonly Step[]; done: number } | null = null
  /** The last run, as it was said: what `tade_updates` answers with. */
  private ran: { at: number; said: string } | null = null
  /**
   * What Tade moved to in this window, while the window still runs the one it
   * opened on. The strip's chip turns into the reload for as long as it is set.
   */
  private moved: string | null = null

  constructor(wire: Wiring, deps: UpdatesDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** What the Updates page says, when Settings is open on it. */
  panel(): Frame['panel'] {
    if (this.wire.state.panel?.kind !== 'settings') return {}
    return { updates: this.look, updatesBusy: this.busy }
  }

  inputs() {
    return { updateActions: updateActions(this.look, this.busy) }
  }

  /**
   * The strip's chip: how many could move forward, the run going, or the
   * reload a run of Tade itself is owed. Nothing at all while there is
   * nothing to say — an up-to-date machine is not news.
   */
  facts(): Partial<Frame> {
    const behind = behindIn(this.look).length
    const going = this.going
    if (!going && this.moved === null && behind === 0) return {}
    return {
      updates: {
        behind,
        running: going ? { done: going.done, of: going.steps.length } : null,
        reload: this.moved !== null,
      },
    }
  }

  actions(): Actions {
    return {
      // Not awaited: the chip says `updating` at once, and the run is minutes.
      'updates-run': () => {
        void this.run(behindIn(this.look))
      },
      'updates-show': async () => {
        await this.deps.terminal(UPDATES_TERMINAL)
      },
      'updates-reload': () => this.deps.reload(),
    }
  }

  /** What the last window kept, read once as this one opens. Nothing is asked of anybody. */
  async recall(): Promise<void> {
    const kept = await lastUpdates(this.wire.opts.home)
    if (kept && !this.look) {
      this.look = kept
      this.wire.draw()
    }
  }

  /**
   * On the window's beat: ask what is current when the last answer is older
   * than the setting says it may be. Never in the first minute of a window,
   * never while anything else is looking or running, and never where the
   * window was not handed a way to ask.
   */
  beat(): void {
    if (!this.wire.opts.updates || this.busy || this.going) return
    const every = updateCheckEvery(this.wire.opts.config.surfaces.window.check_updates)
    if (every === null) return
    const now = this.wire.now()
    if (now - this.wire.openedAt < FIRST_LOOK_MS) return
    const asked = this.look?.asked ? this.look.at : 0
    if (now - asked < every || now - this.triedAt < RETRY_MS) return
    this.triedAt = now
    void this.ask()
  }

  /**
   * What is installed on this machine, for the Updates page. Never on a timer
   * and never on the draw path — it runs a `--version` per program, which
   * belongs to somebody opening the page — and never over an answer that
   * already asked what is current.
   */
  async lookAtWhatIsInstalled(): Promise<void> {
    if (this.look || this.busy) return
    this.busy = true
    this.wire.draw()
    try {
      this.look = await this.read(false)
    } catch (err) {
      this.wire.note(err)
    } finally {
      this.busy = false
      this.wire.draw()
    }
  }

  /**
   * A button on the Updates page: ask what is current, run one update, or
   * reload. Running one goes the way the chip's does, so a button pressed on
   * the page says how it ended just as the chip does.
   */
  async action(id: string): Promise<void> {
    if (id === 'updates:check') {
      if (this.busy) return
      this.onPage('Asking what is current…')
      if (!(await this.ask()) || !this.look) return
      const behind = this.look.programs.filter((one) => one.behind).length
      const newer = this.look.tade.newer ? 1 : 0
      this.onPage(
        behind + newer === 0
          ? 'Everything Tade could ask about is current.'
          : `${behind + newer} could move forward.`,
      )
      return
    }
    if (id === 'updates:reload') {
      this.wire.put({ ...this.wire.state, panel: null })
      this.deps.reload()
      return
    }
    const action = updateActions(this.look, this.busy).find((one) => one.id === id)
    if (!action?.command || !action.about) return
    void this.run(stepsNamed(this.look, [action.about]))
  }

  /**
   * Ask what is current, keep the answer, and draw what it says. Said on the
   * Updates page where it is open and the asking failed; a check on the clock
   * that failed is said nowhere else, because nobody asked for it and it is
   * tried again in an hour. Whether it got an answer.
   */
  private async ask(): Promise<boolean> {
    if (this.busy) return false
    this.busy = true
    this.wire.draw()
    try {
      this.look = await this.read(true)
      // Kept for the next window; one that could not be written is asked again then.
      await rememberUpdates(this.wire.opts.home, this.look).catch(() => {})
      return true
    } catch (err) {
      this.onPage(null, why(err))
      return false
    } finally {
      this.busy = false
      this.wire.draw()
    }
  }

  /** The one reading there is: the window's own where it was handed one, the workbench's otherwise. */
  private read(ask: boolean): Promise<UpdateLook> {
    const { config, home } = this.wire.opts
    return this.wire.opts.updates
      ? this.wire.opts.updates(config, home, ask)
      : lookAtUpdates(config, home, { ask })
  }

  /**
   * Run updates, one after another, in the `updates` terminal — the one way
   * there is: the chip, the page and the orchestrator all come here.
   *
   * Each step's exact command is typed into a terminal put in front first, and
   * how it ended is read off what it printed. Then what is current is asked
   * again, so the chip and the page say what is true now, and what came of it
   * is said in the conversation and told to the orchestrator. Where Tade itself
   * moved, the window runs the old one until it reloads, so the reload is
   * offered — on a panel where nothing else is open, and on the chip until it
   * is taken. Null where nothing ran.
   */
  async run(steps: readonly Step[]): Promise<Outcome[] | null> {
    if (this.going || steps.length === 0) return null
    this.going = { steps, done: 0 }
    this.wire.draw()
    const before = this.look?.tade ?? null
    const outcomes: Outcome[] = []
    try {
      const id = await this.deps.terminal(UPDATES_TERMINAL)
      if (!id) {
        // No project, no folder to open a shell in. The commands are the answer.
        notify(this.wire, `Run it yourself: ${steps.map((step) => step.command).join(' && ')}`)
        return null
      }
      for (const step of steps) {
        const outcome = await this.step(id, step)
        outcomes.push(outcome)
        this.going = { steps, done: outcomes.length }
        this.wire.draw()
        // A closed terminal took the rest with it, and one still running is in the way.
        if (outcome.ended === 'closed' || outcome.ended === 'waited') break
      }
    } catch (err) {
      this.wire.note(err)
    } finally {
      this.going = null
      this.wire.draw()
    }
    if (outcomes.length === 0) return null
    await this.ask()
    const tade = outcomes.find((one) => one.step.about === 'tade' && one.ended === 'ok')
    const after = this.look?.tade ?? null
    // Moved is what is on disk now differing from what was before: a pull that
    // found nothing to pull succeeded and moved nothing, and owes no reload.
    if (
      tade &&
      (!before || !after || before.version !== after.version || before.commit !== after.commit)
    ) {
      this.moved = after ? (after.commit ?? after.version) : 'a newer Tade'
    }
    let said = outcomeSays(outcomes, `the ${UPDATES_TERMINAL} terminal`)
    if (this.moved !== null && tade) {
      said += ' Tade itself moved: this window runs the one it opened on until it reloads.'
    }
    this.ran = { at: this.wire.now(), said }
    notify(this.wire, said)
    this.deps.news(said)
    if (this.moved !== null && tade && mayOffer(this.wire.state, this.wire.now())) {
      this.offerReload()
    }
    this.wire.draw()
    return outcomes
  }

  /** One step: its line typed, and how it ended read off what the terminal printed. */
  private async step(id: string, step: Step): Promise<Outcome> {
    const client = this.wire.opts.client
    const nonce = randomBytes(4).toString('hex')
    let printed = ''
    let settle: (ended: Outcome['ended']) => void = () => {}
    const ending = new Promise<Outcome['ended']>((resolve) => {
      settle = resolve
    })
    // Watched before a key is typed, so an ending printed at once is not missed.
    const watching = await client.watch(
      id as LaneId,
      (chunk) => {
        printed = (printed + Buffer.from(chunk).toString('utf8')).slice(-TAIL)
        const ended = endedIn(printed, nonce)
        if (ended) settle(ended)
      },
      { lines: 1, onExit: () => settle('closed') },
    )
    try {
      await client.runInTerminal(id, typedFor(step.command, nonce))
      const ended = (await within(ending, STEP_MS)) ?? 'waited'
      const lines =
        ended === 'failed'
          ? failureLines(await client.readTerminal(id, 200).catch(() => ''), nonce)
          : []
      return { step, ended, lines }
    } finally {
      watching.stop()
    }
  }

  /** The reload panel, saying what Tade moved to and what reloading costs here. */
  private offerReload(): void {
    // On Later: it arrives on its own, minutes after the press, and an enter
    // meant for something else must never be the one that reloads.
    const panel: ReloadPanel = {
      kind: 'reload',
      field: 'cancel',
      busy: false,
      updated: {
        to: this.moved ?? 'a newer Tade',
        survives: this.wire.opts.client.driver.capabilities.detach,
      },
    }
    this.wire.put({ ...this.wire.state, panel })
  }

  /** What the orchestrator's update tools do, answered from this window. */
  tools(): UpdateTools {
    return {
      read: async (check) => {
        if (check) await this.ask()
        else if (!this.look) this.look = await this.read(false)
        return JSON.stringify(
          {
            ...this.look,
            updating: this.going
              ? {
                  steps: this.going.steps.map((step) => step.title),
                  done: this.going.done,
                }
              : null,
            lastRun: this.ran,
            reloadOwed: this.moved,
          },
          null,
          2,
        )
      },
      run: async (req) => {
        await this.asked(req.said, updateNamedBy, UPDATE_REACH.because, 'an update')
        if (this.going) {
          throw new Error(
            `Already updating: ${this.going.done} of ${this.going.steps.length} done, in the ${UPDATES_TERMINAL} terminal. What it comes to reaches you with the next thing they say, or ask tade_updates.`,
          )
        }
        if (!this.look?.asked) await this.ask()
        const steps = stepsNamed(this.look, req.which)
        if (steps.length === 0) {
          return req.which.length > 0
            ? `Nothing called ${req.which.join(', ')} has a command Tade can run: tade_updates lists what does.`
            : 'Nothing is behind as of the last check, so there is nothing to update.'
        }
        // Boxed, because a run that never started is an answer and not a wait.
        const done = await within(
          this.run(steps).then((outcomes) => ({ outcomes })),
          TOOL_WAIT_MS,
        )
        if (done?.outcomes === null) {
          throw new Error('Nothing ran: there is no project to open a terminal in.')
        }
        if (done === null) {
          return `Updating ${steps.map((step) => step.title).join(', ')} in the ${UPDATES_TERMINAL} terminal, in front of them. It is still going: what it comes to is said in the conversation when it ends, and reaches you with the next thing they say — or ask tade_updates.`
        }
        return this.ran?.said ?? 'Nothing ran.'
      },
      reload: async (req) => {
        await this.asked(req.said, reloadNamedBy, RELOAD_REACH.because, 'a reload')
        const stops = this.deps.reloadStops()
        // After the answer is on its way: a reload ends this window, and with it
        // the turn the answer would have gone to.
        setTimeout(() => this.deps.reload(), ANSWERED_MS)
        return stops > 0
          ? `Asked them: ${stops} lane${stops === 1 ? '' : 's'} run inside this window and would stop, so the reload panel is theirs to press.`
          : 'Reloading in a moment. Agents keep working, and this conversation carries on where it is.'
      },
    }
  }

  /** Refuses unless a line the person said asks for this. The check is here, never in the tool. */
  private async asked(
    said: string,
    namedBy: (lines: readonly string[]) => string | null,
    because: string,
    what: string,
  ): Promise<void> {
    if (said.trim() === '') {
      throw new Error(
        `${what.charAt(0).toUpperCase()}${what.slice(1)} is only done when somebody asks for it: pass what they said, word for word.`,
      )
    }
    if (!namedBy(await saidLately(this.wire, LINES_LOOKED_BACK))) {
      throw new Error(`Nothing they have said asks for ${what}, so I will not: ${because}.`)
    }
  }

  /** Say on the Settings page what just happened, where it is still open. */
  private onPage(saved: string | null, error: string | null = null): void {
    const panel = this.wire.state.panel
    if (panel?.kind === 'settings') {
      this.wire.put({ ...this.wire.state, panel: { ...panel, saved, error } })
    }
    this.wire.draw()
  }
}

/** The answer, or null when it did not come in time. */
async function within<T>(work: Promise<T>, limit: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), limit)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
