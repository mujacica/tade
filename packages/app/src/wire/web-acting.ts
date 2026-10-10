import {
  type Asker,
  type Config,
  type InboxRow,
  orderFirst,
  type Queued,
  type TadeEvent,
} from '@tade/core'
import {
  type AnswerCall,
  allowDevice,
  byOf,
  type ContextCall,
  type Device,
  type DoneCall,
  type From,
  type IntakeCall,
  Moved,
  type NoteCall,
  NotOffered,
  NotThere,
  type Outcome,
  OutOfScope,
  type ParkCall,
  type QueueCall,
  type SteerCall,
  type TaskFacts,
  TooMuch,
  taskRev,
  type WebActing,
} from '@tade/web'
import {
  addToContext,
  approveIntake,
  ContextNotOurs,
  ContextTooBig,
  type IntakeDoors,
  inboxFrom,
  NoTaskFile,
  NoTaskFolder,
  NotYours,
  ParkMovedOn,
} from '@tade/workbench'
import type { Steering } from '../away.ts'

// The window's end of acting: what a verb actually does, and the one door a
// device's scope widens through.
//
// **Its own file, and the seam is the point.** What the away view is *handed*
// is exactly this — a `WebActing` with a method per verb and nothing else on
// it. A `WebActing` that was the whole `Away` subject would put the pairing
// panel, the device file, the projectors and the streams one property access
// away from a route, which is the shape a route somebody added in a hurry gets
// through. Here the route can reach the verbs and nothing besides.
//
// Everything in this file owes the three things only the window can do, and
// `acting.ts` is where they are written down: re-check the state the act
// named, against the file, at the moment of the write; do it as atomically as
// the thing allows; and carry the provenance into the record.
//
// ## The two checks, and which one each verb leans on
//
// Every verb here makes the **same first check**: the revision the device
// echoed back (`was`) against the revision the projection would put on that
// row now (`onTask`). That one is about *the screen* — a tab from two
// minutes ago, a control drawn before somebody at the keyboard did something
// — and it is exact, because both sides are `taskRev` over the same facts
// the row was built from.
//
// What it is **not** is a lock. The projection moves on a beat, so between the
// check and the write there is up to one beat of world, and a check made over
// values that are at most one beat old cannot be the thing that makes an act
// atomic. That is the door's, and every verb below says which door and what it
// guarantees:
//
// | verb | what makes it safe at the moment of the write |
// |---|---|
// | `park` | `setParked`'s compare-and-set, under `aloneOn`, against the file |
// | `answer` | the supervisor holds the request by id; a decision for one that has gone throws |
// | `steer` | the registry answers whether a lane is alive; a dead one is refused, never typed at |
// | `queue` | nothing, and nothing is needed: every choice folds to the same answer twice |
// | `done` | the journal, read here: a second `task_done` is refused rather than appended |
// | `note`, `context` | an append, which cannot lose what somebody else wrote |
// | `intake` | `whyNotAct` on the row, plus the grant and the source, all at the act |
//
// A verb whose answer to that column is "nothing" and whose effect is not
// idempotent does not belong in this file.

/**
 * What a verb needs of the window: a few doors, and no path among them.
 *
 * **Named one by one rather than the workbench itself**, which is the same
 * decision `reading.ts` makes about the projection. What acting is handed is
 * these doors; a parameter typed as the facade would mean every verb here sat
 * one property access away from `startAgent`, the account doors, the setting
 * writers and the lane registry — and the away view's whole claim is that
 * there is nowhere for those to arrive from.
 */
export interface ActingDeps {
  /** The workbench's own doors, and only these. */
  tade: ActingDoors
  /** Whether the setting is on, read **at the act** and never cached. */
  acting: () => boolean
  /**
   * What the projection last said about this task.
   *
   * **The same value the row carried**, which is what makes the `was` check
   * exact rather than approximate: a mismatch means the world moved since the
   * row was drawn and never that two sides spell a revision differently. Null
   * for a task the projection does not have, which is a `404`.
   */
  seen: (task: string) => TaskFacts | null
  /** How this task's agent may be told something, as its harness says. */
  steering: (task: string) => Steering
  /**
   * Why work that came from outside may not go ahead now, or null.
   *
   * The queue's own question (`intakeStands`): the grant, the plan, and the
   * source asked again. Only a window can answer it, because it needs the
   * extension host that can reach the watch.
   */
  stands: (row: InboxRow) => Promise<string | null>
  /**
   * The queue as the window holds it, for the one choice that needs the list.
   *
   * `first` is an order, and an order is a list of task ids — which is
   * exactly what a device never sends. So the list comes from here, out of
   * what the window already folded for its own drawing, and `orderFirst` is
   * the queue's own rule applied to it. Both halves, so the order a phone asks
   * for and the order the window's own control writes are the same function of
   * the same facts.
   */
  queue: () => { items: readonly Queued[]; events: readonly TadeEvent[] }
  /**
   * The config as the **window** has it, read at the act.
   *
   * A function and not a value, and the window's rather than the workbench's:
   * a setting changed while Tade has been open is in the window's config and
   * not in the one the workbench was opened with, and a grant is permission at
   * the moment of acting. The one verb that reads it is `intake`, where the
   * answer decides whether a stranger's request goes ahead.
   */
  config: () => Config
  /** The moment, so nothing here reads a clock of its own. */
  now: () => number
}

/** The workbench doors one verb or another needs. Nothing else of it. */
export interface ActingDoors extends IntakeDoors {
  home: string
  config: Config
  events(filter: { types?: readonly TadeEvent['type'][]; task?: string }): Promise<TadeEvent[]>
  markDone(task: string, how: { by: Asker; summary?: string }): Promise<void>
  /** A note, verbatim, with who wrote it. Never a `said` line. */
  remember(text: string, scope: string | null, by: string, summary: string | null): unknown
  steerAgent(task: string, message: string): Promise<void>
  pendingApprovals(task?: string): readonly { run: string; requestId: string; tool: string }[]
  decideApproval(
    run: string,
    requestId: string,
    decision: { allow: boolean; reason?: string },
  ): Promise<void>
}

/** What letting a device act needs. Deliberately not the whole window. */
export interface GrantDeps {
  home: string
  acting: () => boolean
  now: () => number
}

/**
 * What a paired device may do, as the window implements it.
 *
 * One method per verb. The absence of every other method is the guarantee:
 * there is no shape here a path, a command, a setting, a credential or a new
 * agent could arrive in (`acting.ts` has the list and the argument).
 */
export function webActing(deps: ActingDeps): WebActing {
  return {
    // Read out of the live config at every act. **This is the half of the
    // setting that can only ever take authority away**, which is why it is a
    // function and not a flag: a person who turned acting off a second ago
    // meant it, and the route table they turned it off after was built when
    // the window started.
    unlocked: () => deps.acting(),
    park: (call, from) => park(deps, call, from),
    answer: (call, from) => answer(deps, call, from),
    steer: (call, from) => steer(deps, call, from),
    queue: (call, from) => queued(deps, call, from),
    done: (call, from) => done(deps, call, from),
    note: (call, from) => note(deps, call, from),
    context: (call, from) => context(deps, call, from),
    intake: (call, from) => intake(deps, call, from),
  }
}

/**
 * The first check every verb makes, in one place: **the screen told the
 * truth**.
 *
 * `was` against the revision the projection would put on that row now, built
 * from `taskRev` over the same facts the row was built from — so a
 * mismatch is the world having moved and never the two sides spelling a
 * revision differently. A refusal carries what is true *now*, so the page
 * redraws the truth instead of showing a toast about a conflict.
 *
 * A task the projection does not have is a `404` and not a `409`: it is
 * outside this device's reach, or it is gone, and neither is a thing to redraw
 * from.
 */
function onTask<T>(
  deps: ActingDeps,
  call: { task: string; was: string },
  work: (facts: TaskFacts) => Promise<T>,
): Promise<T> {
  const facts = deps.seen(call.task)
  if (facts === null) throw new NotThere(`there is nothing here called ${call.task}`)
  const now = taskRev(facts)
  if (now !== call.was) {
    throw new Moved(`${call.task} has moved on since that screen was drawn`, now)
  }
  return work(facts)
}

/** The revision to answer with: the facts that were checked, with what moved. */
function after(facts: TaskFacts, moved: Partial<TaskFacts> = {}): string {
  return taskRev({ ...facts, ...moved })
}

/**
 * Park a task, or pick it back up, for whoever asked.
 *
 * The whole of the act is `parkTask`'s compare-and-set (`parked.ts`): the file
 * is read, the park compared against what the caller saw, and a mismatch
 * refused — so a screen from two minutes ago cannot undo what somebody did at
 * the keyboard since, and a captured request replayed after its receipt was
 * gone meets a task that has moved on.
 *
 * **Through the workbench and nowhere else.** The task file is the workbench's
 * to write; a second writer in this process would be two rules about one file,
 * and the journal line that goes with the write would be this function's to
 * remember rather than the door's.
 */
export function park(deps: ActingDeps, call: ParkCall, from: From): Promise<Outcome> {
  return onTask(deps, call, async (facts) => {
    try {
      const moved = await deps.tade.parkTask(call.task, call.parked, {
        by: byOf(from),
        // The park the screen was of, taken from the facts just checked
        // against `was` rather than decoded back out of it — so the
        // compare-and-set in the file is against the same world the revision
        // check passed on, and the two cannot disagree.
        was: facts.parked,
      })
      return {
        // Whether it actually moved, which is not the same as whether it
        // succeeded: picking up a task that was already picked up is an
        // answer, and saying `did: true` to it would make the page draw a
        // change nobody made.
        did: moved.was !== moved.parked,
        rev: after(facts, { parked: moved.parked }),
        said: moved.parked ? 'set aside' : 'picked back up',
      }
    } catch (err) {
      // **Three answers, and each is the workbench's own.** A park that moved
      // under the caller is a `gone` carrying what is true now, so the page
      // redraws the truth rather than a toast; a task with no file is a
      // `no_such`; anything else is the window having broken, which reaches the
      // phone as a request id and a person as a `warning`. The first two are
      // classes rather than messages — matching on the words of an error is the
      // version of this that turns into a silent `500` the day somebody rewords
      // one.
      if (err instanceof ParkMovedOn) {
        throw new Moved(err.message, after(facts, { parked: err.parked }))
      }
      if (err instanceof NoTaskFile) throw new NotThere(err.message)
      // Work that came from outside this machine: picking it up again is
      // approving somebody else's request, which is the `intake` verb and its
      // two re-checks (`parked.ts`'s `NotYours`) rather than this one.
      // `out_of_scope` and not a `404`, because the task is one this device
      // can see and the honest answer is that it was not granted *that*.
      if (err instanceof NotYours) throw new OutOfScope(err.message)
      throw err
    }
  })
}

/**
 * Allow or deny what an agent is held on.
 *
 * **The approval is named, and the supervisor is what makes it exact.** The
 * revision says an approval is waiting; the act says *which*, and this
 * compares the id against the one the supervisor is actually holding before
 * deciding anything. So an agent that finished one call and is now held on the
 * next — identical from a revision, and the commonest way a screen goes stale
 * on a working agent — gets a refusal and never an answer to the wrong
 * question.
 *
 * **`reason` and never `said`.** `PermissionDecision.said` is *the exact words
 * that decided it*, kept verbatim in the ledger; a request from a phone has no
 * such words, and inventing one would be Tade putting a sentence in somebody's
 * mouth. What the agent is told instead is Tade's own sentence naming where
 * the denial came from.
 */
export function answer(deps: ActingDeps, call: AnswerCall, from: From): Promise<Outcome> {
  return onTask(deps, call, async (facts) => {
    const waiting = deps.tade.pendingApprovals(call.task)
    const one = waiting.find((pending) => pending.requestId === call.approval)
    if (!one) {
      // Not a `404`: the task is one this device can see, and an approval it
      // could see was there a moment ago. `gone` with what is true now, so
      // the page redraws whatever is waiting instead of insisting.
      throw new Moved(
        'that approval is not waiting any more',
        after(facts, { approval: waiting.length > 0 }),
      )
    }
    await deps.tade.decideApproval(one.run, one.requestId, {
      allow: call.allow,
      ...(call.allow ? {} : { reason: `denied from ${byOf(from)}` }),
    })
    const left = deps.tade.pendingApprovals(call.task).length
    return {
      did: true,
      rev: after(facts, { approval: left > 0 }),
      said: call.allow ? `allowed ${one.tool}` : `denied ${one.tool}`,
    }
  })
}

/**
 * Say something to an agent that is running.
 *
 * Two things are asked before the words go anywhere, and **neither of them is
 * a sentence to a model**:
 *
 * 1. **Is anything running.** The facts say how many agents are on the task,
 *    and nought is a refusal. This is the line that keeps `steer` from
 *    becoming a way to start work: `steerAgent` falls back to typing at the
 *    lane when the channel has gone, and a lane that is not there would be a
 *    lane somebody could bring up.
 * 2. **Can this harness take one.** `offer()` is the one rule every surface in
 *    Tade asks, and a harness that answers `none` says why in its own words.
 *    The page already has that sentence on the row and draws no control; this
 *    is what happens to a crafted call, and it is `not_offered` — the same
 *    `404` as a path nobody built.
 */
export function steer(deps: ActingDeps, call: SteerCall, from: From): Promise<Outcome> {
  return onTask(deps, call, async (facts) => {
    if (facts.agents === 0) throw new NotOffered(`no agent is running on ${call.task}`)
    const how = deps.steering(call.task)
    if (how.how === null) throw new NotOffered(how.why)
    try {
      await deps.tade.steerAgent(call.task, call.said)
    } catch (err) {
      // The agent went between the look and the write. A refusal with what is
      // true now, never a retry and never a second route to the same lane.
      throw new Moved(err instanceof Error ? err.message : String(err), after(facts))
    }
    // **No line of its own, and that is deliberate.** `web_did` already
    // records it — the device, the verb, the task and what came of it — and a
    // second record of one fact is one more thing to keep in step. The
    // keyboard's own steer writes no line either, so a remote one that did
    // would make `historyFrom` count a message from a phone and not the
    // identical one typed here. The words themselves are in the conversation,
    // where the agent read them, and nowhere else.
    return {
      did: true,
      rev: after(facts),
      said: how.how === 'now' ? 'told its agent' : `told its agent, ${how.how}`,
    }
  })
}

/**
 * One choice about queued work: written down, and **starting nothing**.
 *
 * The whole act is a `queue_changed` line, which is what every other door
 * writes too — so what starts is `readyToStart`'s decision on the window's own
 * next pass, with the park, the pause, the waits and `max_parallel` all still
 * in front of it. A `start` asked for here about work that is parked is
 * refused by `changeQueued` itself (`refuseParked`), which is the rule rather
 * than a second copy of it.
 *
 * **`first` is an order computed here**, out of the queue the window already
 * holds, and a device never sends a list: a list of task ids in a body is the
 * one shape that could reorder work in a project this device cannot see.
 */
export function queued(deps: ActingDeps, call: QueueCall, from: From): Promise<Outcome> {
  return onTask(deps, call, async (facts) => {
    const by = byOf(from) as Asker
    // **It has to be queued work**, and this is the check that keeps the
    // answer the same as the row's. `ableOn` already says `cannot: queue` for
    // anything with no `start` in its file; without this the verb would write
    // a `queue_changed` line about a task the queue has never heard of, which
    // `choicesFor` would read back the day somebody made it queued work.
    if (facts.queue === '') throw new NotOffered(`${call.task} is not queued work`)
    // **Parked work is not startable queued work**, and `refuseParked` is the
    // rule — asked here first only so the answer is a refusal the page has a
    // word for rather than the window appearing to break. The page offers
    // neither of these on a parked row; this is what a crafted call, or a tap
    // on a screen drawn before somebody parked it, meets.
    if (facts.parked && (call.change === 'start' || call.change === 'first')) {
      throw new NotOffered(`${call.task} is parked: pick it up again before it can start`)
    }
    if (call.change === 'first') {
      const now = deps.queue()
      if (!now.items.some((one) => one.task === call.task)) {
        throw new NotOffered(`${call.task} is not in the queue the window holds`)
      }
      await deps.tade.changeQueued({
        change: 'order',
        order: orderFirst(now.items, now.events, call.task),
        by,
      })
      return { did: true, rev: after(facts), said: 'goes first among the ready' }
    }
    await deps.tade.changeQueued({ task: call.task, change: call.change, by })
    return {
      did: true,
      // A pause is the one choice whose answer is knowable without another
      // fold; for the rest the window answers with what it checked, and the
      // next beat carries what the queue actually decided. Guessing would be
      // a revision nothing confirmed.
      rev: after(facts, call.change === 'pause' ? { queue: 'paused' } : {}),
      said: saidQueued(call.change),
    }
  })
}

/** Tade's own sentence for each choice. A switch, so a sixth fails to compile. */
function saidQueued(change: QueueCall['change']): string {
  switch (change) {
    case 'pause':
      return 'paused'
    case 'resume':
      return 'back on'
    case 'start':
      return 'starts as soon as there is room'
    case 'wait':
      return 'waits again'
    case 'first':
      return 'goes first among the ready'
  }
}

/**
 * Mark a task finished by hand.
 *
 * **The journal is read here, at the act, and that is this verb's whole
 * safety.** A `task_done` line is what work waiting on this task waits for, so
 * two of them is two starts' worth of confusion and nothing downstream would
 * say which was meant. The revision carries `finished`, so a screen drawn
 * before somebody marked it is refused — and this read is what catches the
 * beat's worth of world a revision cannot.
 *
 * `by` is the device and never `rule`: `rule` is Tade having seen a task's own
 * rule met, and somebody tapping a button is not that.
 */
export function done(deps: ActingDeps, call: DoneCall, from: From): Promise<Outcome> {
  return onTask(deps, call, async (facts) => {
    const already = await deps.tade.events({ types: ['task_done'], task: call.task })
    if (already.length > 0) {
      throw new Moved(`${call.task} is already marked finished`, after(facts, { finished: true }))
    }
    await deps.tade.markDone(call.task, {
      by: byOf(from) as Asker,
      ...(call.summary.trim() === '' ? {} : { summary: call.summary }),
    })
    return { did: true, rev: after(facts, { finished: true }), said: 'marked finished' }
  })
}

/**
 * Write a note down about a task, exactly as it arrived.
 *
 * **Verbatim, with its origin, and it is not a `said` line.** A note is the
 * thing Tade is *told* rather than derives: never reworded, never lowercased,
 * and a `summary` is only ever one somebody wrote beside it — so this writes
 * no summary at all, because a summary made out of the text is the one thing a
 * note may never carry. The `by` is the device, which is what keeps a remote
 * note from reading as the owner's own words, and `said` — whose one writer is
 * the keyboard, and which `namedBy` reads to authorise settings changes — is
 * not touched.
 */
export function note(deps: ActingDeps, call: NoteCall, from: From): Promise<Outcome> {
  return onTask(deps, call, async (facts) => {
    // Scoped to the task it is about, which is how `recall` finds it for that
    // task, for its project's pages, and for the agent that starts next.
    deps.tade.remember(call.text, call.task, byOf(from), null)
    return { did: true, rev: after(facts), said: 'written down' }
  })
}

/**
 * Add to what a task's agent is told.
 *
 * `addToContext` is the whole of it, and the containment is there rather than
 * here: the id is validated, the task's folder is resolved and must come out
 * inside Tade's home, and the file is opened `O_NOFOLLOW`. What this adds is
 * the mapping from its three refusals onto the ones the page knows — and
 * `ContextNotOurs` is an `out_of_scope` rather than a `broke`, because a
 * context file that is a link is a fact about this machine and not a failure
 * of the request.
 */
export function context(deps: ActingDeps, call: ContextCall, from: From): Promise<Outcome> {
  return onTask(deps, call, async (facts) => {
    try {
      const added = await addToContext(deps.tade, {
        task: call.task,
        add: call.add,
        by: byOf(from),
        at: deps.now(),
      })
      return {
        did: true,
        rev: after(facts),
        said: `added to its context (${added.bytes} bytes now)`,
      }
    } catch (err) {
      if (err instanceof NoTaskFolder) throw new NotThere(err.message)
      if (err instanceof ContextNotOurs) throw new OutOfScope(err.message)
      if (err instanceof ContextTooBig) throw new TooMuch(err.message)
      throw err
    }
  })
}

/**
 * Approve a request that arrived from outside this machine.
 *
 * **Everything that makes this safe is somewhere else, deliberately.** The row
 * is found by the task, `whyNotAct` refuses one that is not waiting to be
 * approved, the grant is read again out of the config as it stands, and the
 * source is asked whether the request still says what it said — all inside
 * `approveIntake`, which is the door a keypress goes through too. A check
 * written into this function would be a check the next surface has to
 * remember.
 *
 * What this verb adds is only that the asking was a device: `by` carries the
 * id, which is what makes `approveIntake` demand the source re-check at all,
 * and what makes the journal say who approved it. Nothing here creates a
 * grant, replies to anybody or starts work — approving lifts the park, and the
 * queue starts what it starts by its own rule.
 */
export function intake(deps: ActingDeps, call: IntakeCall, from: From): Promise<Outcome> {
  return onTask(deps, call, async (facts) => {
    const row = await rowOf(deps, call.task)
    if (row === null) throw new NotThere(`nothing from outside this machine made ${call.task}`)
    try {
      const acted = await approveIntake(deps.tade, {
        item: row.item,
        by: byOf(from) as Asker,
        config: deps.config(),
        stands: (one) => deps.stands(one),
      })
      return { did: true, rev: after(facts, { parked: false }), said: acted.said }
    } catch (err) {
      // **Every refusal here is `out_of_scope` with the door's own sentence**,
      // and that is the honest word for all of them: the grant was turned off,
      // the project came off its list, the source closed the ticket, or nobody
      // could reach the source. None of them is a thing to retry and none is a
      // failure of this machine — what they have in common is that this device
      // was not granted *that*, now.
      throw new OutOfScope(err instanceof Error ? err.message : String(err))
    }
  })
}

/** The inbox row one task came from, or null for a task that came from here. */
async function rowOf(deps: ActingDeps, task: string): Promise<InboxRow | null> {
  const rows = await inboxFrom({ home: deps.tade.home, events: await deps.tade.log.read({}) })
  return rows.find((row) => row.tasks.includes(task)) ?? null
}

/** What granting, or taking it back, came to. */
export interface Granted {
  /** What that device may do now, in full. */
  scopes: readonly string[]
  /** Tade's own sentence for the strip. */
  said: string
}

/**
 * Let one device act, or take it back. **A person at this machine, only.**
 *
 * There is deliberately no other door: no route, no orchestrator tool and no
 * config key, because the thing that grants authority is never reachable from
 * inside the authority it granted (DESIGN.md §9.1).
 *
 * **What it grants is both tiers**, and that is a decision rather than a
 * convenience. §9.1's matrix has two — `answer` for choosing between things an
 * agent itself offered, `steer` for changing what gets done — and one control
 * that granted only the gentler one would mean a phone that can allow a
 * command and cannot set the work aside, which is the wrong half. A control
 * per tier is the thing to build if somebody wants the narrower grant; until
 * then this grants what the sentence beside it names
 * (`ACTING_IS_NOT_YOU`), and that sentence is held to naming all of it.
 *
 * The projects it may act in are the ones it may already read, so revoking a
 * project revokes acting in it in the same act.
 *
 * **Refused while the setting is off**, rather than written and then ignored:
 * a grant that did nothing because of a second setting is exactly what Tade
 * accepting and ignoring a setting would be. The control is not drawn there
 * either; this is the half that holds if something else ever presses it.
 */
export async function letOneAct(
  deps: GrantDeps,
  devices: readonly Device[],
  id: string,
): Promise<Granted> {
  if (!deps.acting()) {
    throw new Error('turn on “Let a paired device act” in Settings → Away view first')
  }
  const device = devices.find((one) => one.id === id && one.revoked === null)
  if (device === undefined) throw new Error('that device is not paired')
  const may = device.scopes.some((scope) => scope !== 'read')
  // **`read` is never taken away here.** Widening what one device may do and
  // signing it out are different acts, and only the first of them is this
  // control; a grant written without `read` would quietly make a phone stop
  // being able to see anything.
  const scopes = may ? ['read'] : ['read', 'answer', 'steer']
  await allowDevice(deps.home, id, scopes, new Date(deps.now()))
  const what = device.label === '' ? 'that device' : device.label
  return { scopes, said: may ? `${what} can no longer act` : `${what} can act` }
}
