import type { IntakeGrantRead } from './intake.ts'
import type { InboxRow } from './intake-inbox.ts'
import type { IntakeItem, IntakeReply } from './intake-journal.ts'

// What may be said back to a source, and which one status is due now.
//
// **The outbox is a fold, not a queue.** There is no table of pending posts
// and nothing to keep in sync: `intake_replied` lines say which statuses have
// gone and which attempt failed, the task files say where the work stands, and
// this file is the arithmetic between the two. Delete the index, close the
// window, come back next week — the same lines fold to the same answer, which
// is the whole of "dedupe across restarts".
//
// **Three bounds, and each is a different failure it stops:**
//
// 1. **One status per saying, ever** (`alreadySaid`) — a window reopening, a
//    refold, a journal replayed: none of them says anything twice.
// 2. **Attempts per saying** (`INTAKE_REPLY_ATTEMPTS`) — a transport that is
//    down does not retry for ever, and the giving-up is visible rather than
//    silent.
// 3. **Posts per request per day** (`INTAKE_REPLY_CAP`) — the belt for a
//    journal nobody expected: duplicate items, a clock that moved, a request
//    accepted twice. Nothing about one request becomes a conversation.
//
// **And one status is never said late.** A saying whose moment passed while
// the window was shut is passed over, never backfilled: a status is a fact
// about now, and four of them arriving at once is a machine talking about
// itself. That is `alreadySaid` reading *later-or-equal*, not equal.
//
// Pure: facts in, a decision out. No clock reads — every rule takes `now`.

/**
 * The only things a reply ever says. A fixed set of sentences Tade generates,
 * with no agent prose, no diff, no log line, no file name, no url and no
 * repository content in any of them.
 *
 * **Acknowledgement is not acceptance, acceptance is not execution, and
 * execution is not done**, so there is a word for each and no copy may blur
 * them: `noticed` is that a look found it, `proposed` is that a person has to
 * approve it, `accepted` is that a task exists and is queued, `started` is
 * that an agent is running, `review` is that there is something to look at,
 * `finished` is that its own done rule is met, and `held` is that it stopped
 * and somebody here has to look. "We'll run it when you're back" is not in the
 * list and never will be — a sleeping laptop runs nothing and promises
 * nothing.
 *
 * **The order is the order of a request's life**, and it is load-bearing: a
 * saying is never said after a later one has been, which is what keeps a
 * window that was shut for a day from posting four statuses in a row.
 */
export const INTAKE_SAYINGS = [
  'noticed',
  'proposed',
  'accepted',
  'started',
  'held',
  'review',
  'finished',
] as const
export type IntakeSaying = (typeof INTAKE_SAYINGS)[number]

/**
 * What a status may name besides the fact itself — and the honest default is
 * nothing.
 *
 * **Enforcement by absence, the way `IntakeSaid` is.** With `names: false` the
 * task and the machine are not in the argument at all, so the sentence cannot
 * carry them even by mistake. That matters because an issue on a public
 * tracker is readable by everybody: `tade/factory-source-replies` names a
 * private repository and a person's own branch of work, and a hostname names
 * their laptop. Neither is a secret and both are disclosure, which is why the
 * owner grants it deliberately (`surfaces.intake.sources.<source>.names`)
 * rather than getting it because they turned replies on.
 */
export type IntakeSayFacts =
  | { names: false }
  | { names: true; task: string | null; machine: string }

/** One of the fixed sentences, said about one request. */
export function intakeSays(saying: IntakeSaying, facts: IntakeSayFacts): string {
  // Read once, and only on the branch that has them: `names: false` carries
  // neither field, so there is nothing here to leak.
  const task = facts.names ? (facts.task ?? 'a task') : ''
  const where = facts.names && facts.machine ? ` on ${facts.machine}` : ''
  const it = facts.names ? ` ${task}${where}` : ''
  switch (saying) {
    case 'noticed':
      return `Picked up${where}.`
    case 'proposed':
      return `Picked up${where}. Waiting for a person to approve it.`
    case 'accepted':
      return facts.names ? `Queued as${it}.` : 'Queued.'
    case 'started':
      return facts.names ? `Working on${it}.` : 'Being worked on.'
    case 'held':
      return facts.names
        ? `${task} stopped${where}: somebody here has to look at it.`
        : 'Stopped: somebody here has to look at it.'
    case 'review':
      return facts.names ? `${task} is up for review${where}.` : 'Up for review.'
    case 'finished':
      return facts.names ? `${task} is finished${where}.` : 'Finished.'
  }
}

/**
 * Tade's own stable marker for one status about one request:
 * `tade:cli:req-7:accepted`.
 *
 * **It is derived, so it is the same marker after a restart** — no clock, no
 * counter, nothing random — and that is what makes a post idempotent across a
 * crash: a window that died between posting and writing the line comes back,
 * finds the status due again, and hands the transport the same marker. A
 * transport that recognises its own marker answers `already` and creates
 * nothing.
 *
 * **It is for the transport's own bookkeeping and need not be posted.** Where
 * a source has no way to carry a hidden marker, putting one in the visible
 * text would be Tade writing its own machinery into somebody's issue — which
 * is the disclosure this file is otherwise careful about. How a transport
 * recognises it is the transport's business.
 */
export function intakeMark(item: string, saying: IntakeSaying): string {
  return `tade:${item}:${saying}`
}

/**
 * How many statuses about one thing a window may post over a day, counted the
 * way `attemptsUnder` counts starts: per external item, over a window.
 *
 * **As many as there are sayings, so it can never be what stops an honest
 * status.** The bound that matters is one per saying, ever, which already caps
 * a request's whole life at seven; this is the belt for a journal nobody
 * expected — duplicate items, a clock that moved, lines nothing can read — and
 * what stops anything here becoming a conversation.
 *
 * It was six, and six is **below** the number of sayings: a request that went
 * from picked up to finished inside a day would have had `finished` — the one
 * status the person who asked actually wants — dropped by the cap, with
 * nothing anywhere saying why, because a status the cap refuses never gets an
 * attempt and so never shows in the inbox either. A cap that binds before the
 * rule does is not a belt, it is a second rule nobody wrote down.
 */
export const INTAKE_REPLY_CAP = INTAKE_SAYINGS.length
export const INTAKE_REPLY_HOURS = 24

/** How many statuses about one request may still go out today. */
export function intakeRepliesLeft(one: IntakeItem | undefined, now: number): number {
  const since = now - INTAKE_REPLY_HOURS * 3_600_000
  const recent = (one?.replies ?? []).filter((at) => at >= since).length
  return Math.max(0, INTAKE_REPLY_CAP - recent)
}

/**
 * How many times posting one status is tried before Tade stops, and how long
 * it waits between tries.
 *
 * The same shape and the same argument as `INTAKE_ATTEMPTS`: neither silent
 * failure mode is allowed — not a retry every look for ever, and not a status
 * that never went with nothing written down. The difference is what is at the
 * other end: a delivery that fails is work that was never made, and a status
 * that fails is somebody not being told. So this one is never a hold on the
 * work, and a request whose statuses all failed still gets built.
 */
export const INTAKE_REPLY_ATTEMPTS = 3
export const INTAKE_REPLY_RETRY_MS = 60_000

/** Why a refusal is never answered, said where somebody might be tempted to. */
export const NEVER_REPLIED_TO =
  'a refusal is written down and never replied to: a reply tells an unauthorised person the machine is there and listening'

/**
 * Why a transport that replies has to say which revision it moved the thing
 * to, said at the port and here.
 *
 * Posting a comment moves `updated_at` on a GitHub issue, and a revision that
 * moved is how Tade knows a request was edited — so a status going out would
 * read, on the next look, as somebody having rewritten the request, and would
 * put back the approval a person had just given. Tade's own words can never be
 * news to Tade: the revision a reply reports is written down with it, and
 * `intakeAgain` knows its own.
 */
export const REPLIES_MOVE_REVISIONS =
  'a source whose revision moves when something is posted to it must report the revision it moved to, or Tade reads its own status as somebody’s edit'

/** Which saying one row's standing calls for, or why it calls for none. */
export function sayingFor(
  row: Pick<InboxRow, 'state' | 'work'>,
): { saying: IntakeSaying } | { nothing: string } {
  switch (row.state) {
    case 'refused':
      return { nothing: NEVER_REPLIED_TO }
    case 'noticed':
      return { saying: 'noticed' }
    case 'proposed':
      return { saying: 'proposed' }
    case 'accepted':
      return { saying: 'accepted' }
    // Tade gave up carrying the delivery out, which is this machine's own
    // trouble and not the requester's fault — so it is the same word as work
    // the queue is holding. It is said because the request was granted: the
    // argument against answering a refusal is about somebody who was not.
    case 'held':
    case 'failure':
      return { saying: 'held' }
    case 'started': {
      const started = row.work.filter((task) => task.started)
      if (started.length > 0 && started.every((task) => task.finished)) {
        return { saying: 'finished' }
      }
      // Only where somebody could ask for a state: `deriveState` needs probes,
      // so outside a window this is null and the honest answer is the one
      // below. Unknown is not "not in review" — it is a status not said.
      if (row.work.some((task) => task.state === 'review')) return { saying: 'review' }
      return { saying: 'started' }
    }
  }
}

/**
 * What came of posting one status, as the transport that posted it says.
 *
 * Here rather than at the port because two layers need the same answer and
 * neither may depend on the other: the watch port declares `reply` and the
 * workbench writes down what came back, and the workbench knows nothing about
 * extensions on purpose — a status goes out through a callback, so the one
 * thing that can post is the window.
 */
export interface IntakeReceipt {
  /** The source's own id for whatever was created, where it has one. */
  posted?: string
  /**
   * True where this exact status was already there and nothing was created:
   * the answer to a window that died after posting and asked again with the
   * same marker. A transport that cannot tell says nothing rather than
   * guessing — reading a missing answer as `already` would silently stop a
   * status from ever going out.
   */
  already?: boolean
  /**
   * The revision the source reports once the status is there, where the
   * transport knows it. `REPLIES_MOVE_REVISIONS` is why a source that moves
   * one when something is posted to it has to say so.
   */
  revision?: string
}

/** One status, ready to go: what to say, how the transport knows it, and which try this is. */
export interface OutboxEntry {
  item: string
  source: string
  externalId: string
  saying: IntakeSaying
  /** Tade's own stable marker for this status about this request. */
  mark: string
  /** The sentence, already generated. The only thing that goes out. */
  say: string
  /** Which try this is, out of `INTAKE_REPLY_ATTEMPTS`, so a failure can say. */
  attempt: number
}

// There is deliberately nothing here saying *this may already have been
// posted*. A try after a failure always might have been — the transport
// answered late, the window died, the append did not happen — and the marker
// is what settles it, every time, whether or not anybody warned the transport.
// A field saying "be careful this time" would be a second answer to a question
// `mark` already answers, and a transport that only checked when it was told
// to would be exactly the one that posts twice.

/** Whether one status goes out now, waits, or is not Tade's to say. */
export type OutboxStanding =
  | { outbox: 'due'; entry: OutboxEntry }
  /** The last try is too recent to be worth an identical one. */
  | { outbox: 'wait'; until: number; because: string }
  /** Nothing to say, in a sentence saying why — a grant that is off included. */
  | { outbox: 'nothing'; because: string }

/**
 * Where the order puts one saying: later is further through a request's life.
 *
 * A word the fold read and this version does not know is `-1` — before
 * everything, so it blocks nothing. A journal written by a newer Tade must
 * never make an older one go quiet about a request it can still see.
 */
function orderOf(saying: string): number {
  return INTAKE_SAYINGS.indexOf(saying as IntakeSaying)
}

/**
 * Whether this saying's moment has been and gone — said already, or passed by
 * a later one.
 *
 * *Later or equal*, which is the half that keeps a window that was shut from
 * catching up out loud: a request that was queued, started and finished while
 * nobody was here gets `finished` and nothing else.
 */
function alreadySaid(said: readonly IntakeReply[], saying: IntakeSaying): IntakeReply | null {
  const order = orderOf(saying)
  return said.find((one) => one.sent && orderOf(one.saying) >= order) ?? null
}

/**
 * Whether a status about one request goes out now.
 *
 * In order, and the order is the whole of it: the grant first, because
 * everything else is moot while nothing may be posted; then what there is to
 * say; then whether it has been said; then the two bounds.
 *
 * **It may only ever decide to say less.** Nothing here can post, nothing here
 * can start work, and nothing an agent or a source said reaches it — `say` is
 * generated from the saying and the facts the grant allowed, and the request's
 * own words are not in any argument it takes.
 */
export function outboxFor(req: {
  row: InboxRow
  /** The journal's own answer about this request, for what has been said and the cap. */
  item: IntakeItem | undefined
  grant: Pick<IntakeGrantRead, 'path' | 'on' | 'reply' | 'names'>
  now: number
  /** What this machine is called, used only where the grant allows a name. */
  machine: string
}): OutboxStanding {
  const { row, grant } = req
  if (!grant.on) {
    return {
      outbox: 'nothing',
      because: 'surfaces.intake.enabled is off: nothing is posted anywhere',
    }
  }
  if (!grant.reply) {
    return { outbox: 'nothing', because: `${grant.path}.reply is off: nothing is posted anywhere` }
  }
  const wanted = sayingFor(row)
  if ('nothing' in wanted) return { outbox: 'nothing', because: wanted.nothing }
  const saying = wanted.saying
  const said = req.item?.said ?? []
  const passed = alreadySaid(said, saying)
  if (passed) {
    return {
      outbox: 'nothing',
      because:
        passed.saying === saying
          ? `${saying} has already gone back about ${row.externalId}`
          : `${row.externalId} is ${saying}, and ${passed.saying} has already gone back about it: a status is never said late`,
    }
  }
  const tried = said.find((one) => one.saying === saying)
  const attempts = tried?.attempts ?? 0
  if (attempts >= INTAKE_REPLY_ATTEMPTS) {
    return {
      outbox: 'nothing',
      because: `saying ${saying} about ${row.externalId} failed ${attempts} times and was given up on: ${tried?.problem ?? 'unsaid'}`,
    }
  }
  const failedAt = tried?.failedAt ?? 0
  const since = req.now - failedAt
  // A failure in the future is a clock that moved rather than a minute that
  // has not passed, so it is tried again: `since < 0` is the only reading that
  // does not strand the status for ever. `intakeNext` makes the same call.
  if (failedAt > 0 && since >= 0 && since < INTAKE_REPLY_RETRY_MS) {
    return {
      outbox: 'wait',
      until: failedAt + INTAKE_REPLY_RETRY_MS,
      because: `saying ${saying} about ${row.externalId} failed less than a minute ago`,
    }
  }
  if (intakeRepliesLeft(req.item, req.now) <= 0) {
    return {
      outbox: 'nothing',
      because: `enough has already been said back about ${row.externalId} today`,
    }
  }
  return {
    outbox: 'due',
    entry: {
      item: row.item,
      source: row.source,
      externalId: row.externalId,
      saying,
      mark: intakeMark(row.item, saying),
      say: intakeSays(
        saying,
        grant.names
          ? { names: true, task: row.tasks[0] ?? null, machine: req.machine }
          : { names: false },
      ),
      attempt: attempts + 1,
    },
  }
}

/**
 * Every status due now, across the whole inbox.
 *
 * Rows in, entries out, in the inbox's own order. What is waiting and what was
 * refused are decided by `outboxFor` one row at a time, so there is no second
 * reading of a grant anywhere and nothing here has an opinion of its own.
 */
export function outboxOf(req: {
  rows: readonly InboxRow[]
  items: ReadonlyMap<string, IntakeItem>
  /** The grant for one source, as the caller's own config says it now. */
  grantOf: (source: string) => Pick<IntakeGrantRead, 'path' | 'on' | 'reply' | 'names'> | null
  now: number
  machine: string
}): OutboxEntry[] {
  const due: OutboxEntry[] = []
  for (const row of req.rows) {
    const grant = req.grantOf(row.source)
    if (!grant) continue
    const standing = outboxFor({
      row,
      item: req.items.get(row.item),
      grant,
      now: req.now,
      machine: req.machine,
    })
    if (standing.outbox === 'due') due.push(standing.entry)
  }
  return due
}
