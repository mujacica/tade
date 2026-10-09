import { TaskId } from '@tade/core'
import { z } from 'zod'
import { type From, type Outcome, projectOf, type WebActing } from './acting.ts'
import type { Scope } from './surface.ts'

// Every verb a paired device may ask for, as a closed table.
//
// **Deny by default, and the table is the whole of it.** A name that is not
// here is not a verb: `verbFor` answers nothing, `routesFor` puts no path in
// the route table for it, and the request is the same `404` as a path nobody
// built. There is no handler that takes a name and dispatches on it, which is
// why there is no shape in this package that a generic "run this" could arrive
// in — the nearest thing to one would be a route taking a verb and a payload
// of `unknown`, and the table below is what it was replaced with.
//
// **Every verb is a target plus the state it expects.** DECISIONS §4.6: the
// idempotency key is a fast path and never the guarantee. What makes a captured
// `POST` safe to replay — after the key has fallen out of memory, after a
// restart, after the receipts file was deleted — is that the act names what it
// assumed and the window re-checks it at the moment of the act. A verb that
// cannot be expressed that way does not ship, and `test/verbs.test.ts` asserts
// every entry's body schema carries `task` and `was`.
//
// **Parsing ends in a closure.** `read` turns a body into an `Asked` that
// already knows how to do itself, so nothing downstream of this file ever
// switches on a verb's name. The payload a key is bound to is `canonical`,
// built here from the parsed fields and never from the bytes that arrived — two
// bodies that differ only in whitespace or key order are the same act, and two
// that differ in a field are not.
//
// Pure: a body in, an `Asked` or nothing out. What the `Asked` does when it is
// run belongs to whoever hands it a `WebActing`.

/**
 * The idempotency key, as the client mints one.
 *
 * Bounded and dull on purpose. The server never derives a key — a key the
 * server made would be a key the client cannot repeat, which is the one thing
 * a key is for — and it never trusts one either: what a key *means* is decided
 * by what it is bound to (`receipts.ts`), not by what it says.
 */
export const KEY = /^[A-Za-z0-9_-]{8,64}$/

/** The entity revision a caller echoes back. Opaque, short, and theirs. */
const Was = z.string().min(1).max(64)

/** What every verb's body carries, whatever else it carries. */
const Every = {
  task: TaskId,
  was: Was,
  key: z.string().regex(KEY),
  /**
   * The projection revision the caller's screen was of.
   *
   * The **global** clock, and it is deliberately not the only check: a
   * projection revision moves when anything anywhere moves, so on a busy
   * machine it is stale within seconds and would refuse acts that are
   * perfectly current. What it is good for is catching a screen that is
   * genuinely old — a tab left open overnight — before the entity check has to
   * explain itself. `was` is the one that decides.
   */
  rev: z.int().nonnegative(),
}

const ParkBody = z.strictObject({
  ...Every,
  /** What it should become. The verb does both directions, because a park is one toggle. */
  parked: z.boolean(),
})

/**
 * One asked-for act, parsed, bound and ready.
 *
 * `payload` is the canonical form of the verb's own fields and is what the
 * idempotency key is bound to, together with the device, the verb and the
 * target. `run` is the only thing in this package that reaches a `WebActing`.
 */
export interface Asked {
  verb: string
  task: string
  project: string
  was: string
  key: string
  rev: number
  /** The verb's own fields, in a fixed order. Never the bytes that arrived. */
  payload: string
  /** Tade's own words for what this asks for. The journal's and the receipt's. */
  said: string
  /**
   * Do it. The only thing in this package that reaches a `WebActing`.
   *
   * `from` is a parameter rather than something the window infers, because
   * what a verb does with it is write it down — and a provenance that could be
   * forgotten is one that will be, in the commit that adds the second caller.
   */
  run(acting: WebActing, from: From): Promise<Outcome>
}

/** What reading a body came to. Nothing is an answer; it is a `malformed`. */
export type Reading = { ok: true; asked: Asked } | { ok: false }

/** One verb: what it is called, what it needs, and how a body becomes one. */
export interface Verb {
  /** The last segment of its path, and the word in the journal. */
  name: string
  /**
   * The scope a device needs for it, out of §9.1's matrix.
   *
   * Declared per verb and not per route table, which is why there is a route
   * each: the guard's scope check is exact, so a device granted `answer` and
   * not `steer` cannot park anything even though both are "acting".
   */
  needs: Scope
  /** What it is, in a sentence, for anything that lists the verbs. */
  about: string
  read(body: unknown): Reading
}

export const PARK: Verb = {
  name: 'park',
  // `steer` and not `answer`: §9.1's matrix puts park/unpark at the steer tier,
  // because setting work aside changes what Tade will start by itself, and
  // answering a question that is already waiting does not.
  needs: 'steer',
  about: 'set a task aside, or pick it back up',
  read(body) {
    const got = ParkBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return {
      ok: true,
      asked: {
        verb: 'park',
        task: call.task,
        project: projectOf(call.task),
        was: call.was,
        key: call.key,
        rev: call.rev,
        payload: `parked=${call.parked}`,
        said: call.parked ? 'parked' : 'picked back up',
        run: (acting, from) =>
          acting.park({ task: call.task, was: call.was, parked: call.parked }, from),
      },
    }
  },
}

/**
 * The verbs there are.
 *
 * One, and the order of arrival is the argument: park and unpark is the
 * smallest verb that proves a real workbench act end to end — it is told
 * rather than derived, it is already a hold with queue semantics behind it, it
 * has exactly one bit of state to expect, and undoing it is the same verb. The
 * rest of §9.1's matrix — answering an approval, answering a question,
 * steering an agent, a note, the context file — arrives in the slices that own
 * those, each as a line here and a method on `WebActing`.
 */
export const VERBS: readonly Verb[] = [PARK]

/** The verb of that name, or null. The one lookup, and it is closed. */
export function verbFor(name: string): Verb | null {
  return VERBS.find((verb) => verb.name === name) ?? null
}

/**
 * The canonical thing a key is bound to: the device, the verb, the target and
 * the payload, in that order.
 *
 * **Written out rather than hashed here**, so that what is compared is
 * readable in a test and in the receipts file. A digest of it is what
 * `receipts.ts` keeps, and the point of this function is that the four things
 * are joined by a separator none of them can contain: a device id is 16 hex
 * characters, a verb is a name out of the table above, a task id is `TaskId`'s
 * own regex, and a payload is built field by field above.
 */
export function boundTo(device: string, asked: Asked): string {
  return [device, asked.verb, asked.task, asked.payload].join('\n')
}
