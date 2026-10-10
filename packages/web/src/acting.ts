import type { Scope } from './surface.ts'

// What a paired device may *do*, as the one interface the window implements.
//
// **The mirror of `reading.ts`, and the same reason it is not a port.** R1's
// port is an interface plus a registry beside a conformance suite, because a
// port has implementations somebody chooses between. This has exactly one for
// ever: the window, which holds `tade.lock`, the pending approvals, the lane
// liveness and the task files. A registry would offer a choice nobody has.
//
// **It is a method per verb, and that is the whole design.** There is no
// `run(name, payload)`, no `call(tool, args)`, no path, no command and no
// settings route — not "they are refused", but *there is nowhere to put one*.
// A verb reaches the window only by somebody adding a method here and an entry
// to `VERBS` (`verbs.ts`), which is two lines a reviewer reads in the same
// diff as the argument for them. DESIGN.md §9.1's `never remote` lines are
// kept by this file having no shape they could arrive in:
//
// - no `startAgent`, which is the one verb that turns text into execution.
//   `steer` is a message into a conversation that is **already** running and
//   the window refuses it where no agent is;
// - no file path. The one verb that writes a file (`context`) names a **task
//   id** and the window works out where that task's own files are, so there
//   is no path on the wire to contain, no `..` to refuse and no symlink to
//   resolve — and the containment that is still owed is owed at the machine,
//   where the folder could be a link to somewhere else;
// - no command, so nothing to run;
// - no push, merge, review answer or check override;
// - no setting, no credential, no extension, no MCP server, no device and no
//   intake grant — the thing that grants authority is never reachable from
//   inside the authority it granted;
// - no reach into the `ToolHost`, which is a Unix socket in
//   `@tade/orchestrator` for the window's own children and is not this
//   (`test/separation.test.ts`).
//
// **Absent is the strongest answer.** With `surfaces.web.acting` off the
// window hands over no `WebActing` at all and `routesFor` puts no acting route
// in the table, so a crafted call meets the same `404` as a path nobody built.
// That is read-only enforced by absence, which is what Phase 1's guarantee was
// and what it stays whenever the setting is off.

/**
 * One verb's answer: what happened, in the words the device is told.
 *
 * `rev` is the entity's own revision **after** the act, so the page's next
 * frame is already consistent without waiting for a beat. `said` is Tade's own
 * sentence and never an exception's: a throw from the window becomes a `broke`
 * with a request id, and the detail goes in a `warning`.
 */
export interface Outcome {
  /** Whether the thing actually moved. `false` is an answer, not a failure. */
  did: boolean
  /** What is true now, as the verb's own entity revision. */
  rev: string
  /** Tade's own sentence about what happened. */
  said: string
}

/**
 * What the act was about, and what the caller had seen.
 *
 * Every verb carries these four, because every verb is **a target plus the
 * state it expects** — DECISIONS §4.6: the idempotency key is a fast path and
 * never the guarantee, and what makes a replay safe is that it meets a target
 * that has moved on. A verb that cannot be expressed this way does not ship.
 */
export interface Target {
  /** `<project>/<task>`. The project half is the per-project scope boundary. */
  task: string
  /** The entity revision the caller's screen was of. */
  was: string
}

/** Park a task, or pick it back up. The one verb that is a toggle. */
export interface ParkCall extends Target {
  parked: boolean
}

/** Allow or deny the approval an agent is held on. */
export interface AnswerCall extends Target {
  /**
   * The approval, by the id the harness gave it.
   *
   * **Named in the act rather than folded into `was`.** A revision can say
   * *an approval is waiting*; it cannot say *which*, and an agent that
   * finished one call and is now held on the next looks identical from a
   * revision. So the id travels with the act and the window compares it
   * against the approval it is actually holding — exact, with nothing
   * hashed and nothing that can collide.
   */
  approval: string
  allow: boolean
}

/** Say something to a running agent: an answer to its question, or a nudge. */
export interface SteerCall extends Target {
  /**
   * What to say, verbatim and bounded.
   *
   * **A message into a conversation that is already running, and never a
   * prompt that starts one.** There is no shape here that reaches
   * `startAgent`: the window refuses it where no agent is on the task
   * (`TaskFacts.agents`), and a harness that cannot take one is *named* in
   * the projection rather than having the words typed at its terminal from
   * away.
   */
  said: string
}

/** One choice about queued work: the queue's own words, for one task. */
export interface QueueCall extends Target {
  change: QueueAsk
}

/**
 * What a device may ask of queued work.
 *
 * `pause`, `resume`, `start` and `wait` are `QUEUE_CHANGES`' own words for one
 * piece of work, and they are *choices written down* — what starts is still
 * `readyToStart`'s to decide, and a paused or parked task that this says
 * `start` about still does not start. `first` is `order` with the list
 * computed at the machine out of the queue as it stands, because a list of
 * task ids in a body is the one shape that could reorder work in a project
 * this device may not see.
 *
 * What is **not** here: pausing or resuming a whole project. Those name no
 * task, and every verb is a target plus the state it expects — a
 * project-wide hold has no entity revision to echo back, so a replay of one
 * could not be told from a fresh ask. Outstanding, not decided against.
 */
export const QUEUE_ASKS = ['pause', 'resume', 'start', 'wait', 'first'] as const
export type QueueAsk = (typeof QUEUE_ASKS)[number]

/** Mark a task finished by hand, which is the one rule nothing derives. */
export interface DoneCall extends Target {
  /**
   * That somebody meant it.
   *
   * `true` and nothing else parses, so there is no body shape that means *do
   * not*: a field that could be `false` would be a confirmation a client
   * sends by accident and a reviewer reads as checked. The page's own second
   * tap is the other half, and neither stands in for the other.
   */
  confirm: true
  /** What it finished as, in the person's own words. Verbatim, bounded. */
  summary: string
}

/** Write something down about a task, exactly as it was sent. */
export interface NoteCall extends Target {
  text: string
}

/**
 * Add to what a task's agent is told.
 *
 * **An append, and the append is the design.** A replace would mean sending
 * the context's current text to the phone first, and this package has no way
 * to read one — `WebReading` answers out of what the window already holds
 * and no handler does any work — while for a task that came from outside
 * the machine the body is a stranger's words (`OUTSIDE_IS_MATERIAL`), which is
 * its own grant and its own conversation. So the act carries only what to add,
 * and what falls out is the property an If-Match was reaching for: **an append
 * cannot overwrite a local edit**, whatever somebody typed here meanwhile.
 */
export interface ContextCall extends Target {
  add: string
}

/** Approve a request that arrived from outside this machine. */
export interface IntakeCall extends Target {
  /**
   * That somebody meant it, for the reason `DoneCall` carries one: approving
   * a stranger's request into an agent on this machine is not a thing to do
   * by a mis-tap, and asking again does not undo it.
   */
  confirm: true
}

/**
 * Where an act came from, carried **into** the thing that does it.
 *
 * **Not a prompt line and not a convention: an argument.** DECISIONS §4.5 is
 * the correction this answers — a sentence telling a model that a request came
 * from a phone is information, and the enforcement has to be code the model
 * cannot talk its way past. The same holds one layer down for the journal: a
 * remote park recorded as `you` would make `historyFrom` count it as the
 * person's own doing, and would make a later `namedBy` look at a line nobody
 * said. So provenance is a parameter of every verb, the local path says
 * `local` with the same type, and `byOf` is the one place either becomes a
 * word in a record.
 */
export type From =
  /** The keyboard, the voice, the window's own controls. */
  | { how: 'local' }
  /** A paired device, by the id the machine gave it. Never its label. */
  | { how: 'remote'; device: string }

/**
 * What goes in a record's `by`, for either provenance.
 *
 * `you` for the keyboard, because that is the word every other door already
 * writes and `historyFrom` already reads as *something you did*. A device is
 * named by its id and never by its label: a label is a person's own words
 * about their own phone, and an id is 16 hex characters that mean nothing on
 * their own. The one thing neither ever becomes is a `said` line.
 */
export function byOf(from: From): string {
  return from.how === 'local' ? 'you' : `device ${from.device}`
}

/**
 * The verbs, one method each.
 *
 * **A method that does not exist cannot be reached** — by a bug, by a stolen
 * session, or by a route somebody added in a hurry. Every method here owes the
 * same three things, and they are the window's rather than the gate's because
 * only the window can do them:
 *
 * 1. **re-check the state at the moment of the act**, against `was`, and
 *    refuse with what is actually true (`Moved`);
 * 2. **do it atomically**, as atomically as the thing allows, with the honest
 *    limit written down rather than implied away (`parked.ts`);
 * 3. **carry `from` into the record** — a remote act is `device <id>` and
 *    never `you`, and never a `said` line.
 */
export interface WebActing {
  /**
   * Whether acting is still unlocked, read **at the act**.
   *
   * A function and not a flag: the route table was built when the window
   * started, and a person who turns the setting off wants that to mean
   * something before they next restart. The asymmetry is deliberate and is in
   * the setting's own words — turning it on waits for a restart, turning it
   * off is now.
   */
  unlocked(): boolean
  park(call: ParkCall, from: From): Promise<Outcome>
  answer(call: AnswerCall, from: From): Promise<Outcome>
  steer(call: SteerCall, from: From): Promise<Outcome>
  queue(call: QueueCall, from: From): Promise<Outcome>
  done(call: DoneCall, from: From): Promise<Outcome>
  note(call: NoteCall, from: From): Promise<Outcome>
  context(call: ContextCall, from: From): Promise<Outcome>
  intake(call: IntakeCall, from: From): Promise<Outcome>
}

/** That the thing moved on since the caller looked. Thrown by a verb. */
export class Moved extends Error {
  /** What is true now, so the page can draw the truth rather than an error. */
  readonly rev: string

  constructor(said: string, rev: string) {
    super(said)
    this.name = 'Moved'
    this.rev = rev
  }
}

/** That the thing the act names is not there at all. Thrown by a verb. */
export class NotThere extends Error {
  constructor(said: string) {
    super(said)
    this.name = 'NotThere'
  }
}

/**
 * That the verb exists and this device may not have it for *this* target.
 *
 * The one refusal a verb can raise that the gate could not: the gate knows the
 * scope, the project and the origin, and this is about what the target
 * **is** — work that came from outside the machine, which a request from away
 * may not approve (`parked.ts`'s `NotYours`). `out_of_scope` and not a `404`,
 * because the task is one this device can see and the honest answer is that it
 * was not granted that rather than that there is nothing there.
 */
export class OutOfScope extends Error {
  constructor(said: string) {
    super(said)
    this.name = 'OutOfScope'
  }
}

/**
 * That what was sent is longer than one act may carry.
 *
 * `too_big`, and the bound it is over is `BOUNDS`' — which is about a
 * *sentence* and not about a socket: `readBody`'s cap is the one that keeps a
 * request from being a denial of service, and this is the one that keeps an
 * append to a task's context from being an agent's instructions rewritten from
 * away. **Never a truncation**: half of what somebody wrote, written down
 * verbatim, is a lie about what they said.
 */
export class TooMuch extends Error {
  constructor(said: string) {
    super(said)
    this.name = 'TooMuch'
  }
}

/**
 * That the verb exists, the device may have it, and **this harness cannot do
 * it** — or there is nothing there to do it to.
 *
 * The one refusal whose answer is `not_offered`: a `404` with the same
 * sentence a path nobody built gets. The page is not supposed to reach this at
 * all — a task row carries what may be asked of it and what may not, with
 * the harness's own `why` (`Cannot` below), so an inert control is never drawn
 * — and the honest answer to a crafted call for something this harness has
 * no way of doing is that there is nothing here by that name.
 */
export class NotOffered extends Error {
  constructor(said: string) {
    super(said)
    this.name = 'NotOffered'
  }
}

/**
 * What may be asked of one task right now, and how it would happen.
 *
 * **The away view's own words, not a harness's.** `Support` is
 * `@tade/harnesses-core`'s vocabulary for the same question and this package
 * does not borrow it (R2): the window maps one onto the other, so a harness
 * gaining a fifth kind of support is a change in one place and not a new word
 * on the wire.
 */
export const HOWS = ['now', 'next-turn', 'restart'] as const
export type How = (typeof HOWS)[number]

/** One verb this task can be asked for, and when it would take effect. */
export interface Can {
  verb: string
  how: How
}

/**
 * One verb this task **cannot** be asked for, and why not.
 *
 * Named rather than passed over in silence, which is the rule the checks
 * reading already follows: what Tade cannot do is *said*, so the failure mode
 * is "the page told you this harness has no way to steer" rather than a
 * control that does nothing or an absence that reads as a bug. The sentence is
 * the harness's own `why` where it has one, and Tade's own where the reason is
 * Tade's — either way it is a sentence somebody wrote.
 */
export interface Cannot {
  verb: string
  why: string
}

/**
 * How much free text one act may carry, per verb.
 *
 * Bounded here rather than at the body reader, because the body's own cap
 * (`readBody`) is about a socket and these are about a *sentence*: a note is
 * something somebody typed on a phone, and a context block that was pages long
 * would be an agent's instructions rewritten from away under the heading of an
 * addition. Over the bound is `too_big` and never a silent truncation —
 * cutting somebody's words in half and writing them down verbatim is the one
 * thing a note may never be.
 */
export const BOUNDS = {
  /** A message into a running turn. Longer than a sentence, shorter than a brief. */
  said: 2_000,
  /** A note, which is the thing Tade is told rather than derives. */
  text: 4_000,
  /** What a person adds to a task's context from a phone. */
  add: 4_000,
  /** What a task finished as. A headline, not a report. */
  summary: 500,
} as const

/**
 * What a task's own revision is made of: **one field per thing a verb
 * assumes**, and nothing else.
 *
 * The rule for what belongs here is exactly that. A field no verb depends on
 * would refuse perfectly current acts every time a figure moved; a thing a
 * verb assumes and that is *not* here is a replay nothing refuses. Each line
 * below names the verb that needs it, which is how the next one gets added
 * honestly — and adding one changes every screen's value at once, so every act
 * in flight at that moment gets a `gone` and redraws. That is the right
 * failure for a deploy and the reason this is one function rather than a
 * convention.
 *
 * **Readable rather than hashed.** A digest would be shorter and would also
 * mean two different worlds could agree by collision, and the one thing a
 * revision decides is whether somebody's screen was telling the truth. What
 * cannot be said in a field this small is named in the act instead:
 * `AnswerCall.approval` carries the approval's own id, because *an approval is
 * waiting* and *this* approval is waiting are different facts.
 */
export interface TaskFacts {
  /** The told fact out of the task file, never `state === 'parked'`. `park`. */
  parked: boolean
  /** Whether an approval is waiting at all. `answer`. */
  approval: boolean
  /** Whether its agent asked something and is waiting. `steer`. */
  question: boolean
  /** How many agents are on it. A steer needs one; a start must not find one. */
  agents: number
  /** Whether the journal already says it is finished. `done`. */
  finished: boolean
  /** `QueueState`'s own word, or the empty string where it is not queued. `queue`. */
  queue: string
}

/** Nothing is waiting, nothing is running, and it is not queued work. */
export function noFacts(): TaskFacts {
  return {
    parked: false,
    approval: false,
    question: false,
    agents: 0,
    finished: false,
    queue: '',
  }
}

/**
 * A task's entity revision: short, opaque, and the same rule on both sides.
 *
 * The projection writes it onto every row and a device echoes it back as
 * `was`; the window builds it again out of the file and its own live state at
 * the moment of the write and refuses a mismatch. One function, so the two
 * cannot drift — two spellings of this would be a comparison that is always
 * true or always false, and neither failure would look like one.
 *
 * The letters are not vocabulary and nothing reads them back: it is a value to
 * echo, not a value to parse. What they buy over a digest is that a test can
 * say which fact moved, and that two worlds cannot agree by accident.
 */
export function taskRev(facts: TaskFacts): string {
  return [
    `p${facts.parked ? 1 : 0}`,
    `a${facts.approval ? 1 : 0}`,
    `q${facts.question ? 1 : 0}`,
    // Capped, because a count in a revision is about *whether what you saw is
    // still true* and a task with nine agents and one with ten are the same
    // answer to every verb here.
    `g${Math.min(Math.max(Math.trunc(facts.agents), 0), 9)}`,
    `f${facts.finished ? 1 : 0}`,
    `k${facts.queue || 'none'}`,
  ].join('.')
}

/** The project half of a task id, which is the per-project scope boundary. */
export function projectOf(task: string): string {
  const cut = task.indexOf('/')
  return cut <= 0 ? '' : task.slice(0, cut)
}

/** The scope each verb needs, for anything that wants to ask without the table. */
export type Needs = Scope
