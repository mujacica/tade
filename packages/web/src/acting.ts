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
// - no `startAgent`, which is the one verb that turns text into execution;
// - no file path, so no repository edit and no symlink to resolve;
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

/** Park a task, or pick it back up. */
export interface ParkCall extends Target {
  parked: boolean
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
 * What a task's own revision is made of, for the verbs there are.
 *
 * One field, and that is honest rather than thin: the only verb is park, the
 * only thing it assumes is the park, and an opaque digest over fields no verb
 * depends on would refuse perfectly current acts every time a figure moved.
 * When a verb arrives that assumes something else — an approval still
 * pending, a content hash still matching — it goes in here, every screen's
 * value changes once, and every act in flight at that moment gets a `gone`
 * and redraws. That is the right failure for a deploy and the reason this is
 * one function rather than a convention.
 */
export interface TaskFacts {
  /** The told fact out of the task file, never `state === 'parked'`. */
  parked: boolean
}

/**
 * A task's entity revision: short, opaque, and the same rule on both sides.
 *
 * The projection writes it onto every row and a device echoes it back as
 * `was`; the window builds it again from the file at the moment of the write
 * and refuses a mismatch. One function, so the two cannot drift — two
 * spellings of this would be a comparison that is always true or always
 * false, and neither failure would look like one.
 */
export function taskRev(facts: TaskFacts): string {
  return facts.parked ? 'p1' : 'p0'
}

/** The project half of a task id, which is the per-project scope boundary. */
export function projectOf(task: string): string {
  const cut = task.indexOf('/')
  return cut <= 0 ? '' : task.slice(0, cut)
}

/** The scope each verb needs, for anything that wants to ask without the table. */
export type Needs = Scope
