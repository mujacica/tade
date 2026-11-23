import { type ConversationAsk, hubOf, machineLabel, printable } from '@tade/core'
import type {
  ConversationAnswer,
  HubLink,
  MachineNamed,
  OneConversation,
} from '@tade/harnesses-core'
import type { Remote, RemoteLink } from '@tade/remotes-core'
import type { WebConversation } from '@tade/web'
import { clockOf, type Wiring, why } from './context.ts'

// One orchestrator conversation on every machine, from the heart and the
// window (`@tade/harnesses-core`'s `one-conversation.ts` is when its turns run
// and how two branches become one, `conversation-share.ts` the exchange).
//
// **The far half is the heart's**, so a `tade serve` hub with no screen
// answers it: `/api/conversation` (`@tade/web`'s `shared-conversation.ts`),
// the exchange and the turn lease in one door. **The near half is the
// window's**, because only a window dials another machine: the hub this
// machine's config names (`hubOf`), over the owner link it already holds.
// Where the config names none, this machine keeps the lease itself.
//
// **On the beat**, between turns, it exchanges with the hub every `AGAIN_MS` —
// every `FAST_MS` while another machine's turn holds the lease — and takes in
// what nothing forked, so the strip shows a turn the hub ran as it is written
// rather than at the next thing you say; the hub takes in what its machines
// gave it the same way. Nothing that draws waits on any of it.

/** How often the conversation is exchanged with the hub between turns. */
const AGAIN_MS = 30_000
/** How often, while another machine's turn is going. */
const FAST_MS = 3_000

/** The hub's door for it (`@tade/web`'s `shared-conversation.ts`). */
const DOOR = '/api/conversation'

export type ConversationReach = (
  name: string,
) => { link: RemoteLink; remote: Remote; live: boolean } | null

/** What whoever starts the orchestrator needs to make its conversation one on every machine. */
export interface ConversationPlace {
  home: string
  me(): MachineNamed
  hub(): HubLink | null
  /** Said where the conversation is drawn, in Tade's words. */
  say(text: string): void
  /** Written down where Tade's own trouble goes. */
  warn(text: string): void
  /** Entries another machine wrote were taken in: drawn below the conversation. */
  took(): void
  clock(at: number): string
  now(): number
  /** The orchestrator's, once it is up on a harness that keeps one conversation everywhere; null when it stops. */
  use(one: OneConversation | null): void
}

export interface FleetConversationDeps {
  /** Said in the strip. */
  say(said: string): void
  /** Drawn below the conversation: what another machine said, read back out of the record. */
  later(): void
}

export class FleetConversation {
  private readonly wire: Wiring
  private readonly deps: FleetConversationDeps
  private one: OneConversation | null = null
  private reach: ConversationReach | null = null
  private readonly downAt = new Map<string, number>()
  private lastAt = 0
  private busy = false

  constructor(wire: Wiring, deps: FleetConversationDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** How the window reaches its remotes. Never set under `tade serve`, which dials nobody. */
  withReach(reach: ConversationReach): void {
    this.reach = reach
  }

  /** What the orchestrator's start is handed (`orchestrating.ts`). */
  place(): ConversationPlace {
    return {
      home: this.wire.opts.home,
      me: () => ({ id: this.wire.opts.client.machine.id, name: machineLabel() }),
      hub: () => this.hub(),
      say: (text) => this.deps.say(text),
      warn: (text) => {
        void this.wire.opts.client.log
          .append({ type: 'warning', task: null, detail: { message: `the conversation: ${text}` } })
          .catch((err: unknown) => this.wire.note(err))
      },
      took: () => this.deps.later(),
      clock: (at) => clockOf(at),
      now: () => this.wire.now(),
      use: (one) => {
        this.one = one
      },
    }
  }

  /** The hub over its link, where another machine is the hub; null where this one keeps the lease. */
  hub(): HubLink | null {
    const { hub } = hubOf(this.wire.opts.config)
    if (!hub || !this.reach) return null
    const name = hub.name
    const up = this.reach(name)?.live === true
    if (up) this.downAt.delete(name)
    else if (!this.downAt.has(name)) this.downAt.set(name, this.wire.now())
    return {
      name,
      up,
      downSince: this.downAt.get(name) ?? null,
      send: async (ask: ConversationAsk) => {
        const held = this.reach?.(name)
        if (!held?.live) throw new Error(`${name} is not linked`)
        const answer = await held.link.request(name, DOOR, ask)
        if (answer.status === 200) return answer.body as ConversationAnswer
        // An older Tade there has no such door: said in words, and carried on apart.
        const said = (answer.body as { said?: unknown } | null)?.said
        throw new Error(
          answer.status === 404
            ? `${name} runs a Tade with no one conversation across machines: upgrade Tade there`
            : `${name} would not exchange the conversation (${answer.status})${typeof said === 'string' ? `: ${printable(said)}` : ''}`,
        )
      },
    }
  }

  /**
   * The hub this window's own conversation is one with, so a turn running
   * there is escape's to stop from here (`remote-talk.ts`); null where none is
   * named, or the last exchange with it was refused or failed.
   */
  oneWith(): string | null {
    const joined = this.one?.joined ?? null
    return joined !== null && hubOf(this.wire.opts.config).hub?.name === joined ? joined : null
  }

  /** The far half: one request of a machine that links here. */
  web(): WebConversation {
    return async (body) => {
      const one = this.one
      if (!one) {
        throw new Error(
          'the orchestrator here is not running on a harness that keeps one conversation on every machine',
        )
      }
      return one.answer(body)
    }
  }

  /** The beat: exchange and take in, between turns, one at a time. Never throws. */
  beat(working: boolean): void {
    const one = this.one
    if (!one || this.busy) return
    const now = this.wire.now()
    if (now - this.lastAt < (one.othersTurn ? FAST_MS : AGAIN_MS)) return
    this.lastAt = now
    this.busy = true
    void one
      .idle(working)
      .catch((err: unknown) =>
        this.deps.say(`The conversation could not be exchanged: ${why(err)}`),
      )
      .finally(() => {
        this.busy = false
      })
  }
}
