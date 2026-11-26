import {
  type Arm,
  LINES_LOOKED_BACK,
  machineLabel,
  printable,
  REMOTE_ACT_REACH,
  type RemoteGrant,
  remoteNamedBy,
} from '@tade/core'
import { type Answer, LinkError, type Remote, type RemoteLink } from '@tade/remotes-core'
import { type ActBody, readOutboxAnswer } from '@tade/web'
import { actingFor } from './acting.ts'
import { clockOf, saidLately, type Wiring, why } from './context.ts'
import { seenName } from './machines-seen.ts'

// One orchestrator on every machine, acting on any of them: an act aimed at
// another machine runs **through that machine's own gate**, never this one's.
//
// The orchestrator's tools take a machine (`tade_remote_act`, the tools
// extension): the call is the same tool call it would make here, forwarded as
// the method and its parameters (`remote/act`) and run there by its own
// `ToolHost` under an owner's arm — so what the setting reach, the queue's
// rules and every refusal say there is what decides, as if its own
// orchestrator had made the call. Each act carries an idempotency key, so one
// sent twice over a link that dropped is done once and answered twice.
//
// **Two ways there**, because only one machine of a pair can dial:
// - a machine this window links to is asked at once (`/api/acts`), over the
//   owner link it holds;
// - a machine that links *here* — the Mac, seen from the hub — cannot be
//   called: the act waits in this machine's outbox, which that machine's
//   window asks for on its beat (`/api/acts/outbox`), runs through its own
//   gate, and answers in its next ask. The hub holds no credential for it.
//
// **Whose words count there.** A setting in the `asked` tier needs the
// person's own line naming it (`namedBy`), and the person typed theirs on
// *this* machine. So the act carries this machine's `said` lines — the
// person's own, read out of the journal here, never anything the model wrote
// — and the far side reads them beside its own (`quotedWords`), only for an
// act that came over an owner's link, and writes `by: orchestrator via
// <machine>` on what it changes. Words an agent wrote never become a `said`
// line anywhere, so they never travel as one.
//
// **What comes back through an outbox is not an owner's.** The machine that
// dials holds the SSH key to the hub; the hub holds nothing for it, and every
// agent on the hub runs as the same user as its Tade — so anything that
// controls the hub (an agent that read a hostile ticket included) can answer
// the outbox ask with any act and any "person's words" it likes. So an act
// taken from an outbox is read by the same schema as one sent to this
// machine's door (`readOutboxAnswer`), run under a narrowed arm with the
// steer and tidy tiers only (`outboxArm`, judged by `allowMethod`), and the
// lines it quotes are not read: a terminal, an agent started, an approval
// answered or a setting changed here needs the person here, or their own
// device paired here.
//
// **A machine that is down is said, with since when** (`machine_seen`), and
// the act refused rather than queued for a machine that may never come back.

/** How long an act waits for a machine that links here to take it from the outbox. */
export const OUTBOX_WAITS_MS = 5 * 60_000

/** How much of one answer goes back through an outbox ask, which is one request of 64 KB at most. */
const ANSWER_MOST = 8_000
/** How many answers one outbox ask hands in. */
const ANSWERS_AT_ONCE = 6
/**
 * How many acts one beat takes from a hub's outbox: what one ask hands back in.
 * The rest wait there, unanswered, for the next beat.
 */
const ACTS_AT_ONCE = ANSWERS_AT_ONCE

/** How long an answered act is kept by its key, so one asked again is answered and not done again. */
const ANSWERS_KEPT_MS = 30 * 60_000

/**
 * What an act taken from a hub's outbox may reach here (ONE-AWAY-VIEW Q3b):
 * a paired device's steer tier — steer, park, a note — and the tidy tier no
 * device has — stop an agent, pause or resume queued work and a schedule — in
 * every project, judged method by method (`REMOTE_METHODS`). Each of those
 * only ever makes less happen here. Not `answer`, because approving a command
 * an agent here is waiting on is running it; and nothing that starts an
 * agent, opens a terminal or changes a setting, because whatever controls
 * the hub must never be able to make this machine run code (F1).
 */
export const OUTBOX_GRANTS: readonly RemoteGrant[] = ['steer', 'tidy']

/** The arm an act from `from`'s outbox runs under here. */
export function outboxArm(from: string): Arm {
  return { how: 'remote', device: `machine ${from}`, projects: null, may: [...OUTBOX_GRANTS] }
}

/** Which door an act came in by: asked at this machine's own (an owner's), or taken from a hub's outbox. */
export type ActDoor = 'asked' | 'outbox'

/** One act, as it travels. */
export interface Act {
  key: string
  method: string
  params: Record<string, unknown>
  /** The person's own lines on the machine it came from, newest last. */
  quoted: string[]
  /** What that machine calls itself. */
  from: string
}

export interface ActAnswer {
  key: string
  ok: boolean
  text: string
}

export type ActsReach = (name: string) => { link: RemoteLink; remote: Remote; live: boolean } | null

export interface MachineActsDeps {
  /** Said in the strip, once per trouble. */
  say: (said: string) => void
  /** How each of the person's other machines last stood (`machines-seen.ts`). */
  seen: () => readonly {
    machine: string
    way: 'to' | 'from'
    state: string
    at: number
    since: number | null
  }[]
}

/** One of this machine's own tool methods run through its own gate, under an arm (`ToolHost.act`). */
export type ActRunner = (
  method: string,
  params: Record<string, unknown>,
  arm: Arm,
) => Promise<unknown>

export class MachineActs {
  private readonly wire: Wiring
  private readonly deps: MachineActsDeps
  /** Acts waiting for a machine that links here, by its name. */
  private readonly outbox = new Map<string, Act[]>()
  /** Who is waiting on each act's answer, by its key. */
  private readonly waiting = new Map<string, (answer: ActAnswer) => void>()
  /** Acts done here, by key, so one sent again is answered again and not done again. */
  private readonly answered = new Map<string, { answer: ActAnswer; at: number }>()
  private readonly running = new Map<string, Promise<ActAnswer>>()
  /** This machine's own gate, once its orchestrator's tools are up: until then an act is refused, said. */
  private runner: ActRunner | null = null
  private reach: ActsReach | null = null

  constructor(wire: Wiring, deps: MachineActsDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** This machine's own gate (`ToolHost.act`), once the orchestrator's tools are up. */
  useRunner(runner: ActRunner | null): void {
    this.runner = runner
  }

  /** How the window reaches its remotes. Never set under `tade serve`, which dials nobody. */
  withReach(reach: ActsReach): void {
    this.reach = reach
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  /**
   * One of the orchestrator's tool calls, aimed at another machine: refused
   * unless a line of the person's names it, and while it is down; otherwise
   * run there, and its answer handed back — a refusal there thrown here.
   */
  async act(req: {
    machine: string
    asked: string
    key: string
    method: string
    params: Record<string, unknown>
  }): Promise<unknown> {
    const machine = req.machine.trim()
    if (req.asked.trim() === '') {
      throw new Error(
        `Something is done on another machine only when they ask for it there: pass what they said, word for word, in \`asked\`.`,
      )
    }
    const said = await saidLately(this.wire, LINES_LOOKED_BACK)
    if (!remoteNamedBy(machine, said)) {
      throw new Error(
        `Nothing they have said names ${machine}, so I will not: ${REMOTE_ACT_REACH.because}.`,
      )
    }
    return this.send(machine, {
      key: req.key,
      method: req.method,
      params: req.params,
      quoted: said.slice().reverse(),
      from: machineLabel(),
    })
  }

  /**
   * One of that machine's tool calls, asked for by a press in this window —
   * a person's own hand here, so there are no words to check it against and
   * none are carried: what the far side needs a person's words for (a setting
   * in its `asked` tier) it refuses, and says so. Otherwise as `act`: refused
   * while it is down, run there through its own gate, its answer as text.
   */
  async pressed(req: {
    machine: string
    key: string
    method: string
    params: Record<string, unknown>
  }): Promise<string> {
    const answer = await this.send(req.machine.trim(), {
      key: req.key,
      method: req.method,
      params: req.params,
      quoted: [],
      from: machineLabel(),
    })
    return typeof answer === 'string' ? answer : JSON.stringify(answer)
  }

  /** An act, sent to the machine it is for, and its answer handed back — a refusal there thrown here. */
  private async send(machine: string, act: Act): Promise<unknown> {
    this.refuseDown(machine)
    const held = this.reach?.(machine)
    let answer: ActAnswer
    if (held) {
      if (!held.live) throw new Error(`${machine} is not linked now, so nothing was done there`)
      const asked = await held.link.request(machine, '/api/acts', act)
      if (asked.status === 404) {
        throw new Error(
          `${machine} runs a Tade that cannot be acted on from here: upgrade Tade there`,
        )
      }
      if (asked.status !== 200) {
        const said = (asked.body as { said?: unknown } | null)?.said
        throw new Error(
          `${machine} would not take it (${asked.status})${typeof said === 'string' ? `: ${printable(said)}` : ''}`,
        )
      }
      answer = asked.body as ActAnswer
    } else if (this.linksHere(machine)) {
      answer = await this.queued(seenName(machine), act)
    } else {
      throw new Error(`${machine} is not a machine this one links to, or one that links here`)
    }
    if (!answer.ok) throw new Error(`${machine}: ${answer.text}`)
    return answer.text
  }

  /** Throws with its state and since when, for a machine that is down. */
  private refuseDown(machine: string): void {
    const name = seenName(machine)
    const seen = this.deps
      .seen()
      .filter((one) => one.machine === machine || one.machine === name)
      .sort((a, b) => b.at - a.at)[0]
    if (!seen || seen.state === 'up') return
    const since = clockOf(seen.since ?? seen.at)
    throw new Error(
      `${machine} is ${seen.state} since ${since}, so nothing was done there: ask again once it is back`,
    )
  }

  private linksHere(machine: string): boolean {
    const name = seenName(machine)
    return this.deps.seen().some((one) => one.way === 'from' && one.machine === name)
  }

  /** Into the outbox for a machine that links here, answered when it asks, or refused when it never does. */
  private queued(name: string, act: Act): Promise<ActAnswer> {
    const box = this.outbox.get(name) ?? []
    if (!box.some((one) => one.key === act.key)) box.push(act)
    this.outbox.set(name, box)
    return new Promise<ActAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(act.key)
        const left = (this.outbox.get(name) ?? []).filter((one) => one.key !== act.key)
        this.outbox.set(name, left)
        reject(
          new Error(
            `${name} did not take it within ${OUTBOX_WAITS_MS / 60_000} minutes: its window may be closed or not linked here, and nothing was done there`,
          ),
        )
      }, OUTBOX_WAITS_MS)
      timer.unref?.()
      this.waiting.set(act.key, (answer) => {
        clearTimeout(timer)
        resolve(answer)
      })
    })
  }

  // ── The far side ──────────────────────────────────────────────────────────

  /**
   * An act from another machine of the person's, run here through this
   * machine's own gate. Asked at this machine's own door — an owner's link —
   * it runs under an owner's arm with the words it carried read beside this
   * machine's own; taken from a hub's outbox, under `outboxArm` with none of
   * them. Done once per key and door; asked again, answered again.
   */
  async take(act: Act, door: ActDoor = 'asked'): Promise<ActAnswer> {
    const now = this.wire.now()
    for (const [key, one] of this.answered)
      if (now - one.at > ANSWERS_KEPT_MS) this.answered.delete(key)
    // By door as well as key, so an outbox can never be handed what an owner's act was answered.
    const kept = `${door}:${act.key}`
    const done = this.answered.get(kept)
    if (done) return done.answer
    const going = this.running.get(kept)
    if (going) return going
    const from = seenName(act.from)
    const arm: Arm =
      door === 'outbox'
        ? outboxArm(from)
        : { how: 'owner', device: `machine ${from}`, theirs: true, typed: true }
    const quoted = door === 'outbox' ? [] : act.quoted
    const run = actingFor(quoted, from, async (): Promise<ActAnswer> => {
      try {
        const runner = this.runner
        if (!runner)
          throw new Error(
            'the orchestrator here is still starting, so nothing it can do is open yet',
          )
        const result = await runner(act.method, act.params, arm)
        const text =
          typeof result === 'string' ? result : JSON.stringify(result ?? { ok: true }, null, 2)
        return { key: act.key, ok: true, text }
      } catch (err) {
        return { key: act.key, ok: false, text: err instanceof Error ? err.message : String(err) }
      }
    })
    this.running.set(kept, run)
    try {
      const answer = await run
      this.answered.set(kept, { answer, at: this.wire.now() })
      return answer
    } finally {
      this.running.delete(kept)
    }
  }

  /** The outbox door: a machine that links here hands in its answers and takes what waits for it. */
  outboxFor(label: string, answers: readonly ActAnswer[]): Act[] {
    for (const answer of answers) {
      this.waiting.get(answer.key)?.(answer)
      this.waiting.delete(answer.key)
    }
    const name = seenName(label)
    const answeredKeys = new Set(answers.map((one) => one.key))
    const box = (this.outbox.get(name) ?? []).filter((one) => !answeredKeys.has(one.key))
    this.outbox.set(name, box)
    return box
  }

  // ── The near side of an outbox ────────────────────────────────────────────

  /** Answers to hand in on the next ask, by the machine they are for. */
  private readonly owed = new Map<string, ActAnswer[]>()
  private asking = new Set<string>()
  /** Hubs whose last outbox answer was not one, so the strip says it once rather than every beat. */
  private readonly malformed = new Set<string>()

  /** The beat: ask each machine this window links to for acts waiting here, and run them. Never throws. */
  beat(names: readonly string[]): void {
    const reach = this.reach
    if (!reach) return
    for (const name of names) {
      const held = reach(name)
      if (!held?.live || this.asking.has(name)) continue
      this.asking.add(name)
      void this.ask(name, held.link).finally(() => this.asking.delete(name))
    }
  }

  /**
   * One round: hand in what is owed, take at most `ACTS_AT_ONCE` of what waits,
   * and hand their answers in at once rather than at the next beat, so whoever
   * waits there hears now. Those last asks only hand in: what they bring waits
   * for the next beat, so a hub that always has one more act — a hostile one
   * can — gets one round a beat and never a loop.
   */
  private async ask(name: string, link: RemoteLink): Promise<void> {
    const acts = await this.handIn(name, link)
    if (acts === null) return
    for (const act of acts.slice(0, ACTS_AT_ONCE)) {
      const done = await this.take({ ...act, from: name }, 'outbox')
      this.owed.set(name, [...(this.owed.get(name) ?? []), done])
    }
    // Each ask that is answered hands in at least one and adds none, so this ends.
    while ((this.owed.get(name) ?? []).length > 0) {
      if ((await this.handIn(name, link)) === null) return
    }
  }

  /** One outbox ask: answers owed handed in, and the acts it hands back, or `null` where there are none to read. */
  private async handIn(name: string, link: RemoteLink): Promise<ActBody[] | null> {
    // A request is 64 KB at most: a few answers at a time, a long one cut, saying where.
    const owed = this.owed.get(name) ?? []
    const answers = owed.slice(0, ANSWERS_AT_ONCE).map((one) =>
      one.text.length <= ANSWER_MOST
        ? one
        : {
            ...one,
            text: `${one.text.slice(0, ANSWER_MOST)}\n… (${one.text.length - ANSWER_MOST} more characters there)`,
          },
    )
    let answer: Answer
    try {
      answer = await link.request(name, '/api/acts/outbox', { answers })
    } catch (err) {
      // A link that went is the link's own news; the answers wait for the next ask.
      if (!(err instanceof LinkError))
        this.deps.say(`${name}'s outbox could not be asked: ${why(err)}`)
      return null
    }
    // An older Tade there has no outbox: nothing waits in one.
    if (answer.status !== 200) return null
    this.owed.set(name, owed.slice(answers.length))
    const acts = readOutboxAnswer(answer.body)
    if (acts === null) {
      if (!this.malformed.has(name)) {
        this.malformed.add(name)
        this.deps.say(
          `${name}'s outbox answered with something that is not a list of acts, so nothing in it was done here`,
        )
      }
      return null
    }
    this.malformed.delete(name)
    return acts
  }
}
