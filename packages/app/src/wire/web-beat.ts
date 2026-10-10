import { uptime } from 'node:os'
import type { PlanStanding, Queued, QueueFacts, Spend, TadeEvent, Workspace } from '@tade/core'
import { documentsIn, overridesFrom, writtenOrder } from '@tade/core'
import { offer, type WorkerCapabilities } from '@tade/harnesses-core'
import type { IntakeIn, SnapshotInput, SourceIn, TalkIn, WorkflowIn } from '@tade/web'
import {
  type awayCollections,
  nothingKnown,
  ranOn,
  type Steering,
  steeringOf,
  type TaskExtra,
  talkIn,
} from '../away.ts'
import { type RunTask, runsIn } from '../away-factory.ts'
import type { ActionsView, NoteShown } from '../frame.ts'
import type { Transcript } from '../transcript.ts'

// What the window hands the away view on a beat, and what it reads to build it.
//
// **Out of `web.ts` because it is a different subject.** That file is the
// listener's lifetime, the pairing panel and the beat; this is the one
// function that turns what `Live` holds into the collections the projection is
// built from, plus the two interfaces that say exactly what of `Live` it is
// allowed to read. Keeping them apart is what lets the second be read as a
// list of accessors instead of against a thousand-line class.
//
// Nothing here starts work. Every value is one the window already has for its
// own drawing — `seenActions` is the last look and never a look, `spendToday`
// is a kept fold, and `overridesFrom`/`writtenOrder`/`ranOn`/`documentsIn` are
// folds over the journal it already holds. **No `git`, no `ps`, no
// `collectStatus`**: a page refresh starts nothing at all
// (`test/wire/away.test.ts` asserts it as a count of calls).

/** What the window hands the away view on a beat. */
export type AwayBeat = Parameters<typeof awayCollections>[0]

/** Everything a projection needs but the device it is for and the lifetime. */
export type AwayHeld = Omit<SnapshotInput, 'reach' | 'lifetime'>

/**
 * How a task's agent may be told something, as its harness says.
 *
 * `offer()` is the one rule every surface in Tade asks — the window's own
 * controls, the orchestrator's tools and voice all go through it — and this
 * is the away view asking it too, so no surface offers what another hides.
 * Nothing is running on the task is a *different* answer from the harness
 * having no way to take a message, and both are refusals with a sentence.
 *
 * **Which harness is read out of the run**, never guessed from a model or a
 * route: a `WorkerHandle` carries the harness its agent actually started on.
 */
export function steeringFor(client: Harnessed, task: string): Steering {
  const run = client.runs().find((one) => one.task === task)
  if (run === undefined) return { how: null, why: 'no agent is running on it' }
  const harness = run.harness ?? ''
  const capabilities = harness === '' ? null : client.capabilitiesOf(harness)
  if (capabilities === null) {
    return { how: null, why: `nothing here knows what ${harness || 'its harness'} can do` }
  }
  return steeringOf(offer(capabilities, 'steer', capabilities.steer))
}

/** What `steeringFor` reads of the workbench. Two accessors, both held values. */
export interface Harnessed {
  /**
   * The runs there are. `harness` is optional because a `WorkerHandle` can be
   * one picked up from a window that has since closed, whose harness nothing
   * recorded — and that is `unknown`, which is a refusal with a sentence
   * rather than a default that offers a control.
   */
  runs(): readonly { task: string; harness?: string }[]
  capabilitiesOf(harness: string): WorkerCapabilities | null
}

/** When the machine came up, or null where nothing could say. */
export function upSinceOf(): number | null {
  try {
    const seconds = uptime()
    return Number.isFinite(seconds) && seconds > 0 ? Date.now() - seconds * 1000 : null
  } catch {
    // `unknown`, and never nought: a page drawing "up for 0s" because nothing
    // answered is the one lie that would make the whole panel worthless.
    return null
  }
}

/**
 * The conversation, as the projection takes it — or null where talking from
 * away is off.
 *
 * **Here because it is not part of the world**, which is the bug it fixes: the
 * collections are `nothingYet()` until `Live` has looked once, and a `null`
 * conversation there would tell a phone *talking is not turned on* for the
 * first second of every window. The world and the conversation go stale on
 * different clocks, so they are read in different places.
 */
export function talkFor(
  transcript: Transcript,
  talk: { busy(): boolean; whose(): string },
  on: boolean,
): TalkIn | null {
  if (!on) return null
  return talkIn({ transcript, busy: talk.busy(), whose: talk.whose() })
}

/** Nothing projected yet: an away view that has had no beat still answers. */
export function nothingYet(): AwayHeld {
  return {
    projects: [],
    tasks: [],
    queue: [],
    findings: [],
    notes: [],
    plans: [],
    // The factory floor, empty for the same reason the rest is: nothing has
    // been looked at yet. Each collection reports its own real count of
    // nought, which the page draws as *nothing read yet* out of the freshness
    // rather than as *no source is turned on*.
    intake: [],
    sources: [],
    runs: [],
    workflows: [],
    warnings: [],
    machineUpSince: null,
    // Nothing folded yet, so there is no period to name: `unknown`, which the
    // page says by saying nothing rather than by naming a date in 1970.
    spendSince: null,
    // Overlaid by whoever holds the conversation (`talkFor`): it is not part
    // of the world, so it is not this function's to answer.
    talk: null,
  }
}

/**
 * The beat's own parts, built out of what `Live` holds.
 *
 * Here rather than in `app.ts` so the window's wiring stays wiring, and out of
 * held values only: `seenActions` is the last look and never a look,
 * `spendToday` is a kept fold, and `overridesFrom`/`orderFrom`/`ranOn` are
 * folds over the journal the window already has. **No `git`, no `ps`, no
 * `collectStatus`** — a page refresh starts no work at all.
 */
export function beatParts(
  live: Beatable,
  world: Workspace,
  steering: (task: string) => Steering,
  /**
   * The factory floor as the inbox subject already folded it.
   *
   * **Handed in rather than folded here**, for the reason the conversation is:
   * the inbox is a fold of the journal *and the task files*, refolded when a
   * line that could change it is written rather than on every frame, and the
   * subject that owns that fold is the one that draws the window's own INTAKE
   * section. A second fold here would read a task file per request per beat,
   * which is exactly the poll this window does not do.
   */
  factory: FactoryHeld = nothingHandedOver(),
): AwayBeat {
  const spend = live.spendToday()
  const overrides = overridesFrom(live.events)
  const ran = ranOn(live.events)
  // Folds over the journal the window already holds, each pure: whether an
  // agent is waiting on a question, and whether a task's document is actually
  // there. The state and not the triage — a document somebody has already
  // decided about is still a document that exists, and the phone is saying
  // whether there is one to read, never whether anybody has read it.
  const waiting = new Set(live.tasks.filter((one) => one.waiting === true).map((one) => one.task))
  const written = new Set(
    documentsIn(live.events)
      .filter((one) => one.state === 'written')
      .map((one) => one.task),
  )
  // **A task is finished when the journal says so**, which is the rule
  // everywhere else in Tade and is not a state: `deriveState` has no `done`.
  // The page needs it so it never offers to finish what is finished, and
  // `taskRev` carries it so a second `done` from an old screen is refused.
  const finished = new Set(
    live.events.flatMap((one) => (one.type === 'task_done' && one.task ? [one.task] : [])),
  )
  const extras = new Map<string, TaskExtra>()
  const pending = new Map<string, number>()
  for (const approval of live.pending) {
    pending.set(approval.task, (pending.get(approval.task) ?? 0) + 1)
  }
  for (const project of world.projects) {
    for (const task of project.tasks) {
      const approval = live.pending.find((one) => one.task === task.id) ?? null
      extras.set(task.id, {
        ...nothingKnown(),
        work: live.seenActions(task.id),
        overridden: overrides.some((one) => one.task === task.id),
        spend: spend.byTask[task.id] ?? null,
        ran: ran.get(task.id) ?? nothingKnown().ran,
        question: waiting.has(task.id),
        approval:
          approval === null
            ? null
            : // The tool's **name** and nothing else. The harness's one-line
              // summary of the call is the command with its paths in it, and
              // answering an approval from away is a later slice's — which
              // gets to decide what a person is shown before they say yes.
              { id: approval.requestId, tool: approval.tool, sinceAt: approval.at },
        produced: written.has(task.id),
        finished: finished.has(task.id),
        // Asked of the harness the run actually started on, through `offer()`
        // — the same rule the window's own controls and the orchestrator's
        // tools ask, so no surface offers what another hides.
        steering: steering(task.id),
      })
    }
  }
  return {
    world,
    titles: live.titles,
    extras,
    pending,
    intake: factory.intake,
    sources: factory.sources,
    workflows: factory.workflows,
    // **The runs are folded here and the provenance is handed in**, because
    // the two halves come from different places: which tasks name one effort
    // is the world's answer (`world.projects[].tasks`, with `start.after` for
    // the edges), and which request a run came from is the inbox's. Neither
    // half starts anything: both are values this beat already has.
    runs: runsIn(
      runTasks(world, { finished, starts: startsOf(live.events), checks: live, spend }),
      factory.runFrom,
    ),
    queued: live.queued,
    queueFacts: live.queueFacts(),
    order: writtenOrder(live.events),
    notes: live.notes(null),
    plans: live.plans,
    machineUpSince: live.machineUpSince,
    spendSince: live.spendSince,
  }
}

/**
 * What `Away` reads of `Live`: held values, every one of them.
 *
 * Named rather than taking `Live` itself, so the one place that decides what
 * leaves the machine can be read against a list of nine accessors instead of
 * against a thousand-line class — and so a tenth cannot arrive by accident.
 */
export interface Held {
  events: readonly TadeEvent[]
  pending: readonly { requestId: string; task: string; tool: string; at: number }[]
  world: Workspace | null
  seenActions(task: string): ActionsView | null
  spendToday(): { byTask: Record<string, Spend> }
  queued: readonly Queued[]
  queueFacts(): QueueFacts
  notes(project: string | null): readonly NoteShown[]
  tasks: readonly { task: string; waiting?: boolean }[]
}

/** What `beatParts` needs, so it can be tested without a window. */
export interface Beatable {
  events: readonly TadeEvent[]
  pending: readonly { requestId: string; task: string; tool: string; at: number }[]
  seenActions(task: string): ActionsView | null
  spendToday(): { byTask: Record<string, Spend> }
  queued: readonly Queued[]
  queueFacts(): QueueFacts
  notes(project: string | null): readonly NoteShown[]
  plans: readonly PlanStanding[]
  titles: Readonly<Record<string, string>>
  /** The task snapshots the window already drew, for `waiting`. */
  tasks: readonly { task: string; waiting?: boolean }[]
  machineUpSince: number | null
  /** When `spendToday`'s fold starts, which is the period every figure covers. */
  spendSince: number | null
}

/**
 * The factory floor as the inbox subject hands it over.
 *
 * Three already-projected collections and one map. The map is the half the
 * runs fold cannot answer: which request an effort came from, and which
 * published version it was stamped from.
 */
export interface FactoryHeld {
  intake: readonly IntakeIn[]
  sources: readonly SourceIn[]
  workflows: readonly WorkflowIn[]
  /** Effort → the request it came from. Empty for a run nobody asked for from outside. */
  runFrom: ReadonlyMap<string, RunFrom>
}

/** Where one run came from, as the inbox knows it. */
export interface RunFrom {
  item: string
  source: string
  stamp: { name: string; version: number } | null
  /** How many times carrying the request out failed before the run existed. */
  retries: number
}

/** Nothing handed over yet: a window with no inbox fold still answers. */
export function nothingHandedOver(): FactoryHeld {
  return { intake: [], sources: [], workflows: [], runFrom: new Map() }
}

/**
 * How many agents have been started on each task, out of `run_started`.
 *
 * **Two is a retry, and that is the whole of the retry history a step has.**
 * There is no counter anywhere and there must not be one: the journal already
 * says every time an agent started, and a tally kept beside it would be a
 * second answer that goes wrong the first time somebody compacts the log — at
 * which point the honest answer is "as many as the journal still remembers",
 * which is what a fold says and a counter would hide.
 */
export function startsOf(events: readonly TadeEvent[]): Map<string, number> {
  const starts = new Map<string, number>()
  for (const event of events) {
    if (event.type !== 'run_started' || !event.task) continue
    starts.set(event.task, (starts.get(event.task) ?? 0) + 1)
  }
  return starts
}

/**
 * Every task that names an effort, at the narrowness `runsIn` asks for.
 *
 * The one thing worth saying about it: **`after` comes off the task file and
 * not off the queue**. `live.queued` holds work that has not started, so a run
 * read from there would lose an edge the moment a step began — and a graph
 * whose arrows disappear as the work progresses is worse than no graph. A
 * `Task` carries `start` whether or not it is still queued.
 */
export function runTasks(
  world: Workspace,
  facts: {
    finished: ReadonlySet<string>
    starts: ReadonlyMap<string, number>
    checks: { seenActions(task: string): ActionsView | null }
    spend: { byTask: Record<string, Spend> }
  },
): RunTask[] {
  const tasks: RunTask[] = []
  for (const project of world.projects) {
    for (const task of project.tasks) {
      if (!task.effort) continue
      const money = facts.spend.byTask[task.id] ?? null
      tasks.push({
        id: task.id,
        project: task.project,
        effort: task.effort,
        state: task.state,
        after: (task.start?.after ?? []).map((one) => ({ task: one.task, why: one.why ?? '' })),
        parked: task.parked === true,
        // The journal's answer, and `merged` with it: there is nothing left for
        // anybody to do with a branch that has landed (`effortsIn`'s own rule).
        finished: facts.finished.has(task.id) || task.state === 'merged',
        runs: facts.starts.get(task.id) ?? 0,
        // An agent is on it *now*, which is what makes it the active step — and
        // it is a count of signals rather than a state, because `working` is
        // `deriveState`'s word and covers a task whose agent has gone quiet.
        active: task.agents.length > 0,
        checks: facts.checks.seenActions(task.id)?.rollup ?? 'unknown',
        review: task.git?.pr?.state ?? null,
        // Nought where nothing was recorded is the projection's to decide, not
        // this file's: `null` here means *this window folded no money for it*.
        usd: money === null ? null : money.usd,
      })
    }
  }
  return tasks
}
