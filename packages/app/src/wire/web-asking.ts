import type { Arm, Arming } from '@tade/core'
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
import { parseCommand } from '../commands.ts'

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
//    of the session the request arrived on. A device revoked a second ago
//    must not be answered as though it were still paired — so the arm is
//    built here, against the list as it is now.
// 3. **Carry the provenance into the record.** The transcript line is marked
//    as the device's (`deviceSaid`) and the journal line is a `web_asked`.
//    A paired phone — every one is the person's own — also writes a `said`
//    line, and that is the window's (`askRemote`), never this file's.
//
// What this file deliberately does **not** do is decide what the turn may
// reach. That is two closed tables in `@tade/orchestrator` and a gate in front
// of every tool call; here the arm is only built and handed over. One place
// that decides, asked at every call, rather than a copy of the decision at the
// door.

/**
 * What a remote turn's "where are we" is answered with: that device's own
 * projection, which `Arming.seen` has the argument for.
 *
 * A device that has gone **throws** rather than answering an empty tree:
 * *that device is no longer paired* is a true sentence a model can act on, and
 * nought projects would read as a machine with no work on it.
 */
export function seenFrom(
  arm: Arm,
  paired: (device: string) => Device | undefined,
  snapshot: (device: Device) => unknown,
): Promise<unknown> {
  if (arm.how !== 'remote') throw new Error('only a narrowed turn from away is answered this way')
  const device = paired(arm.device)
  if (device === undefined) throw new Error('that device is no longer paired')
  return Promise.resolve(snapshot(device))
}

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
  /** That device as the list has it **now**, or null where it is no longer paired. */
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
  /**
   * The person's own words from their own phone: a `said` line, as what they
   * type here is. Never called for a machine link's words it did not say were typed.
   */
  theirSaid(text: string): void
}

/**
 * The conversation, through whoever holds it once there is one.
 *
 * **Lazily, because the subjects are built in an order and this one is built
 * first.** `Away` is constructed before the orchestrator subject — the window
 * opens without waiting for a model in another process — so a direct
 * reference here would be read before it was assigned. Six one-line
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
    theirSaid: (text) => held().theirSaid(text),
  }
}

/** One device as the record has it now. */
export interface Paired {
  /** Whether it is a machine link (`@tade/web`'s `owner.ts`). Absent is not. */
  owner?: boolean
}

/**
 * The lease's arm, re-checked against the device list **now**.
 *
 * **The revocation case, and the reason the lease alone is not enough.** The
 * arm is taken when the words are handed over and held until the turn ends —
 * so a device disconnected while a turn of its is in flight would otherwise
 * keep whatever it had when it started. One turn is seconds, which is exactly
 * long enough for somebody who has just realised they lost a phone to press
 * Disconnect and have it mean nothing.
 *
 * So: it can only ever **take away**. A device that is gone keeps its id — the
 * audit needs it — and loses every project and every grant, which leaves a
 * remote arm that reaches nothing but a read its own projection refuses
 * (`seen` throws for it). An owner turn keeps the keyboard's reach only while
 * the record is still the kind of device it was minted for: a machine link
 * while it says owner, a phone while it does not.
 */
export function narrowed(arm: Arm, paired: (device: string) => Paired | null): Arm {
  if (arm.how === 'local') return arm
  const held = paired(arm.device)
  const nothing: Arm = { how: 'remote', device: arm.device, projects: [], may: [] }
  if (held === null) return nothing
  if (arm.how === 'remote') return arm
  return stillOwner(arm, held) ? arm : nothing
}

/** Whether the record still gives an owner turn the keyboard's reach. */
function stillOwner(arm: Extract<Arm, { how: 'owner' }>, held: Paired): boolean {
  // A machine link, typed there or not, while the record says owner.
  if (arm.theirs !== true || arm.typed === true) return held.owner === true
  return held.owner !== true
}

/**
 * What `/login` typed on the away view's line is answered with, where the
 * page did not carry it out itself.
 *
 * On a paired phone the page opens the orchestrator's sign-in there
 * (`POST /api/orchestrator/sign-in`, `@tade/web`'s `signing-in.ts`, run by
 * `web-sign-in.ts`) and never sends the line. A page that sent it anyway — one
 * older than that, or another machine's link — reaches this, and is told
 * where it is done rather than starting a turn of the model's.
 */
export const LOG_IN_IS_HERE =
  "Signing the orchestrator in from away is done on your phone's own page: /login there opens its sign-in. At the machine, type /login on Tade's own line, or run `tade accounts sign-in --orchestrator` in a shell on it."

/**
 * What each of the window's slash commands (`actions`) is answered with when
 * it is typed on the away view's line: where that is done from a device.
 *
 * **Every one of them is the window's, never a sentence.** At the machine a
 * line that starts with one is carried out and never reaches the model; handed
 * to the orchestrator from away it was a model asked to open a screen it does
 * not have. So each is answered here, and none starts a turn — `/new` and
 * `/stop` included, because what the window does with them is not what a model
 * reads into them, and a device's words are never an agent's instruction
 * except through a turn under its arm (`START`'s argument in `@tade/web`).
 * `test/wire/away-asking.test.ts` fails when a command is added without one.
 */
export const FROM_AWAY: Readonly<Record<string, string>> = {
  '/new':
    'A new agent from here is asked of Tade in words: say what it should do, and where, without the /new.',
  '/stop':
    "Stopping an agent from here is Stop on its row, on the Agents page or in the agent's ⋯.",
  '/open': 'The Agents page here lists every agent running: press one to open it.',
  '/project': "Adding a repository is done at the machine: type /project on Tade's own line there.",
  '/settings': 'Settings is its own page here: see and change what Tade has been told there.',
  '/login': LOG_IN_IS_HERE,
  '/away':
    "The devices let in are the Devices page here; pairing a new one is /away on Tade's own line at the machine.",
  '/workflows': 'Workflows is its own page here: the stored workflows, and writing one.',
  '/evals': 'Evaluations is its own page here: what lands work, the races and the judge.',
  '/plans': 'Plans is its own page here: every plan, and what wants you in each.',
  '/race': 'Races are on the Evaluations page here, each with what was asked and who was picked.',
  '/help':
    "The window's keys are at the machine; here, type a page's name in this bar to go to it.",
  '/quit':
    "Closing the window is done at the machine: type /quit on Tade's own line there. Agents carry on if they can.",
}

/**
 * The window's answer to a line from away that is one of its commands, as the
 * window's line would read it (`parseCommand`), or null for anything else —
 * a sentence about a command, a path, or a slash word that is not one of them,
 * all of which are still Tade's to answer.
 */
export function answeredHere(said: string): string | null {
  return FROM_AWAY[parseCommand(said).name.toLowerCase()] ?? null
}

/** What talking needs of the window: a few doors, and no path among them. */
export interface AskingDeps {
  /** Whether the setting is on, read **at the turn** and never cached. */
  talking: () => boolean
  /** The devices as they are now, so a device revoked a second ago means something. */
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
  /**
   * Write the person's own words down as theirs: a `said` line, which is what
   * `namedBy` reads. Called only for an owner arm that is `theirs`.
   */
  theirs: (text: string) => void
  now: () => number
}

/**
 * The two methods, and nothing else reachable.
 *
 * `unlocked` is read at every turn: the route table was built when the
 * listener came up, so turning the setting **off** has to mean something
 * before it is built again (`web-follow.ts`), which is also when on applies.
 */
export function webAsking(deps: AskingDeps): WebAsking {
  return {
    unlocked: () => deps.talking(),

    async ask(call: AskCall, from: From, here: boolean): Promise<Outcome> {
      const arm = armOf(deps, from, here, call.typed === true)
      // The window's commands are the window's, never a sentence
      // (`FROM_AWAY`). Answered here, after the arm (a device revoked a second
      // ago is still refused) and before anything is written or handed over,
      // so no turn starts.
      const windows = answeredHere(call.said)
      if (windows !== null) {
        return { did: false, rev: chatRev({ busy: deps.seen().busy }), said: windows }
      }
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
      // **The person's own device is them**, so what they typed is a `said`
      // line, written before the turn so a setting it names is named by the
      // time a tool asks. A machine link's words are only where it said so.
      if (arm.how === 'owner' && arm.theirs === true) deps.theirs(call.said)
      await deps.ask(call.said, arm)
      const after = deps.seen()
      return { did: true, rev: chatRev({ busy: after.busy }), said: 'Tade is answering' }
    },

    async stop(call: StopCall, from: From): Promise<Outcome> {
      // The device is asked of the list for the same reason it is on `ask`: a
      // device that has been revoked stops nothing.
      pairedNow(deps, from)
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
 * person who disconnected a phone thirty seconds ago meant it. A device that
 * is no longer in the list is `OutOfScope`, which is the honest answer and not
 * a `404`.
 *
 * A **local** `from` cannot reach here: the local path is `say`, which never
 * goes through a `WebAsking` at all. It is refused rather than quietly turned
 * into `LOCAL`, because the one thing that must never happen is a remote
 * request running as the keyboard without a device behind it.
 */
function armOf(deps: AskingDeps, from: From, here: boolean, typed = false): Arm {
  const device = pairedNow(deps, from)
  // **A machine link needs both halves, and neither is the request's word.**
  // The record says owner (minted only by `tade web pair --owner`, bound to a
  // loopback host), and the door says this message came in on this machine.
  // Its words may be another machine's model's, so they are `theirs` only
  // where that machine says the person typed them (`AskCall.typed`).
  if (device.owner) {
    // Bound to a loopback host, an owner session is never answered off this
    // machine's door; refused rather than given a reach of its own if it were.
    if (!here) throw new OutOfScope('a machine link is answered on this machine alone')
    return {
      how: 'owner',
      device: device.id,
      ...(typed ? { theirs: true as const, typed: true as const } : {}),
    }
  }
  // **Every paired phone is the person's own**, from any door the guard let it
  // through — a public name only with a passkey proved: its reach is the
  // keyboard's and its words are theirs (`Arm`'s owner variant).
  return { how: 'owner', device: device.id, theirs: true }
}

/** The device a message came from, as the list has it now, or `OutOfScope`. */
function pairedNow(deps: AskingDeps, from: From): Device {
  if (from.how !== 'remote') {
    throw new OutOfScope('a message from away is never the person at the machine')
  }
  const device = deps.devices().find((one) => one.id === from.device && one.revoked === null)
  if (device === undefined) throw new OutOfScope('that device is not paired')
  return device
}
