import { type ClientRequest, request } from 'node:http'
import { SEEN_EVERY_MS } from '@tade/core'
import { COOKIE, idFor } from '@tade/web'
import { FRAME_MOST, framesIn } from './frames.ts'
import {
  answered,
  DIAL_MS,
  dialDue,
  dialling,
  dialStuck,
  type Heard,
  heard,
  heldFor,
  lost,
  presenceDue,
  quiet,
  touched,
} from './held.ts'
import { type Held, LinkError, type LinkProblem, type Remote } from './port.ts'

// Following one remote's live stream into a held value: the half of a link
// every implementation shares, because what crosses is the same away protocol
// however it got there.
//
// An implementation says only **how to reach the remote's listener**
// (`Reaching`): a socket a forward listens on, or an address. Everything after
// that — the stream, the cursor, the deadlines, the backoff, the presence — is
// here, once, and the rules it follows are `held.ts`'s, which is pure.
//
// **Nothing here is awaited by anybody who draws.** `beat`, `wake` and `press`
// return at once; a dial runs in the background and answers into `value`, and
// a dial overtaken by another (a wake, a redial) is told so by its number
// rather than by being waited for, so a late answer from a stream nobody wants
// any more can never overwrite the one that replaced it.

/** Where a remote's listener can be reached from here, once whatever is underneath is up. */
export type Door = { socketPath: string } | { host: string; port: number }

/** How an implementation reaches one remote. */
export interface Reaching {
  /**
   * A door to the remote's loopback listener, bringing up whatever is
   * underneath first. Throws `LinkError` with a sentence somebody can act on.
   */
  reach(): Promise<Door>
  /** Whatever is underneath may be dead: let go of it, so the next `reach` starts fresh. */
  drop(): Promise<void>
}

/** How long one presence may take to be carried before it is given up on. */
const POST_MS = 10_000

/**
 * How long a goodbye may take. The window is closing, and a remote that does
 * not answer in this long is one that will record this machine `lost` instead
 * — which is what `lost` exists for, and no reason to hold a quit.
 */
export const GOODBYE_MS = 2_000

/** What a follower is told by whoever holds it. */
export interface FollowOptions {
  now: () => number
  changed: (held: Held) => void
  /** This machine's own figures, said with its word that it is up; null for none. */
  figures?: () => unknown
}

export class Follower {
  private held: Held
  /** The stream being read, while there is one. */
  private stream: ClientRequest | null = null
  /** The door the last reach found, for the presence. */
  private door: Door | null = null
  /** Which dial is the current one: an answer from any other is thrown away. */
  private dial = 0
  private pressedAt: number | null = null
  /** The keypress last carried, and when; cleared whenever a stream opens. */
  private sent: { pressedAt: number; at: number } | null = null
  private posting = false
  private closed = false
  /**
   * This machine's own word to the remote that it is up (`/api/seen`): when it
   * was last said, whether one is on its way, and whether the remote takes it
   * at all — an older Tade there does not, and is not asked again until its
   * stream opens again.
   */
  private seenAt: number | null = null
  private seenPosting = false
  private seenRefused = false
  /**
   * Whether the remote refused this machine's figures with its word: an older
   * Tade there reads a body with them as malformed, so they are left off until
   * its stream opens again, and the word that it is up still gets through.
   */
  private figuresRefused = false
  /** When this machine went to sleep, where it woke from one: told once the link is back. */
  private went: number | null = null

  private readonly remote: Remote
  private readonly reaching: Reaching
  private readonly opts: FollowOptions

  constructor(remote: Remote, reaching: Reaching, opts: FollowOptions) {
    this.remote = remote
    this.reaching = reaching
    this.opts = opts
    this.held = heldFor(remote.name)
  }

  get value(): Held {
    return this.held
  }

  /** The spec it was opened with, so opening the same one again changes nothing. */
  get spec(): Remote {
    return this.remote
  }

  /** The door the stream came in by, while it is live: what a request rides on. Null otherwise. */
  get reached(): Door | null {
    return this.held.link.kind === 'live' ? this.door : null
  }

  /** The beat: a dial past its deadline or a stream gone quiet is given up on, then whatever is due. */
  beat(now: number): void {
    if (this.closed) return
    if (dialStuck(this.held, now)) {
      this.giveUp('timed out', `it did not answer within ${DIAL_MS / 1000}s`, now)
    } else if (quiet(this.held, now)) {
      this.giveUp('timed out', 'its stream went quiet, as a connection that dropped does', now)
    }
    if (dialDue(this.held, now)) void this.dialNow(false)
    if (this.held.link.kind === 'live' && presenceDue(this.pressedAt, this.sent, now)) {
      void this.carryPresence(now)
    }
    if (this.held.link.kind === 'live' && this.seenDue(now)) void this.carrySeen(now)
  }

  /**
   * Whether this machine's word that it is up is due: every `SEEN_EVERY_MS`,
   * and at once whenever a stream opens — a wake redials, so a sleep is told
   * on the first beat back, and one that did not get through is asked again
   * at the next interval rather than on every beat.
   */
  private seenDue(now: number): boolean {
    if (this.seenPosting || this.seenRefused) return false
    if (this.seenAt === null) return true
    return now - this.seenAt >= SEEN_EVERY_MS
  }

  /**
   * Say to the remote that this machine is up — and, the first time after a
   * sleep, how long ago it went, so its record says it slept rather than that
   * it was lost (`machines-seen.ts`). A `404` is an older Tade there: asked
   * again only once its stream opens again.
   */
  private async carrySeen(now: number): Promise<void> {
    const door = this.door
    if (door === null) return
    const went = this.went
    this.seenPosting = true
    try {
      const body = went === null ? { state: 'up' } : { state: 'up', slept: Math.max(0, now - went) }
      const figures = this.figuresRefused ? null : (this.opts.figures?.() ?? null)
      let status = await post(
        door,
        '/api/seen',
        figures === null ? body : { ...body, host: figures },
        this.remote,
      )
      // An older Tade there, which reads figures as a malformed body: said
      // again without them, so the word that this machine is up gets through.
      if (status === 400 && figures !== null) {
        this.figuresRefused = true
        status = await post(door, '/api/seen', body, this.remote)
      }
      if (status === 404) this.seenRefused = true
      // Told, or never to be: either way it is not said again.
      if (went !== null && (status === 200 || status === 404) && this.went === went)
        this.went = null
    } finally {
      this.seenAt = now
      this.seenPosting = false
    }
  }

  /**
   * This machine's Tade is closing: say so to the remote while the link is
   * live, within `GOODBYE_MS`. Never throws; a remote that does not hear it
   * records this machine `lost`, which is true enough.
   */
  async goodbye(): Promise<void> {
    const door = this.reached
    if (door === null || this.seenRefused) return
    await post(door, '/api/seen', { state: 'closed' }, this.remote, GOODBYE_MS)
  }

  /**
   * The machine was away: whatever is open may be dead without knowing it, so
   * let go of it and dial again now. An ended link stays ended.
   */
  wake(_now: number, went?: number): void {
    if (this.closed || this.held.link.kind === 'ended') return
    if (went !== undefined) this.went = went
    void this.dialNow(true)
  }

  /** The person last pressed a key here, then. */
  press(at: number | null): void {
    this.pressedAt = at
  }

  /**
   * What this machine kept of the remote from an earlier window (`kept.ts`):
   * drawn `as of` when it was heard, until the remote says anything itself. A
   * projection already heard is newer, and is left as it is.
   */
  seed(kept: Pick<Held, 'projection' | 'heardAt' | 'cursor'>): void {
    if (this.closed || this.held.projection !== null) return
    this.set({ ...this.held, ...kept })
  }

  /** Why what is held could not be kept on disk, or null where it was: on what is held, for saying. */
  keep(said: string | null): void {
    if (said !== this.held.kept) this.set({ ...this.held, kept: said })
  }

  /** Stop: no more dials, the stream closed, whatever reaches it let go of. Safe twice. */
  async stop(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.dial++
    this.endStream()
    await this.reaching.drop()
  }

  private set(held: Held): void {
    if (this.closed) return
    this.held = held
    this.opts.changed(held)
  }

  /** Give up on the dial or the stream there is, and let go of what reaches it. */
  private giveUp(problem: LinkProblem, said: string, now: number): void {
    this.dial++
    this.endStream()
    this.set(lost(this.held, problem, said, now))
    void this.reaching.drop()
  }

  private endStream(): void {
    const stream = this.stream
    this.stream = null
    stream?.destroy()
  }

  /** One dial: reach the listener, then open the stream from the cursor held. */
  private async dialNow(fresh: boolean): Promise<void> {
    if (this.closed) return
    const mine = ++this.dial
    this.endStream()
    this.set(dialling(this.held, this.opts.now()))
    let door: Door
    try {
      if (fresh) await this.reaching.drop()
      door = await this.reaching.reach()
    } catch (err) {
      if (mine !== this.dial) return
      const problem =
        err instanceof LinkError && err.problem !== 'unsupported' ? err.problem : 'failed'
      this.set(lost(this.held, problem, messageOf(err), this.opts.now()))
      return
    }
    if (mine !== this.dial || this.closed) return
    this.door = door
    this.open(door, mine)
  }

  private open(door: Door, mine: number): void {
    const session = this.remote.session
    const cursor = this.held.cursor
    const req = request({
      ...doorOf(door),
      path: '/api/stream',
      method: 'GET',
      agent: false,
      headers: {
        host: session.host,
        cookie: `${COOKIE}=${session.cookie}`,
        accept: 'text/event-stream',
        'cache-control': 'no-cache',
        ...(cursor === null ? {} : { 'last-event-id': idFor(cursor.epoch, cursor.rev) }),
      },
    })
    this.stream = req
    const now = this.opts.now
    const mineStill = () => mine === this.dial && !this.closed
    req.on('response', (res) => {
      if (!mineStill()) {
        res.destroy()
        return
      }
      const first = answered(
        this.held,
        res.statusCode ?? 0,
        String(res.headers['content-type'] ?? ''),
        now(),
      )
      this.set(first.held)
      if (first.next !== 'go on') {
        res.resume()
        this.endStream()
        return
      }
      this.sent = null
      // A stream opening is a remote that may have restarted: it is told this
      // machine is up at once, and one that refused before is asked again.
      this.seenAt = null
      this.seenRefused = false
      this.figuresRefused = false
      res.setEncoding('utf8')
      let rest = ''
      res.on('data', (chunk: string) => {
        if (!mineStill()) return
        rest += chunk
        if (rest.length > FRAME_MOST) {
          this.giveUp('failed', 'the remote sent a frame past every bound a snapshot has', now())
          return
        }
        const read = framesIn(rest)
        rest = read.rest
        let held = touched(this.held, now())
        for (const frame of read.frames) {
          const one: Heard = heard(held, frame, now())
          held = one.held
          if (one.next === 'go on') continue
          this.set(held)
          this.endStream()
          if (one.next === 'redial') void this.dialNow(false)
          return
        }
        this.set(held)
      })
      res.on('close', () => {
        if (!mineStill() || this.held.link.kind !== 'live') return
        this.stream = null
        this.set(lost(this.held, 'failed', 'the remote ended the stream', now()))
      })
    })
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (!mineStill()) return
      this.stream = null
      this.set(lost(this.held, 'failed', connectionSaid(err, this.remote), now()))
      // Refused or gone at this end is what is underneath being dead: a
      // forward whose connection went away leaves a socket nobody listens on.
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') void this.reaching.drop()
    })
    req.end()
  }

  /** Carry the person's presence: how long ago, never when (`@tade/web`'s `presence.ts`). */
  private async carryPresence(now: number): Promise<void> {
    const door = this.door
    const pressedAt = this.pressedAt
    if (this.posting || door === null || pressedAt === null) return
    this.posting = true
    try {
      const status = await post(
        door,
        '/api/presence',
        { ago: Math.max(0, now - pressedAt) },
        this.remote,
      )
      const held = { ...this.held, presence: status === 200 ? null : presenceSaid(status) }
      if (held.presence !== this.held.presence) this.set(held)
    } finally {
      // Written down whatever came of it, so a remote that refuses is asked
      // again at the next interval and not on every beat.
      this.sent = { pressedAt, at: now }
      this.posting = false
    }
  }
}

/** Why a presence was not taken, where it was not. */
function presenceSaid(status: number): string {
  if (status === 404) {
    return 'it does not take presence — an older Tade there, or notifications off — so it cannot tell you are here'
  }
  if (status === 0) return 'its presence could not be carried: the connection dropped'
  return `it refused this machine’s presence (${status})`
}

export function doorOf(door: Door): { socketPath: string } | { host: string; port: number } {
  return 'socketPath' in door
    ? { socketPath: door.socketPath }
    : { host: door.host, port: door.port }
}

/** A POST the guard takes: the exact origin, JSON, the session's token. The status, or 0. */
function post(
  door: Door,
  path: string,
  body: unknown,
  remote: Remote,
  within = POST_MS,
): Promise<number> {
  const text = JSON.stringify(body)
  const session = remote.session
  return new Promise((done) => {
    const req = request(
      {
        ...doorOf(door),
        path,
        method: 'POST',
        agent: false,
        timeout: within,
        headers: {
          host: session.host,
          origin: `http://${session.host}`,
          cookie: `${COOKIE}=${session.cookie}`,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(text)),
          'x-tade-csrf': session.csrf,
        },
      },
      (res) => {
        res.resume()
        done(res.statusCode ?? 0)
      },
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => done(0))
    req.end(text)
  })
}

/** A connection that failed, in words: what answered, or what did not. */
function connectionSaid(err: NodeJS.ErrnoException, remote: Remote): string {
  const code = err.code ?? ''
  if (code === 'ECONNREFUSED' || code === 'ENOENT') {
    return 'the connection to it had gone; it is dialled again'
  }
  if (code === 'ECONNRESET' || code === 'EPIPE' || /hang up/.test(err.message)) {
    return `nothing answers on ${remote.session.host} there: its Tade is not open, or its away view is off`
  }
  return `the stream could not be opened: ${err.message}`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
