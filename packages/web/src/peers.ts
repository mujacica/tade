import type { Delta, Snapshot } from './protocol.ts'
import {
  type Cursor,
  deltaFrame,
  HEARTBEAT_MS,
  KEEP_ALIVE,
  NOTICES,
  overBudget,
  PER_DEVICE,
  type Pending,
  REVOKED,
  Ring,
  resumeFrom,
  STALL_MS,
  STREAM_OPENING,
  snapshotFrame,
  sseFrame,
  TOTAL,
} from './stream.ts'

// Who is listening, what each of them has had, and when one of them stops
// being worth writing to.
//
// Pure, like `stream.ts`: **no clock and no timer.** The moment arrives as an
// argument and the beat belongs to the window, which is the same decision
// `reading.ts` already made and for the same reason — the window draws four
// times a second and already has a beat, so a second one here would be a timer
// nobody can see the cost of. A heartbeat is therefore *"has this stream been
// silent for fifteen seconds"* asked on a beat, not an interval per connection:
// one of those is bounded by the number of peers and the other is bounded by
// nothing.
//
// What writes bytes is `Sink`, which `server.ts` makes out of a
// `ServerResponse`. Nothing here imports `node:`, so the whole of the
// behaviour below — the caps, the fan-out, the backpressure, the stall, the
// revocation — is a table test over a fake sink rather than twenty sockets.
//
// **A ring per device, not per server.** The projection is per device
// (`readingFor`), so two phones granted different projects are two
// projections; one ring would replay one device's rows into the other's page.

/** Where a frame's bytes go. One line of it per peer, and nothing else. */
export interface Sink {
  /**
   * Hand bytes over.
   *
   * `false` is Node's own answer when the socket's buffer is past its mark —
   * the bytes are still accepted, so this is "the peer is not keeping up"
   * rather than "that was not written". What is done about it is to **stop
   * handing it deltas**, which is the only bound that actually holds when the
   * thing underneath buffers for you.
   */
  write(text: string): boolean
  end(): void
}

/** What one stream is, as the window has it to count and to close. */
export interface Peer {
  readonly device: string
  /** Whether anything more will be written to it. */
  readonly open: boolean
}

export interface OpenRequest {
  device: string
  /** When this device's session runs out, as a moment. */
  until: number
  /** Where the client says it got to. Null for a new tab. */
  cursor: Cursor | null
  sink: Sink
  /**
   * The whole projection, built **only if a snapshot is what gets sent**.
   *
   * A function and not a value, so a reconnection that can be answered out of
   * the ring costs no projection at all — which is the common case and the
   * one worth being cheap.
   */
  snapshot: () => Snapshot
  /**
   * The revision this device's projection has reached.
   *
   * The window's, out of its own projector, and **not** read off the ring: a
   * server that has been up for an hour with nobody connected has advanced
   * its revision many times and kept no delta, so a ring's newest entry is a
   * lower number than the truth — and comparing a client's cursor against it
   * would answer "from the future" to a perfectly good reconnection.
   */
  rev: number
  now: number
}

/** What opening came to. */
export type Opened =
  /** It is open; the opening frames have already been written. */
  | { kind: 'open'; peer: Peer }
  /**
   * This device already has its allowance, and has been **told so and closed**
   * — the frame and the `end()` have happened, because the stream was opened
   * far enough to say why. A hang would be the alternative, and a named error
   * is the whole point.
   */
  | { kind: 'too_many' }

export interface StreamOptions {
  perDevice?: number
  total?: number
  /** How many deltas each device's ring keeps. */
  ring?: number
  /** Where a line about a stream goes. Never throws, never blocks. */
  tell?: (said: { why: string; device: string }) => void
}

/**
 * Every live stream, grouped by the device it belongs to.
 *
 * The one object the window holds and the server opens into. Everything it
 * decides is bounded: the number of peers, the number of deltas kept, and how
 * much may be outstanding for one of them before its deltas stop being worth
 * sending.
 */
export class Streams {
  private readonly peers: Held[] = []
  private readonly rings = new Map<string, Ring>()
  private readonly perDevice: number
  private readonly most: number
  private readonly ringSize: number
  private readonly tell: (said: { why: string; device: string }) => void
  /** The epoch every frame is stamped with. Set once, by the window. */
  private epoch = ''
  private stopping = false

  constructor(opts: StreamOptions = {}) {
    this.perDevice = Math.max(1, opts.perDevice ?? PER_DEVICE)
    this.most = Math.max(1, opts.total ?? TOTAL)
    this.ringSize = opts.ring ?? 0
    const tell = opts.tell
    this.tell = (said) => {
      try {
        tell?.(said)
      } catch {
        // A reporter that throws is not a reason a stream dies. The same rule
        // the server already holds for `tell`.
      }
    }
  }

  /** The server lifetime every frame belongs to. Minted once, per start. */
  use(epoch: string): void {
    this.epoch = epoch
  }

  get count(): number {
    return this.peers.length
  }

  /** Whether the total cap is reached, which the server answers `503` to. */
  get full(): boolean {
    return this.peers.length >= this.most
  }

  /**
   * The devices somebody is listening for.
   *
   * What the window reads to decide which projections to build at all: a
   * device nobody has a stream open for is a projection nobody asked for, and
   * building one would be the "idle cost" this design promised was nought.
   */
  listening(): string[] {
    return [...new Set(this.peers.map((peer) => peer.device))]
  }

  /**
   * Open one, having already decided it is allowed in.
   *
   * The opening frames are written here rather than by the caller, because
   * what they are is a property of the cursor and the ring: a client that can
   * be caught up gets its deltas and no snapshot, and a client that cannot
   * gets told `resync` *before* the snapshot so the page can say it lost its
   * place rather than redrawing with no explanation.
   */
  open(req: OpenRequest): Opened {
    const mine = this.peers.filter((peer) => peer.device === req.device)
    if (mine.length >= this.perDevice) {
      req.sink.write(STREAM_OPENING)
      req.sink.write(
        sseFrame({
          event: 'too_many',
          data: { said: `this device already has ${this.perDevice} live connections` },
        }),
      )
      req.sink.end()
      this.tell({ why: `a fifth stream for one device was refused`, device: req.device })
      return { kind: 'too_many' }
    }

    const ring = this.ringFor(req.device)
    const held = new Held(req.device, req.until, req.sink, req.now)
    this.peers.push(held)
    held.send(STREAM_OPENING, req.now)

    const resume = resumeFrom(req.cursor, this.epoch, req.rev, ring.held)
    if (resume.kind === 'replay') {
      for (const delta of ring.since(resume.from)) {
        held.send(sseFrame(deltaFrame(this.epoch, delta)), req.now)
      }
      // A client that was already level gets nothing but the keep-alive
      // rhythm, which is correct and is the case a test has to cover: the
      // tempting shape — always open with a snapshot — is a whole projection
      // down a phone's connection every time a tunnel blinks.
      return { kind: 'open', peer: held }
    }
    if (resume.kind === 'resync') {
      held.send(
        sseFrame({
          event: 'resync',
          data: { why: 'behind', said: 'this page was too far behind to catch up' },
        }),
        req.now,
      )
      this.tell({ why: `a stream resynced: ${resume.why}`, device: req.device })
    }
    held.send(sseFrame(snapshotFrame(req.snapshot())), req.now)
    return { kind: 'open', peer: held }
  }

  /**
   * One device's projection moved on.
   *
   * The ring is fed whether or not anybody is behind, because the ring is what
   * a reconnection is answered out of — a delta nobody was connected for is
   * still the delta the next reconnection needs.
   */
  push(device: string, delta: Delta, now: number): void {
    if (this.stopping) return
    this.ringFor(device).add(delta)
    const text = sseFrame(deltaFrame(this.epoch, delta))
    for (const peer of this.peers) {
      if (peer.device !== device) continue
      peer.send(text, now)
    }
  }

  /**
   * The beat: heartbeats, clients that stopped reading, sessions that ran out.
   *
   * Everything time-based about a stream happens here and nowhere else, which
   * is what "no unbounded timers" means mechanically rather than as a claim.
   */
  beat(now: number): void {
    for (const peer of [...this.peers]) {
      if (now >= peer.until) {
        this.end(peer, sseFrame({ event: 'revoked', data: { why: REVOKED.expired } }))
        continue
      }
      if (peer.stalledFor(now) > STALL_MS) {
        // No frame: a client that has not read for thirty seconds is not going
        // to read the sentence explaining why it was closed. The browser
        // reconnects and resyncs, which is the recovery.
        this.tell({ why: 'a stream that stopped reading was closed', device: peer.device })
        this.end(peer, null)
        continue
      }
      peer.catchUp(now)
      if (now - peer.wroteAt >= HEARTBEAT_MS) peer.send(KEEP_ALIVE, now)
    }
  }

  /** This device's session was pushed forward, so its streams live longer. */
  renewed(device: string, until: number): void {
    for (const peer of this.peers) {
      if (peer.device === device) peer.renew(until)
    }
  }

  /**
   * This device lost its access: every stream it has ends now.
   *
   * Promptly and not at the next beat, because revoking a device at the
   * machine is a person deciding something, and a stream that kept delivering
   * for two more seconds would be the one thing "Disconnect everything" must
   * never mean.
   */
  revoke(device: string, why: keyof typeof REVOKED = 'signed out'): void {
    const frame = sseFrame({ event: 'revoked', data: { why: REVOKED[why] } })
    for (const peer of [...this.peers]) {
      if (peer.device === device) this.end(peer, frame)
    }
    this.rings.delete(device)
  }

  /** The socket drained: this peer is keeping up again. */
  drained(peer: Peer, now: number): void {
    if (peer instanceof Held) peer.drained(now)
  }

  /** The client went away. Nothing is written and nothing is ended. */
  gone(peer: Peer): void {
    if (peer instanceof Held) {
      peer.close()
      this.forget(peer)
    }
  }

  /**
   * Every stream ends, having been told why.
   *
   * Synchronous and with nothing to await: there is no acknowledgement worth
   * waiting for from a client that may be a phone in a drawer, and `App.stop()`
   * must not be able to hang on one.
   */
  closeAll(notice: keyof typeof NOTICES): void {
    this.stopping = true
    const frame = sseFrame({ event: 'notice', data: { kind: notice, said: NOTICES[notice] } })
    for (const peer of [...this.peers]) this.end(peer, frame)
    this.rings.clear()
    this.stopping = false
  }

  private end(peer: Held, frame: string | null): void {
    if (frame !== null) peer.send(frame, peer.wroteAt)
    peer.close()
    this.forget(peer)
  }

  private forget(peer: Held): void {
    const at = this.peers.indexOf(peer)
    if (at >= 0) this.peers.splice(at, 1)
    // The ring outlives the last stream on purpose: a phone whose tunnel drops
    // and comes back four seconds later is the case replay exists for, and a
    // ring thrown away on disconnect would answer it with a whole projection
    // every time. It is dropped when the device is revoked, and with the
    // window.
  }

  private ringFor(device: string): Ring {
    const held = this.rings.get(device)
    if (held !== undefined) return held
    const made = new Ring(this.ringSize <= 0 ? undefined : this.ringSize)
    this.rings.set(device, made)
    return made
  }
}

/** One connection, and everything known about how well it is keeping up. */
class Held implements Peer {
  readonly device: string
  until: number
  open = true
  /** When anything was last written to it, for the heartbeat. */
  wroteAt: number
  private readonly sink: Sink
  /** Since when it has not been keeping up, or null while it is. */
  private slowSince: number | null = null
  private pending: Pending = { frames: 0, bytes: 0 }
  /** Whether it owes a `resync` once it catches up. */
  private owed = false

  constructor(device: string, until: number, sink: Sink, now: number) {
    this.device = device
    this.until = until
    this.sink = sink
    this.wroteAt = now
  }

  renew(until: number): void {
    this.until = Math.max(this.until, until)
  }

  /**
   * Write, unless this peer is so far behind that a delta is worth nothing.
   *
   * Over the budget, **nothing more is handed over and one `resync` is owed** —
   * which is the bound that holds when the layer underneath buffers whatever
   * it is given. A snapshot replaces anything, so a client that comes back
   * from this has a correct projection and not a half-applied one.
   */
  send(text: string, now: number): void {
    if (!this.open) return
    if (overBudget(this.pending)) {
      this.owed = true
      return
    }
    const kept = this.sink.write(text)
    this.wroteAt = Math.max(this.wroteAt, now)
    if (kept) {
      this.slowSince = null
      this.pending = { frames: 0, bytes: 0 }
      return
    }
    this.slowSince ??= now
    this.pending = {
      frames: this.pending.frames + 1,
      bytes: this.pending.bytes + text.length,
    }
  }

  /** The socket drained, so what was outstanding is not any more. */
  drained(now: number): void {
    this.slowSince = null
    this.pending = { frames: 0, bytes: 0 }
    this.catchUp(now)
  }

  /** Hand over the `resync` a dropped run of deltas owes, once it can be sent. */
  catchUp(now: number): void {
    if (!this.owed || !this.open || overBudget(this.pending)) return
    this.owed = false
    this.send(
      sseFrame({
        event: 'resync',
        data: { why: 'behind', said: 'this page fell behind, so it is being redrawn' },
      }),
      now,
    )
  }

  /** How long it has not been keeping up, which is nought while it is. */
  stalledFor(now: number): number {
    return this.slowSince === null ? 0 : now - this.slowSince
  }

  close(): void {
    if (!this.open) return
    this.open = false
    try {
      this.sink.end()
    } catch {
      // A socket that has already gone is not a failure worth a line: the
      // peer is being forgotten either way.
    }
  }
}
