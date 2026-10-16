import type { RequiredProgram, Unsubscribe } from '@tade/core'
import { Follower, type Reaching } from './follow.ts'
import type {
  Held,
  LinkCapabilities,
  LinkOptions,
  OwnerSession,
  PairAt,
  Remote,
  RemoteLink,
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
}

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
