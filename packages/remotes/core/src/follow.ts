import { type ClientRequest, request } from 'node:http'
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

  private readonly remote: Remote
  private readonly reaching: Reaching
  private readonly opts: { now: () => number; changed: (held: Held) => void }

  constructor(
    remote: Remote,
    reaching: Reaching,
    opts: { now: () => number; changed: (held: Held) => void },
  ) {
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
  }

  /**
   * The machine was away: whatever is open may be dead without knowing it, so
   * let go of it and dial again now. An ended link stays ended.
   */
  wake(_now: number): void {
    if (this.closed || this.held.link.kind === 'ended') return
    void this.dialNow(true)
  }

  /** The person last pressed a key here, then. */
  press(at: number | null): void {
    this.pressedAt = at
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

function doorOf(door: Door): { socketPath: string } | { host: string; port: number } {
  return 'socketPath' in door
    ? { socketPath: door.socketPath }
    : { host: door.host, port: door.port }
}

/** A POST the guard takes: the exact origin, JSON, the session's token. The status, or 0. */
function post(door: Door, path: string, body: unknown, remote: Remote): Promise<number> {
  const text = JSON.stringify(body)
  const session = remote.session
  return new Promise((done) => {
    const req = request(
      {
        ...doorOf(door),
        path,
        method: 'POST',
        agent: false,
        timeout: POST_MS,
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
