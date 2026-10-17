import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import type { RequiredProgram, Unsubscribe } from '@tade/core'
import { callOver } from './call.ts'
import { type Door, doorOf, Follower, type Reaching } from './follow.ts'
import {
  type Answer,
  type Held,
  type Identity,
  type LinkCapabilities,
  LinkError,
  type LinkOptions,
  type OwnerSession,
  type PairAt,
  type Remote,
  type RemoteLink,
  type TerminalThere,
} from './port.ts'

// A `RemoteLink` made out of how one kind of link reaches a remote.
//
// What differs between implementations is small and is the `Transport`: what
// it is called, what it needs of the machine, how it pairs, and how it reaches
// one remote's listener. Holding any number of remotes, a follower each, the
// beat, the wake and the presence is the same for all of them, so it is here
// once — the way `drivers/core` keeps what every driver would otherwise write
// again — and the conformance suite holds every implementation to it all the
// same, because an implementation is free not to use this.

/** What one kind of link brings: the part that is not the same for every kind. */
export interface Transport {
  readonly id: string
  readonly capabilities: LinkCapabilities
  readonly programs: readonly RequiredProgram[]
  pair(at: PairAt): Promise<OwnerSession>
  unpair(remote: Remote): Promise<void>
  /** How to reach one remote's listener: made once per `open`, dropped with it. */
  reaching(remote: Remote): Reaching
  /**
   * A stream to one remote's loopback listener for one call, opened by itself
   * and gone when the call is: never the one a held link reads. Throws
   * `LinkError`.
   */
  connect(remote: Remote): Promise<Duplex>
  /** With `identifies`: how the remote is known here, and trusting it. */
  identify?(address: string): Promise<Identity>
  trust?(address: string, fingerprints: readonly string[]): Promise<Identity>
  /** With `terminals`: what to run here for a terminal there. */
  terminal?(remote: Remote, words: readonly string[]): TerminalThere
  /** With `terminals`: what to run here for a terminal there running the remote's own line. */
  attach?(remote: Remote, line: string): Promise<TerminalThere>
}

/** How long a request over a held link may take: a read, or a verb carried out there. */
export const REQUEST_MS = 20_000

/** A whole link out of a transport. */
export function linkOver(transport: Transport, options: LinkOptions): RemoteLink {
  return new Links(transport, options.now ?? Date.now)
}

class Links implements RemoteLink {
  readonly id: string
  readonly capabilities: LinkCapabilities
  readonly programs: readonly RequiredProgram[]
  private readonly followers = new Map<string, Follower>()
  private readonly listeners = new Set<(name: string) => void>()
  private pressedAt: number | null = null
  private readonly transport: Transport
  private readonly now: () => number

  constructor(transport: Transport, now: () => number) {
    this.transport = transport
    this.now = now
    this.id = transport.id
    this.capabilities = transport.capabilities
    this.programs = transport.programs
  }

  pair(at: PairAt): Promise<OwnerSession> {
    return this.transport.pair(at)
  }

  unpair(remote: Remote): Promise<void> {
    return this.transport.unpair(remote)
  }

  async identify(address: string): Promise<Identity> {
    if (!this.capabilities.identifies || this.transport.identify === undefined) {
      throw new LinkError('unsupported', `a ${this.id} link has nothing to show before connecting`)
    }
    return this.transport.identify(address)
  }

  async trust(address: string, fingerprints: readonly string[]): Promise<Identity> {
    if (!this.capabilities.identifies || this.transport.trust === undefined) {
      throw new LinkError('unsupported', `a ${this.id} link has nothing to trust`)
    }
    return this.transport.trust(address, fingerprints)
  }

  call(remote: Remote, path: string, body: unknown): Promise<Answer> {
    return callOver(() => this.transport.connect(remote), remote, path, body)
  }

  terminal(remote: Remote, words: readonly string[]): TerminalThere | null {
    if (!this.capabilities.terminals) return null
    return this.transport.terminal?.(remote, words) ?? null
  }

  async attach(remote: Remote, line: string): Promise<TerminalThere | null> {
    if (!this.capabilities.terminals || this.transport.attach === undefined) return null
    return this.transport.attach(remote, line)
  }

  request(name: string, path: string, body?: unknown): Promise<Answer> {
    const follower = this.followers.get(name)
    if (follower === undefined) {
      return Promise.reject(new LinkError('failed', `${name} is not linked from this window`))
    }
    const door = follower.reached
    if (door === null) return Promise.reject(notLive(follower.value))
    return callOver(() => through(door), follower.spec, path, body, REQUEST_MS)
  }

  open(remote: Remote): void {
    const was = this.followers.get(remote.name)
    if (was !== undefined && same(was.spec, remote)) return
    // Another spec under the same name is another remote, as far as anything
    // held goes: a new session, a new place. The old one is let go of first.
    if (was !== undefined) void was.stop()
    const follower = new Follower(remote, this.reachingOf(remote), {
      now: this.now,
      changed: () => this.told(remote.name),
    })
    follower.press(this.pressedAt)
    this.followers.set(remote.name, follower)
    this.told(remote.name)
  }

  async close(name: string): Promise<void> {
    const follower = this.followers.get(name)
    if (follower === undefined) return
    this.followers.delete(name)
    await follower.stop()
    this.told(name)
  }

  held(name: string): Held | null {
    return this.followers.get(name)?.value ?? null
  }

  names(): readonly string[] {
    return [...this.followers.keys()]
  }

  watch(listener: (name: string) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  beat(now: number): void {
    for (const follower of this.followers.values()) follower.beat(now)
  }

  wake(now: number): void {
    for (const follower of this.followers.values()) follower.wake(now)
  }

  present(at: number | null): void {
    this.pressedAt = at
    for (const follower of this.followers.values()) follower.press(at)
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.names().map((name) => this.close(name)))
  }

  /**
   * How to reach it, or a way that only ever says why not: `open` is called on
   * the window's beat and may never throw, so an implementation that cannot
   * reach a remote at all is a link that is down with the reason.
   */
  private reachingOf(remote: Remote): Reaching {
    try {
      return this.transport.reaching(remote)
    } catch (err) {
      return {
        reach: () => Promise.reject(err),
        drop: async () => {},
      }
    }
  }

  private told(name: string): void {
    for (const listener of this.listeners) {
      try {
        listener(name)
      } catch (err) {
        // A listener that throws is not a reason a link stops being held, and
        // is not lost either: a promise nobody awaited is what Tade reports
        // (`watchProcess`), and nothing else.
        void Promise.reject(err)
      }
    }
  }
}

/** Why a link that is not live cannot be asked anything, in the words its state already has. */
function notLive(held: Held): LinkError {
  const link = held.link
  if (link.kind === 'down')
    return new LinkError(link.problem, `${held.remote} is down: ${link.said}`)
  if (link.kind === 'ended')
    return new LinkError('failed', `${held.remote} signed this machine out`)
  return new LinkError('timed out', `${held.remote} is still being linked`)
}

/** A stream to the remote's listener through the door a held link came in by. */
function through(door: Door): Promise<Duplex> {
  return new Promise((done, failed) => {
    const at = doorOf(door)
    const socket = 'socketPath' in at ? connect({ path: at.socketPath }) : connect(at)
    socket.once('connect', () => done(socket))
    socket.once('error', (err) => failed(err))
  })
}

function same(a: Remote, b: Remote): boolean {
  return (
    a.address === b.address &&
    a.tade === b.tade &&
    a.session.device === b.session.device &&
    a.session.cookie === b.session.cookie &&
    a.session.csrf === b.session.csrf &&
    a.session.host === b.session.host
  )
}
