import { uptime } from 'node:os'
import type { PlanStanding, Queued, QueueFacts, Spend, TadeEvent, Workspace } from '@tade/core'
import { overridesFrom, producedIn, writtenOrder } from '@tade/core'
import { offer, type WorkerCapabilities } from '@tade/harnesses-core'
import type { SnapshotInput, TalkIn } from '@tade/web'
import {
  type awayCollections,
  nothingKnown,
  ranOn,
  type Steering,
  steeringOf,
  type TaskExtra,
  talkIn,
} from '../away.ts'
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
// is a kept fold, and `overridesFrom`/`writtenOrder`/`ranOn`/`producedIn` are
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
): AwayBeat {
  const spend = live.spendToday()
  const overrides = overridesFrom(live.events)
  const ran = ranOn(live.events)
  // Folds over the journal the window already holds, each pure: whether an
  // agent is waiting on a question, and whether a task's document is actually
  // there. `producedIn` says `missing` rather than `written`, which is the
  // right way round — a task that names a document and has none is the case
  // worth being able to see.
  const waiting = new Set(live.tasks.filter((one) => one.waiting === true).map((one) => one.task))
  const written = new Set(
    producedIn(live.events)
      .filter((one) => !one.missing)
      .map((one) => one.task),
  )
  // **A task is finished when the journal says so**, which is the rule
  // everywhere else in Tade and is not a state: `deriveState` has no `done`.
  // The page needs it so it never offers to finish what is finished, and
  // `taskRev` carries it so a second `done` from an old screen is refused.
  const finished = new Set(
    live.events.filter((one) => one.type === 'task_done' && one.task).map((one) => one.task),
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
