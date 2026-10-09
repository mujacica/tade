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
  /** How many replies have gone back about it, and when, newest last. */
  replies: number[]
  at: number
}

const MODES = new Set<string>(INTAKE_MODES)
const REFUSALS = new Set<string>(INTAKE_REFUSALS)

/**
 * What the journal says about every external thing Tade has been handed.
 *
 * Additive: it reads four event types that nothing wrote before this and
 * ignores everything else, so a journal written before intake existed folds to
 * an empty map and every existing fold over the same events is untouched.
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
      at,
    }
    one.at = Number.isFinite(at) ? at : one.at
    if (type === 'intake_replied') {
      if (Number.isFinite(at)) one.replies.push(at)
      items.set(item, one)
      continue
    }
    if (text(event.detail.revision)) one.revision = text(event.detail.revision)
    if (text(event.detail.project)) one.project = text(event.detail.project)
    if (text(event.detail.requester)) one.requester = text(event.detail.requester)
    if (text(event.detail.hash)) one.hash = text(event.detail.hash)
    if (text(event.detail.ref)) one.ref = text(event.detail.ref)
    if (text(event.detail.url)) one.url = text(event.detail.url)
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

// --- what may be said back

/**
 * The only things a reply ever says. A fixed set of sentences Tade generates,
 * with no agent prose, no diff, no log line, no file name and no repository
 * content in any of them.
 *
 * **Acknowledgement is not acceptance, and acceptance is not execution**, so
 * there is a word for each and no copy may blur them: `noticed` is that a look
 * found it, `accepted` is that a task exists, `started` is that an agent is
 * running. "We'll run it when you're back" is not in the list and never will
 * be — a sleeping laptop runs nothing and promises nothing.
 */
export const INTAKE_SAYINGS = ['noticed', 'proposed', 'accepted', 'started'] as const
export type IntakeSaying = (typeof INTAKE_SAYINGS)[number]

export function intakeSays(
  saying: IntakeSaying,
  facts: { task: string | null; machine: string },
): string {
  const where = facts.machine ? ` on ${facts.machine}` : ''
  switch (saying) {
    case 'noticed':
      return `Picked up${where}.`
    case 'proposed':
      return `Picked up${where}. Waiting for a person to approve it.`
    case 'accepted':
      return `Queued as ${facts.task ?? 'a task'}${where}.`
    case 'started':
      return `Working on ${facts.task ?? 'it'}${where}.`
  }
}

/**
 * How many replies about one thing a window may still post, counted the way
 * `attemptsUnder` counts starts: over a day, per external item.
 *
 * Three, because the three facts worth saying are picked up, queued and done,
 * and a fourth is a conversation Tade is not having.
 */
export const INTAKE_REPLY_CAP = 3
export const INTAKE_REPLY_HOURS = 24

export function intakeRepliesLeft(one: IntakeItem | undefined, now: number): number {
  const since = now - INTAKE_REPLY_HOURS * 3_600_000
  const recent = (one?.replies ?? []).filter((at) => at >= since).length
  return Math.max(0, INTAKE_REPLY_CAP - recent)
}
