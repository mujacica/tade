import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { printable, type RequiredProgram, type Unsubscribe } from '@tade/core'
import { callOver } from './call.ts'
import { type Door, doorOf, Follower, type Reaching } from './follow.ts'
import { readKept, writeKept } from './kept.ts'
import { pagesOver } from './pages.ts'
import {
  type Answer,
  type Held,
  type Identity,
  type LinkCapabilities,
  LinkError,
  type LinkOptions,
  type PagesHere,
  type PairAt,
  type Paired,
  type Remote,
  type RemoteLink,
  type RepositoryThere,
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
  pair(at: PairAt): Promise<Paired>
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
  /** With `terminals`: what came of a terminal it handed back with `proving`. */
  attached?(remote: Remote, by: string, through: boolean): Promise<void>
  /** With `fetches`: how git here fetches a repository there, at a root `rootOk` passed. */
  repository?(remote: Remote, root: string): RepositoryThere
}

/** How long a request over a held link may take: a read, or a verb carried out there. */
export const REQUEST_MS = 20_000

/**
 * A remote's line for a terminal there, as it may be handed back to it: one
 * line of printable text, bounded. It is that machine's own words run by that
 * machine's shell, so this is not what keeps it safe — it is what keeps a
 * second command, or an escape this terminal would act on, out of an argument
 * nobody reads.
 */
export function lineOk(line: string): boolean {
  return /^[\x20-\x7e]{1,4096}$/.test(line)
}

/**
 * A root another machine named as one of its projects, as it may be handed to
 * git there: absolute, and plain — no space, no quote, nothing a shell or a
 * URL would read as more than a path. A root with anything else is one this
 * machine does not fetch, and says so, rather than one it quotes and hopes.
 */
export function rootOk(root: string): boolean {
  return /^\/[A-Za-z0-9_.@+~/-]{0,4095}$/.test(root) && !root.split('/').includes('..')
}

/**
 * How often what is held of one remote is written to disk while it moves
 * (`kept.ts`): a projection moves on every beat that changed something, and
 * a copy for drawing `as of` after a restart is worth a write every few
 * seconds, not one per delta. The last one is written as a link is let go of.
 */
export const KEEP_EVERY_MS = 5_000

/** A whole link out of a transport. */
export function linkOver(transport: Transport, options: LinkOptions): RemoteLink {
  return new Links(transport, options.now ?? Date.now, options.home, options.figures, options.name)
}

/** What keeping one remote's projection on disk stands at. */
interface Keeping {
  /** The projection last written, by identity: an unchanged one is not written again. */
  wrote: object | null
  at: number | null
  writing: boolean
  /** A write held back by `KEEP_EVERY_MS`, waiting for its turn. */
  waiting: ReturnType<typeof setTimeout> | null
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
  private readonly home: string
  private readonly keeping = new Map<string, Keeping>()
  private readonly figures: () => unknown
  private readonly name: (() => string) | undefined

  constructor(
    transport: Transport,
    now: () => number,
    home: string,
    figures: () => unknown = () => null,
    name?: () => string,
  ) {
    this.transport = transport
    this.now = now
    this.home = home
    this.figures = figures
    this.name = name
    this.id = transport.id
    this.capabilities = transport.capabilities
    this.programs = transport.programs
  }

  pair(at: PairAt): Promise<Paired> {
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

  pages(remote: Remote): Promise<PagesHere> {
    return pagesOver(() => this.transport.connect(remote), remote)
  }

  terminal(remote: Remote, words: readonly string[]): TerminalThere | null {
    if (!this.capabilities.terminals) return null
    return this.transport.terminal?.(remote, words) ?? null
  }

  async attach(remote: Remote, line: string): Promise<TerminalThere | null> {
    if (!this.capabilities.terminals || this.transport.attach === undefined) return null
    if (!lineOk(line)) {
      throw new LinkError(
        'failed',
        `${remote.name} answered a line no link hands a shell: ${JSON.stringify(printable(line).slice(0, 80))}`,
      )
    }
    return this.transport.attach(remote, line)
  }

  async attached(remote: Remote, by: string, through: boolean): Promise<void> {
    await this.transport.attached?.(remote, by, through)
  }

  repository(remote: Remote, root: string): RepositoryThere | null {
    if (!this.capabilities.fetches || this.transport.repository === undefined) return null
    if (!rootOk(root)) {
      throw new LinkError(
        'failed',
        `${remote.name} named ${JSON.stringify(printable(root).slice(0, 120))} as where a project is, which is not a path this machine fetches from: an absolute path of letters, digits and . _ - + @ ~ /`,
      )
    }
    return this.transport.repository(remote, root)
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
      figures: this.figures,
      ...(this.name && { name: this.name }),
    })
    follower.press(this.pressedAt)
    this.followers.set(remote.name, follower)
    this.told(remote.name)
    // What an earlier window kept of it, drawn `as of` until it answers.
    if (was === undefined) {
      readKept(this.home, remote.name).then(
        (kept) => {
          if (kept !== null && this.followers.get(remote.name) === follower) {
            this.keepingOf(remote.name).wrote = kept.projection
            follower.seed(kept)
          }
        },
        // Said on what is held, as a write that failed is; the next write replaces the file.
        (err: unknown) => follower.keep(err instanceof Error ? err.message : String(err)),
      )
    }
  }

  async close(name: string): Promise<void> {
    const follower = this.followers.get(name)
    if (follower === undefined) return
    this.followers.delete(name)
    await follower.stop()
    await this.keepNow(name, follower)
    this.keeping.delete(name)
    this.told(name)
  }

  async goodbye(): Promise<void> {
    await Promise.all([...this.followers.values()].map((follower) => follower.goodbye()))
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

  wake(now: number, went?: number): void {
    for (const follower of this.followers.values()) follower.wake(now, went)
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

  private keepingOf(name: string): Keeping {
    const had = this.keeping.get(name)
    if (had !== undefined) return had
    const made: Keeping = { wrote: null, at: null, writing: false, waiting: null }
    this.keeping.set(name, made)
    return made
  }

  /**
   * What is held of one remote moved: written to disk if its projection did,
   * no oftener than `KEEP_EVERY_MS` — one held back is written when its turn
   * comes, with whatever is held by then.
   */
  private keep(name: string): void {
    const follower = this.followers.get(name)
    const projection = follower?.value.projection ?? null
    if (follower === undefined || projection === null) return
    const keeping = this.keepingOf(name)
    if (keeping.wrote === projection || keeping.waiting !== null || keeping.writing) return
    const wait = keeping.at === null ? 0 : KEEP_EVERY_MS - (this.now() - keeping.at)
    if (wait > 0) {
      keeping.waiting = setTimeout(() => {
        keeping.waiting = null
        this.keep(name)
      }, wait)
      keeping.waiting.unref?.()
      return
    }
    void this.keepNow(name, follower)
  }

  /** Write what is held of one remote now, if it moved since the last write; never throws. */
  private async keepNow(name: string, follower: Follower): Promise<void> {
    const keeping = this.keepingOf(name)
    if (keeping.waiting !== null) clearTimeout(keeping.waiting)
    keeping.waiting = null
    const held = follower.value
    if (held.projection === null || held.heardAt === null || keeping.wrote === held.projection) {
      return
    }
    if (keeping.writing) return
    keeping.writing = true
    keeping.at = this.now()
    try {
      await writeKept(this.home, name, {
        projection: held.projection,
        heardAt: held.heardAt,
        cursor: held.cursor,
      })
      keeping.wrote = held.projection
      follower.keep(null)
    } catch (err) {
      follower.keep(
        `what was last heard from ${name} could not be kept on this machine, so a window opened while it is down draws nothing of it: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      keeping.writing = false
    }
    // What moved while it was being written is written in its turn.
    if (this.followers.get(name) === follower) this.keep(name)
  }

  private told(name: string): void {
    this.keep(name)
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
