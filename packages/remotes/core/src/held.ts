import {
  applyDelta,
  backoffAt,
  COLLECTIONS,
  cursorOf,
  type Delta,
  PRESENCE_MOST_MS,
  PROTOCOL_VERSION,
  type Snapshot,
  STALE_AFTER_MS,
} from '@tade/web'
import type { Held, LinkProblem, LinkState } from './port.ts'

// What a link holds, and every rule about how it moves: a frame arriving, an
// answer to a dial, a failure, a beat. Pure — no clock, no socket, nothing to
// await — because each of these is a decision about a few values, and a
// decision should be a table somebody can read rather than a listener somebody
// has to start (`stream.ts` is the same choice from the other end of the wire).
//
// **The cursor is `(epoch, rev)`, and nothing here reads `seq` or a byte
// offset** (REMOTE-TADE.md §4.5). The remote's epoch is minted per server start
// and its revision moves only on a beat that changed something, so a cursor is
// correct over the remote's restarts, its journal's compaction and a backup
// restored there, by construction: another epoch is a snapshot, a revision
// past ours is a snapshot, and a gap is a snapshot. The only thing it costs to
// be wrong is one whole projection, and it can never be wrong silently.
//
// **A projection is never emptied by trouble.** Every failure here keeps what
// was held and its age; only a remote that sent a whole new projection
// replaces one.

/** How long a dial may take before it is given up on: a connection, a sign-in and the first answer. */
export const DIAL_MS = 30_000

/**
 * How long a live stream may say nothing before it counts as gone.
 *
 * The away view writes seventeen bytes every fifteen seconds to a quiet stream
 * (`HEARTBEAT_MS`), so twenty is one missed heartbeat and some slack — the same
 * rule a page uses to call its stream stale (`STALE_AFTER_MS`). A laptop that
 * slept does not wait this out: `wake` drops the stream at once.
 */
export const QUIET_MS = STALE_AFTER_MS

/**
 * How often the person's presence is carried while they keep typing.
 *
 * A remote counts somebody as present for two minutes after their last key
 * (`focusWindowMs`), so saying it every thirty seconds keeps that true with a
 * line a minute's worth of slack, and is one tiny request instead of one per
 * beat. The first key after a quiet spell goes at once.
 */
export const PRESENCE_EVERY_MS = 30_000

/** A remote nothing has been heard from yet. */
export function heldFor(remote: string): Held {
  return {
    remote,
    link: { kind: 'idle' },
    projection: null,
    heardAt: null,
    cursor: null,
    presence: null,
  }
}

/** How many dials in a row have failed, which is what the wait before the next one is made of. */
function triesOf(link: LinkState): number {
  return link.kind === 'down' || link.kind === 'dialling' ? link.tries : 0
}

/**
 * Whether a dial is due now.
 *
 * Opened and never dialled: now. Down: once its wait is over, which grows 1, 2,
 * 4, 8, 15 seconds and stays at 15 (`backoffAt`, the page's own curve), so a
 * laptop on a train is not dialling a dead network every beat for an hour.
 * Dialling, live or ended: never — one dial at a time, and nothing redials a
 * session the remote said is over.
 */
export function dialDue(held: Held, now: number): boolean {
  if (held.link.kind === 'idle') return true
  if (held.link.kind !== 'down') return false
  return now - held.link.since >= backoffAt(held.link.tries - 1)
}

export function dialling(held: Held, now: number): Held {
  return { ...held, link: { kind: 'dialling', since: now, tries: triesOf(held.link) } }
}

/** A dial that has run past its deadline, which the beat gives up on. */
export function dialStuck(held: Held, now: number): boolean {
  return held.link.kind === 'dialling' && now - held.link.since > DIAL_MS
}

/** A live stream that has said nothing for longer than a heartbeat and its slack. */
export function quiet(held: Held, now: number): boolean {
  return held.link.kind === 'live' && held.heardAt !== null && now - held.heardAt > QUIET_MS
}

/** It is not up, for this reason: one more failed try, and everything held kept. */
export function lost(held: Held, problem: LinkProblem, said: string, now: number): Held {
  // An ended link stays ended: nothing that happens to a stream afterwards
  // un-says that the remote signed this machine out.
  if (held.link.kind === 'ended') return held
  const tries = triesOf(held.link) + 1
  return { ...held, link: { kind: 'down', since: now, tries, problem, said } }
}

/** The remote said this machine's session is over. Only pairing again changes that. */
export function ended(held: Held, said: string, now: number): Held {
  return { ...held, link: { kind: 'ended', since: now, said } }
}

/** Something arrived, which is all a heartbeat says. */
export function touched(held: Held, now: number): Held {
  return { ...held, heardAt: now }
}

/** What to do with the stream after something happened on it. */
export type Next =
  /** Keep reading. */
  | 'go on'
  /** Close it; `held` says why and whether it will be dialled again. */
  | 'drop'
  /** Close it and dial again at once, from the cursor `held` now carries. */
  | 'redial'

export interface Heard {
  held: Held
  next: Next
}

/** What the session no longer working is called, wherever the remote says it. */
export const SIGNED_OUT =
  'the remote no longer knows this machine’s session — `tade remote add` it again to pair'

/**
 * A dial's answer, before any frame: what the status line says.
 *
 * `204` is how the away view tells a client of a dead session to stop
 * retrying (`server.ts`), and `401` is a session it refused, so both end the
 * link — dialling again with the same session would be told the same thing.
 */
export function answered(held: Held, status: number, type: string, now: number): Heard {
  if (status === 200 && type.startsWith('text/event-stream')) {
    return {
      held: { ...held, heardAt: now, link: { kind: 'live', since: now } },
      next: 'go on',
    }
  }
  if (status === 204 || status === 401) return { held: ended(held, SIGNED_OUT, now), next: 'drop' }
  if (status === 404) {
    return {
      held: lost(held, 'missing', 'what answers there is not a Tade away view', now),
      next: 'drop',
    }
  }
  if (status === 503) {
    return {
      held: lost(held, 'failed', 'the remote has as many live connections as it takes', now),
      next: 'drop',
    }
  }
  return { held: lost(held, 'failed', `the remote answered ${status}`, now), next: 'drop' }
}

/** One event off the stream, as the parser hands it over. */
export interface StreamFrame {
  event: string
  /** The `id:` it carried, which is a cursor, or null. */
  id: string | null
  data: string
}

/**
 * One frame applied.
 *
 * The four that move the projection or end the stream, and everything else —
 * `resync` (a snapshot follows), `reload` (a page's own files), an event this
 * Tade has never heard of — only says the stream is alive.
 */
export function heard(held: Held, frame: StreamFrame, now: number): Heard {
  switch (frame.event) {
    case 'snapshot': {
      const read = readSnapshot(frame.data)
      if (typeof read === 'string') return { held: lost(held, 'failed', read, now), next: 'drop' }
      const cursor = { epoch: read.fresh.epoch, rev: read.fresh.rev }
      return { held: { ...held, projection: read, cursor, heardAt: now }, next: 'go on' }
    }
    case 'delta':
      return deltaHeard(held, frame, now)
    case 'notice':
      return {
        held: lost(held, 'failed', saidIn(frame.data, 'the remote ended the stream'), now),
        next: 'drop',
      }
    case 'revoked':
      return { held: ended(held, saidIn(frame.data, SIGNED_OUT), now), next: 'drop' }
    case 'too_many':
      return {
        held: lost(held, 'failed', saidIn(frame.data, 'the remote refused another stream'), now),
        next: 'drop',
      }
    default:
      return { held: touched(held, now), next: 'go on' }
  }
}

/**
 * A delta, against the cursor.
 *
 * Behind it is a repeat and is ignored. At it is a tick (the freshness moved
 * and nothing else) or a repeat, and applying either is harmless. One past it
 * is the next revision. Anything else — no projection to apply it to, another
 * server's epoch, a revision skipped — starts over from a snapshot, which is
 * always correct: a delta can always be replaced by one.
 */
function deltaHeard(held: Held, frame: StreamFrame, now: number): Heard {
  const delta = readDelta(frame.data)
  if (typeof delta === 'string') return { held: lost(held, 'failed', delta, now), next: 'drop' }
  const at = cursorOf(frame.id)
  const over: Heard = { held: { ...held, cursor: null }, next: 'redial' }
  if (held.projection === null || held.cursor === null || at === null) return over
  if (at.epoch !== held.cursor.epoch || at.rev !== delta.rev) return over
  if (delta.rev < held.cursor.rev) return { held: touched(held, now), next: 'go on' }
  if (delta.rev > held.cursor.rev + 1) return over
  let projection: Snapshot
  try {
    projection = applyDelta(held.projection, delta)
  } catch (err) {
    // Down rather than a quiet redial, so what the remote sent is said: it is
    // read again from a snapshot either way, which is always correct.
    const said = `the remote sent a delta that would not apply (${messageOf(err)}); it is read again whole`
    return { held: lost({ ...held, cursor: null }, 'failed', said, now), next: 'drop' }
  }
  const cursor = { epoch: at.epoch, rev: Math.max(held.cursor.rev, delta.rev) }
  return { held: { ...held, projection, cursor, heardAt: now }, next: 'go on' }
}

/** The `said` a frame's data carries, or what to say instead. */
function saidIn(data: string, instead: string): string {
  // A frame whose data is not JSON still ended the stream; the sentence is ours.
  const read = jsonOf(data)
  if (!read.ok || !isObject(read.value)) return instead
  const { said, why } = read.value
  if (typeof said === 'string' && said !== '') return said.slice(0, 200)
  if (typeof why === 'string' && why !== '') return why.slice(0, 200)
  return instead
}

/** Text as JSON, or what the parser said about it — bounded, for a sentence. */
function jsonOf(text: string): { ok: true; value: unknown } | { ok: false; why: string } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (err) {
    return { ok: false, why: messageOf(err) }
  }
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 120)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The protocol version a frame was in, said where it is not this one.
 *
 * The one mismatch that cannot be read past: a version moves when a field
 * changes meaning or goes away (`protocol.ts`), so reading another one would be
 * reading the right words with the wrong meanings. Both machines run whichever
 * Tade was installed on each, and this is what updating one of them fixes.
 */
function versionTrouble(value: Record<string, unknown>): string | null {
  if (value.v === PROTOCOL_VERSION) return null
  return `the remote speaks the away protocol v${String(value.v)} and this Tade v${PROTOCOL_VERSION}: update the older of the two`
}

/**
 * A snapshot, read for its shape and not parsed field by field.
 *
 * **Fields this Tade does not know are kept, not refused.** The away protocol
 * adds a field without moving its version, because "a client reads the fields
 * it knows" (`protocol.ts`) — and two machines are two installs, one of them
 * usually a version ahead. A strict parse here would be a link that breaks on
 * the morning one machine updated. What is checked is what everything above
 * reads before anything else: the version, the cursor, and that every
 * collection is a list. A string is why it is not one.
 */
export function readSnapshot(data: string): Snapshot | string {
  const read = jsonOf(data)
  if (!read.ok) return `the remote sent a snapshot that is not JSON (${read.why})`
  const value = read.value
  if (!isObject(value)) return 'the remote sent a snapshot that is not an object'
  const version = versionTrouble(value)
  if (version !== null) return version
  const fresh = value.fresh
  if (!isObject(fresh) || typeof fresh.epoch !== 'string' || !Number.isInteger(fresh.rev)) {
    return 'the remote sent a snapshot with no cursor in it'
  }
  for (const collection of COLLECTIONS) {
    if (!Array.isArray(value[collection])) return `the remote sent a snapshot with no ${collection}`
  }
  return value as unknown as Snapshot
}

/** A delta, read the same way: the version, its revision, and the two maps. */
export function readDelta(data: string): Delta | string {
  const read = jsonOf(data)
  if (!read.ok) return `the remote sent a delta that is not JSON (${read.why})`
  const value = read.value
  if (!isObject(value)) return 'the remote sent a delta that is not an object'
  const version = versionTrouble(value)
  if (version !== null) return version
  if (!Number.isInteger(value.rev) || !isObject(value.set) || !isObject(value.del)) {
    return 'the remote sent a delta with no revision in it'
  }
  if (value.fresh !== null && !isObject(value.fresh)) {
    return 'the remote sent a delta with a freshness that is not one'
  }
  return value as unknown as Delta
}

/**
 * Whether the person's presence is due to be carried.
 *
 * Only something new, only something recent enough to matter there, and no
 * oftener than `PRESENCE_EVERY_MS` while they keep typing. `sent` is the
 * keypress last carried, cleared whenever a stream opens, because the remote
 * holds presence in memory and a remote that restarted has forgotten it.
 */
export function presenceDue(
  pressedAt: number | null,
  sent: { pressedAt: number; at: number } | null,
  now: number,
): boolean {
  if (pressedAt === null || now - pressedAt > PRESENCE_MOST_MS || now < pressedAt) return false
  if (sent === null) return true
  if (pressedAt <= sent.pressedAt) return false
  return now - sent.at >= PRESENCE_EVERY_MS
}
