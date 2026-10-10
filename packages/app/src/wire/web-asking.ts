import { type Arm, type Arming, armFor, byOf } from '@tade/core'
import {
  type AskCall,
  chatRev,
  type Device,
  type From,
  Moved,
  NotOffered,
  NotThere,
  type Outcome,
  OutOfScope,
  type StopCall,
  type WebAsking,
} from '@tade/web'

// The window's end of talking: what a message actually does, and the arm it
// does it under.
//
// **Its own file, and the seam is the same one `web-acting.ts` has.** What the
// away view is handed is exactly this — two methods and `unlocked`, and
// nothing else on it. A `WebAsking` that was the whole `Away` subject would
// put the device file, the projectors and the streams one property access away
// from a route.
//
// ## The three things only the window can do, and this file owes all three
//
// 1. **Re-check the state at the moment of the act.** The revision the device
//    echoed (`was`) against the conversation as it stands *now* — which for a
//    message means, above everything else, that nothing is in flight. A
//    harness delivers a prompt that arrives mid-turn *into* that turn, so a
//    message accepted while the person's question is being answered would put
//    a stranger's words inside it, under the person's own arm. That is the one
//    failure here that is not recoverable by refusing afterwards, and it is
//    why `busy` is in the revision rather than only in a guard.
// 2. **Build the arm**, out of the device record read at the act and never out
//    of the session the request arrived on. A device revoked a second ago, or
//    one whose grant was narrowed, must not be answered on what it had when it
//    connected — so `armFor` is called here, against the list as it is now.
// 3. **Carry the provenance into the record.** The transcript line is marked
//    as the device's (`deviceSaid`), the journal line is a `web_asked`, and
//    neither is ever a `said` line.
//
// What this file deliberately does **not** do is decide what the turn may
// reach. That is two closed tables in `@tade/orchestrator` and a gate in front
// of every tool call; here the arm is only built and handed over. One place
// that decides, asked at every call, rather than a copy of the decision at the
// door.

/**
 * What the `ToolHost` is handed so a call can be judged, built out of the
 * window's own three answers.
 *
 * **All three are functions, and that is the load-bearing part.** Every one of
 * these questions is asked *at the call* rather than when the socket was made:
 * a cached arm is the one that is still remote after the turn ended, and a
 * cached projection is the one that still answers for a phone somebody
 * disconnected. The socket outlives both.
 *
 * `refused` is written down whatever it was, like every refusal at the away
 * view's own door: a device whose turn asked for something it may not have is
 * exactly what a person reading back needs to see, and it is the case the
 * audit matters most in. Never awaited — a journal that will not take the line
 * is not a reason the refusal does not happen — and said in the window if it
 * would not go in.
 */
export function armingFor(deps: {
  arm: () => Arm
  /** What that device is granted **now**, or null where it is no longer paired. */
  paired: (device: string) => Paired | null
  seen: (arm: Arm) => Promise<unknown>
  log: (event: { type: 'web_did'; detail: Record<string, string> }) => Promise<unknown>
  note: (said: string) => void
}): Arming {
  return {
    arm: () => narrowed(deps.arm(), deps.paired),
    seen: (arm) => deps.seen(arm),
    refused: (arm, method, why) => {
      if (arm.how !== 'remote') return
      void deps
        .log({
          type: 'web_did',
          detail: { device: arm.device, tool: method, state: 'refused', why },
        })
        .catch(() => {
          deps.note(`a refusal from ${arm.device} could not be written down`)
        })
    },
  }
}

/**
 * What the away view is allowed to know of the conversation.
 *
 * The orchestrator subject has all five, so the window passes it straight in —
 * but it is declared here, narrowly, for the reason `ActingDoors` is declared
 * rather than taking the workbench: a parameter typed as that subject would
 * put `say`, which is the one function that writes a `said` line, one property
 * access away from a route.
 */
export interface Talking {
  /** How far the turn in flight reaches, or `LOCAL` between turns. */
  arm(): Arm
  /** Whether a turn is in flight. */
  busy(): boolean
  /** Whose turn is in flight, as `byOf` writes it. Empty for none. */
  whose(): string
  /** Hand a device's words over under an arm. Throws with what to say. */
  askRemote(said: string, arm: Arm): Promise<void>
  /** Stop the turn in flight. False where the harness cannot. */
  stopTurn(): Promise<boolean>
  /** A device's words, in the conversation, marked as theirs. */
  remoteSaid(text: string, device: string): void
}

/**
 * The conversation, through whoever holds it once there is one.
 *
 * **Lazily, because the subjects are built in an order and this one is built
 * first.** `Away` is constructed before the orchestrator subject — the window
 * opens without waiting for a model in another process — so a direct
 * reference here would be read before it was assigned. Five one-line
 * delegations rather than five lambdas at the call site, so `app.ts` stays
 * wiring and the reason is written down once.
 */
export function talkingThrough(held: () => Talking): Talking {
  return {
    arm: () => held().arm(),
    busy: () => held().busy(),
    whose: () => held().whose(),
    askRemote: (said, arm) => held().askRemote(said, arm),
    stopTurn: () => held().stopTurn(),
    remoteSaid: (text, device) => held().remoteSaid(text, device),
  }
}

/** What one device was granted, as the record has it now. */
export interface Paired {
  projects: readonly string[] | null
  scopes: readonly string[]
}

/**
 * The lease's arm, narrowed to what that device is granted **now**.
 *
 * **The revocation case, and the reason the lease alone is not enough.** The
 * arm is taken when the words are handed over and held until the turn ends —
 * so a device disconnected, or a grant narrowed, while a turn of its is in
 * flight would otherwise keep whatever it had when it started. One turn is
 * seconds, which is exactly long enough for somebody who has just realised
 * they lost a phone to press Disconnect and have it mean nothing.
 *
 * So: it can only ever **take away**. A device that is gone keeps its id — the
 * audit needs it — and loses every grant and every project, which leaves a
 * remote arm that reaches nothing but a read its own projection refuses
 * (`seen` throws for it). A grant that was narrowed is narrowed here too,
 * because `armFor` is a fold of the record and the record is the authority.
 */
export function narrowed(arm: Arm, paired: (device: string) => Paired | null): Arm {
  if (arm.how !== 'remote') return arm
  const held = paired(arm.device)
  if (held === null) return { how: 'remote', device: arm.device, projects: [], may: [] }
  const now = armFor({ id: arm.device, projects: held.projects, scopes: held.scopes })
  if (now.how !== 'remote') return arm
  return {
    how: 'remote',
    device: arm.device,
    // The narrower of the two lists, so nothing here can widen a lease either:
    // a grant made *during* a turn is not a grant that turn was given.
    projects: narrower(arm.projects, now.projects),
    may: now.may.filter((grant) => arm.may.includes(grant)),
  }
}

/** The narrower of two project lists, where `null` is every one. */
function narrower(
  was: readonly string[] | null,
  now: readonly string[] | null,
): readonly string[] | null {
  if (was === null) return now
  if (now === null) return was
  return was.filter((name) => now.includes(name))
}

/** What talking needs of the window: a few doors, and no path among them. */
export interface AskingDeps {
  /** Whether the setting is on, read **at the turn** and never cached. */
  talking: () => boolean
  /** The devices as they are now, so a grant narrowed a second ago means something. */
  devices: () => readonly Device[]
  /**
   * The conversation as it stands: the fact its revision is made of, and who
   * is being answered.
   *
   * The same fact `talkIn` builds the projected revision from, through the
   * same function — so what a device echoes back and what is compared here
   * cannot be two spellings of one value.
   */
  seen: () => { busy: boolean; whose: string }
  /**
   * Hand the words to the orchestrator under this arm.
   *
   * Throws rather than answering a reason, because a tool fails by throwing
   * and because the reasons are not interchangeable: a harness that cannot be
   * narrowed is `NotOffered`, an orchestrator that is not running is a throw
   * with its own words, and a turn that started is nothing at all.
   */
  ask: (said: string, arm: Arm) => Promise<void>
  /**
   * Stop the turn in flight, if its harness can. `false` where it cannot,
   * which is a `not_offered` and not a silent nothing.
   */
  stop: () => Promise<boolean>
  /** Write the message down: the transcript line, marked as the device's. */
  said: (text: string, device: string) => void
  now: () => number
}

/**
 * The two methods, and nothing else reachable.
 *
 * `unlocked` is read at every turn: the route table was built when the window
 * started, so turning the setting **off** has to mean something before the
 * next restart. Turning it on waits, and the setting's own words say so.
 */
export function webAsking(deps: AskingDeps): WebAsking {
  return {
    unlocked: () => deps.talking(),

    async ask(call: AskCall, from: From): Promise<Outcome> {
      const arm = armOf(deps, from)
      const seen = deps.seen()
      // **The state the act named, re-checked against the world now.** A
      // mismatch is the conversation having moved — somebody said something,
      // or a turn started — and the answer carries what is true now so the
      // page redraws the truth rather than a toast about it.
      const now = chatRev({ busy: seen.busy })
      if (call.was !== now) {
        throw new Moved(
          seen.busy
            ? `Tade is already answering ${seen.whose || 'something'}`
            : 'the conversation moved on',
          now,
        )
      }
      // Written down *before* the words are handed over, so a line nobody can
      // see is not the first thing a person reads about a turn Tade is already
      // on. It is the device's line and never the person's: `deviceSaid` is a
      // different function from `youSaid` for exactly that reason.
      deps.said(call.said, from.how === 'remote' ? from.device : '')
      await deps.ask(call.said, arm)
      const after = deps.seen()
      return { did: true, rev: chatRev({ busy: after.busy }), said: 'Tade is answering' }
    },

    async stop(call: StopCall, from: From): Promise<Outcome> {
      // The arm is built for the same reason it is on `ask`: a device that has
      // been revoked stops anything, which would be a small thing to allow and
      // is still the thing that grants authority being reachable from inside
      // what it granted.
      armOf(deps, from)
      const seen = deps.seen()
      const was = chatRev({ busy: seen.busy })
      if (call.was !== was) throw new Moved('the conversation moved on', was)
      // **Nothing in flight is `NotThere` rather than a quiet success.** A
      // button that says it stopped something when there was nothing to stop
      // is a button nobody can trust the next time.
      if (!seen.busy) throw new NotThere('nothing is in flight to stop')
      const stopped = await deps.stop()
      if (!stopped) {
        throw new NotOffered('this harness cannot stop a turn once it has started')
      }
      const after = deps.seen()
      return { did: true, rev: chatRev({ busy: after.busy }), said: 'stopped it' }
    },
  }
}

/**
 * The arm this turn runs under, built from the device record **now**.
 *
 * Not from the session the request arrived on, and that is the whole point: a
 * session carries the scopes it was minted with, and a person who narrowed a
 * grant or disconnected a phone thirty seconds ago meant it. A device that is
 * no longer in the list is `OutOfScope` — it is a device that can see the
 * conversation screen and was not granted this, which is the honest answer and
 * not a `404`.
 *
 * A **local** `from` cannot reach here: the local path is `say`, which never
 * goes through a `WebAsking` at all. It is refused rather than quietly turned
 * into `LOCAL`, because the one thing that must never happen is a remote
 * request running unnarrowed.
 */
function armOf(deps: AskingDeps, from: From): Arm {
  if (from.how !== 'remote') {
    throw new OutOfScope('a message from away is never the person at the machine')
  }
  const device = deps.devices().find((one) => one.id === from.device && one.revoked === null)
  if (device === undefined) throw new OutOfScope('that device is not paired')
  if (!device.scopes.includes('ask')) {
    throw new OutOfScope(`${byOf(from)} was not granted talking to Tade`)
  }
  return armFor(device)
}
