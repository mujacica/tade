import type { DoneRule, PlanStanding, ReviewState, Spend, TaskState } from '@tade/core'
import type { Can, Cannot, TaskFacts } from './acting.ts'
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
 *
 * **What the caller owes, said out loud because the type cannot say it.** A
 * task with a pending approval must arrive as `approval`, never as a `clause`
 * holding `deriveState`'s string — handing that string straight through is the
 * leak, with one more step in it. The two variants are what force the choice
 * to be made somewhere a reviewer reads; the test that the window makes it
 * correctly belongs to the slice that writes `packages/app/src/wire/web.ts`,
 * and it has `PendingApproval.tool` to make it with.
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
  /**
   * Whether somebody set this task aside. Metadata.
   *
   * **The told fact out of the task file, never `state === 'parked'`.** A
   * merge is ahead of a park in `deriveState`, so a parked task whose branch
   * landed reads as `merged` and the park is invisible in the state — which is
   * the hole the queue had before `factory-web-foundations` fixed it, and the
   * same hole here would make a phone's park control toggle the wrong way.
   *
   * On the wire because the page needs it twice: to say which way the control
   * goes, and to send back what it saw. `park`'s own entity revision is built
   * from this (`revOf`), so what a device echoes is a value Tade generated and
   * not a boolean it chose.
   */
  parked: boolean
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
  /**
   * Metadata: who asked for the work, as `taskOrigin` reads the task file.
   *
   * `intake` is its own kind here as it is in the domain: what arrived from
   * outside is somebody else's request, and the one answer this field must
   * never give for one is `you`.
   */
  origin: { kind: 'you' | 'orchestrator' | 'extension' | 'schedule' | 'intake'; name: string }
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
   * be added, and that stands now that answering one from away is a verb: what
   * a person on a phone is shown before they say yes is the tool's name and
   * the count of what else waits, and the command stays at the machine where
   * the lane is.
   */
  approval: { id: string; tool: string; sinceAt: number } | null
  /**
   * Whether the journal already says this task is finished. Metadata.
   *
   * Not a state: `deriveState` has no `done`, because what a task's state is
   * about is the work and this is about the record. It is here because two
   * things need it — a page must not offer to finish what is finished, and
   * `taskRev` carries it so that a second `done` from a screen drawn before
   * the first is refused rather than appending a second `task_done` line.
   */
  finished: boolean
  /**
   * The queue's own word for where this task stands, or empty for work that is
   * not queued. Metadata.
   *
   * `QueueStateIn['kind']`, and the *word* only: the queue collection carries
   * the whole of it, with the sentence and the counts. What this is for is
   * `taskRev` — a queue choice made from a screen drawn when the work was
   * waiting on something else is a choice about a different world.
   */
  queue: string
  /**
   * What may be asked of this task right now, and what may not with why.
   *
   * **Two lists rather than one, and the second is the point.** A control the
   * page cannot draw is a control nobody can explain: *this harness has no way
   * to take a message mid-turn* is a sentence somebody wrote, and an absence is
   * not. So what cannot be asked is named (`cannot`) exactly as what cannot be
   * read is, and the page draws the reason beside the control it has turned
   * off rather than leaving a hole.
   *
   * It is **not** permission. A device's scopes and the acting setting are the
   * gate's (`acts.ts`), re-asked at the act; this is about whether the thing
   * is *possible* — a harness that cannot steer, an agent that is not
   * running, a task already finished. A row that says `can` is still refused
   * where the grant does not allow it.
   */
  can: readonly Can[]
  cannot: readonly Cannot[]
  /** The fold. Already a pure value in `@tade/core`: no paths, no ids. */
  spend: Spend
  checks: ChecksIn
  /** The review this branch is out for. `url` is carried only with `reviews`. */
  review: { state: ReviewState; url: string } | null
}

/**
 * The facts a task's own revision is built from, out of its projected row.
 *
 * **One rule, and this is where the two sides meet it.** `snapshot.ts` calls
 * it to put `rev` on the row, and the window calls it at the act to build the
 * revision `was` is compared against. Two spellings of the same six fields
 * would be a comparison that is always true or always false, and neither
 * failure would look like one.
 */
export function factsOf(task: TaskIn): TaskFacts {
  return {
    parked: task.parked,
    approval: task.approval !== null,
    question: task.question,
    agents: task.agents,
    finished: task.finished,
    queue: task.queue,
  }
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

/**
 * One line of the conversation with Tade, as the window holds it.
 *
 * **The whole of what crosses, and `transcript` is not a field.**
 * `fields.ts`'s `NEVER_A_FIELD` names a transcript as *the largest, least
 * structured, most injection-prone surface Tade has*, and that entry stands:
 * what a raw one carries — a tool call's arguments, a tool's answer, a lane's
 * bytes, a machine path — is still a name that fails a test. This is the
 * hand-written allow-list over it, which is the only shape that gets to go to
 * a phone: five fields, a tool's **name** and never its arguments, and an
 * outcome in one word.
 *
 * Behind its own grant (`talk`), because reading what somebody typed at their
 * own keyboard is a decision somebody makes per device, exactly as `notes` is.
 */
export interface ChatIn {
  /**
   * The stable id: the line's own place in the conversation.
   *
   * Stable is load-bearing (a delta is a shallow merge keyed by this), and the
   * conversation is append-only with a cap at the front — so the id is minted
   * from a counter the window keeps and never from a position in the array,
   * which would make every line that fell off the top renumber all the rest.
   */
  id: string
  at: number
  /**
   * What kind of line it is. Five, and they are about *who is speaking*
   * rather than about how it should look: a page that chose a shape from a
   * guess is a second state machine.
   */
  kind: 'asked' | 'reply' | 'tool' | 'tade' | 'problem'
  /**
   * Who asked, as `byOf` writes it: `you` at the machine, `device <id>` from
   * away, or empty for Tade's own lines and the model's — which goes out as
   * `null`, because one spelling of *nobody said* is the only way a client can
   * be written once.
   *
   * **The reason this collection exists at all.** A conversation that showed
   * what was said and not who said it would let a request from a phone read,
   * on the phone and in the window, as something the person typed — which is
   * the `said` confusion one layer up, in the one place a person actually
   * reads the words.
   */
  from: string
  /**
   * The words.
   *
   * AUTHORED where a person wrote them — their own message, a device's own
   * message — and kept verbatim. A **reply** is a model's words rather than a
   * person's, and a model quotes what its tools answered, so that one is run
   * through `withoutPaths` on the way out (`chatRows`). It is the second
   * metadata-ish field whose text this package did not write; `fresh.warnings`
   * was the first, and the treatment is the same.
   */
  text: string
  /** The tool's **name**, in Tade's own words for it. Empty for other lines. */
  tool: string
  /** How a tool line went, in one word. Empty where it is not a tool line. */
  outcome: '' | 'running' | 'ok' | 'failed'
  /** Still arriving, so the page can draw it as such rather than as finished. */
  streaming: boolean
}

/**
 * The conversation, as this device may see and use it.
 *
 * `null` where talking is turned off, which is `unknown` and not an empty
 * conversation: a page told *there are no lines* would say Tade had never been
 * spoken to, and what is true is that this surface is not on.
 */
export interface TalkIn {
  lines: readonly ChatIn[]
  /**
   * The conversation's own revision (`chatRev`), which a message echoes back
   * as `was`. Tade's own value, built from the same facts the window
   * re-checks at the moment it hands the words over.
   */
  rev: string
  /** Whether a turn is in flight, which is what a message needs to be false. */
  busy: boolean
  /** Whose turn is in flight, as `byOf` writes it. Empty for none. */
  whose: string
  /**
   * Whether **this** device may send one: granted `ask`, on a trusted origin,
   * with the setting on.
   *
   * A drawing hint and **not permission** — the gate re-asks every layer at
   * the turn (`admitAsk`) — and it is here for the reason `TaskRow.can` is:
   * a control nothing could carry out is a control nobody can explain, so the
   * page draws the conversation without a composer rather than a composer that
   * answers `403`.
   */
  mine: boolean
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
  /** The conversation with Tade, or null where talking is turned off. */
  talk: TalkIn | null
  /** What each account's plan standing is. Already pathless in `@tade/core`. */
  plans: readonly PlanStanding[]
  /**
   * What could not be read, in status's own words.
   *
   * **The one metadata field whose words are composed outside this package**,
   * and the one place the projection's claim has to be *kept* rather than
   * inherited. `collectStatus` writes `<project>: <its root>: <what git said>`
   * when a checkout will not answer, and `<task>: ... its files are in <the
   * folder>` for a worktree somebody took away — so these do arrive with a
   * machine path in them, and they may quote a tool's own error text. What
   * crosses is run through `withoutPaths` (`fields.ts`), bounded by
   * `budget.warnings`, and `test/leak.test.ts` holds it against a fixture
   * carrying the shapes status actually writes — because a fixture whose
   * warnings happen to have no path in them is that test passing while the
   * claim is false, which is the failure DECISIONS.md §4.11 names.
   */
  warnings: readonly string[]
  /** When the machine came up, or null where it could not be read: `unknown`, not nought. */
  machineUpSince: number | null
  /**
   * The moment every `TaskIn.spend` is folded from, or null for nothing folded.
   *
   * **Carried because a figure without its period is not a figure.** The
   * window hands over its own `spendToday` fold, which starts at midnight
   * where Tade is running — so a task that cost forty dollars yesterday and
   * nothing since arrives with `hasCost: false`, which the page would
   * otherwise draw as *not recorded*: the exact lie the three-dashes rule
   * exists to prevent, one period out. The page says the window instead, and
   * says it from this rather than from a word of its own, because the phone is
   * somewhere else and *today* is not the same day there.
   */
  spendSince: number | null
}
