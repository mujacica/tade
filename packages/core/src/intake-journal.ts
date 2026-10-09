import type { TadeEvent } from './events.ts'
import {
  INTAKE_MODES,
  INTAKE_REFUSALS,
  type IntakeMode,
  type IntakeRefusal,
  type IntakeSource,
  newerRevision,
  revisionUncomparable,
} from './intake.ts'

// What the journal says about what has been handed to this machine, and the
// arithmetic of what to do about one that did not work.
//
// Its own file because it is the half that is *about the journal* rather than
// about an envelope: a fold, two rules read off that fold, and nothing that
// knows what a request contains. The other half (`intake.ts`) is the envelope,
// the keys and the rule that reads a grant, and neither needs the other except
// for a comparison of revisions.
//
// Pure: events in, facts out. No clock — every one of these takes `now`.

// --- what the journal says

/** Where one external thing stands, folded out of the journal. */
export interface IntakeItem {
  /** `<source>:<externalId>`, across every revision. */
  item: string
  source: string
  externalId: string
  /** The newest revision Tade has seen, whether or not it was acted on. */
  revision: string
  /** The revision the task was made for; empty when none was. */
  taken: string
  project: string
  requester: string
  /** The grant that allowed it, where one did. */
  grant: string
  /**
   * The published template and the version resolved at the moment of
   * accepting, where one was stamped out.
   *
   * Folded rather than looked up again, and that is the point: a draft moves
   * on and a newer version is published, so asking the store today would
   * answer about this week's shape rather than about what this work was
   * actually made from. The line that wrote it down is the only thing that
   * knows.
   */
  template: { name: string; version: number } | null
  /**
   * The source's own stable reference to the raw material — a node id, a
   * permalink, the spool file the local door wrote.
   *
   * Carried so a surface can say *where the request is* without Tade keeping a
   * second copy of it. Never a path Tade took from a caller: it comes off the
   * delivery's own line in the journal.
   */
  ref: string
  /** The source's own page for it, where it has one a person could open. */
  url: string
  /**
   * The one id per external delivery, carried on every line about it.
   *
   * Folded because a status said back about one request has to carry the same
   * id as the delivery that made it: by the time a status is due the candidate
   * is long gone, and only the journal still knows.
   */
  correlation: string
  /**
   * The watch it came through, as `<extension>.<id>`, and the schedule that
   * watch runs as.
   *
   * Written down rather than worked out later, because by the time the queue
   * asks whether a request still stands there is nothing left to work it out
   * from: the schedule may have been renamed, paused or removed, and a task
   * whose source cannot be identified has to hold rather than start.
   */
  watch: string
  schedule: string
  mode: IntakeMode | null
  /** The task made for it, or the first of a plan's. Null while nothing was made. */
  task: string | null
  /** Every task made for it, in the order they were written down. */
  tasks: string[]
  state: 'received' | 'refused' | 'accepted'
  /** Why it was refused, where it was. */
  why: IntakeRefusal | null
  /** The hash of the body the task was made from, for seeing that the text has moved. */
  hash: string
  /** How many times carrying it out has failed since the last one that worked. */
  attempts: number
  /** When the last attempt failed, as a time. Zero when none has. */
  failedAt: number
  /** What went wrong last, where something did. */
  problem: string | null
  /** True once Tade has stopped trying, which is a thing somebody has to see. */
  gaveUp: boolean
  /** When each status that actually went out went, newest last. What the cap counts. */
  replies: number[]
  /**
   * One record per status Tade has tried to say back about it, in the order
   * they were first tried.
   *
   * **The outbox is this and nothing else.** There is no table of pending
   * posts: what has gone, what failed and how often is folded out of the
   * `intake_replied` lines, so dedupe survives a restart, a deleted index and
   * a journal copied to another machine. `intake-outbox.ts` is the arithmetic
   * over it.
   */
  said: IntakeReply[]
  at: number
}

/**
 * What came of one status Tade meant to say back.
 *
 * Both halves are kept, because they answer different questions: `sent` is
 * whether the source has it — which is what dedupe reads — and `attempts` with
 * `problem` is why somebody at this machine is looking at a request whose
 * requester was never told anything, which is what the inbox draws.
 */
export interface IntakeReply {
  /** Which of the fixed sentences, as `IntakeSaying` names them. */
  saying: string
  /** True once it went, or once the source turned out to have it already. */
  sent: boolean
  /** True where the source already had it: a window that died after posting. */
  already: boolean
  /** The source's own id for what was created, where it gave one. */
  posted: string
  /**
   * The revision the source reported once the status was posted, where the
   * transport could say.
   *
   * **This is what keeps Tade's own words from being news to Tade.** Posting a
   * comment moves `updated_at` on a GitHub issue, and a moved revision is how
   * an edit is noticed — so without this, a status going out would read on the
   * next look as somebody having rewritten the request, and would put back the
   * approval a person had just given. Written down here, `intakeAgain` knows
   * its own.
   */
  revision: string
  /** How many times posting it has failed since the last try that worked. */
  attempts: number
  /** When the last try failed, as a time. Zero when none has. */
  failedAt: number
  /** What went wrong last, where something did. */
  problem: string | null
  /** When it went, or zero while it has not. */
  at: number
}

const MODES = new Set<string>(INTAKE_MODES)
const REFUSALS = new Set<string>(INTAKE_REFUSALS)

/**
 * What the journal says about every external thing Tade has been handed.
 *
 * Additive: it reads the five intake event types and ignores everything else,
 * so a journal written before intake existed folds to an empty map and every
 * existing fold over the same events is untouched.
 *
 * Pure: events in, facts out. The order of the lines is the order of the
 * truth, which is what makes a crash between two of them readable afterwards —
 * an `intake_received` with no `intake_accepted` or `intake_refused` after it
 * is a delivery that was interrupted, and `intakeUnfinished` is how the next
 * look finds it again.
 */
export function intakeFrom(events: readonly TadeEvent[]): Map<string, IntakeItem> {
  const items = new Map<string, IntakeItem>()
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  for (const event of events) {
    const type = event.type
    if (
      type !== 'intake_received' &&
      type !== 'intake_accepted' &&
      type !== 'intake_refused' &&
      type !== 'intake_held' &&
      type !== 'intake_replied'
    ) {
      continue
    }
    const item = text(event.detail.item)
    if (!item) continue
    const at = Date.parse(event.ts)
    const was = items.get(item)
    const one: IntakeItem = was ?? {
      item,
      source: text(event.detail.source),
      externalId: text(event.detail.external_id),
      revision: '',
      taken: '',
      project: '',
      requester: '',
      grant: '',
      template: null,
      ref: '',
      url: '',
      correlation: '',
      watch: '',
      schedule: '',
      mode: null,
      task: null,
      tasks: [],
      state: 'received',
      why: null,
      hash: '',
      attempts: 0,
      failedAt: 0,
      problem: null,
      gaveUp: false,
      replies: [],
      said: [],
      at,
    }
    one.at = Number.isFinite(at) ? at : one.at
    if (type === 'intake_replied') {
      foldReply(one, event, Number.isFinite(at) ? at : one.at)
      items.set(item, one)
      continue
    }
    if (text(event.detail.revision)) one.revision = text(event.detail.revision)
    if (text(event.detail.project)) one.project = text(event.detail.project)
    if (text(event.detail.requester)) one.requester = text(event.detail.requester)
    if (text(event.detail.hash)) one.hash = text(event.detail.hash)
    if (text(event.detail.ref)) one.ref = text(event.detail.ref)
    if (text(event.detail.url)) one.url = text(event.detail.url)
    if (text(event.detail.correlation)) one.correlation = text(event.detail.correlation)
    if (text(event.detail.watch)) one.watch = text(event.detail.watch)
    if (text(event.detail.schedule)) one.schedule = text(event.detail.schedule)
    if (type === 'intake_received') {
      one.state = 'received'
      one.why = null
    } else if (type === 'intake_refused') {
      one.state = 'refused'
      const why = text(event.detail.why)
      one.why = REFUSALS.has(why) ? (why as IntakeRefusal) : null
      // The sentence the refusal was made in, kept: the four the rule writes
      // can be said again from the code that wrote them, and a person's own
      // cannot — their words exist nowhere but on this line.
      one.problem = text(event.detail.because) || text(event.detail.problem) || one.problem
    } else if (type === 'intake_accepted') {
      one.state = 'accepted'
      one.why = null
      one.taken = text(event.detail.revision) || one.taken
      one.grant = text(event.detail.grant) || one.grant
      const template = text(event.detail.template)
      const version = event.detail.version
      if (template && typeof version === 'number' && Number.isInteger(version) && version > 0) {
        one.template = { name: template, version }
      }
      const mode = text(event.detail.mode)
      one.mode = MODES.has(mode) ? (mode as IntakeMode) : one.mode
      const tasks = Array.isArray(event.detail.tasks) ? event.detail.tasks.map(String) : []
      const made = event.task ? [event.task, ...tasks.filter((id) => id !== event.task)] : tasks
      for (const id of made) if (!one.tasks.includes(id)) one.tasks.push(id)
      one.task = one.tasks[0] ?? one.task
      // Carried out, so whatever was failing is over: a hold that healed must
      // not keep counting against the next one.
      one.attempts = 0
      one.failedAt = 0
      one.problem = null
      one.gaveUp = false
    } else {
      one.attempts += 1
      one.failedAt = Number.isFinite(at) ? at : one.failedAt
      one.problem = text(event.detail.problem) || one.problem
      if (event.detail.gave_up === true) one.gaveUp = true
    }
    items.set(item, one)
  }
  return items
}

/**
 * One `intake_replied` line, folded into the record of that saying.
 *
 * **A line is written after the thing happened and never before**, which is
 * the journal's own rule, so there is no "about to post" state to interpret:
 * a status that went has a line saying so, a try that failed has a line saying
 * that, and a window that died between the post and the append has **no** line
 * — which reads as due again, and the transport recognising Tade's own marker
 * is what keeps that from posting twice.
 *
 * **A line with no `state` is one that went.** Those are the lines written
 * before a failure could be recorded at all, and they were only ever written
 * on success — so an old journal folds to exactly what it meant.
 */
function foldReply(one: IntakeItem, event: TadeEvent, at: number): void {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  const unsent = text(event.detail.state) === 'unsent'
  const saying = text(event.detail.saying)
  if (!saying) {
    // A line that does not say which status it was still says that something
    // left this machine, so it counts against the cap. Counting it is the safe
    // direction: not counting it would let a journal nobody can read say
    // *more*, and the one thing a bound must never do is quietly widen.
    if (!unsent) one.replies.push(at)
    return
  }
  let record = one.said.find((kept) => kept.saying === saying)
  if (!record) {
    record = {
      saying,
      sent: false,
      already: false,
      posted: '',
      revision: '',
      attempts: 0,
      failedAt: 0,
      problem: null,
      at: 0,
    }
    one.said.push(record)
  }
  if (unsent) {
    record.attempts += 1
    record.failedAt = at
    record.problem = text(event.detail.problem) || record.problem
    return
  }
  record.sent = true
  record.at = at
  record.already = event.detail.already === true
  record.posted = text(event.detail.posted) || record.posted
  record.revision = text(event.detail.revision) || record.revision
  // Whatever was failing is over, and a try that healed must not count
  // against anything: the same call `intake_accepted` makes about a delivery.
  record.problem = null
  one.replies.push(at)
}

/** What an intake-originated task belongs to, or null when a task is nobody's intake. */
export function intakeOf(items: ReadonlyMap<string, IntakeItem>, task: string): IntakeItem | null {
  for (const one of items.values()) if (one.tasks.includes(task)) return one
  return null
}

/**
 * How many times carrying one delivery out is tried before Tade stops, and how
 * long it waits between tries.
 *
 * **Bounded, because a request somebody is waiting on is not a Sentry issue.**
 * The existing watches write a failed start down as found and move on, which is
 * right for a source that will send another one: another error will happen. It
 * is wrong for a ticket — one transient failure and the request is silently
 * gone, and nobody will file it twice. So an interrupted delivery keeps its
 * item key and is tried again.
 *
 * **And it stops.** Three tries, a minute apart at least, and then a record
 * saying Tade gave up and why — `watch_found` with the problem, which burns the
 * revision's key so the next look does not start the same storm, plus a held
 * line somebody can see. The failure mode that is not allowed is the silent
 * one in either direction: neither a retry every ten minutes for ever, nor a
 * request that vanished with nothing written down.
 */
export const INTAKE_ATTEMPTS = 3
export const INTAKE_RETRY_MS = 60_000

export type IntakeNext =
  /** Try again now. */
  | { next: 'retry'; attempt: number }
  /** Wait: the last failure is too recent to be worth another identical try. */
  | { next: 'wait'; until: number }
  /** Stop, and say so. */
  | { next: 'give up'; because: string }

/** Whether an interrupted delivery is tried again now, waits, or is given up on. */
export function intakeNext(one: IntakeItem | undefined, now: number): IntakeNext {
  const attempts = one?.attempts ?? 0
  if (one?.gaveUp) {
    return { next: 'give up', because: one.problem ?? 'it has already been given up on' }
  }
  if (attempts >= INTAKE_ATTEMPTS) {
    return {
      next: 'give up',
      because: `carrying it out failed ${attempts} times; the last was: ${one?.problem ?? 'unsaid'}`,
    }
  }
  const failedAt = one?.failedAt ?? 0
  const since = now - failedAt
  // A failure in the future is a clock that moved, not a minute that has not
  // passed — so it is tried again rather than waited on for ever. `since < 0`
  // is the only reading of that which does not strand the request.
  if (failedAt > 0 && since >= 0 && since < INTAKE_RETRY_MS) {
    return { next: 'wait', until: failedAt + INTAKE_RETRY_MS }
  }
  return { next: 'retry', attempt: attempts + 1 }
}

/**
 * What a new revision of something already taken means for the task that
 * exists: nothing, a hold, or a question nobody can answer.
 *
 * **Never a second workflow.** One active intake per external id — a comment on
 * something already taken is not intake, and an edit is not a second ticket.
 * What an edit *is* is grounds to stop: the approval a person gave was about
 * text that has moved, and the snapshot the plan was filled from is about a
 * body with a different hash.
 */
export type IntakeAgain =
  /** The same revision, or an older one: nothing happened. */
  | { again: 'ignore'; because: string }
  /** Newer: whatever was approved was approved about different words. */
  | { again: 'invalidate'; because: string }
  /** Not comparable: somebody has to say. */
  | { again: 'hold'; because: string }

export function intakeAgain(
  one: IntakeItem,
  candidate: { source: IntakeSource; revision: string; material: { hash: string } },
): IntakeAgain {
  const taken = one.taken || one.revision
  // **Tade's own words are never news to Tade.** Posting a status moves the
  // revision at a source that counts comments as changes, and a moved revision
  // is how an edit is noticed — so without this, a reply going out would read
  // on the next look as somebody having rewritten the request, put back the
  // approval a person had just given, and do it again every time it said so.
  // The loop is closed by the record rather than by a clock or a sentence
  // match: the revision each reply moved the thing to is written down beside
  // it, and the hash is the independent check that the words themselves have
  // not moved since.
  // A reply with no revision reported matches nothing: `said.revision` is
  // empty where the transport could not say, and comparing an empty one would
  // make every such reply claim whatever revision it was asked about.
  const mine = one.said.find(
    (said) => said.sent && said.revision !== '' && said.revision === candidate.revision,
  )
  if (mine && (!one.hash || one.hash === candidate.material.hash)) {
    return {
      again: 'ignore',
      because: `revision ${candidate.revision} is the one Tade's own ${mine.saying} status moved ${one.externalId} to, and its text has not changed`,
    }
  }
  const order = newerRevision(candidate.source, candidate.revision, taken)
  if (order === null) {
    return {
      again: 'hold',
      because: revisionUncomparable(candidate.source, candidate.revision, taken),
    }
  }
  if (order <= 0) {
    return {
      again: 'ignore',
      because: `revision ${candidate.revision} is not newer than ${taken}, which is already taken`,
    }
  }
  const moved = one.hash && one.hash !== candidate.material.hash ? ' and its text has changed' : ''
  return {
    again: 'invalidate',
    because: `${one.externalId} is now revision ${candidate.revision}, not ${taken}${moved}: whatever was approved was approved about the earlier words`,
  }
}
