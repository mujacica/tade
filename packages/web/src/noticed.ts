import { type AttentionSettings, inQuietHours, type TaskState } from '@tade/core'
import type { TaskIn } from './input.ts'
import { type Reach, sees } from './reach.ts'

// What is worth waking a phone for, what it is allowed to say, and everything
// that stops one being sent. Pure: facts in, a notice or nothing out — no
// clock read, no I/O, no async.
//
// ## Why this is not `decideAttention`, and what it borrows from it
//
// `decideAttention` answers *how loudly* — speak, earcon, silent — and that is
// a different question from this one, because a notification has exactly one
// loudness. A phone either buzzes or nothing happened. So the **selection** is
// here and it is a shorter list than voice's: five transitions somebody who is
// out of the room would want to know about. Reusing `SPOKEN_STATES` would have
// got two of them wrong in the quiet direction — `task_done` is `notable`, so
// a finished piece of work would be an earcon and a phone would never hear
// about it.
//
// What it **does** borrow is every limit, out of the same `AttentionSettings`
// the earbud reads: the hourly budget, the quiet hours (through
// `inQuietHours`, which is exported so there is one rule about midnight rather
// than two) and the presence window. A second set of quiet hours for phones is
// the drift `@tade/core`'s `attention.ts` is kept in one piece to prevent.
//
// ## Presence is read wider here, and that is deliberate
//
// Voice drops *the focused task* to an earcon while you type in its lane: the
// question there is which lane has your attention. A notification is for
// somebody who is **not here at all**, so the question is only whether they
// are — any keypress in the window inside `focusWindowMs` and nothing is sent
// about anything. That is the whole of "no spam while the user is active", and
// it is why `push`'s window in `DEFAULT_ATTENTION` is two minutes rather than
// thirty seconds: somebody at the keyboard is at the keyboard between
// keystrokes.
//
// ## What a notification says
//
// `PUSH_SAYS_NOTHING` is the sentence and this is where it is true. A generic
// payload carries a count and a word Tade wrote — never a project, a task id,
// a title, a branch, an approval's summary, a note, a line of a conversation
// or a character of anybody's code. With details turned on it carries the
// **name of the work** and nothing else, and even that is narrowed by what the
// device was granted to read, so the detailed payload of a phone that may not
// read titles is the generic one.
//
// One notification per beat per device, coalesced, which is both the honest
// shape and the anti-spam rule: four things happening at once is one buzz
// saying four things happened, not four buzzes.

/** The five transitions a phone is for. */
export const HAPPENINGS = ['wants', 'stuck', 'held', 'red', 'done'] as const
export type Happening = (typeof HAPPENINGS)[number]

/**
 * What Tade says about one of them, in its own words, with no name in it.
 *
 * Singular and plural written out rather than built, because "1 pieces of
 * work" is the bug a count and a suffix always eventually produces.
 */
const SAYS: Readonly<Record<Happening, { one: string; many: (count: number) => string }>> = {
  wants: { one: 'wants your answer', many: (n) => `${n} want your answer` },
  stuck: { one: 'has stopped and needs you', many: (n) => `${n} have stopped and need you` },
  held: { one: 'is held and will not start', many: (n) => `${n} are held and will not start` },
  red: { one: 'has gone red', many: (n) => `${n} have gone red` },
  done: { one: 'has finished', many: (n) => `${n} have finished` },
}

/**
 * What a task is, as this file reads one.
 *
 * The fields the projection already has (`TaskIn`), named here so that nothing
 * in this file can reach a title it was not handed and so a test can hand it
 * five facts rather than a whole row.
 */
export interface TaskNow {
  id: string
  /** Which project it belongs to, which is the per-device read boundary. */
  project: string
  /** `deriveState`'s own answer. */
  state: TaskState
  /** Whether an approval is waiting. The tool's name is never read here. */
  waiting: boolean
  /** Whether the journal already says it is finished. */
  finished: boolean
  /** The queue's own word, or empty for work that is not queued. */
  queue: string
  /** What the work is called, for a detailed payload only. May be empty. */
  title: string
}

/** One task's facts as the last beat saw them. What a transition is *from*. */
export interface TaskWas {
  state: TaskState
  waiting: boolean
  finished: boolean
  queue: string
}

/**
 * One projected task as this file reads one.
 *
 * The seam, in one function, so nothing downstream reaches a `TaskIn` field it
 * was not meant to: five values out of a row that has forty. `title` is read
 * here and is only ever *used* under a grant and a setting — the narrowing is
 * at the payload (`bodyOf`) rather than here, because a row withheld at this
 * end would make a transition on a task whose name is not granted invisible
 * rather than generic.
 */
export function noticeable(task: TaskIn): TaskNow {
  return {
    id: task.id,
    project: task.project,
    state: task.state,
    // An approval waiting, which is a different fact from `question`: an agent
    // that asked something in words is not an agent whose tool call is held.
    waiting: task.approval !== null,
    finished: task.finished,
    queue: task.queue,
    title: task.title,
  }
}

/** The facts of one task, kept between beats. */
export function wasOf(task: TaskNow): TaskWas {
  return {
    state: task.state,
    waiting: task.waiting,
    finished: task.finished,
    queue: task.queue,
  }
}

/** One thing that happened to one task. */
export interface Change {
  task: string
  /**
   * The project it is in.
   *
   * Here because a notification is **per device** and a read scope is too: a
   * phone granted one of five projects must not be told that something in the
   * other four wants you, and a count is still a fact about work it cannot
   * see. `changesFor` is the narrowing, and it is applied before the budget so
   * that one device's silence is not another's spent allowance.
   */
  project: string
  what: Happening
  /** What the work is called, or empty. Only ever used under a details grant. */
  title: string
}

/**
 * What changed between two beats, as the transitions a phone is for.
 *
 * **Transitions, never states**, which is the whole of "notifications for
 * supported actual transitions": a task that has been blocked for an hour is
 * not news, and a loop over what is blocked *now* would send that hour's worth
 * every beat. A task the last beat had never seen is **not** a transition
 * either — a window that has just opened would otherwise notify about
 * everything that was already true, which is the one shape that gets a feature
 * turned off in its first minute.
 *
 * `was` being empty is therefore silence, and that is the same decision as
 * `PUSH_IS_WHILE_OPEN`'s *nothing is caught up*: a window coming back says
 * what happens next, not what happened while it was shut.
 */
export function changesBetween(
  was: ReadonlyMap<string, TaskWas>,
  now: readonly TaskNow[],
): Change[] {
  const out: Change[] = []
  for (const task of now) {
    const before = was.get(task.id)
    if (before === undefined) continue
    const what = happened(before, task)
    if (what === null) continue
    out.push({ task: task.id, project: task.project, what, title: task.title })
  }
  return out
}

/**
 * The one transition this task made, or null.
 *
 * Ordered, and the order is what somebody would want to be told first: an
 * approval waiting beats everything, because it is the only one where work is
 * standing still until a person answers. A task can only ever produce one
 * notice per beat — two would be two buzzes about one thing.
 */
function happened(was: TaskWas, now: TaskNow): Happening | null {
  // **Wants you**: an approval that was not waiting a beat ago and is now.
  // Read off `waiting` rather than off `blocked`, because a task can be
  // blocked for several reasons and only one of them is a question.
  if (now.waiting && !was.waiting) return 'wants'
  // **Done**: the journal saying so (`task_done`), or a branch that landed —
  // and **either** of them counts as already done, in both directions. A task
  // marked finished and then merged is one notification, and so is one merged
  // and then marked: read as two conditions it would be two buzzes about the
  // same piece of work finishing, which is exactly the shape somebody would
  // write and nobody would notice.
  if (done(now) && !done(was)) return 'done'
  // **Red**: `deriveState`'s own `failed`.
  if (now.state === 'failed' && was.state !== 'failed') return 'red'
  // **Held**: the queue's own word, which is a different fact from a state —
  // work that will not start is not work that stopped.
  if (now.queue === 'held' && was.queue !== 'held') return 'held'
  // **Stuck**: blocked without a question, which is a turn that ended with
  // something undone. Last, so a blocked task with an approval is `wants`.
  if (now.state === 'blocked' && was.state !== 'blocked' && !now.waiting) return 'stuck'
  return null
}

/** Whether this is work that has finished, by either of the two things that say so. */
function done(task: TaskWas): boolean {
  return task.finished || task.state === 'merged'
}

/**
 * The changes one device may be told about: the ones in projects it reads.
 *
 * **Per device, and before everything else.** The collections are built once
 * for every phone — they are the window's own, not a projection — so the
 * transitions have to be narrowed here or a device scoped to one project would
 * be told, as a count, that something somewhere else wants you. A count is
 * still a fact about work a device cannot see.
 *
 * `every` is the ordinary case and short-circuits, so the phone that can read
 * everything pays one comparison.
 */
export function changesFor(changes: readonly Change[], reach: Reach): Change[] {
  if (reach.projects.kind === 'every') return [...changes]
  return changes.filter((change) => sees(reach, change.project))
}

/** Everything that decides whether a notice is sent, and what it may say. */
export interface Noticing {
  now: number
  /** The limits, out of the same settings the earbud reads. */
  settings: AttentionSettings
  /** How many notifications went out in the last hour, for the budget. */
  sentInLastHour: number
  /** When somebody last typed in the window, or null where nothing says. */
  lastInputAt: number | null
  /** The local hour, passed in so the same inputs give the same answer. */
  localHour: number
  /** Whether a notification may name the work: the setting and the grant. */
  details: boolean
  /** Keys already notified, so one thing is one notification. */
  already: ReadonlySet<string>
}

/** What one device is sent, or why nothing is. */
export type Noticed =
  | { send: true; notice: Notice; keys: readonly string[] }
  | { send: false; why: string }

/**
 * A notification, as the bytes that go on the wire.
 *
 * Three fields and no more: there is no icon path, no url, no data and no
 * action. A payload with a `url` in it would be a notification that opens a
 * deep link — which is a project and a task in something a push service keeps,
 * and the page already opens where it was last left.
 */
export interface Notice {
  /** The heading. Always Tade's own name: never a project, never a task. */
  title: string
  /** The line under it. A count and a word Tade wrote, or a name under a grant. */
  body: string
  /**
   * The tag the phone replaces by.
   *
   * One tag for everything, so a phone that was away for an hour has **one**
   * notification rather than a column of them. A tag per task would be the
   * stack this exists to avoid, and would also put a task id in something the
   * push service keeps.
   */
  tag: string
}

/** The one tag, and the one title. Tade's own words, and not configurable. */
export const NOTICE_TAG = 'tade'
export const NOTICE_TITLE = 'Tade'

/**
 * Whether these changes are worth one notification, and what it says.
 *
 * The order of the refusals is the order somebody debugging this asks them in,
 * and each is a sentence rather than a boolean because every one of them ends
 * up in a `warning` or in the journal: *nothing changed*, *you are at the
 * keyboard*, *quiet hours*, *the budget*, and *every one of these has already
 * been sent*.
 */
export function noticeFor(changes: readonly Change[], noticing: Noticing): Noticed {
  if (changes.length === 0) return { send: false, why: 'nothing changed' }
  // **Presence first**, because it is the cheapest and the one that is true
  // most often: somebody at the keyboard can see all of this on the screen in
  // front of them.
  if (
    noticing.lastInputAt !== null &&
    noticing.now - noticing.lastInputAt <= noticing.settings.focusWindowMs
  ) {
    return { send: false, why: 'you are at the keyboard' }
  }
  if (inQuietHours(noticing.settings.quiet, noticing.localHour)) {
    return { send: false, why: 'quiet hours' }
  }
  // The budget, read the way voice reads it: at the budget, not over it.
  if (noticing.sentInLastHour >= noticing.settings.budget) {
    return { send: false, why: `hourly budget of ${noticing.settings.budget} reached` }
  }
  // **Dedupe before the payload is built**, so a beat whose every change has
  // already been sent is silence rather than a notification saying nothing new.
  const fresh = changes.filter((change) => !noticing.already.has(keyOf(change)))
  if (fresh.length === 0) return { send: false, why: 'already sent' }
  return {
    send: true,
    notice: { title: NOTICE_TITLE, body: bodyOf(fresh, noticing.details), tag: NOTICE_TAG },
    keys: fresh.map(keyOf),
  }
}

/**
 * The key one change is remembered by: the task and what happened to it.
 *
 * The task id is in the key and **never in a payload**: this is a value kept
 * in the window's own memory, which is the one place a task id is already
 * everywhere. Keyed by both halves, so a task that goes red, is fixed and goes
 * red again is two notifications, and a task that is blocked across twenty
 * beats is one.
 */
export function keyOf(change: Change): string {
  return `${change.task}\n${change.what}`
}

/**
 * The line under the heading.
 *
 * One kind of change is that kind's own sentence; several is a count and the
 * worst of them, in `HAPPENINGS` order — which is the order somebody would
 * want them. **No name unless details are on**, and no name at all for more
 * than one: a notification that listed three task names would be the whole of
 * what is on a phone's lock screen for anybody who picked it up.
 */
function bodyOf(changes: readonly Change[], details: boolean): string {
  const worst = HAPPENINGS.find((what) => changes.some((change) => change.what === what))
  // Unreachable while `Change.what` is a `Happening`, and answered rather than
  // asserted: a notification that threw would be a beat that threw.
  if (worst === undefined) return 'something happened'
  const mine = changes.filter((change) => change.what === worst)
  const says = SAYS[worst]
  const others = changes.length - mine.length
  const also = others === 0 ? '' : `, and ${others} other${others === 1 ? '' : 's'}`
  if (mine.length === 1) {
    const one = mine[0]
    const named = details && one !== undefined && one.title !== '' ? `${one.title} ` : ''
    // `Work wants your answer` with nothing granted; `api-v2 wants your
    // answer` with a title and the setting on.
    return `${named === '' ? 'Work ' : named}${says.one}${also}`
  }
  return `${says.many(mine.length)}${also}`
}
