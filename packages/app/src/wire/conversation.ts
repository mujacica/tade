import { type ConversationAsk, hubOf, machineLabel, printable } from '@tade/core'
import {
  HubAway,
  type HubLink,
  HubStarting,
  type MachineNamed,
  type OneConversation,
} from '@tade/harnesses-core'
import { type Answer, LinkError, type Remote, type RemoteLink } from '@tade/remotes-core'
import { type OrchestratorStanding, STARTING, type WebConversation } from '@tade/web'
import { clockOf, type Wiring, why } from './context.ts'
import { seenName } from './machines-seen.ts'

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
  /**
   * The orchestrator's, once it is up on a harness that keeps one conversation
   * everywhere; `'starting'` while it is coming up again; null where it runs on
   * one that keeps none, or did not start.
   */
  use(one: OneConversation | 'starting' | null): void
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
  /**
   * Until the orchestrator's start has settled, a machine asking is told to
   * wait (`STARTING`) rather than refused: the door opens before the
   * orchestrator is up, and refusing then was a 500 reported from both ends
   * on every start of a hub (TADE-A, TADE-B).
   */
  private starting = true
  private reach: ConversationReach | null = null
  /** Whether the orchestrator came up, and why not where it did not: told by whoever starts it. */
  private thinker: { state: OrchestratorStanding['state']; said: string | null } = {
    state: 'starting',
    said: null,
  }
  private readonly downAt = new Map<string, number>()
  private lastAt = 0
  private busy = false
  /**
   * The machines that link here whose exchange this machine, as the hub,
   * last took rather than refused, by the name their copy is kept under
   * (`seenName`): their turns are turns of this conversation (`joinedBy`).
   */
  private readonly joiners = new Set<string>()

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
        this.starting = one === 'starting'
        this.one = one === 'starting' ? null : one
        if (one === 'starting') this.thinker = { state: 'starting', said: null }
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
        // The link down as it was asked, or nothing answering there — its
        // window restarting: given at the next exchange, not trouble (`HubAway`).
        if (!held?.live) throw new HubAway(`${name} is not linked`)
        let answer: Answer
        try {
          answer = await held.link.request(name, DOOR, ask)
        } catch (err) {
          if (err instanceof LinkError) throw new HubAway(err.message)
          throw err
        }
        // Unread: the exchange checks every answer before it takes anything (`ConversationReply`).
        if (answer.status === 200) return answer.body
        // Its orchestrator not up yet: waited for, and not trouble.
        if (
          answer.status === 503 &&
          (answer.body as { error?: unknown } | null)?.error === STARTING
        )
          throw new HubStarting(name)
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

  /**
   * The hub whose turns are turns of this machine's conversation, by its
   * name here, whether or not its link is up this minute: named as the hub,
   * with the orchestrator here on a harness that keeps one conversation
   * everywhere (or still coming up), and the hub not having said it keeps
   * its own. Its tab folds into the one strip (`remote-talk.ts`), and its
   * lines are drawn there as they run (`fleet-talk.ts`).
   */
  sharesWith(): string | null {
    const hub = hubOf(this.wire.opts.config).hub?.name ?? null
    if (hub === null || this.one?.refused === true) return null
    return this.one !== null || this.starting ? hub : null
  }

  /** Whether a machine that links here exchanges this conversation, by its copy's name (`ProjectionsHeld`). */
  joinedBy(name: string): boolean {
    return this.joiners.has(seenName(name).toLowerCase())
  }

  /** The orchestrator came up (`Heart.attachThinker`). */
  started(): void {
    this.thinker = { state: 'up', said: null }
  }

  /** The orchestrator did not start, and why (`Heart.thinkerFailed`). */
  failed(reason: string): void {
    this.thinker = { state: 'failed', said: reason }
  }

  /**
   * How the orchestrator here stands, as another machine of the person's is
   * told it (`/api/machine`): whether it came up, whether its conversation is
   * one across the machines, and with which hub — what a reload of every
   * machine is checked against (`fleet-reload.ts`).
   */
  standing(): OrchestratorStanding {
    return {
      state: this.thinker.state,
      said: this.thinker.said === null ? null : printable(this.thinker.said).slice(0, 600),
      shares: this.one !== null,
      joined: this.one?.joined ?? null,
      model: this.wire.opts.config.orchestrator.model || null,
    }
  }

  /** The far half: one request of a machine that links here. */
  web(): WebConversation {
    return async (body) => {
      const one = this.one
      if (!one) {
        if (this.starting) return STARTING
        throw new Error(
          'the orchestrator here is not running on a harness that keeps one conversation on every machine',
        )
      }
      const answer = await one.answer(body)
      const name = seenName(body.from.name).toLowerCase()
      if (answer.refused === undefined) this.joiners.add(name)
      else this.joiners.delete(name)
      return answer
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
