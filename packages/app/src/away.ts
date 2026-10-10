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
import type { Offer } from '@tade/harnesses-core'
import type {
  Can,
  Cannot,
  ChatIn,
  ChecksIn,
  How,
  IntakeIn,
  NoteIn,
  ProjectIn,
  QueueIn,
  QueueStateIn,
  RunIn,
  SourceIn,
  TalkIn,
  TaskIn,
  WorkflowIn,
} from '@tade/web'
import { chatRev } from '@tade/web'
import type { ActionsView, NoteShown } from './frame.ts'
import type { Entry, Transcript } from './transcript.ts'

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
  /** Whether the journal already says the task is finished. */
  finished: boolean
  /** `QueueState`'s own word, or empty for work that is not queued. */
  queue: string
  /** How its agent may be told something, as its harness says. */
  steering: Steering
}

/**
 * How a task's agent may be told something, as its harness says.
 *
 * **The away view's own vocabulary and not the harness port's.** `offer()`
 * answers this question for every surface in Tade and answers it as a
 * `Support` plus a note; this is that answer mapped into the three words the
 * wire has (`HOWS`), so a harness gaining a fourth kind of support is a change
 * in `steeringOf` and not a new word on a phone.
 *
 * `how` is null for *cannot*, and then `why` is the sentence beside the
 * control the page turns off — the harness's own `why` where it wrote one,
 * and Tade's where the reason is Tade's.
 */
export interface Steering {
  how: How | null
  why: string
}

/** Nothing is running, so there is nothing to tell. */
export function notSteerable(why = 'no agent is running on it'): Steering {
  return { how: null, why }
}

/**
 * `offer()`'s answer, in the away view's three words.
 *
 * Here rather than in `@tade/web` because `offer` is the harness port's and
 * the projection may not borrow its vocabulary (R2) — and here rather than
 * in the window's wiring because it is a pure mapping and this is where the
 * pure mapping of what the window holds onto what the page sees lives.
 */
export function steeringOf(offer: Offer): Steering {
  if (!offer.shown) return notSteerable(offer.note ?? 'this harness cannot be told anything')
  switch (offer.support) {
    case 'live':
      return { how: 'now', why: '' }
    case 'idle':
      return { how: 'next-turn', why: offer.note ?? '' }
    case 'restart':
      return { how: 'restart', why: offer.note ?? '' }
    default:
      return notSteerable(offer.note ?? 'this harness cannot be told anything')
  }
}

/**
 * What may be asked of one task right now, and what may not with why.
 *
 * **Possible, never permitted.** Every answer here is about the world — a
 * harness with no way to take a message, an agent that is not running, work
 * already finished, a request that came from outside. What a *device* may do
 * is the gate's (`acts.ts`), asked again at the act against the scopes a
 * person granted at the machine and the origin the request came from. A row
 * that says `can` is still refused where the grant does not allow it, and that
 * is the right way round: the page may not draw a control nothing could carry
 * out, and it may not be the thing that decides who is allowed to press one.
 *
 * **Every verb appears in exactly one of the two lists**, which is what lets
 * the page draw a reason wherever it draws a disabled control instead of
 * leaving a hole somebody has to guess at. `test/away.test.ts` asserts that of
 * the whole of `VERBS`.
 */
export function ableOn(task: AbleFacts): { can: Can[]; cannot: Cannot[] } {
  const can: Can[] = []
  const cannot: Cannot[] = []
  const yes = (verb: string, how: How = 'now'): void => void can.push({ verb, how })
  const no = (verb: string, why: string): void => void cannot.push({ verb, why })

  // Setting work aside is always safe; picking it up again is not, for work
  // that came from outside the machine — that is approving somebody else's
  // request, which is the `intake` verb and its two re-checks (`parked.ts`'s
  // `NotYours`). So the park control is offered in one direction only there,
  // with the other verb named rather than a dead end.
  if (task.parked && task.origin === 'intake') {
    no(
      'park',
      'it came from outside this machine: approving it is its own act, with its own checks',
    )
  } else yes('park')

  if (task.approval) yes('answer')
  else no('answer', 'nothing is waiting on an answer')

  if (task.agents === 0) no('steer', notSteerable().why)
  else if (task.steering.how === null) no('steer', task.steering.why)
  else yes('steer', task.steering.how)

  if (task.queue === '') no('queue', 'it is not queued work')
  else yes('queue')

  if (task.finished) no('done', 'the journal already says it is finished')
  else yes('done')

  // A note and a context block are always possible: both are appends to files
  // Tade owns, neither needs an agent and neither can lose anything somebody
  // wrote here. What they need is the grant, which is not this question.
  yes('note')
  yes('context')

  if (task.origin !== 'intake') no('intake', 'it did not come from outside this machine')
  else if (task.finished) no('intake', 'the journal already says it is finished')
  else if (!task.parked) no('intake', 'it is not waiting to be approved')
  else yes('intake')

  return { can, cannot }
}

/** What `ableOn` reads. Named, so a test can build one without a `Task`. */
export interface AbleFacts {
  parked: boolean
  origin: string
  approval: boolean
  agents: number
  finished: boolean
  queue: string
  steering: Steering
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
    finished: extra.finished,
    queue: extra.queue,
    // What is *possible*, which is a question about a harness and a lane and
    // so one only the window can answer. Permission is asked again at the act.
    ...ableOn({
      parked: task.parked === true,
      origin: taskOrigin(task.by).kind,
      approval: extra.approval !== null,
      agents: task.agents.length,
      finished: extra.finished,
      queue: extra.queue,
      steering: extra.steering,
    }),
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
  /**
   * The factory floor, already projected by the slices that hold it.
   *
   * **Already projected, unlike everything else here**, and that is the one
   * asymmetry in this file worth explaining. Every collection above is built
   * out of a `Workspace` this function is handed, field by field, because the
   * domain value it comes from carries paths. These four come from folds the
   * window keeps for its own drawing — the inbox (`wire/intake.ts`) and the
   * runs (`wire/web-beat.ts`) — and are mapped field by field *there*, by
   * `away-factory.ts`, which is this file's rule applied in the place that
   * holds the fold. Folding them again here would mean reading a task file per
   * request on the beat the window draws on.
   */
  intake: readonly IntakeIn[]
  sources: readonly SourceIn[]
  runs: readonly RunIn[]
  workflows: readonly WorkflowIn[]
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
  intake: readonly IntakeIn[]
  sources: readonly SourceIn[]
  runs: readonly RunIn[]
  workflows: readonly WorkflowIn[]
  warnings: readonly string[]
  machineUpSince: number | null
  spendSince: number | null
}

// **The conversation is deliberately not among them.** Everything above is a
// fold of the *world* — what `Live` last looked at, on the clock it looks on —
// and the conversation is the window's own, true the moment it is read. So
// `talkIn` is called by whoever holds it (`wire/web-beat.ts`'s `talkFor`) and
// laid over these, and `AwayHeld` is what the two make together. Folding it in
// here would mean a `null` conversation for as long as `Live` has not looked
// once, which a page reads as *talking is not turned on*.

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
  // Folded once here rather than carried per task, so the word on a task row
  // and the state on its queue row are the same reading of the same facts.
  const words = queueWords(parts.queued, parts.queueFacts)
  for (const project of parts.world.projects) {
    for (const task of project.tasks) {
      const extra = parts.extras.get(task.id) ?? nothingKnown()
      tasks.push(
        taskIn(
          task,
          { ...extra, queue: words.get(task.id) ?? '' },
          parts.pending.get(task.id) ?? 0,
        ),
      )
    }
  }
  return {
    projects: parts.world.projects.map((project) => projectIn(project, parts.titles)),
    tasks,
    queue: queueIn(parts.queued, parts.queueFacts, parts.order),
    findings: [],
    notes: noteIn(parts.notes),
    plans: parts.plans,
    // Carried as they were handed over. Nothing is narrowed here: a device's
    // read scope is the projection's to apply (`snapshotOf`), and applying it
    // twice in two places is how a rule comes to be half-applied.
    intake: parts.intake,
    sources: parts.sources,
    runs: parts.runs,
    workflows: parts.workflows,
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

/**
 * The conversation, as a device may read it.
 *
 * **One line per entry, and `kind` is about who is speaking rather than how it
 * should look.** The window draws a routed line, a suggestion and a note
 * differently because it has the room; a phone does not, and a page that chose
 * a shape from a guess would be a second reading of the same entries. So the
 * five kinds are *asked*, *reply*, *tool*, *tade* (Tade's own words, whatever
 * prompted them) and *problem*, and `glyphs.js` has one rule for each.
 *
 * **What is left out is the point.** A tool entry's `detail` is the call's own
 * arguments — a command, a path, a prompt — and its `result` is what the tool
 * answered; neither crosses. The tool's **name** does, which is what Phase 3
 * promised and what a person on a phone can actually act on.
 */
export function talkIn(from: { transcript: Transcript; busy: boolean; whose: string }): TalkIn {
  const lines = chatLines(from.transcript)
  return {
    lines,
    // Built from the same two facts the window re-checks at the moment it
    // hands a message over, through the same function the device echoes back.
    rev: chatRev({ busy: from.busy }),
    busy: from.busy,
    whose: from.whose,
    // Raised per device by whoever knows that device's scopes. Never here.
    mine: false,
  }
}

/**
 * Every entry as a line, with an id that is stable while the conversation
 * grows and loses its front.
 *
 * `<the moment, ISO>#<n>` — the shape a note's id already has, and for the
 * same two reasons. It sorts in the order things were said, which matters
 * because a delta is a shallow merge keyed by it and the page draws them in id
 * order; and it does not move when an old entry falls off the top, which an
 * index would. `n` tells apart two entries in the same millisecond, counted
 * over the whole list so that dropping one from the front changes nobody's id.
 */
export function chatLines(transcript: Transcript): ChatIn[] {
  const seen = new Map<number, number>()
  const out: ChatIn[] = []
  for (const entry of transcript.entries) {
    const n = seen.get(entry.at) ?? 0
    seen.set(entry.at, n + 1)
    out.push({ ...chatLine(entry), id: `${new Date(entry.at).toISOString()}#${n}`, at: entry.at })
  }
  return out
}

/** One entry's own fields, without its id. */
function chatLine(entry: Entry): Omit<ChatIn, 'id' | 'at'> {
  const plain = { from: '', tool: '', outcome: '' as const, streaming: false }
  switch (entry.kind) {
    case 'you':
      return { ...plain, kind: 'asked', from: entry.from, text: entry.text }
    case 'said':
      return {
        ...plain,
        // The model's words and Tade's own are different lines, because what
        // somebody may believe of them is different: one is a reply, the other
        // is Tade stating something.
        kind: entry.by === 'orchestrator' ? 'reply' : 'tade',
        text: entry.text,
        streaming: entry.streaming,
      }
    case 'tool':
      return {
        ...plain,
        kind: 'tool',
        // The name, and **never** `detail` (the call's arguments) or `result`
        // (what it answered). `NEVER_A_FIELD` forbids both by name.
        tool: entry.tool,
        text: '',
        outcome: entry.state,
      }
    case 'problem':
      return { ...plain, kind: 'problem', text: entry.text }
    // Tade's own lines: where its grammar sent something, what it did, and
    // something it offered to ask. All three are Tade stating a fact, and a
    // phone has room for the fact and not for three shapes of it.
    default:
      return { ...plain, kind: 'tade', text: entry.text }
  }
}

/**
 * Where each queued task stands, in the queue's own one word.
 *
 * The *word* and nothing else: the queue collection carries the whole of each
 * state with its sentence and its counts, and what this is for is `taskRev` —
 * so a queue choice made from a screen drawn while the work was waiting on
 * something else is refused as a choice about a different world. One fold, so
 * the row and the queue row cannot disagree about which state it is in.
 */
export function queueWords(items: readonly Queued[], facts: QueueFacts): Map<string, string> {
  const out = new Map<string, string>()
  for (const item of items) out.set(item.task, queueStateOf(item, facts).kind)
  return out
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
    finished: false,
    queue: '',
    // **Nothing known is nothing offered**, which is the direction that has to
    // be right: a task the window has learned nothing about must not draw a
    // steer control on the strength of a default.
    steering: notSteerable('nothing here knows what its harness can do'),
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
