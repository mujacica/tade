import { randomUUID } from 'node:crypto'
import type { ConversationAsk } from '@tade/core'
import {
  type ConversationAnswer,
  RENEW_MS,
  type Settled,
  type SharedConversation,
  TurnLease,
} from './conversation-share.ts'

// One orchestrator conversation on every machine: when its turns run, and
// what happens around each.
//
// **A turn runs where its input arrived** — typed at the Mac, found by a watch
// on the hub, said from the phone to whichever machine it reached — with that
// machine's own model and account, because nothing here moves a turn. What
// this keeps is that there is **one turn at a time** across the fleet while
// the machines can reach the hub, and that every turn starts from the whole
// conversation:
//
// - **before** a turn (`before`): the turn lease is taken — from the hub over
//   its link, or here where this machine is the hub — waiting for it where a
//   turn of another machine's holds it, said once; this machine's record and
//   the hub's are exchanged; whatever another machine said is taken in
//   (`SharedConversation.settle`), merged where the two forked — which only a
//   machine that dials the hub ever does, holding the lease with both copies
//   whole, so one fork is never merged twice; and the harness reads its record again
//   (`reload`) where anything was appended, which is a reload between turns
//   and never an interruption;
// - **after** it (`after`): what it wrote is given to the hub, and the lease
//   let go.
//
// **The hub not there is not trouble.** A machine that cannot reach it runs its
// turns on its own branch, and the strip says so once ("carrying on here");
// the two branches are merged at the first turn after it comes back. A turn
// asked for from a paired device does not wait for the lease — it is refused
// with who is answering, like any busy conversation is — because a request
// from a phone that hangs for minutes is one it gives up on.

/** The hub's link, where another machine is the hub. */
export interface HubLink {
  /** Its name here. */
  name: string
  /** Its link is up now. */
  up: boolean
  /** When it went down, where it is. */
  downSince: number | null
  send(ask: ConversationAsk): Promise<ConversationAnswer>
}

export interface OneConversationOptions {
  shared: SharedConversation
  /** The hub's link, where another machine is the hub; null where this one keeps the lease. */
  hub: () => HubLink | null
  /** The harness reads its record again: between turns, and only then. */
  reload: () => Promise<void>
  /** Said where the conversation is drawn, in Tade's words. */
  say: (text: string) => void
  /** Something went wrong that did not stop a turn: written down where Tade's own trouble goes. */
  warn: (text: string) => void
  /** Entries another machine wrote were taken into the record here: the strip draws them. */
  took?: (settled: readonly Settled[]) => void
  now: () => number
  clock: (at: number) => string
  /** Waits, for a lease somebody else holds: a test passes one that does not sleep. */
  pause?: (ms: number) => Promise<void>
}

/** How long between asks for a lease somebody else holds. */
const LEASE_ASKED_EVERY_MS = 2_000

/**
 * How many requests one exchange makes at most: about two and a half
 * megabytes given, more taken. A month's conversation is hundreds of
 * megabytes the first time two machines meet, which no turn should wait for —
 * the beat carries the rest across, and until it has, nothing forked is
 * merged against a copy that is not whole.
 */
export const ROUNDS_AT_ONCE = 50

export class OneConversation {
  /** The lease this machine keeps, as the hub. */
  readonly lease = new TurnLease()
  private readonly opts: OneConversationOptions
  private readonly key = randomUUID()
  /** Where this turn's lease is held: at the hub, here, or nowhere (carrying on apart). */
  private holding: 'hub' | 'here' | null = null
  private renewing: ReturnType<typeof setInterval> | null = null
  /** Appended to since the harness last read its record. */
  private stale = false
  /** What was said once, so it is not said every turn. */
  private readonly said = new Set<string>()
  /** Since when the hub could not be reached, as this machine last said it. */
  private apartSince: number | null = null
  /** An exchange or a settle in flight, so the beat never runs two. */
  private busy: Promise<unknown> | null = null
  /** Another machine's turn held the lease when the hub was last asked. */
  private others = false
  /** The last exchange with the hub ended with neither side lacking anything. */
  private whole = true
  /** The hub whose last exchange was the same conversation as this one's: not refused, not failed. */
  private one: string | null = null

  constructor(opts: OneConversationOptions) {
    this.opts = opts
  }

  /**
   * The hub this conversation is one with, as the last exchange said, or null:
   * a turn running there is a turn of this conversation, which escape here
   * stops. A hub that refused — another harness keeps its own — or could not
   * be asked is not, and its turns are its own.
   */
  get joined(): string | null {
    return this.one
  }

  /** Whether a lease is held for a turn of this machine's now. */
  get leased(): boolean {
    return this.holding !== null
  }

  /** Whether another machine's turn held the lease when it was last looked at: the beat looks oftener then. */
  get othersTurn(): boolean {
    return this.others
  }

  /**
   * Ready for a turn of this machine's: the lease, the exchange, what came in
   * taken in, the harness reading it again. `wait` false refuses, in words,
   * where another machine's turn holds the lease, rather than waiting.
   */
  async before(wait: boolean): Promise<void> {
    // What the beat was doing finishes first; how it went is its own to say (`idle`).
    while (this.busy) await Promise.allSettled([this.busy])
    const hub = this.opts.hub()
    if (hub) await this.fromHub(hub, wait)
    else await this.here(wait)
    // A fork is merged by the machine that dials the hub, holding the lease,
    // with both copies whole — the one place both are known to be. The hub
    // only ever adopts: it cannot tell whether what it was given is all there is.
    const settled = await this.opts.shared.settle(this.holding === 'hub' && this.whole)
    this.saySettled(settled)
    if (this.stale) {
      await this.opts.reload()
      this.stale = false
    }
  }

  private async fromHub(hub: HubLink, wait: boolean): Promise<void> {
    if (!hub.up) {
      this.apart(hub)
      return
    }
    for (;;) {
      let done: Awaited<ReturnType<SharedConversation['exchange']>>
      try {
        done = await this.opts.shared.exchange(
          (ask) => hub.send(ask),
          { op: 'take', key: this.key },
          ROUNDS_AT_ONCE,
        )
      } catch (err) {
        // The link went as it was asked: this turn carries on here.
        this.opts.warn(`the conversation could not be exchanged with ${hub.name}: ${why(err)}`)
        this.one = null
        this.apart(hub)
        return
      }
      this.one = done.refused ? null : hub.name
      if (done.refused) {
        this.once(done.refused)
        return
      }
      const lease = done.lease
      if (!lease || lease.granted) {
        this.whole = done.complete
        if (!done.complete) {
          this.once(
            `The conversation is still being copied to and from ${hub.name}: this turn runs on what is here, and what went apart is merged once the copy is whole.`,
            `copying:${hub.name}`,
          )
        }
        this.holding = 'hub'
        this.together(hub)
        this.renewEvery()
        return
      }
      const holder = lease.holder
      const who = holder
        ? `${holder.name} is answering (since ${this.opts.clock(holder.since)})`
        : 'another machine is answering'
      if (!wait)
        throw new Error(
          `${who}: this conversation takes one turn at a time across the machines, so say it again once it is done`,
        )
      this.once(
        `Waiting: ${who}, and this goes after its turn.`,
        `wait:${holder?.name}:${holder?.since}`,
      )
      await (this.opts.pause ?? sleep)(LEASE_ASKED_EVERY_MS)
    }
  }

  private async here(wait: boolean): Promise<void> {
    this.one = null
    const me = this.opts.shared.me
    for (;;) {
      const answer = this.lease.ask('take', me, this.key, this.opts.now())
      if (answer.granted) {
        this.holding = 'here'
        return
      }
      const holder = answer.holder
      const who = holder
        ? `${holder.name} is answering (since ${this.opts.clock(holder.since)})`
        : 'another machine is answering'
      if (!wait)
        throw new Error(
          `${who}: this conversation takes one turn at a time across the machines, so say it again once it is done`,
        )
      this.once(
        `Waiting: ${who}, and this goes after its turn.`,
        `wait:${holder?.name}:${holder?.since}`,
      )
      await (this.opts.pause ?? sleep)(LEASE_ASKED_EVERY_MS)
    }
  }

  /** The turn is over: what it wrote goes to the hub, and the lease is let go. Never throws. */
  async after(): Promise<void> {
    if (this.renewing) clearInterval(this.renewing)
    this.renewing = null
    const holding = this.holding
    this.holding = null
    if (holding === 'here') {
      this.lease.ask('release', this.opts.shared.me, this.key, this.opts.now())
      return
    }
    const hub = this.opts.hub()
    if (!hub?.up) return
    try {
      await this.opts.shared.exchange(
        (ask) => hub.send(ask),
        holding === 'hub' ? { op: 'release', key: this.key } : undefined,
        ROUNDS_AT_ONCE,
      )
    } catch (err) {
      // Given next time; the lease runs out by itself meanwhile.
      this.opts.warn(`what this turn said could not be given to ${hub.name} yet: ${why(err)}`)
    }
  }

  /**
   * The hub's door: one request of a machine that links here, its lease asked
   * of the lease this machine keeps.
   */
  async answer(ask: ConversationAsk): Promise<ConversationAnswer> {
    const lease = ask.lease
      ? this.lease.ask(ask.lease.op, ask.from, ask.lease.key, this.opts.now())
      : undefined
    const answer = await this.opts.shared.answer(ask)
    return lease ? { ...answer, lease } : answer
  }

  /**
   * Between turns, on the beat: exchange with the hub where there is one, and
   * take in what another machine said where nothing forked — so every screen
   * shows the conversation as it is written. A fork waits for a turn, or for
   * the lease to be free here. The harness reads it all before the next turn.
   */
  async idle(working: boolean): Promise<void> {
    if (this.busy || this.holding !== null || working) return
    const run = (async () => {
      const hub = this.opts.hub()
      if (hub?.up) {
        try {
          const done = await this.opts.shared.exchange(
            (ask) => hub.send(ask),
            { op: 'look', key: this.key },
            ROUNDS_AT_ONCE,
          )
          this.whole = done.complete
          this.others = done.lease?.granted === false
          this.one = done.refused ? null : hub.name
          this.together(hub)
          if (done.refused) this.once(done.refused)
        } catch (err) {
          this.opts.warn(`the conversation could not be exchanged with ${hub.name}: ${why(err)}`)
          this.one = null
          return
        }
      } else if (hub) {
        return
      }
      if (hub === null) {
        this.one = null
        this.others = this.lease.holder(this.opts.now()) !== null
      }
      // Only what nothing forked: a fork waits for a turn of a machine that dials the hub.
      this.saySettled(await this.opts.shared.settle(false))
    })()
    this.busy = run
    try {
      await run
    } catch (err) {
      this.opts.warn(`the conversation could not be taken in: ${why(err)}`)
    } finally {
      this.busy = null
    }
  }

  /** Renew the hub's lease while the turn runs, asking each time how the hub's link stands now. */
  private renewEvery(): void {
    if (this.renewing) clearInterval(this.renewing)
    this.renewing = setInterval(() => {
      const hub = this.opts.hub()
      if (!hub?.up) return
      void hub
        .send({
          from: this.opts.shared.me,
          harness: this.opts.shared.harness,
          lease: { op: 'renew', key: this.key },
        })
        // Said, and not fatal: a lease not renewed runs out, and the next turn takes it again.
        .catch((err: unknown) =>
          this.opts.warn(`the turn lease at ${hub.name} could not be renewed: ${why(err)}`),
        )
    }, RENEW_MS)
    this.renewing.unref?.()
  }

  private saySettled(settled: readonly Settled[]): void {
    let took = false
    for (const one of settled) {
      if ('refused' in one && one.refused) {
        this.once(
          `The conversation is not one across the machines right now: ${one.refused}.`,
          `refused:${one.refused}`,
        )
        continue
      }
      if (one.took === 0) continue
      took = true
      this.stale = true
      if ('merged' in one && one.merged) {
        this.opts.say(
          `While ${one.merged.trunk} and ${one.merged.other} could not reach each other, this conversation went on on both: what happened on ${one.merged.other} is now in it, after a marker, word for word.`,
        )
      }
    }
    if (took) this.opts.took?.(settled)
  }

  private apart(hub: HubLink): void {
    const since = hub.downSince ?? this.opts.now()
    if (this.apartSince !== null) return
    this.apartSince = since
    this.opts.say(
      `${hub.name} not linked since ${this.opts.clock(since)}: carrying on here; this conversation is merged with ${hub.name}'s when it is back.`,
    )
  }

  private together(hub: HubLink): void {
    if (this.apartSince === null) return
    this.apartSince = null
    this.opts.say(
      `${hub.name} is linked again: the conversation is exchanged, and merged at the next turn where the two went apart.`,
    )
  }

  private once(text: string, key = text): void {
    if (this.said.has(key)) return
    this.said.add(key)
    this.opts.say(text)
  }
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
