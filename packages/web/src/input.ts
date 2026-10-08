import type { DoneRule, PlanStanding, ReviewState, Spend, TaskState } from '@tade/core'
import type { Reach } from './reach.ts'

// What the away view is handed, and the reason it is handed this and not more.
//
// The window already holds everything on this page — `Live` refreshes task
// snapshots, queue items, folds, checks and reviews on its own beat — so the
// away view asks the machine nothing. What it needs is a way to be *given*
// that, and the shape of the giving is this file.
//
// **This is not a serialization of `Workspace`, `AppState` or `TadeEvent`, and
// that is the whole design.** `Workspace` carries `project.root` and
// `task.worktree`, both absolute paths, and `Task.agents` carries pids and
// transcript paths; `AppState` carries panes and scroll offsets; a `TadeEvent`
// carries whatever anybody put in its detail. A projection built by taking one
// of those and leaving things out is only ever as good as the leaving-out — and
// the field somebody adds to `Task` next month arrives on the page by default,
// with nobody having decided that.
//
// So: **there is no field here that can hold a machine path, a pid, a lane id,
// a run id, a socket path or a credential.** Not "they are filtered" — there is
// nowhere to put one. A field reaches the page only by somebody writing a line
// into this file, which is a line a reviewer reads. The tests in
// `test/leak.test.ts` are what stop that discipline rotting; this file is what
// makes the claim true.
//
// ## The two kinds of value, named
//
// **Metadata** is what Tade itself generated about the work: a name, a count, a
// state, `deriveState`'s own clause, an id, a branch, a check's id, a rule's
// name, a probability. Tade wrote every word of it, so it holds no path and no
// credential, and `test/leak.test.ts` holds every metadata field in the
// projection to exactly that.
//
// **Authored free text** is what a person typed or spoke, kept verbatim: a
// task's title, `intent_spoken`, a note, the sentence an agent wrote accounting
// for a finding. It is **not scrubbed**. A note that says *the fix is in
// /Users/amir/work/thing.ts*, or into which somebody pasted a credential, goes
// out as they wrote it, because the house rule is *never lowercase or reword
// one* and a scrubbed note is a reworded note. What stands instead is that it
// is marked as authored (`Said`), cut to a budget, carried only where the
// device was granted it, and drawn as text and never as markup.
//
// So the projection's claim is exactly this and nothing stronger: **the away
// view adds no path and no credential of its own, and it shows what you wrote
// as you wrote it.** (DECISIONS.md §4.11.) Every field below says which of the
// two it is.

/**
 * The server's own lifetime.
 *
 * `epoch` is minted when the server starts and is **never derived from the
 * journal**: `readJournalSince` resumes by byte offset, `compactJournal`
 * rewrites `events.jsonl` in place at every window start, and a `seq` is
 * monotonic only per log file. A cursor keyed to either can, after a restart
 * and a few hours of appends, point at completely different content while
 * still looking valid. `(epoch, rev)` is correct by construction over restart,
 * rotation and compaction, and it costs one `randomUUID()`.
 *
 * `rev` is the server's own projection revision, advanced only on a beat where
 * the projection actually changed (`revise`). It is not a count of beats, not a
 * clock and not a sequence number.
 */
export interface Lifetime {
  epoch: string
  rev: number
  /** When this server started listening. */
  openedAt: number
}

/** A task's checks, as the rollup of the required ones at its head stands. */
export interface ChecksIn {
  /**
   * What the required checks add up to. `unknown` is first-class and is the
   * answer whenever one of them has not run: absent is not fine, and a check
   * nobody ran is not a check that passed.
   */
  state: 'pass' | 'fail' | 'unknown'
  /** The ids of the required checks that failed. Metadata: Tade's own names. */
  failed: readonly string[]
  /** The ids of the required checks nothing can speak for yet. Metadata. */
  missing: readonly string[]
  /** Whether somebody overruled a red run. A red run that was overruled is still red. */
  overridden: boolean
}

/**
 * Why a task is in the state it is.
 *
 * Two shapes, and the second one is the finding that earns this type.
 * `deriveState`'s clause is Tade's own vocabulary in every case but one: a task
 * blocked on an approval reads `wants approval: <the harness's one-line
 * summary>`, and that summary is **the tool call itself** —
 * `describeToolCall` in the Claude and Codex adapters renders `Bash: <the whole
 * command>`, `Read <an absolute file path>`, or the tool's name with 200
 * characters of its JSON arguments. It is a raw tool payload with a machine
 * path in it, and it is the single most common reason a task is blocked.
 *
 * So DESIGN.md §10.2's rule 6 (*`reason` is verbatim*) and its rule 1 (*no
 * absolute path, ever*) contradict each other in the commonest case on the
 * page, and the contradiction is settled here rather than left to whoever
 * writes the app's side: the summary **never arrives**, so there is nothing to
 * leave out by accident. The projection writes the same clause from the tool's
 * name, which is not a second state machine — the state is still
 * `deriveState`'s, and the words are still its words.
 */
export type ReasonIn =
  /** `deriveState`'s clause, in Tade's own vocabulary. Metadata, carried verbatim. */
  | { kind: 'clause'; said: string }
  /** Blocked on an approval. `tool` is the tool's name; `also` is how many more wait. */
  | { kind: 'approval'; tool: string; also: number }

/** One task, as the window holds it. */
export interface TaskIn {
  /** `<project>/<task>`. The stable id, and the only id on the wire. Metadata. */
  id: string
  /** Metadata. */
  project: string
  /** `deriveState`'s own enum. Metadata. */
  state: TaskState
  reason: ReasonIn
  /** Metadata. */
  stalled: boolean
  /** When the task was made, as a moment. Metadata. */
  createdAt: number
  /**
   * The last time anything about this task was seen to move, or null where
   * nothing says.
   *
   * A moment and never an elapsed figure. An `ageMs` on a row changes on every
   * beat, which would make every row differ from the last beat's and turn a
   * tick of the clock into a resend of the whole tree — see `tick` in
   * `delta.ts`. DESIGN.md §10.2 has `ageMs` on `TaskRow`; this is that field
   * corrected.
   */
  movedAt: number | null
  /** AUTHORED: what the work is called. Empty for nothing said. */
  title: string
  /** AUTHORED, verbatim: `intent_spoken`. Empty for nothing said. */
  intent: string
  /** Metadata: a branch name is not a path. Empty where it has none. */
  branch: string
  /** Metadata. Null is `unknown` — git could not say — and never nought. */
  ahead: number | null
  behind: number | null
  /** How many files are changed and not committed. A count, never the names. */
  dirty: number | null
  /** Metadata. */
  workspace: 'checkout' | 'worktree'
  /** Whether other agents work in the same tree. Metadata. */
  shared: boolean
  /** Metadata: the effort's slug. Empty for none. */
  effort: string
  /** Metadata. Null where the task file says nothing. */
  done: DoneRule | null
  /** Metadata: the document's name, and whether it has been written. */
  produces: { name: string; written: boolean } | null
  /** Metadata: the harness's own id. Empty where nothing recorded one. */
  harness: string
  /** Metadata: the model's own name. Empty is `UNRECORDED`. */
  model: string
  /**
   * AUTHORED: which sign-in the agent runs as.
   *
   * Metadata by its job and a person's own words by its content — an account
   * name is whatever they called it at the harness, which is often an email
   * address. Granted (`accounts`) rather than default, for that reason alone.
   * Empty for the harness's own sign-in.
   */
  account: string
  /** Metadata: who asked for the work, as `taskOrigin` reads the task file. */
  origin: { kind: 'you' | 'orchestrator' | 'extension' | 'schedule'; name: string }
  /** A COUNT of the agents attached. Never a pid, never a session id. */
  agents: number
  /** A COUNT of the lanes. Never a lane id, never an attach line. */
  lanes: number
  /** Whether the agent asked something and is waiting. Metadata. */
  question: boolean
  /**
   * The approval waiting, when one is.
   *
   * `tool` is the tool's **name** and nothing else. The harness's one-line
   * summary — which is the command, with its paths — is not here and must not
   * be added: answering an approval from away is Phase 2's and its own slice
   * decides what a person is shown before they say yes.
   */
  approval: { id: string; tool: string; sinceAt: number } | null
  /** The fold. Already a pure value in `@tade/core`: no paths, no ids. */
  spend: Spend
  checks: ChecksIn
  /** The review this branch is out for. `url` is carried only with `reviews`. */
  review: { state: ReviewState; url: string } | null
}

/** What a project is, once its paths are not in it. */
export interface ProjectIn {
  /** The stable id. Metadata. */
  name: string
  /** AUTHORED: what the person calls it, when that is not its name. */
  title: string
}

/**
 * Why queued work has not started.
 *
 * `@tade/core`'s own `QueueState` carries `changed`, the list of files work
 * going on now has touched. That is a list of repository paths, and nobody taps
 * one on a phone — so what crosses this boundary is **how many**, and the
 * names stay at the machine. `because` is `holdSaid`'s own sentence: Tade's
 * words, and metadata.
 */
export type QueueStateIn =
  | { kind: 'waiting'; on: readonly string[] }
  | {
      kind: 'held'
      on: string | null
      because: string
      changed: number | null
      by: readonly string[]
    }
  | { kind: 'scheduled'; at: number }
  | { kind: 'paused'; all: boolean; parked: boolean }
  | { kind: 'ready' }

/** One piece of queued work. */
export interface QueueIn {
  /** The task id. The stable id for this collection too: one task, one row. */
  task: string
  project: string
  state: QueueStateIn
  /** The written preference among the ready, when one was written. Metadata. */
  order: number | null
  /** What it waits on, and why, as its task file says. `why` is AUTHORED. */
  waitsOn: readonly { task: string; why: string }[]
}

/** One finding a judge raised about one agent's change. */
export interface FindingIn {
  /** The stable id. Metadata. */
  key: string
  /** The question's own id, out of `questions.ts`. Tade's vocabulary: metadata. */
  question: string
  project: string
  /** The tasks whose work the change was. Metadata: task ids. */
  tasks: readonly string[]
  /** When the reading was made. */
  at: number
  probability: number
  /** The file it was highest about, repository-relative. Metadata. */
  file: string
  /** Whether the newest reading of that change still raises it. */
  stillThere: boolean
  /**
   * What the agent said about it, while it still remembered why the code is
   * the way it is. `said` is AUTHORED — an agent's own words — and `did` is
   * metadata.
   */
  account: { did: 'fixed' | 'not real'; said: string; at: string } | null
  /**
   * That somebody wrote a verdict, and what it was. **Not its sentence.**
   *
   * A verdict must cite what in the change decided it, which makes its text a
   * paragraph about somebody's code; its place is the calibration table, and
   * the phone's question is only *has this been read yet*.
   */
  verdict: { was: 'confirmed' | 'false positive'; at: string } | null
}

/** One note, verbatim. */
export interface NoteIn {
  /** AUTHORED, verbatim. Never reworded, never lowercased, never summarised. */
  text: string
  /** AUTHORED: the headline whoever took it down wrote beside it. */
  summary: string
  /** A task id, a project name, or null for everything. Metadata. */
  scope: string | null
  /** `voice`, `window`, `cli`. Metadata. */
  by: string
  /** When it was said, as its own ISO string: half of the key it is forgotten by. */
  at: string
}

/** Everything one projection is built from. */
export interface SnapshotInput {
  lifetime: Lifetime
  reach: Reach
  projects: readonly ProjectIn[]
  tasks: readonly TaskIn[]
  queue: readonly QueueIn[]
  findings: readonly FindingIn[]
  notes: readonly NoteIn[]
  /** What each account's plan standing is. Already pathless in `@tade/core`. */
  plans: readonly PlanStanding[]
  /**
   * What could not be read, in status's own words.
   *
   * Carried verbatim and treated as metadata, because every one of them is a
   * sentence Tade wrote. A warning that quoted a path would make that false,
   * and `test/leak.test.ts` is where it would be caught.
   */
  warnings: readonly string[]
  /** When the machine came up, or null where it could not be read: `unknown`, not nought. */
  machineUpSince: number | null
}
