import {
  type Finished,
  modelIn,
  type PlanStanding,
  type Project,
  type Queued,
  type QueueFacts,
  type QueueState,
  queueStateOf,
  type Reality,
  runFactsOf,
  type Spend,
  type TadeEvent,
  type Task,
  type TaskOrigin,
  taskOrigin,
  UNRECORDED,
  type Workspace,
} from '@tade/core'
import type { ChecksIn, NoteIn, ProjectIn, QueueIn, QueueStateIn, TaskIn } from '@tade/web'
import type { ActionsView, NoteShown } from './frame.ts'

// What the away view is handed, built out of what the window already holds.
//
// **Pure**: `Workspace` in, `SnapshotInput`'s collections out, with the moment
// and the folds passed as arguments. No `node:`, no clock, nothing to await —
// the same rule the window's other pure files are held to, and here it buys
// something specific: the one function that decides what may leave the machine
// can be tested exhaustively against a fixture, without a listener, a socket
// or a browser.
//
// **Nothing is spread.** Every field is written out, because `Workspace`
// carries `project.root` and `task.worktree` — both absolute paths — and
// `Task.agents` carries pids and transcript paths. A projection built by
// taking one of those and leaving things out is only ever as good as the
// leaving-out, and the field somebody adds to `Task` next month arrives on a
// phone by default with nobody having decided it. `@tade/web`'s `input.ts` has
// the argument; this is the side of the boundary that honours it.
//
// **The window never starts work to answer a page.** Everything here is a
// value the window already has for its own drawing: `seenActions` is what the
// last look said and never a look, and a task nobody has looked at reads
// `unknown` — which is first-class and is the honest answer, rather than
// `pass` by omission. The route that warms that cache is the task detail, and
// it belongs to the slice that draws one.

/** What only the window can say about one task, beside what status said. */
export interface TaskExtra {
  /** What the last look at its checks said. Null where nothing has looked. */
  work: ActionsView | null
  /** Whether a red run at its head was overruled. */
  overridden: boolean
  /** The fold of what it spent, or null for nothing recorded. */
  spend: Spend | null
  /** The harness, the model and the sign-in its last run was on. */
  ran: RanOn
  /** Whether its agent asked something and is waiting. */
  question: boolean
  /** The approval waiting, by the tool's **name** and nothing else. */
  approval: { id: string; tool: string; sinceAt: number } | null
  /** Whether the document it produces has been written. */
  produced: boolean
}

/** What a run was on, as the journal recorded it. Never guessed from a name. */
export interface RanOn {
  harness: string
  model: string
  account: string
}

export function nothingRecorded(): RanOn {
  return { harness: '', model: '', account: '' }
}

/**
 * What each task last ran on, folded out of `run_started`.
 *
 * **Read out of the journal and never out of a model's name or a route's
 * wish**: the provider is the harness's declared answer (`runFactsOf`), and a
 * route is a wish. `UNRECORDED` becomes the empty string, which is how the
 * projection spells *nobody said* — `@tade/web` turns that into `null` and the
 * page draws an em dash.
 */
export function ranOn(events: readonly TadeEvent[]): Map<string, RanOn> {
  const out = new Map<string, RanOn>()
  for (const event of events) {
    if (event.type !== 'run_started' || !event.task) continue
    const facts = runFactsOf(event)
    out.set(event.task, {
      harness: said(facts.harness),
      model: said(modelIn(event).name),
      account: said(facts.account ?? ''),
    })
  }
  return out
}

/** One project, once its root is not in it. */
export function projectIn(project: Project, titles: Readonly<Record<string, string>>): ProjectIn {
  // `root` is deliberately not read at all, rather than read and dropped.
  return { name: project.name, title: titles[project.name] ?? '' }
}

/**
 * One task, field by field.
 *
 * The two that are not a straight copy are worth the words.
 *
 * **`reason`.** A task blocked on an approval arrives as `{kind:'approval'}`
 * and never as `deriveState`'s clause, because that clause holds the harness's
 * one-line summary of the call — `Bash: <the whole command>`, a raw tool
 * payload with a machine path in it, and the commonest reason a task is
 * blocked. Handing the string through is the leak with one more step in it.
 *
 * **`movedAt` is a moment, never an age.** An elapsed figure changes on every
 * beat, so every row would differ from the last beat's and a tick of the clock
 * would resend the whole tree to every connected phone (`delta.ts`).
 */
export function taskIn(task: Task, extra: TaskExtra, pending: number): TaskIn {
  const git = task.git
  const workspace = task.workspace === 'worktree' ? 'worktree' : 'checkout'
  return {
    id: task.id,
    project: task.project,
    state: task.state,
    reason:
      extra.approval === null
        ? { kind: 'clause', said: task.reason }
        : { kind: 'approval', tool: extra.approval.tool, also: Math.max(0, pending - 1) },
    stalled: task.stalled,
    // The **told** fact out of the task file, never `state === 'parked'`: a
    // merge is ahead of a park in `deriveState`, so a parked task whose branch
    // landed reads `merged` and the park would be invisible. The queue reads it
    // the same way and for the same reason (`live.ts`).
    parked: task.parked === true,
    createdAt: moment(task.created) ?? 0,
    movedAt: movedAt(task),
    title: task.title ?? '',
    intent: task.intent_spoken,
    branch: task.branch,
    ahead: git?.ahead ?? null,
    behind: git?.behind ?? null,
    // A count, never the names: nobody taps a repository path on a phone, and
    // a path is the one thing the projection adds none of.
    dirty: git === null ? null : git.dirty.length,
    workspace,
    // Its tree is shared with every other agent in the project, so which of
    // the changed files are its own cannot be told — which the page says,
    // rather than counting somebody else's work as this agent's.
    shared: workspace === 'checkout',
    effort: task.effort ?? '',
    done: task.done ?? null,
    produces: task.produces === undefined ? null : { name: task.produces, written: extra.produced },
    harness: extra.ran.harness,
    model: extra.ran.model,
    account: extra.ran.account,
    origin: originIn(taskOrigin(task.by)),
    // Counts. Never a pid, never a session id, never a transcript path — and
    // `task.agents` is the field that carries all three.
    agents: task.agents.length,
    lanes: task.lanes.length,
    question: extra.question,
    approval: extra.approval,
    spend: extra.spend ?? noSpendAt(),
    checks: checksIn(extra.work, extra.overridden),
    review: git?.pr ?? null,
  }
}

/**
 * The rollup at a task's head, as the last look said.
 *
 * `unknown` wherever nothing has looked, and that is the whole point: a check
 * nobody ran is not a check that passed, and the away view may not start a
 * look to find out. `failed` and `missing` are named so a phone can say which,
 * and a check that was queued, running, skipped or cancelled is **missing**
 * rather than fine — that is the bug that draws a red thing green.
 */
export function checksIn(work: ActionsView | null, overridden: boolean): ChecksIn {
  if (work === null) {
    return { state: 'unknown', failed: [], missing: [], overridden }
  }
  const required = work.checks.filter((check) => check.required)
  const failed = required
    .filter((check) => check.state === 'failed' || check.state === 'timed out')
    .map((check) => check.id)
  const missing = required
    .filter(
      (check) =>
        check.state !== 'passed' && check.state !== 'failed' && check.state !== 'timed out',
    )
    .map((check) => check.id)
  return { state: work.rollup, failed, missing, overridden }
}

/** Who asked for the work, in `taskOrigin`'s own words. */
export function originIn(origin: TaskOrigin): TaskIn['origin'] {
  return { kind: origin.kind, name: origin.name }
}

/**
 * Queued work, with the list of changed files turned into a count.
 *
 * `QueueState` carries `changed`: the repository paths work going on now has
 * touched. Nobody taps one of those on a phone, so what crosses the boundary
 * is **how many**, and the names stay at the machine. `because` is `holdSaid`'s
 * own sentence, which is Tade's words.
 */
export function queueIn(
  items: readonly Queued[],
  facts: QueueFacts,
  order: readonly string[] = [],
): QueueIn[] {
  return items.map((item) => {
    const at = order.indexOf(item.task)
    return {
      task: item.task,
      project: item.project,
      state: queueStateIn(queueStateOf(item, facts)),
      // Where in the written preference this task is, or null for one nobody
      // put anywhere. **A preference among the ready and never a rule**: the
      // window starts work by `readyToStart`, and an order is only ever a
      // tie-break inside it.
      order: at === -1 ? null : at,
      waitsOn: (item.start.after ?? []).map((one) => ({ task: one.task, why: one.why ?? '' })),
    }
  })
}

function queueStateIn(state: QueueState): QueueStateIn {
  switch (state.kind) {
    case 'waiting':
      return { kind: 'waiting', on: [...state.on] }
    case 'held':
      return {
        kind: 'held',
        on: state.on,
        because: state.because,
        changed: state.changed === undefined ? null : state.changed.length,
        by: [...(state.by ?? [])],
      }
    case 'scheduled':
      return { kind: 'scheduled', at: state.at }
    case 'paused':
      return { kind: 'paused', all: state.all, parked: state.parked === true }
    default:
      return { kind: 'ready' }
  }
}

/**
 * The notes, verbatim.
 *
 * **Never reworded, never lowercased, never summarised**, and a `summary` is
 * only ever one somebody wrote beside the note — never a reading of its text.
 * They are not scrubbed either: a note that says *the fix is in
 * /Users/me/thing.ts* goes out as it was written, which is the claim
 * `@tade/web`'s `input.ts` makes and no stronger one.
 */
export function noteIn(notes: readonly NoteShown[]): NoteIn[] {
  return notes.map((note) => ({
    text: note.text,
    summary: note.summary ?? '',
    scope: note.scope ?? null,
    by: note.by ?? '',
    at: note.at,
  }))
}

/** What the window hands the away view on a beat, minus the device's reach. */
export interface AwayParts {
  world: Workspace
  titles: Readonly<Record<string, string>>
  extras: ReadonlyMap<string, TaskExtra>
  /** How many approvals are waiting, per task, for the `(+n more)` clause. */
  pending: ReadonlyMap<string, number>
  queued: readonly Queued[]
  queueFacts: QueueFacts
  /** The order last written for the ready work, as `orderFrom` reads it. */
  order: readonly string[]
  notes: readonly NoteShown[]
  plans: readonly PlanStanding[]
  machineUpSince: number | null
  /** The moment `TaskExtra.spend` is folded from. The window's own midnight. */
  spendSince: number | null
}

/** Every collection one projection is built from, as one value. */
export interface AwayCollections {
  projects: ProjectIn[]
  tasks: TaskIn[]
  queue: QueueIn[]
  /**
   * Always empty here, and that is a decision rather than a gap.
   *
   * A finding is a judge's reading of one agent's change, and what the window
   * holds about one lives in the `jev` extension rather than in `Live` — so
   * carrying it would mean the away view asking an extension on the thread the
   * window draws on. The collection is on the wire with its real count of
   * nought, which is the honest shape: the page says *no findings* because
   * none were handed over, and the slice that hands them over is the one with
   * the extension's own list to hand.
   */
  findings: readonly never[]
  notes: NoteIn[]
  plans: readonly PlanStanding[]
  warnings: readonly string[]
  machineUpSince: number | null
  spendSince: number | null
}

/**
 * The whole input, built once per beat and shared by every device.
 *
 * Once and not once per device: the collections are the same for everybody and
 * the *reach* is what differs, so the projector narrows them per device
 * (`readingFor`). Building per device instead would be four projections' worth
 * of work on the thread the window draws on.
 *
 * **`findings` is deliberately empty here.** A finding is a judge's reading of
 * one agent's change, and what the window holds about one lives in the `jev`
 * extension rather than in `Live` — so carrying it would mean the away view
 * asking an extension on the drawing thread. The collection exists on the wire
 * with its real count of nought, which is the honest shape: the page says
 * *no findings* because none were handed over, and the slice that hands them
 * over is the one that has the extension's own list to hand.
 */
export function awayCollections(parts: AwayParts): AwayCollections {
  const tasks: TaskIn[] = []
  for (const project of parts.world.projects) {
    for (const task of project.tasks) {
      const extra = parts.extras.get(task.id) ?? nothingKnown()
      tasks.push(taskIn(task, extra, parts.pending.get(task.id) ?? 0))
    }
  }
  return {
    projects: parts.world.projects.map((project) => projectIn(project, parts.titles)),
    tasks,
    queue: queueIn(parts.queued, parts.queueFacts, parts.order),
    findings: [],
    notes: noteIn(parts.notes),
    plans: parts.plans,
    // Status's own words, handed over as it wrote them — and **they are not
    // all path-free**: `collectStatus` writes a project's own checkout into a
    // warning when git will not answer there. They are the one metadata field
    // this side does not compose, so the projection keeps the claim at its own
    // boundary (`withoutPaths`, `@tade/web`'s `fields.ts`) rather than here,
    // where it would have to be done again for every future producer.
    warnings: parts.world.warnings,
    machineUpSince: parts.machineUpSince,
    // The period every money figure here covers, handed over rather than
    // described: the window folds from its own midnight, and the phone is
    // somewhere else.
    spendSince: parts.spendSince,
  }
}

/** What is true of a task the window has learned nothing extra about. */
export function nothingKnown(): TaskExtra {
  return {
    work: null,
    overridden: false,
    spend: null,
    ran: nothingRecorded(),
    question: false,
    approval: null,
    produced: false,
  }
}

/** The facts the queue's own rule needs, as the window has them. */
export interface QueueParts {
  tasks: ReadonlyMap<string, { state: Task['state']; reason: string }>
  finished: ReadonlyMap<string, Finished>
  events: readonly TadeEvent[]
  reality?: ReadonlyMap<string, Reality>
  now: number
}

/** `UNRECORDED` and nothing said are one answer on the wire: the empty string. */
function said(value: string): string {
  return value === UNRECORDED ? '' : value
}

/**
 * The last time anything about this task was seen to move.
 *
 * The newest of what git saw and what an agent last did, because either one
 * alone is wrong in a way somebody notices: a task whose agent has been
 * thinking for ten minutes has an old commit, and a task somebody committed to
 * by hand has no agent at all.
 */
function movedAt(task: Task): number | null {
  const moments = [task.git?.headTime ?? null, ...task.agents.map((one) => one.lastActivityAt)]
  const known = moments.filter((at): at is number => at !== null && Number.isFinite(at))
  return known.length === 0 ? null : Math.max(...known)
}

/** An ISO string as a moment, or null for one that is not a date. */
function moment(said: string): number | null {
  const at = Date.parse(said)
  return Number.isFinite(at) ? at : null
}

/**
 * Nought of everything, rather than no `spend` field.
 *
 * `TaskIn.spend` is required because *nothing recorded* and *nothing spent*
 * are told apart by `hasCost` rather than by the field's absence — a `null`
 * here would reach the page as a missing figure, which the page would draw as
 * `$0.00`, which is the one lie this whole projection is written to avoid.
 */
function noSpendAt(): Spend {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokens: 0,
    usd: 0,
    usdExact: 0,
    usdEstimated: 0,
    usdListed: 0,
    usdOnPlan: 0,
    tokensUnpriced: 0,
    tokensOnPlanUnrated: 0,
    hasCost: false,
  }
}
