import { TaskId } from '@tade/core'
import { z } from 'zod'
import {
  BOUNDS,
  type From,
  type Outcome,
  projectOf,
  QUEUE_ASKS,
  type QueueAsk,
  type WebActing,
} from './acting.ts'
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
 * Free text somebody typed, bounded and **never trimmed into meaning**.
 *
 * `min(1)` after the trim, so a body of spaces is a `malformed` rather than a
 * note of nothing or an empty message delivered into a turn. What is *stored*
 * is what arrived: `trim` here decides whether there is anything to say, and
 * the verb carries the original. A silent truncation is the one thing this may
 * never do — over the bound is `too_big`, because half of what somebody
 * wrote, written down verbatim, is a lie about what they said.
 */
function authored(bound: number) {
  return z
    .string()
    .max(bound)
    .refine((text) => text.trim() !== '', { message: 'say something' })
}

const AnswerBody = z.strictObject({
  ...Every,
  /** The approval, by the harness's own id for it. Compared, never parsed. */
  approval: z.string().min(1).max(200),
  allow: z.boolean(),
})

const SteerBody = z.strictObject({ ...Every, said: authored(BOUNDS.said) })

const QueueBody = z.strictObject({ ...Every, change: z.enum(QUEUE_ASKS) })

const DoneBody = z.strictObject({
  ...Every,
  /** `true` and nothing else: there is no shape of this body that means *do not*. */
  confirm: z.literal(true),
  /** What it finished as. Optional, because a person may have nothing to add. */
  summary: z.string().max(BOUNDS.summary).default(''),
})

const NoteBody = z.strictObject({ ...Every, text: authored(BOUNDS.text) })

const ContextBody = z.strictObject({ ...Every, add: authored(BOUNDS.add) })

const IntakeBody = z.strictObject({ ...Every, confirm: z.literal(true) })

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
 * Allow or deny what an agent is held on.
 *
 * `answer` and not `steer`: §9.1's matrix puts answering a question that is
 * already waiting at the gentler tier, because it chooses between two things
 * the agent itself offered and changes nothing Tade would start by itself. A
 * device granted `answer` and nothing else can do this and cannot park, steer,
 * reorder or finish anything.
 *
 * **The approval's own id is in the payload**, so a key bound to allowing one
 * call is not a key that allows the next one.
 */
export const ANSWER: Verb = {
  name: 'answer',
  needs: 'answer',
  about: 'allow or deny what an agent is waiting on',
  read(body) {
    const got = AnswerBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return {
      ok: true,
      asked: {
        verb: 'answer',
        task: call.task,
        project: projectOf(call.task),
        was: call.was,
        key: call.key,
        rev: call.rev,
        payload: `approval=${call.approval}\nallow=${call.allow}`,
        said: call.allow ? 'allowed' : 'denied',
        run: (acting, from) =>
          acting.answer(
            { task: call.task, was: call.was, approval: call.approval, allow: call.allow },
            from,
          ),
      },
    }
  },
}

/**
 * Say something to an agent that is running.
 *
 * `steer` — it is the tier's own verb. What it is **not** is a way to start
 * work: the window refuses it where no agent is on the task, and a harness
 * with no way to take a message is named on the row rather than having the
 * words typed at its terminal from away.
 *
 * The words are the payload, so two different messages are two acts and the
 * same message twice is one.
 */
export const STEER: Verb = {
  name: 'steer',
  needs: 'steer',
  about: 'say something to an agent that is running',
  read(body) {
    const got = SteerBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return {
      ok: true,
      asked: {
        verb: 'steer',
        task: call.task,
        project: projectOf(call.task),
        was: call.was,
        key: call.key,
        rev: call.rev,
        payload: `said=${call.said}`,
        // Tade's own word for what was asked for, and **never the message
        // itself**: this is what goes in the journal line and in the receipt,
        // and what somebody typed on a phone is not a record Tade writes
        // about them.
        said: 'told its agent something',
        run: (acting, from) =>
          acting.steer({ task: call.task, was: call.was, said: call.said }, from),
      },
    }
  },
}

/**
 * Tade's own word for each queue choice, for the journal and the receipt.
 *
 * A switch rather than a table, so a sixth choice in `QUEUE_ASKS` fails to
 * compile here instead of reaching the journal as `undefined`.
 */
function saidQueue(change: QueueAsk): string {
  switch (change) {
    case 'pause':
      return 'paused in the queue'
    case 'resume':
      return 'back on in the queue'
    case 'start':
      return 'may start as soon as there is room'
    case 'wait':
      return 'waits again'
    case 'first':
      return 'put first among the ready'
  }
}

/**
 * One choice about queued work.
 *
 * `steer`, because every one of them changes what Tade will start by itself.
 * **It writes a choice down and starts nothing**: `readyToStart` is still the
 * rule, so `start` on work that is paused, parked or waiting on something is a
 * line in the journal and not an agent — which is the whole reason this is
 * the queue's own door rather than a start.
 */
export const QUEUE: Verb = {
  name: 'queue',
  needs: 'steer',
  about: 'pause, resume, reorder or let queued work start',
  read(body) {
    const got = QueueBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return {
      ok: true,
      asked: {
        verb: 'queue',
        task: call.task,
        project: projectOf(call.task),
        was: call.was,
        key: call.key,
        rev: call.rev,
        payload: `change=${call.change}`,
        said: saidQueue(call.change),
        run: (acting, from) =>
          acting.queue({ task: call.task, was: call.was, change: call.change }, from),
      },
    }
  },
}

/**
 * Mark a task finished by hand.
 *
 * `steer`, because whatever waits on this task starts from it: a `task_done`
 * line is the thing the queue reads, so marking one finished can set four
 * other pieces of work going. That is the argument for the tier and the
 * argument for `confirm`.
 *
 * **It is the one rule nothing derives**, so this is a person saying so and is
 * recorded as a device having said so — never as `rule`, which is Tade
 * having seen a task's own rule met.
 */
export const DONE: Verb = {
  name: 'done',
  needs: 'steer',
  about: 'mark a task finished, which starts whatever waits on it',
  read(body) {
    const got = DoneBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return {
      ok: true,
      asked: {
        verb: 'done',
        task: call.task,
        project: projectOf(call.task),
        was: call.was,
        key: call.key,
        rev: call.rev,
        payload: `summary=${call.summary}`,
        said: 'marked finished',
        run: (acting, from) =>
          acting.done(
            { task: call.task, was: call.was, confirm: true, summary: call.summary },
            from,
          ),
      },
    }
  },
}

/**
 * Write a note down about a task, exactly as it arrived.
 *
 * `steer`, because a note is read by every agent that starts afterwards
 * (`composeAgentPrompt`), which makes it the gentlest way to change what work
 * gets done.
 *
 * **It is a note and it is never a `said` line.** `said` has one writer and
 * `namedBy` reads those lines to authorise settings changes; a note is the
 * thing Tade is *told*, kept verbatim with who told it, and the `by` on this
 * one is the device. The two are different records and this is the second.
 */
export const NOTE: Verb = {
  name: 'note',
  needs: 'steer',
  about: 'write something down about a task, as you wrote it',
  read(body) {
    const got = NoteBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return {
      ok: true,
      asked: {
        verb: 'note',
        task: call.task,
        project: projectOf(call.task),
        was: call.was,
        key: call.key,
        rev: call.rev,
        payload: `text=${call.text}`,
        said: 'wrote a note',
        run: (acting, from) =>
          acting.note({ task: call.task, was: call.was, text: call.text }, from),
      },
    }
  },
}

/**
 * Add to what a task's agent is told.
 *
 * `steer`, and an **append**: there is no field here for what the context
 * should become, so nothing a device sends can overwrite what somebody typed
 * at the machine. `acting.ts`'s `ContextCall` has the argument for why that is
 * the design rather than a limitation.
 */
export const CONTEXT: Verb = {
  name: 'context',
  needs: 'steer',
  about: 'add to what a task’s agent is told',
  read(body) {
    const got = ContextBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return {
      ok: true,
      asked: {
        verb: 'context',
        task: call.task,
        project: projectOf(call.task),
        was: call.was,
        key: call.key,
        rev: call.rev,
        payload: `add=${call.add}`,
        said: 'added to its context',
        run: (acting, from) =>
          acting.context({ task: call.task, was: call.was, add: call.add }, from),
      },
    }
  },
}

/**
 * Approve work that arrived from outside this machine.
 *
 * `answer`, which is the tier for answering something that is already waiting
 * — and it is the one verb here whose target is somebody else's request, so
 * it carries two re-checks the others do not need and that only the machine
 * can make: **the local grant must still allow it**, and **the source must
 * still say what it said**. Both are asked at the moment of the act
 * (`intakeStands`), and a source that cannot be reached holds rather than
 * passes, which is the one direction this has to get right.
 *
 * It **creates no grant**: the thing that grants authority is never reachable
 * from inside the authority it granted. A device can approve what a person at
 * this machine already allowed, and nothing else.
 */
export const INTAKE: Verb = {
  name: 'intake',
  needs: 'answer',
  about: 'approve a request that came from outside this machine',
  read(body) {
    const got = IntakeBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return {
      ok: true,
      asked: {
        verb: 'intake',
        task: call.task,
        project: projectOf(call.task),
        was: call.was,
        key: call.key,
        rev: call.rev,
        payload: 'approve',
        said: 'approved what came from outside',
        run: (acting, from) =>
          acting.intake({ task: call.task, was: call.was, confirm: true }, from),
      },
    }
  },
}

/**
 * The verbs there are, and the whole of what a paired device may ever do.
 *
 * Eight, and the order is the order they arrived in rather than a ranking:
 * park went first because it was the smallest act that proved the path, and
 * the rest are §9.1's matrix filled in. What they have in common is the shape
 * the first one established — a target, the state it expects, and a method on
 * `WebActing` — and what they have in common is also the limit: **none of them
 * takes a path, a command, a credential, a setting or a prompt**, and the
 * three §9.1 calls `never remote` are absent rather than refused. There is no
 * push, no merge, no check override, no account change, no grant and no new
 * agent, because there is no method here one could be called through.
 *
 * Three in the matrix are deliberately not here, each for a reason that is not
 * "nobody got to it":
 *
 * - **a whole project's queue, paused or resumed.** It names no task, so it
 *   has no entity revision to echo and no replay could be told from a fresh
 *   ask.
 * - **a diff, a review's text, a lane's output.** Each ships source or an
 *   agent's bytes to a phone and to a browser cache; that is a *reading*
 *   grant with its own threat model (`fields.ts`'s `NEVER_A_FIELD`), not a
 *   verb.
 * - **stopping an agent.** It is not a hold and not undoable by the same
 *   verb, and what a person wants after one is usually the lane in front of
 *   them.
 */
export const VERBS: readonly Verb[] = [PARK, ANSWER, STEER, QUEUE, DONE, NOTE, CONTEXT, INTAKE]

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
