import { DONE_RULES, ReviewState, TaskState } from '@tade/core'
import { z } from 'zod'
import { GRANTS } from './reach.ts'

// What goes on the wire, declared as an allow-list. Nothing is inherited.
//
// Every object here is a `z.strictObject`, which is the third leg of the
// leakage guarantee and the only one that scales: a regex over a fixture is a
// sample, a hand-written input type (`input.ts`) is the discipline, and a
// strict parse is what turns a field somebody spread in by accident into a
// failure instead of a passenger.
//
// **Versioned, and the version is on every frame.** A snapshot and a delta each
// carry `v`. A client that is served a version it does not know has one correct
// move — say so and stop — and it cannot make that move if it has to guess from
// the shape. The number goes up when a field changes meaning or goes away;
// adding a field does not need it, because a client reads the fields it knows.
//
// **Zod is the schema and the test, not a per-request cost.** The server parses
// every *input*. It parses its own *output* in tests, where a 60 KiB snapshot
// validated twice a second is free and a field that should not be there is a
// failure somebody reads.

/** The wire version. On every snapshot and every delta. */
export const PROTOCOL_VERSION = 1

/**
 * A piece of free text somebody wrote, as much of it as the budget allowed.
 *
 * `more` and not an ellipsis: three dots written into the text cannot be told
 * from three dots the person typed, and the house rule about a note is that it
 * is never reworded. See `page.ts`.
 */
export const SaidSchema = z.strictObject({
  /** As much of what was said as the budget allowed. */
  words: z.string(),
  more: z.boolean(),
})
export type Said = z.infer<typeof SaidSchema>

/**
 * How fresh this is, and whose server lifetime it belongs to.
 *
 * `machineUpSince` is `null` where it could not be read, which is `unknown` and
 * is not nought: a page drawing "up for 0s" because nothing answered is the one
 * lie that would make the whole panel worthless.
 */
export const FreshnessSchema = z.strictObject({
  /** The **server's** own time this is of, as an ISO string. */
  at: z.string(),
  /** Minted per server start. Never derived from the journal. */
  epoch: z.string(),
  /** The server's projection revision, not a journal sequence number. */
  rev: z.int().nonnegative(),
  openedAt: z.string(),
  machineUpSince: z.string().nullable(),
  /**
   * The moment every money figure in this projection is counted from.
   *
   * On the wire because **the page cannot know it and must not guess it**: the
   * window folds spend from its own midnight (`spendToday`), and a phone in
   * another timezone reading the word *today* would read its own. `null` where
   * nothing has been folded yet, which is `unknown` and is why the page says
   * nothing about a period rather than naming the epoch.
   */
  spendSince: z.string().nullable(),
  /** Status's own warnings, with anything path-shaped taken out. Metadata. */
  warnings: z.array(z.string()),
})
export type Freshness = z.infer<typeof FreshnessSchema>

/** The collections a projection has, each keyed by a stable id. */
export const COLLECTIONS = ['projects', 'tasks', 'queue', 'findings', 'notes', 'plans'] as const
export type Collection = (typeof COLLECTIONS)[number]

/**
 * How much of one collection is here.
 *
 * `total` is what there is inside this device's reach and `omitted` is how many
 * of them are not in `rows` — including **all** of them, which is what a
 * collection the device was not granted looks like. A count is a name-and-count
 * fact and goes out always; the rows are content and need a grant. So a phone
 * with no `notes` grant is told *there are forty-one notes* and not one word of
 * them, which is the honest shape of a read scope.
 */
export const PageInfoSchema = z.strictObject({
  total: z.int().nonnegative(),
  omitted: z.int().nonnegative(),
  next: z.string().nullable(),
  restarted: z.boolean(),
})
export type PageInfo = z.infer<typeof PageInfoSchema>

/**
 * The money and the tokens, never collapsed to one figure.
 *
 * The three kinds of dollar claim stay apart because adding them in silence is
 * the thing `pricedOf` exists to stop, and `usdOnPlan` is in **no** total: a
 * subscription pays a flat fee, so nobody is charged it.
 */
export const SpendOutSchema = z.strictObject({
  usd: z.number(),
  usdExact: z.number(),
  usdEstimated: z.number(),
  usdListed: z.number(),
  /** What a plan's turns would have cost at list. In no total here. */
  usdOnPlan: z.number(),
  tokens: z.int().nonnegative(),
  /** Of `tokens`, what no dollar figure here covers. */
  tokensUnpriced: z.int().nonnegative(),
  tokensOnPlanUnrated: z.int().nonnegative(),
  /** Whether anything reported money at all: free told apart from unpriced. */
  hasCost: z.boolean(),
})
export type SpendOut = z.infer<typeof SpendOutSchema>

export const ChecksOutSchema = z.strictObject({
  state: z.enum(['pass', 'fail', 'unknown']),
  failed: z.array(z.string()),
  missing: z.array(z.string()),
  overridden: z.boolean(),
})
export type ChecksOut = z.infer<typeof ChecksOutSchema>

export const TaskRowSchema = z.strictObject({
  /** `<project>/<task>`. The stable id. */
  id: z.string(),
  project: z.string(),
  /** The id's second half, so a phone need not split one. */
  name: z.string(),
  state: TaskState,
  /**
   * `deriveState`'s own clause. The page does not reword it: a second wording
   * of it is a second state machine.
   */
  reason: z.string(),
  stalled: z.boolean(),
  /** Whether somebody set it aside: the told fact, never read off `state`. */
  parked: z.boolean(),
  /**
   * What an act about this task must still find true of it. Opaque.
   *
   * **The entity's own revision, and the reason `fresh.rev` is not enough.**
   * A projection revision moves when anything anywhere moves, so a check
   * against it alone either refuses acts that are perfectly current or passes
   * ones that are not. This changes only when something an act depends on
   * changes, and a device sends it back on every verb (`was`) so the window
   * can compare what the screen said against the file at the moment of the
   * write. Short and meaningless on purpose: it is a value to echo, not a
   * value to read.
   */
  rev: z.string(),
  /** `blocked | failed | review`. The one flag derived here rather than read. */
  wantsYou: z.boolean(),
  question: z.boolean(),
  /** The tool's **name** and when it started waiting. Never the command. */
  approval: z.strictObject({ id: z.string(), tool: z.string(), since: z.string() }).nullable(),
  createdAt: z.string(),
  /** A moment, never an elapsed figure: see `tick` in `delta.ts`. */
  movedAt: z.string().nullable(),
  title: SaidSchema.nullable(),
  intent: SaidSchema.nullable(),
  /** A branch name is not a path. Null where it has none. */
  branch: z.string().nullable(),
  ahead: z.int().nullable(),
  behind: z.int().nullable(),
  dirty: z.int().nonnegative().nullable(),
  workspace: z.enum(['checkout', 'worktree']),
  shared: z.boolean(),
  effort: z.string().nullable(),
  done: z.enum(DONE_RULES).nullable(),
  produces: z.strictObject({ name: z.string(), written: z.boolean() }).nullable(),
  harness: z.string().nullable(),
  model: z.string().nullable(),
  account: SaidSchema.nullable(),
  origin: z.strictObject({
    // `intake` is here and is not folded into `schedule`, which is the one
    // thing this row must not do: a ticket somebody else filed arriving as
    // "you" would read on the page as the owner having asked for it.
    kind: z.enum(['you', 'orchestrator', 'extension', 'schedule', 'intake']),
    name: z.string(),
  }),
  /** A COUNT. Never a pid, never a session id. */
  agents: z.int().nonnegative(),
  /** A COUNT. Never a lane id, never an attach line. */
  lanes: z.int().nonnegative(),
  spend: SpendOutSchema.nullable(),
  checks: ChecksOutSchema,
  review: z.strictObject({ state: ReviewState, url: z.string().nullable() }).nullable(),
})
export type TaskRow = z.infer<typeof TaskRowSchema>

export const ProjectRowSchema = z.strictObject({
  /** The stable id. There is no `root` and there never will be. */
  name: z.string(),
  title: SaidSchema.nullable(),
  counts: z.strictObject({
    tasks: z.int().nonnegative(),
    /** How many of them are in this snapshot. The budget, said out loud. */
    shown: z.int().nonnegative(),
    wantsYou: z.int().nonnegative(),
    working: z.int().nonnegative(),
    queued: z.int().nonnegative(),
  }),
})
export type ProjectRow = z.infer<typeof ProjectRowSchema>

/** Why queued work has not started. A count of changed files, never their names. */
export const QueueStateOutSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('waiting'), on: z.array(z.string()) }),
  z.strictObject({
    kind: z.literal('held'),
    on: z.string().nullable(),
    /** `holdSaid`'s own sentence. Tade's words. */
    because: z.string(),
    changed: z.int().nonnegative().nullable(),
    by: z.array(z.string()),
  }),
  z.strictObject({ kind: z.literal('scheduled'), at: z.string() }),
  z.strictObject({ kind: z.literal('paused'), all: z.boolean(), parked: z.boolean() }),
  z.strictObject({ kind: z.literal('ready') }),
])
export type QueueStateOut = z.infer<typeof QueueStateOutSchema>

export const QueueRowSchema = z.strictObject({
  /** The task id: one task, one row, and the stable id for this collection. */
  task: z.string(),
  project: z.string(),
  state: QueueStateOutSchema,
  /** A written preference among the ready, and only ever a preference. */
  order: z.int().nullable(),
  waitsOn: z.array(z.strictObject({ task: z.string(), why: SaidSchema.nullable() })),
})
export type QueueRow = z.infer<typeof QueueRowSchema>

export const FindingRowSchema = z.strictObject({
  key: z.string(),
  /** The question's own id, out of `questions.ts`. */
  question: z.string(),
  project: z.string(),
  tasks: z.array(z.string()),
  at: z.string(),
  probability: z.number(),
  /** Repository-relative, the way git names it. */
  file: z.string(),
  stillThere: z.boolean(),
  /** That the agent answered it, which is the question a phone has. */
  accounted: z.boolean(),
  account: z
    .strictObject({
      did: z.enum(['fixed', 'not real']),
      said: SaidSchema.nullable(),
      at: z.string(),
    })
    .nullable(),
  /** That somebody read it, and what they decided. Never their sentence. */
  verdict: z
    .strictObject({ was: z.enum(['confirmed', 'false positive']), at: z.string() })
    .nullable(),
})
export type FindingRow = z.infer<typeof FindingRowSchema>

export const NoteRowSchema = z.strictObject({
  /**
   * `<at>#<n>`, where `n` tells apart two notes written in the same
   * millisecond. `memory.jsonl` is append-only and a note has no id of its
   * own, so this is stable for as long as the file is — which is for ever.
   */
  id: z.string(),
  at: z.string(),
  scope: z.string().nullable(),
  by: z.string(),
  text: SaidSchema.nullable(),
  summary: SaidSchema.nullable(),
})
export type NoteRow = z.infer<typeof NoteRowSchema>

export const PlanRowSchema = z.strictObject({
  /** `<harness>/<account>`. */
  id: z.string(),
  harness: z.string(),
  account: SaidSchema.nullable(),
  pays: z.enum(['plan', 'per-token']),
  windows: z.array(
    z.strictObject({
      label: z.string(),
      used: z.number(),
      /** Null where the harness did not say when it starts over. */
      resetsAt: z.string().nullable(),
    }),
  ),
  at: z.string().nullable(),
  /** Why there is nothing to show, in words. Null when there is something. */
  cannotTell: z.string().nullable(),
})
export type PlanRow = z.infer<typeof PlanRowSchema>

export const YouSchema = z.strictObject({
  device: z.string(),
  /** What this device was granted at the machine. */
  reads: z.array(z.enum(GRANTS)),
})
export type You = z.infer<typeof YouSchema>

export const SnapshotSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  fresh: FreshnessSchema,
  you: YouSchema,
  /** One row per collection, whether or not it has any rows here. */
  pages: z.strictObject({
    projects: PageInfoSchema,
    tasks: PageInfoSchema,
    queue: PageInfoSchema,
    findings: PageInfoSchema,
    notes: PageInfoSchema,
    plans: PageInfoSchema,
  }),
  projects: z.array(ProjectRowSchema),
  tasks: z.array(TaskRowSchema),
  queue: z.array(QueueRowSchema),
  findings: z.array(FindingRowSchema),
  notes: z.array(NoteRowSchema),
  plans: z.array(PlanRowSchema),
})
export type Snapshot = z.infer<typeof SnapshotSchema>

/**
 * What changed since the last revision.
 *
 * **Deliberately dumb**: `set` is collection → id → the changed fields, `del`
 * is collection → ids. No operational transforms, no JSON Patch, no array
 * index arithmetic. Every collection is keyed by a stable id and is sorted by
 * it, which is what makes a shallow merge enough — and a row arriving for the
 * first time is sent **whole**, so a merge is never applied to nothing.
 *
 * The property that makes every failure path recoverable: **a delta can always
 * be replaced by a snapshot.**
 */
export const DeltaSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  rev: z.int().nonnegative(),
  at: z.string(),
  /** The freshness, whenever it moved. A tick is this and nothing else. */
  fresh: FreshnessSchema.nullable(),
  set: z.strictObject({
    projects: z.record(z.string(), ProjectRowSchema.partial()).optional(),
    tasks: z.record(z.string(), TaskRowSchema.partial()).optional(),
    queue: z.record(z.string(), QueueRowSchema.partial()).optional(),
    findings: z.record(z.string(), FindingRowSchema.partial()).optional(),
    notes: z.record(z.string(), NoteRowSchema.partial()).optional(),
    plans: z.record(z.string(), PlanRowSchema.partial()).optional(),
  }),
  del: z.strictObject({
    projects: z.array(z.string()).optional(),
    tasks: z.array(z.string()).optional(),
    queue: z.array(z.string()).optional(),
    findings: z.array(z.string()).optional(),
    notes: z.array(z.string()).optional(),
    plans: z.array(z.string()).optional(),
  }),
  pages: z
    .strictObject({
      projects: PageInfoSchema.optional(),
      tasks: PageInfoSchema.optional(),
      queue: PageInfoSchema.optional(),
      findings: PageInfoSchema.optional(),
      notes: PageInfoSchema.optional(),
      plans: PageInfoSchema.optional(),
    })
    .optional(),
  you: YouSchema.optional(),
})
export type Delta = z.infer<typeof DeltaSchema>

/** What kind of row each collection holds. */
export interface Rows {
  projects: ProjectRow
  tasks: TaskRow
  queue: QueueRow
  findings: FindingRow
  notes: NoteRow
  plans: PlanRow
}

/**
 * The stable id a row is keyed by in its collection, in one place so that the
 * projection, the delta and the client cannot disagree about it.
 *
 * Stable is the load-bearing word: a delta is a shallow merge keyed by these,
 * so an id that changed when a row changed would make a delta apply to the
 * wrong row — and an id derived from a position would make every insert look
 * like a change to everything after it.
 */
export const KEYED: { [C in Collection]: (row: Rows[C]) => string } = {
  projects: (row) => row.name,
  tasks: (row) => row.id,
  queue: (row) => row.task,
  findings: (row) => row.key,
  notes: (row) => row.id,
  plans: (row) => row.id,
}
