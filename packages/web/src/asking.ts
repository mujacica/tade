import type { From, Outcome } from './acting.ts'

// What a paired device may *say to Tade*, as the one interface the window
// implements.
//
// **A third table, not a ninth verb**, and the reason is the shape of the
// thing. Every verb in `verbs.ts` is a target plus the state it expects — a
// task id, a revision, and an act whose whole effect is written on it. This
// has no task, and its effect is whatever a model decides to do next. Folding
// it into `VERBS` would mean a verb whose `task` is empty and whose payload is
// a paragraph, which is exactly the generic "run this" shape that file exists
// not to have.
//
// So it is its own interface, its own route, its own setting
// (`surfaces.web.orchestrator`) and its own scope (`ask`) — and **`acting` does
// not imply it**. A device granted both tiers of acting has been granted eight
// bounded things; it has not been granted free text to a model that holds
// tools, and a control that gave both at once would be a yes to a question
// nobody was asked.
//
// ## What makes it safe, said here because this is where somebody looks
//
// Not the sentence Tade prepends to the turn. Three things, none of which is
// in this package:
//
// 1. **The turn runs under an arm** (`@tade/core`'s `Arm`): the device, the
//    projects it may reach, and what it was granted. It is an argument carried
//    into the harness's own gate and into the `ToolHost`, not a line of
//    prose.
// 2. **Two closed tables** (`@tade/orchestrator`'s `origin.ts`): which of
//    Tade's own tools a remote turn may call, and what each call may do with
//    the parameters it carries. Everything unnamed is refused, and the
//    harness's own tools — a shell, a file write — are refused as a class.
// 3. **One turn at a time.** A message sent while anything is in flight is
//    refused rather than steered into the turn that is running, because a
//    harness delivers a mid-turn prompt *into* that turn and a stranger's
//    words inside the person's question would be inside the person's arm.
//
// What this package owes is the door: the scope, the setting read at the turn,
// the trusted origin re-asked, the idempotency, and the audit line. The same
// things `acted.ts` owes for a verb, which is why the two files read alike.

/**
 * What one message carries, and the state it expects of the conversation.
 *
 * `was` is the conversation's own revision (`chatRev`): what the screen said
 * about whether anything was in flight, echoed back. A message that was typed
 * while Tade started answering somebody else meets a world that is not the one
 * it was written against, and the answer carries what is true now so the page
 * draws the truth rather than a toast about it.
 */
export interface AskCall {
  /** The revision the device's screen was of. */
  was: string
  /** What to say, verbatim and bounded. Never trimmed into meaning. */
  said: string
}

/**
 * Stop the turn in flight.
 *
 * **Its own call and not a field on `AskCall`**, because the two need different
 * things to be true and a body that could mean either is a body that stops a
 * turn by accident. It is the same act escape is at the keyboard: what was said
 * stays, the conversation is not ended, and the next message carries on from
 * there.
 */
export interface StopCall {
  was: string
}

/**
 * Saying something to Tade, and stopping it: the two methods, and the whole of
 * what a paired device may ever do to the conversation.
 *
 * **There is no method here that reads it.** The conversation is read through
 * the projection like everything else — a collection with a budget, behind the
 * `talk` grant, with tool *names* and never their arguments — so there is no
 * shape in this interface that could answer with a transcript, and no handler
 * that does any work.
 */
export interface WebAsking {
  /**
   * Whether talking is still unlocked, read **at the turn**.
   *
   * A function and not a flag, exactly as `WebActing.unlocked` is: the route
   * table was built when the window started, and a person who turns the
   * setting off wants that to mean something before they next restart. The
   * asymmetry is in the setting's own words — on waits for a restart, off is
   * now.
   */
  unlocked(): boolean
  ask(call: AskCall, from: From): Promise<Outcome>
  stop(call: StopCall, from: From): Promise<Outcome>
}

/**
 * The facts the conversation's own revision is made of: one field per thing a
 * message assumes, and nothing else.
 *
 * The same rule `TaskFacts` is written to. A field no call depends on would
 * refuse perfectly current messages every time a figure moved; a thing a call
 * assumes that is *not* here is a replay nothing refuses.
 */
export interface ChatFacts {
  /** Whether a turn is in flight, which is what a message needs to be false. */
  busy: boolean
}

/** Nothing in flight. */
export function noChat(): ChatFacts {
  return { busy: false }
}

/**
 * The conversation's revision: short, opaque, and the same rule on both sides.
 *
 * Readable rather than hashed for the reason `taskRev` is: a test can say
 * which fact moved, and two worlds cannot agree by accident.
 *
 * **One field, and the count of lines is deliberately not a second.** A
 * conversation gains lines *because of the turn* — a reply, a tool, a problem
 * — so a revision that moved with them would refuse the commonest message
 * there is: the one somebody typed while an answer was arriving. That is
 * `TaskFacts`' own rule applied here — a field no call depends on refuses
 * perfectly current calls every time a figure moves — and what a message
 * genuinely assumes is the one thing left: that nothing is in flight.
 *
 * What is **not** given up by that is the replay: a captured `POST` sent again
 * carries the same key, and `receipts.ts` answers it out of the record rather
 * than asking twice. A *different* key from an authenticated device is a fresh
 * ask, which is what it is — and a revision could not tell those apart either,
 * because anything holding a session can read the current one.
 */
export function chatRev(facts: ChatFacts): string {
  return `b${facts.busy ? 1 : 0}`
}

/** How much one message may carry. A paragraph somebody typed, not a brief. */
export const ASK_BOUND = 4_000
