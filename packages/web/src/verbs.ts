import { MACHINE_NAMED, TaskId, THINKING_LEVELS } from '@tade/core'
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
// **Every verb is a target plus the state it expects.** The
// idempotency key is a fast path and never the guarantee. What makes a captured
// `POST` safe to replay — after the key has fallen out of memory, after a
// restart, after the receipts file was deleted — is that the act names what it
// assumed and the window re-checks it at the moment of the act. A verb that
// cannot be expressed that way does not ship, and `test/verbs.test.ts` asserts
// every entry's body schema carries its target — `task`, or `project` for the
// two that are about a whole project — and `was`.
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

const StopBody = z.strictObject({ ...Every, confirm: z.literal(true) })

const ReopenBody = z.strictObject({ ...Every })

const StartBody = z.strictObject({ ...Every })

const RemoveBody = z.strictObject({ ...Every, confirm: z.literal(true) })

const RenameBody = z.strictObject({ ...Every, title: authored(BOUNDS.title) })

/**
 * A name out of a list the machine itself offered, never free text: bounded,
 * and the characters a model id, an account name or a harness id are made of.
 * The window asks the list again at the act, so a name that is the right shape
 * and in no list is refused there.
 */
const Named = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/)

const ModelBody = z.strictObject({ ...Every, model: Named })

const ThinkingBody = z.strictObject({ ...Every, level: z.enum(THINKING_LEVELS) })

/** `''` is the harness's own sign-in, which has no name of Tade's. */
const AccountBody = z.strictObject({ ...Every, account: z.union([z.literal(''), Named]) })

const HarnessBody = z.strictObject({
  ...Every,
  harness: z
    .string()
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
})

const MoveBody = z.strictObject({
  ...Every,
  machine: z.string().regex(MACHINE_NAMED),
  confirm: z.literal(true),
})

/**
 * What a verb about a whole project carries: the project instead of a task.
 *
 * The name is the config's own rule for one (`projects.<name>`), so a body
 * cannot name a path, a task or a key path into the config — and it is the
 * per-project scope boundary itself, asked of the device's reading reach at
 * the gate exactly as a task's project half is.
 */
const OnProject = {
  project: z
    .string()
    .max(200)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  was: Was,
  key: z.string().regex(KEY),
  rev: z.int().nonnegative(),
}

const CloseBody = z.strictObject({ ...OnProject, confirm: z.literal(true) })

const OpenBody = z.strictObject({ ...OnProject })

/**
 * One asked-for act, parsed, bound and ready.
 *
 * `payload` is the canonical form of the verb's own fields and is what the
 * idempotency key is bound to, together with the device, the verb and the
 * target. `run` is the only thing in this package that reaches a `WebActing`.
 */
export interface Asked {
  verb: string
  /** The task, or the empty string for a verb about a whole project. */
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
   * What kind of act it is (`SCOPES`): every paired device may do every one,
   * and the kind is what the guard asks an act of — a trusted origin, a
   * session not paired in the clear and, from the public name, the passkey.
   */
  needs: Scope
  /** What it is, in a sentence, for anything that lists the verbs. */
  about: string
  /**
   * What it is about: one task, or one whole project.
   *
   * Declared rather than read off a body, so a row can say what may be asked
   * of it over exactly the verbs that are about it — a task's `can` and
   * `cannot` cover every `task` verb and a project's every `project` one, and
   * neither carries the other's.
   */
  on: 'task' | 'project'
  read(body: unknown): Reading
}

export const PARK: Verb = {
  name: 'park',
  // `steer` and not `answer`: the scope matrix puts park/unpark at the steer tier,
  // because setting work aside changes what Tade will start by itself, and
  // answering a question that is already waiting does not.
  needs: 'steer',
  about: 'set a task aside, or pick it back up',
  on: 'task',
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
 * **The approval's own id is in the payload**, so a key bound to allowing one
 * call is not a key that allows the next one.
 */
export const ANSWER: Verb = {
  name: 'answer',
  needs: 'steer',
  about: 'allow or deny what an agent is waiting on',
  on: 'task',
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
  on: 'task',
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
    case 'drop':
      return 'no longer waits on a machine silent for days'
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
  on: 'task',
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
  on: 'task',
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
  on: 'task',
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
  on: 'task',
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
  needs: 'steer',
  about: 'approve a request that came from outside this machine',
  on: 'task',
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
 * Stop a task's agent. Its lane ends; the lane's spec, its conversation, its
 * branch and its worktree all stay, and `reopen` puts it back.
 *
 * **Two presses and a literal**, like `done`: what a turn was in the middle of
 * is not undone by opening the agent again.
 */
export const STOP: Verb = {
  name: 'stop',
  needs: 'agents',
  about: 'stop a task’s agent, keeping its lane’s spec so it can be opened again',
  on: 'task',
  read(body) {
    const got = StopBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return {
      ok: true,
      asked: {
        verb: 'stop',
        task: call.task,
        project: projectOf(call.task),
        was: call.was,
        key: call.key,
        rev: call.rev,
        payload: 'stop',
        said: 'stopped its agent',
        run: (acting, from) => acting.stop({ task: call.task, was: call.was, confirm: true }, from),
      },
    }
  },
}

/**
 * Open a task's stopped agent again where it left off, saying nothing to it.
 *
 * `agents`, the same decision as `stop` from the other side. **Never a new
 * agent**: the window refuses it where none has ever run, so what this can
 * bring up is a conversation that already existed and nothing else.
 */
export const REOPEN: Verb = {
  name: 'reopen',
  needs: 'agents',
  about: 'open a stopped agent again where it left off, saying nothing to it',
  on: 'task',
  read(body) {
    const got = ReopenBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return {
      ok: true,
      asked: {
        verb: 'reopen',
        task: call.task,
        project: projectOf(call.task),
        was: call.was,
        key: call.key,
        rev: call.rev,
        payload: 'reopen',
        said: 'opened its agent again',
        run: (acting, from) => acting.reopen({ task: call.task, was: call.was }, from),
      },
    }
  },
}

/**
 * Take a project off Tade's list: the window's own close, which deletes
 * nothing and stops nothing.
 *
 * `projects`, implied by nothing: it changes what every surface here draws,
 * and the project's own settings go with its line. **Two presses and a
 * literal**, for that last reason.
 *
 * The first verb whose target is not a task, so `task` is empty and the
 * project is the target — the gate's per-project boundary asks the name
 * itself, and the journal line carries it in its detail rather than on the
 * event, where every fold keyed by task would read it as one.
 */
export const CLOSE: Verb = {
  name: 'close',
  needs: 'projects',
  about: 'close a project, which deletes nothing and stops none of its agents',
  on: 'project',
  read(body) {
    const got = CloseBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return {
      ok: true,
      asked: {
        verb: 'close',
        task: '',
        project: call.project,
        was: call.was,
        key: call.key,
        rev: call.rev,
        payload: 'close',
        said: 'closed the project',
        run: (acting, from) =>
          acting.close({ project: call.project, was: call.was, confirm: true }, from),
      },
    }
  },
}

/**
 * Put a closed project back where the journal says it was.
 *
 * `projects`, the same decision as `close`. There is no path in the body, so
 * what a device can open is a project Tade has had and nothing else.
 */
export const OPEN: Verb = {
  name: 'open',
  needs: 'projects',
  about: 'open a closed project again, where it was when it closed',
  on: 'project',
  read(body) {
    const got = OpenBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return {
      ok: true,
      asked: {
        verb: 'open',
        task: '',
        project: call.project,
        was: call.was,
        key: call.key,
        rev: call.rev,
        payload: 'open',
        said: 'opened the project again',
        run: (acting, from) => acting.open({ project: call.project, was: call.was }, from),
      },
    }
  },
}

/** One task's own act, built the same way for every agent verb below. */
function onTaskOf(
  verb: string,
  call: { task: string; was: string; key: string; rev: number },
  payload: string,
  said: string,
  run: Asked['run'],
): Reading {
  return {
    ok: true,
    asked: {
      verb,
      task: call.task,
      project: projectOf(call.task),
      was: call.was,
      key: call.key,
      rev: call.rev,
      payload,
      said,
      run,
    },
  }
}

/**
 * Start a task's agent: the window's own Start agent, saying nothing to it.
 *
 * `agents`, beside `stop` and `reopen`, and the same decision from its third
 * side. **There is no opening instruction in it** (`StartAgentCall`): where an
 * agent ran it comes back where it left off, and where none did one starts on
 * what its task already said at the machine — so the text an agent acts on is
 * never a device's. Refused where it is running, for work that is queued (the
 * queue's own Start now is its door) and for work that came from outside until
 * it is approved (`intake`).
 */
export const START: Verb = {
  name: 'start',
  needs: 'agents',
  about: 'start a task’s agent, saying nothing to it: where it left off if it ran before',
  on: 'task',
  read(body) {
    const got = StartBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return onTaskOf('start', call, 'start', 'started its agent', (acting, from) =>
      acting.start({ task: call.task, was: call.was }, from),
    )
  },
}

/**
 * Close a task's agent for good: stopped, off the list, its worktree and
 * branch removed — the window's Remove agent.
 *
 * Two presses and a literal: it deletes work that may not be merged anywhere.
 */
export const REMOVE: Verb = {
  name: 'remove',
  needs: 'agents',
  about: 'close a task’s agent for good, removing its worktree and branch',
  on: 'task',
  read(body) {
    const got = RemoveBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return onTaskOf('remove', call, 'remove', 'removed its agent', (acting, from) =>
      acting.remove({ task: call.task, was: call.was, confirm: true }, from),
    )
  },
}

/** What an agent is called: the task file's title, told to its session where the harness can take it. */
export const RENAME: Verb = {
  name: 'rename',
  needs: 'agents',
  about: 'change what a task’s agent is called',
  on: 'task',
  read(body) {
    const got = RenameBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return onTaskOf('rename', call, `title=${call.title}`, 'renamed its agent', (acting, from) =>
      acting.rename({ task: call.task, was: call.was, title: call.title }, from),
    )
  },
}

/** Switch a running agent's model, among what its own harness offers. */
export const MODEL: Verb = {
  name: 'model',
  needs: 'agents',
  about: 'switch a running agent to another model its harness offers',
  on: 'task',
  read(body) {
    const got = ModelBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return onTaskOf('model', call, `model=${call.model}`, 'switched its model', (acting, from) =>
      acting.model({ task: call.task, was: call.was, model: call.model }, from),
    )
  },
}

/** How hard a running agent thinks, among the levels its harness offers. */
export const THINKING: Verb = {
  name: 'thinking',
  needs: 'agents',
  about: 'change how hard a running agent thinks',
  on: 'task',
  read(body) {
    const got = ThinkingBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return onTaskOf(
      'thinking',
      call,
      `level=${call.level}`,
      'changed how hard it thinks',
      (acting, from) =>
        acting.thinking({ task: call.task, was: call.was, level: call.level }, from),
    )
  },
}

/**
 * Run an agent as another account of its harness, by name: it decides whose
 * sign-in and whose plan the work is paid from, and no credential crosses.
 */
export const ACCOUNT: Verb = {
  name: 'account',
  needs: 'agents',
  about: 'run an agent as another account of its harness, its conversation with it',
  on: 'task',
  read(body) {
    const got = AccountBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return onTaskOf(
      'account',
      call,
      `account=${call.account}`,
      'moved it to another account',
      (acting, from) =>
        acting.account({ task: call.task, was: call.was, account: call.account }, from),
    )
  },
}

/** Run an agent in another harness. */
export const HARNESS: Verb = {
  name: 'harness',
  needs: 'agents',
  about: 'run an agent in another harness, starting it again there if it is running',
  on: 'task',
  read(body) {
    const got = HarnessBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return onTaskOf(
      'harness',
      call,
      `harness=${call.harness}`,
      'moved it to another harness',
      (acting, from) =>
        acting.harness({ task: call.task, was: call.was, harness: call.harness }, from),
    )
  },
}

/**
 * Hand a running agent to another of the person's machines: the window's own
 * Hand to, in two presses: the work goes
 * to a machine the device names, which is where its project is checked out
 * already and nowhere else.
 */
export const MOVE: Verb = {
  name: 'move',
  needs: 'agents',
  about: 'hand a running agent to another of your machines that has its project',
  on: 'task',
  read(body) {
    const got = MoveBody.safeParse(body)
    if (!got.success) return { ok: false }
    const call = got.data
    return onTaskOf(
      'move',
      call,
      `machine=${call.machine}`,
      'handed it to another machine',
      (acting, from) =>
        acting.move({ task: call.task, was: call.was, machine: call.machine, confirm: true }, from),
    )
  },
}

/**
 * The verbs there are, and the whole of what a paired device may ever do.
 *
 * Twenty, and the order is the order they arrived in rather than a ranking:
 * park went first because it was the smallest act that proved the path, the
 * next seven are the scope matrix filled in, the next four are the lifecycle
 * — an agent stopped and opened again, a project closed and opened again —
 * and the last eight are the rest of the window's own agent menu, so a phone
 * can do to an agent what a press on its row can. What they have in common is
 * the shape the first one established — a target, the state it expects, and a
 * method on `WebActing` — and what they have in common is also the limit:
 * **none of them takes a path, a command, a credential, a setting or a
 * prompt**. A model, an account, a harness or a machine is a *name* out of
 * what the machine itself offered, asked again at the act. There is no push, no merge, no check
 * override, no grant and no opening instruction, because there is no method
 * here one could be called through.
 *
 * Two in the matrix are deliberately not here, each for a reason that is not
 * "nobody got to it":
 *
 * - **a whole project's queue, paused or resumed.** It names no task, so it
 *   has no entity revision to echo and no replay could be told from a fresh
 *   ask — `projectRev` is about whether a project is open, not its queue.
 * - **a diff, a review's text, a lane's output.** Each ships source or an
 *   agent's bytes to a phone and to a browser cache; that is a *reading*
 *   with its own threat model (`fields.ts`'s `NEVER_A_FIELD`), not a verb.
 *   The first and the third are now readings of their own (`changes.ts`,
 *   `screen.ts`, cleaned at the boundary) and are still no verb: nothing writes a file or types into a
 *   lane from away, and what a person says to an agent goes through `steer`
 *   or through Tade.
 *
 * **Stopping an agent used to be the third**, because it was not a hold and
 * not undoable by the same verb. It is here now as half of a pair: `reopen`
 * undoes it, the act names *which* run it stops (`TaskFacts.starts`) so a
 * replay cannot stop the agent somebody opened since, it takes two presses,
 * and it is a scope of its own that nothing implies.
 */
export const VERBS: readonly Verb[] = [
  PARK,
  ANSWER,
  STEER,
  QUEUE,
  DONE,
  NOTE,
  CONTEXT,
  INTAKE,
  STOP,
  REOPEN,
  CLOSE,
  OPEN,
  START,
  REMOVE,
  RENAME,
  MODEL,
  THINKING,
  ACCOUNT,
  HARNESS,
  MOVE,
]

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
 *
 * The target is the project for a verb about a whole project, which cannot be
 * mistaken for a task: a project's name has no `/` in it and a task's id
 * always has one.
 */
export function boundTo(device: string, asked: Asked): string {
  return [device, asked.verb, targetOf(asked), asked.payload].join('\n')
}

/** What an act is about: its task, or its project where it is about a whole one. */
export function targetOf(asked: Pick<Asked, 'task' | 'project'>): string {
  return asked.task === '' ? asked.project : asked.task
}
