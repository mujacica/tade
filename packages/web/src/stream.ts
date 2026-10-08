import type { Delta, Snapshot } from './protocol.ts'

// The live stream's protocol: what a frame looks like, what a cursor means, and
// what to do with one that cannot be honoured.
//
// Pure — no `node:`, no clock, nothing to await — because every interesting
// thing here is a decision about two numbers, and a decision about two numbers
// should be a table rather than a listener somebody has to start.
// `peers.ts` is the half that holds connections, and `server.ts` is the only
// file that touches a socket.
//
// **`(epoch, rev)` is the cursor, and nothing here reads `seq` or a byte
// offset.** `input.ts`'s `Lifetime` carries the argument: `compactJournal`
// rewrites `events.jsonl` in place at every window start, so a journal cursor
// can look perfectly valid and point at different content after a restart. An
// epoch minted per server start plus a revision advanced only on a beat that
// changed something is correct by construction over restart, rotation and
// compaction, and costs one `randomUUID()`.
//
// **Server-sent events and not a WebSocket**, which is `EventSource`'s
// reconnection, `Last-Event-ID` and one code path for "the connection went
// away" — all of which a socket would have to grow by hand. The cost is that a
// non-200 or a wrong content type kills an `EventSource` *permanently*, which
// is why `server.ts` answers a reopened dead session with `204` rather than
// `401`: the browser stops retrying, and the page says so.

/**
 * How many deltas are kept for a client that reconnects.
 *
 * 256, which at the window's two-second beat is over eight minutes of
 * continuous change — far longer than a phone spends between a tunnel going
 * and coming back. Past it the answer is a `resync` and a fresh snapshot,
 * which is always correct, so the number decides how often that happens and
 * never whether the result is right.
 */
export const RING = 256

/** How long a stream may be silent before it is sent seventeen bytes. */
export const HEARTBEAT_MS = 15_000

/**
 * How much may be waiting for one client before its deltas are thrown away.
 *
 * Whichever comes first. Over it, **every pending delta is dropped and one
 * `resync` is queued** — correct by construction, because a snapshot replaces
 * anything a delta could have said. No urgency ranking, unlike the journal's
 * `evictLeastUrgent`: a projection delta is never the only record of itself.
 */
export const PEER_BYTES = 64 * 1024
export const PEER_FRAMES = 50

/** How long a client may refuse to read before the stream is closed. */
export const STALL_MS = 30_000

/**
 * How many streams one device gets, and how many there are altogether.
 *
 * Four per device under the HTTP/1.1 six-connection ceiling, leaving two for
 * assets and the pairing POST. Sixteen altogether, which is four devices'
 * worth: past it the answer is `503 busy` with a `Retry-After`, because a cap
 * nobody is told about is a page that hangs.
 */
export const PER_DEVICE = 4
export const TOTAL = 16

/** The events a stream carries, as the client's one `switch`. */
export const STREAM_EVENTS = [
  'snapshot',
  'delta',
  'resync',
  'notice',
  'revoked',
  'too_many',
] as const
export type StreamEvent = (typeof STREAM_EVENTS)[number]

/** Where a client got to: the server lifetime it was talking to, and how far. */
export interface Cursor {
  epoch: string
  rev: number
}

/**
 * A cursor out of `Last-Event-ID`, or null for anything that is not one.
 *
 * The header is whatever the client sent — a browser echoes the last `id:` it
 * saw, and a non-browser sends whatever it likes — so this is a parser over
 * attacker-controlled text and answers null rather than throwing. Null means
 * "start again", which is the safe direction: the worst a made-up cursor can
 * buy is a snapshot the client was entitled to anyway.
 */
export function cursorOf(id: string | null | undefined): Cursor | null {
  if (typeof id !== 'string') return null
  const at = id.lastIndexOf(':')
  if (at <= 0) return null
  const epoch = id.slice(0, at)
  const rev = id.slice(at + 1)
  // The epoch is a `randomUUID`, so its alphabet is known and bounded. A
  // length cap as well, because this value is compared and then written into
  // nothing: it is only ever matched against the epoch this server minted.
  if (!/^[0-9a-fA-F-]{8,64}$/.test(epoch)) return null
  if (!/^\d{1,15}$/.test(rev)) return null
  return { epoch, rev: Number(rev) }
}

/** The `id:` a frame carries, which is the cursor a client will send back. */
export function idFor(epoch: string, rev: number): string {
  return `${epoch}:${rev}`
}

/**
 * What to do about a cursor.
 *
 * Four answers, and the three that are not `replay` all end in the client
 * holding a whole projection — which is what makes every failure path here
 * recoverable rather than merely handled. `why` is for the journal and for a
 * test; the client is told `resync` or handed a snapshot, and needs no more.
 */
export type Resume =
  | { kind: 'replay'; from: number }
  | { kind: 'snapshot'; why: 'no cursor' | 'another server' | 'from the future' }
  | { kind: 'resync'; why: 'too far behind' }

/**
 * The reconnection rule, as one function of four numbers.
 *
 * `held` is the lowest revision the ring can still replay, or null when it has
 * never held anything — in which case the only client that can be caught up is
 * one already at `rev`.
 *
 * The order is the order of §10.5 and each line is a different kind of wrong:
 * no cursor is a new tab; another epoch is a restart or a different machine;
 * a revision above ours is a cursor from the future, which is never trusted
 * because it would otherwise let a client talk the server into replaying
 * nothing for ever; and below the ring is a gap, which is the one case where
 * the client is *told* (a `resync`) before being handed a snapshot, so the
 * page can say it lost its place rather than blinking.
 */
export function resumeFrom(
  cursor: Cursor | null,
  epoch: string,
  rev: number,
  held: number | null,
): Resume {
  if (cursor === null) return { kind: 'snapshot', why: 'no cursor' }
  if (cursor.epoch !== epoch) return { kind: 'snapshot', why: 'another server' }
  if (cursor.rev > rev) return { kind: 'snapshot', why: 'from the future' }
  if (cursor.rev === rev) return { kind: 'replay', from: rev + 1 }
  // Something to send, so the ring has to be able to reach back one past the
  // cursor. An empty ring reaches nowhere, and a cursor below the oldest
  // entry is a gap however many entries there are.
  if (held === null || cursor.rev + 1 < held) return { kind: 'resync', why: 'too far behind' }
  return { kind: 'replay', from: cursor.rev + 1 }
}

/**
 * The deltas kept for a reconnection, bounded by construction.
 *
 * One ring per device, because the projection is per device: two phones
 * granted different projects are two projections, and a shared ring would
 * replay one device's rows into the other's page. Dropped on close, so nothing
 * here outlives the window.
 *
 * Mutable, and pure in the sense this repository holds: it reads no clock,
 * imports no machine and waits for nothing.
 */
export class Ring {
  private readonly kept: Delta[] = []
  private readonly most: number

  constructor(most = RING) {
    this.most = Math.max(1, most)
  }

  add(delta: Delta): void {
    this.kept.push(delta)
    while (this.kept.length > this.most) this.kept.shift()
  }

  get size(): number {
    return this.kept.length
  }

  /** The lowest revision still replayable, or null while it holds nothing. */
  get held(): number | null {
    return this.kept[0]?.rev ?? null
  }

  /**
   * Every delta from this revision on, in order.
   *
   * The caller has already asked `resumeFrom` whether this is answerable, so
   * this is a filter and not a second decision — a second decision here is how
   * a gap becomes a silently half-applied projection.
   */
  since(from: number): Delta[] {
    return this.kept.filter((delta) => delta.rev >= from)
  }

  clear(): void {
    this.kept.length = 0
  }
}

/** One frame, before it is text. */
export interface Frame {
  event: StreamEvent
  data: unknown
  /** The cursor this frame is, for the events that advance one. */
  id?: string
}

/**
 * A frame as the bytes an `EventSource` parses.
 *
 * `data` is JSON, which is the one encoding with no raw newline in it — so
 * there is no multi-line `data:` to get wrong and no injected frame boundary
 * from a note somebody typed a newline into. The `id` is written through
 * `oneLine` all the same, because a value that reaches a protocol delimiter
 * should be bounded where it is written rather than wherever it came from.
 */
export function sseFrame(frame: Frame): string {
  const lines = [`event: ${oneLine(frame.event)}`]
  if (frame.id !== undefined) lines.push(`id: ${oneLine(frame.id)}`)
  lines.push(`data: ${JSON.stringify(frame.data)}`)
  return `${lines.join('\n')}\n\n`
}

/** Seventeen bytes that say the connection is alive and the state is not. */
export const KEEP_ALIVE = ': keep-alive\n\n'

/**
 * How much padding the opening carries, and why there is any.
 *
 * Some proxies buffer a response until they have a couple of kilobytes, and a
 * stream that says nothing for a minute is indistinguishable from a machine
 * that went to sleep — which is the one distinction §5.10 exists to draw. Two
 * kilobytes of a comment line flushes every buffer anybody has met, costs two
 * kilobytes once per connection, and is ignored by `EventSource` because a
 * line starting with `:` is a comment.
 */
const PADDING = 2048

/**
 * The first thing written on a stream, before any frame.
 *
 * `retry` is the browser's own reconnection delay and is set once here: two
 * seconds, which is the window's beat, so a tab that drops and comes back
 * misses about one.
 */
export const STREAM_OPENING = `retry: 2000\n:${'-'.repeat(PADDING)}\n\n`

/**
 * How a page tells being out of date from being unable to reach anything, and
 * both from Tade having closed.
 *
 * **The rule that keeps the page honest, and the reason it is here rather than
 * only in the browser.** When a stream drops, every row keeps its last state
 * and the page gains one bar: no row changes glyph, no count changes, nothing
 * becomes nought. *Unreachable is never stopped* — a sleeping laptop runs
 * nothing, and a page that drew `0 working` because it could not ask would be
 * lying about somebody's morning.
 *
 * The four states are told apart by **what happened**, not by how long ago:
 *
 * - `closed` — the server said `notice: closing` or `revoked`. It *told* us,
 *   so this is certain and no amount of waiting changes it.
 * - `live` — the stream is open and something arrived inside `HEARTBEAT_MS`
 *   plus slack. The keep-alive is what makes this answerable on a quiet
 *   morning when the state has not moved for an hour.
 * - `stale` — the stream is open and nothing has arrived for longer than
 *   that. Something is wrong with the connection and the browser has not
 *   noticed yet.
 * - `unreachable` — the stream is not open and a reconnection has failed.
 *   Said with *since when*, from the last frame that did arrive, because that
 *   is the last moment anything was known to be true.
 *
 * `assets/live.js` has the same rule, because a browser cannot import this;
 * `test/client.test.ts` asserts the two agree over a table, so the copy cannot
 * drift.
 */
export type Connection =
  | { kind: 'live'; sinceAt: number }
  | { kind: 'stale'; sinceAt: number }
  | { kind: 'unreachable'; sinceAt: number }
  | { kind: 'closed'; why: string }

/** How long after the last frame a stream stops counting as live. */
export const STALE_AFTER_MS = HEARTBEAT_MS + 5_000

export function connectionOf(
  seen: {
    /** Whether the browser says the stream is open. */
    open: boolean
    /** When anything last arrived on it, as this page's own clock. */
    lastAt: number
    /** What the server said when it ended one, or null. */
    ended: string | null
  },
  now: number,
): Connection {
  // Told first, and whatever else is true: a server that said why is the one
  // answer no timeout can improve on.
  if (seen.ended !== null) return { kind: 'closed', why: seen.ended }
  if (!seen.open) return { kind: 'unreachable', sinceAt: seen.lastAt }
  if (now - seen.lastAt > STALE_AFTER_MS) return { kind: 'stale', sinceAt: seen.lastAt }
  return { kind: 'live', sinceAt: seen.lastAt }
}

/**
 * How long to wait before trying again, in the order the tries happen.
 *
 * 1, 2, 4, 8, 15 and then every 15 seconds, which is what `retry: 2000` tells
 * a browser to start at and what a page reconnecting by hand should match. The
 * ceiling matters more than the curve: a phone in a pocket with a dead tunnel
 * must not be asking every second for an hour.
 */
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const

export function backoffAt(tries: number): number {
  return BACKOFF_MS[Math.min(Math.max(0, tries), BACKOFF_MS.length - 1)] ?? 15_000
}

/** What a `notice` frame says, in Tade's own words. */
export const NOTICES: Readonly<Record<'closing' | 'off', string>> = {
  closing: 'Tade is closing, so this stream is ending',
  off: 'the away view was turned off at the machine',
}

/** Why a stream ended, as the client is told. */
export const REVOKED: Readonly<Record<'signed out' | 'expired', string>> = {
  'signed out': 'this device was signed out at the machine',
  expired: 'this device’s session has run out',
}

/** A `snapshot` frame, stamped with the revision it is. */
export function snapshotFrame(snapshot: Snapshot): Frame {
  return {
    event: 'snapshot',
    data: snapshot,
    id: idFor(snapshot.fresh.epoch, snapshot.fresh.rev),
  }
}

/** A `delta` frame, stamped the same way. */
export function deltaFrame(epoch: string, delta: Delta): Frame {
  return { event: 'delta', data: delta, id: idFor(epoch, delta.rev) }
}

/** What is waiting to go out on one stream. */
export interface Pending {
  frames: number
  bytes: number
}

/** Whether a client is far enough behind that its deltas are worth nothing. */
export function overBudget(pending: Pending): boolean {
  return pending.frames > PEER_FRAMES || pending.bytes > PEER_BYTES
}

/**
 * A value on its way into a protocol line: one line, and bounded.
 *
 * Nothing that reaches here is attacker-controlled today — an event name is
 * one of six literals and an id is this server's own epoch and its own counter
 * — and it is written anyway, because the cost is a regex and the failure it
 * prevents is a frame boundary somebody else gets to choose.
 */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 200)
}
