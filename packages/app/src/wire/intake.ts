import {
  type InboxRow,
  type IntakeCandidate,
  type IntakeSource,
  inboxActs,
  intakeKey,
  type PlanSource,
  planReport,
} from '@tade/core'
import type { ExtensionHost } from '@tade/extensions-core'
import {
  approveIntake,
  type InboxOpen,
  inboxFrom,
  intakeGrant,
  intakeSourceOf,
  intakeWouldRun,
  openIntakeRow,
  refuseIntake,
  retryIntake,
} from '@tade/workbench'
import type { Frame, IntakeOpenView } from '../frame.ts'
import { inboxEmptyMeans, inboxEmptySays } from '../intake-view.ts'
import { notice, withTranscript } from '../model.ts'
import { type IntakePanel, intakePanel } from '../panels/intake/state.ts'
import type { PanelInputs } from '../panels.ts'
import { problem, tadeDid } from '../transcript.ts'
import { type Actions, type Subject, type Submits, type Wiring, why } from './context.ts'
import { Workflows } from './workflows.ts'

// What has been handed to this machine from outside, in the window.
//
// **It derives, it does not remember.** The rows are a fold of the journal and
// the task files (`inboxFrom`), refolded when the journal grows rather than on
// every frame: the side is drawn four times a second and reading a task file
// per request per frame is exactly the sort of poll this window does not do.
// Nothing is cached that the journal could answer — what is held is the last
// answer, not a second copy of the truth.
//
// **Every act goes through the one local door** (`@tade/workbench`'s
// `approveIntake`, `refuseIntake`, `retryIntake`), which is also what the CLI
// calls and what a web adapter would call. The window adds exactly the two
// things only a window has: the extension host, so a retry can ask the source
// again, and the queue, so approving can start what waits on nothing.
//
// **Approving is never implied.** Clicking a row opens it; the page it opens
// asks before it starts agents, because the request is somebody else's words
// and the agents run as you, with your keys.

/**
 * The journal lines a row is folded out of.
 *
 * Four are intake's own; the other four are what became of the work it made —
 * a park lifted or put back, a task made or removed, an agent started, a task
 * finished. A line of any other type cannot change a row, so it never costs a
 * read.
 */
const INBOX_LINES = new Set<string>([
  'intake_received',
  'intake_accepted',
  'intake_refused',
  'intake_held',
  'intake_replied',
  'state_change',
  'task_created',
  'task_removed',
  'queue_held',
  'queue_changed',
  'run_started',
  'task_done',
])

/** What a watch's look hands back, as its host declares it. */
type Looked = Awaited<ReturnType<ExtensionHost['look']>>

/**
 * Where each sign-in stands against its plan, in the words the template dry
 * run already says them in.
 *
 * Only the process supervising the agents can read a plan window, which is
 * this one — so the answer is a list and never null here, and a sign-in that
 * cannot say carries its own reason rather than being drawn as one with room.
 * `planReport`'s sentences, not a second set: two pages saying the same figure
 * two ways is how one of them comes to be wrong.
 */
function planSaid(usage: readonly PlanSource[], now: number): string[] {
  return planReport(usage, now).signIns.map((one) =>
    one.cannotTell
      ? `${one.label}: cannot tell — ${one.cannotTell}`
      : `${one.label}: ${one.windows.map((w) => `${w.label} ${w.used}% used`).join(', ') || 'nothing to say'}`,
  )
}

/** What this subject needs from the rest of the window. */
export interface IntakeDeps {
  /** Start whatever the queue can now start, so approving does not wait for the next look. */
  advanceQueue(): void
}

export class Intake implements Subject {
  private readonly wire: Wiring
  private readonly deps: IntakeDeps
  /** The last fold, and the journal it was folded from. */
  private rows: readonly InboxRow[] = []
  private folded = -1
  /** A fold under way, so a slow one is never started twice. */
  private folding: Promise<void> | null = null
  /**
   * The request being read in front of you, and which one it is the answer to.
   *
   * Kept beside the panel rather than in it, for `wire/rows.ts`' reason: it is
   * an answer arriving after the click, and which request it is for is kept
   * with it so a slow read can never land under another request's name.
   */
  private shown: InboxOpen | null = null

  /**
   * The stored workflows, which this subject owns rather than being a subject
   * of their own — `wire/rows.ts`' shape, and its argument: the inbox and the
   * workflows its grants stamp from are one surface area, and a second entry
   * in `app.ts` for something that only ever answered about templates would be
   * wiring with nothing of its own to wire.
   */
  private readonly workflows: Workflows

  constructor(wire: Wiring, deps: IntakeDeps) {
    this.wire = wire
    this.deps = deps
    this.workflows = new Workflows(wire)
  }

  facts(): Partial<Frame> {
    const grant = this.cliGrant()
    return {
      intake: this.rows,
      intakeEmpty: { short: inboxEmptySays(grant), long: inboxEmptyMeans(grant) },
    }
  }

  /** What the open page needs: only the answer to the request it is actually on. */
  panel(): Frame['panel'] {
    const panel = this.wire.state.panel
    if (panel?.kind === 'workflow') return this.workflows.panel()
    if (panel?.kind !== 'intake') return {}
    const shown = this.shown
    const open: IntakeOpenView | null =
      shown && shown.row.item === panel.item
        ? { ...shown, would: null, acts: inboxActs(shown.row) }
        : null
    return { intake: open ? { ...open, would: this.would } : null }
  }

  /** What approving the open request would start, once it has been worked out. */
  private would: IntakeOpenView['would'] = null

  actions(): Actions {
    return {
      'intake-open:': (item: string) => this.open(item),
      // A command rather than a control on a heading, for `/away`'s reason:
      // this is a page whose whole subject is off until somebody writes a
      // template, and a chip in every window for a feature nobody has used
      // costs the heading a column to say nothing. `/` lists it and `ctrl+k`
      // finds it.
      '/workflows': (name: string) => this.workflows.open(name.trim()),
    }
  }

  submits(): Submits {
    return {
      intake: (panel, choice) => this.act(panel, choice ?? ''),
      workflow: (panel, choice) =>
        choice === 'choose'
          ? this.workflows.choose(panel)
          : this.workflows.from(panel, choice ?? ''),
    }
  }

  /** What a panel's keys need that it does not hold: the workflow form's fields. */
  inputs(): PanelInputs {
    return this.workflows.inputs()
  }

  /**
   * Refold when a line the inbox actually depends on has been written, and no
   * more often than that.
   *
   * The journal grows constantly while agents work — a `usage` line every few
   * seconds — and refolding reads a task file per request, so "the journal
   * grew" is far too cheap a signal: forty requests would be forty file reads
   * every time somebody's agent spent a penny. So only the new lines are
   * looked at, and only the eight types that can change a row (`INBOX_LINES`)
   * cause a read. Everything else only moves the mark.
   *
   * An act refolds at once by setting the mark back, because a button whose
   * effect appears a second later is a button people press twice.
   */
  look(): void {
    const events = this.wire.live?.events ?? []
    if (events.length === this.folded || this.folding) return
    const fresh = this.folded < 0 ? events : events.slice(this.folded)
    this.folded = events.length
    if (!fresh.some((event) => INBOX_LINES.has(event.type))) return
    this.folding = this.fold(events)
      .catch((err: unknown) => this.couldNotRead(err))
      .finally(() => {
        this.folding = null
      })
  }

  private async fold(events: readonly { type: string }[]): Promise<void> {
    const rows = await inboxFrom({
      home: this.wire.opts.client.home,
      events: events as never,
      states: new Map(this.wire.state.panes.map((pane) => [pane.task, pane.state])),
    })
    this.rows = rows
    this.wire.draw()
  }

  /**
   * The fold could not be done, said once.
   *
   * **Not swallowed**, which is what it was: the rows it was going to replace
   * are still there, so a caught-and-dropped failure leaves the side drawing
   * the last answer that worked for as long as the window is open, and a
   * request that arrived afterwards is invisible rather than late. A look that
   * could not look is not a look that found nothing, and this is the sentence
   * that says which — once, because the fold runs again on the next line
   * written and a reason repeated every second is a reason nobody reads.
   */
  private couldNotRead(err: unknown): void {
    const said = `what has been handed to this machine could not be read: ${why(err)}`
    this.wire.put(
      withTranscript(this.wire.state, problem(this.wire.state.transcript, said, this.wire.now())),
    )
    this.wire.draw()
  }

  /** One request in front of you: the page opens at once and is filled in while it is up. */
  async open(item: string): Promise<void> {
    const row = this.rows.find((one) => one.item === item)
    this.shown = null
    this.would = null
    this.wire.put({
      ...this.wire.state,
      panel: intakePanel(item, row?.externalId ?? item),
    })
    this.wire.draw()
    await this.read(item)
  }

  /** Read the request, and then what approving it would start. Both put the page right. */
  private async read(item: string): Promise<void> {
    const home = this.wire.opts.client.home
    try {
      const opened = await openIntakeRow({
        home,
        events: this.wire.live?.events ?? [],
        item,
      })
      this.settle(item, opened, opened ? null : 'nothing has been handed over by that name')
      if (!opened) return
      const would = await intakeWouldRun(
        {
          home,
          config: this.wire.opts.config,
          // The journal itself, through its own reader: a filter answered by
          // hand over the window's held fold is a second implementation of
          // `EventFilter` that silently ignores whatever it was not written
          // for. This runs on a click rather than on a frame, so it can read.
          events: (filter) => this.wire.opts.client.log.read(filter),
        },
        opened.row,
        // Only this process can read a plan window, and it is the one reading.
        planSaid(this.wire.opts.client.planUsage(), this.wire.now()),
      )
      if (this.onItem(item)) {
        this.would = { ...would }
        this.wire.draw()
      }
    } catch (err) {
      this.settle(item, null, why(err))
    }
  }

  /** Whether the page is still on the request an answer is about. */
  private onItem(item: string): boolean {
    const panel = this.wire.state.panel
    return panel?.kind === 'intake' && panel.item === item
  }

  /**
   * The page has an answer, or the reason there is none.
   *
   * Nothing at all happens where the page has moved on: the answer is not kept
   * either, for `wire/rows.ts`' reason — kept, it would be the held answer
   * under the next request's name.
   */
  private settle(item: string, opened: InboxOpen | null, problem: string | null): void {
    if (!this.onItem(item)) return
    this.shown = opened
    const panel = this.wire.state.panel as IntakePanel
    this.wire.put({
      ...this.wire.state,
      panel: { ...panel, busy: false, ...(problem ? { problem } : {}) },
    })
    this.wire.draw()
  }

  /** One of the page's buttons, carried out. */
  private async act(panel: IntakePanel, choice: string): Promise<void> {
    const tade = this.wire.opts.client
    try {
      const acted =
        choice === 'refuse'
          ? await refuseIntake(tade, { item: panel.item, by: 'you' })
          : choice === 'retry'
            ? await retryIntake(tade, {
                item: panel.item,
                by: 'you',
                again: (row) => this.again(row),
              })
            : await approveIntake(tade, {
                item: panel.item,
                ...(choice === 'start' ? { start: true } : {}),
                by: 'you',
                // The window's own config, not the workbench's: a grant turned
                // off while this window has been open is off now, and the one
                // the workbench opened with is a minute out of date.
                config: this.wire.opts.config,
              })
      this.said(panel.item, acted.said, null)
      // Work somebody started goes in the conversation, not in a notice the
      // next notice overwrites: an act on an outside request is exactly the
      // kind of thing a person comes back to and asks about.
      this.wire.put(
        withTranscript(
          this.wire.state,
          tadeDid(this.wire.state.transcript, acted.said, this.wire.now()),
        ),
      )
      // Refolded at once: the row's state is what the person just changed.
      this.folded = -1
      this.look()
      if (choice === 'approve' || choice === 'start') this.deps.advanceQueue()
      await this.read(panel.item)
    } catch (err) {
      this.said(panel.item, null, why(err))
      this.wire.put(notice(this.wire.state, why(err)))
    }
    this.wire.draw()
  }

  /** What the page says it did, or why it could not. */
  private said(item: string, what: string | null, problem: string | null): void {
    if (!this.onItem(item)) return
    const panel = this.wire.state.panel as IntakePanel
    this.wire.put({
      ...this.wire.state,
      panel: { ...panel, busy: false, said: what, problem },
    })
  }

  /**
   * Ask the source for one request again, and put it through the one delivery
   * door — which recognises the work a failed attempt already made rather than
   * making a second copy.
   *
   * The watch's own look is what asks: a retry that went to the source some
   * other way would be a second way into intake, and there is one.
   */
  private async again(row: InboxRow): Promise<string> {
    if (!row.watch || !row.schedule) {
      throw new Error(`nothing says which watch found ${row.externalId}`)
    }
    const key = intakeKey({
      source: row.source as IntakeSource,
      externalId: row.externalId,
      revision: row.taken || row.revision,
    })
    const looked = await this.looking(row)
    const again =
      looked.found.find((one) => one.key === key) ??
      looked.found.find(
        (one) => (one.intake as IntakeCandidate | undefined)?.externalId === row.externalId,
      )
    if (!again) {
      throw new Error(
        `${row.source} no longer has ${row.externalId}: there is nothing to take in, and nothing was changed`,
      )
    }
    const agent = await looked.agent(again)
    const taken = await this.wire.opts.client.watchFound(row.schedule, again, {
      agent: { ...agent, links: agent.links ?? again.links ?? [] },
      again: true,
    })
    this.deps.advanceQueue()
    return taken.said ?? `${row.externalId} was handed over again`
  }

  /**
   * What the watch that found this request can see now, asked through the
   * watch's **own** look with the watch's own input.
   *
   * Only a window runs the extensions, so a retry has to come through here —
   * and it comes through the same `host.look` the schedule's own beat calls,
   * because a second way of asking a source would be a second way into intake
   * and there is one. `since` is null: what is being asked for is one request
   * that is already behind wherever the last look left off, and `seen` is not
   * consulted at all, because a person asking for one request again is asking
   * past the dedupe.
   */
  private async looking(row: InboxRow): Promise<Looked> {
    const host = this.wire.opts.extensions
    if (!host) throw new Error('this window runs no extensions')
    const kept = this.wire.opts.client.schedules().find((one) => one.id === row.schedule)
    return host.look(row.watch, {
      project: row.project,
      input: kept?.does.kind === 'watch' ? kept.does.input : {},
      since: null,
      turnedOn: kept?.created ?? new Date(this.wire.now()).toISOString(),
      tade: this.wire.opts.extensionWorkbench ?? null,
    })
  }

  /** The local door's grant, for the words an empty section says. */
  private cliGrant(): { on: boolean; accept: boolean } {
    const source: IntakeSource | null = intakeSourceOf('cli')
    if (!source) return { on: false, accept: false }
    const grant = intakeGrant(this.wire.opts.config, source)
    return { on: grant.on, accept: grant.accept }
  }
}
