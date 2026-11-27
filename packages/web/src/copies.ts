import { deltaBetween } from './delta.ts'
import { type Delta, PROTOCOL_VERSION, type Snapshot } from './protocol.ts'
import type { Reach } from './reach.ts'
import { type Cursor, type Frame, sseFrame } from './stream.ts'

// Every other machine's projection, as a door passes it on to a page.
//
// **The page you open is a door, not a machine** (ONE-AWAY-VIEW §2.1): the
// machine that serves it draws every machine of the person's from a copy it
// keeps of each — live while that machine is heard, and as of its last word
// while it isn't. The Mac already holds ipax's whole projection over its link
// (`@tade/remotes-core`'s `held.ts`, kept on disk by `kept.ts`); ipax holds the
// Mac's as the Mac sends it. This is the one place either is turned into
// frames on a page's stream.
//
// **A frame of its own, beside the door's own snapshot and deltas, never
// folded into them.** Each copy is its machine's own fold, keyed by its name,
// with its own `(epoch, rev)`: nothing on the wire is added together, and a
// page keeps a store per machine (`store.js`'s `applyCopy`). A `machine` event
// is new to the stream and an older page ignores it — the protocol's version
// moves when a field changes meaning, never when one is added (`protocol.ts`),
// and moving it would cut every link between two machines on two versions.
//
// **Every paired phone is sent them** (`copiesFor`), every one being the
// person's own. Never a link:
// another machine following this one's stream is told nothing of the copies it
// is itself the source of, and a third machine's is not relayed yet.
//
// **What is not in a copy**: the conversation and the notes, which are one
// already (Phase 7 and `notes-shared.ts`) and would be drawn twice. Everything
// else is that machine's answer as it gave it; the page draws text only.
//
// **A stream that opens again resumes them** (`copiesHeldOf`): the page says, in the
// stream's address, which revision of each copy it holds, and a copy still at
// that revision is not sent again — on a phone whose tunnel blinks, a few
// hundred kilobytes a machine every time. One the page holds and this door
// does not is `gone`; anything else, or a page that fell behind, is whole.
//
// Pure: no clock, no socket, nothing to await. `Copies` holds what each
// machine's copy was last sent as, and every beat is a comparison against it.

/** One other machine's projection, as the window holds it. */
export interface CopyIn {
  /** Its name here: the same `name` as its row in `Snapshot.machines`. */
  name: string
  /** What it last said, or null where it has never been heard and nothing was kept. */
  projection: Snapshot | null
}

/** What one `machine` frame says. */
export type CopyFrame =
  /** The copy, whole: on a stream's opening, on its machine's restart, or where a change would not apply. */
  | { v: typeof PROTOCOL_VERSION; machine: string; kind: 'whole'; snapshot: Snapshot }
  /** What changed since the revision `from`, which the page's copy must be at. */
  | { v: typeof PROTOCOL_VERSION; machine: string; kind: 'change'; from: number; delta: Delta }
  /** The machine is no longer one this door holds a copy of. */
  | { v: typeof PROTOCOL_VERSION; machine: string; kind: 'gone' }

/**
 * Whether a device is sent the other machines' copies: a paired phone, every
 * one of which is the person's own, and not another machine's link, which is
 * an owner device.
 */
export function copiesFor(_reach: Reach, owner: boolean): boolean {
  return !owner
}

/** A copy as a page is sent it: without the two things that are one already. */
export function copyOf(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    chat: [],
    notes: [],
    pages: {
      ...snapshot.pages,
      chat: { total: 0, omitted: 0, next: null, restarted: false },
      notes: { total: 0, omitted: 0, next: null, restarted: false },
    },
  }
}

/** One frame on the stream. */
export function copyFrame(frame: CopyFrame): Frame {
  return { event: 'machine', data: frame }
}

/** What is held of one machine's copy. */
interface Sent {
  /** The projection the window handed over, compared by identity: a held projection is replaced, never written into. */
  source: Snapshot
  /** What the page was sent, which the next change is made against. */
  sent: Snapshot
}

/**
 * What every page has been sent of each other machine.
 *
 * One for the whole door, not one per device: every device that is sent any
 * is sent the same, because only the person's own are (`copiesFor`). A stream
 * that opens is sent each copy whole (`wholes`), so nothing here has to know
 * which page has had what.
 */
export class Copies {
  private readonly held = new Map<string, Sent>()

  /**
   * What moved since the last beat, as frames: a machine heard for the first
   * time, or restarted, is whole; one that moved is its change; one no longer
   * handed over is gone. A beat on which nothing moved is no frames, and a
   * projection the window did not replace costs one comparison.
   */
  beat(copies: readonly CopyIn[]): CopyFrame[] {
    const frames: CopyFrame[] = []
    const now = new Set<string>()
    for (const copy of copies) {
      if (copy.projection === null) continue
      now.add(copy.name)
      const was = this.held.get(copy.name)
      if (was !== undefined && was.source === copy.projection) continue
      const sent = copyOf(copy.projection)
      const change = was === undefined ? null : changeOf(was.sent, sent)
      // Nothing but the moment moved: the page's copy is still at the revision
      // it was sent, so the next change is made against that one.
      if (change === 'same' && was !== undefined) {
        this.held.set(copy.name, { source: copy.projection, sent: was.sent })
        continue
      }
      this.held.set(copy.name, { source: copy.projection, sent })
      frames.push(
        change === null || change === 'same'
          ? { v: PROTOCOL_VERSION, machine: copy.name, kind: 'whole', snapshot: sent }
          : {
              v: PROTOCOL_VERSION,
              machine: copy.name,
              kind: 'change',
              from: (was as Sent).sent.fresh.rev,
              delta: change,
            },
      )
    }
    for (const name of [...this.held.keys()]) {
      if (now.has(name)) continue
      this.held.delete(name)
      frames.push({ v: PROTOCOL_VERSION, machine: name, kind: 'gone' })
    }
    return frames
  }

  /**
   * What a stream opens with: each copy whole, but where the page says it
   * holds a copy at the revision it was last sent, nothing; and `gone` for a
   * copy the page holds that this door no longer does. With nothing held —
   * a page that fell behind — every copy whole.
   */
  resumed(held: ReadonlyMap<string, Cursor> | null): CopyFrame[] {
    if (held === null || held.size === 0) return this.wholes()
    const frames: CopyFrame[] = []
    for (const [machine, { sent }] of this.held) {
      const at = held.get(machine)
      if (at?.epoch === sent.fresh.epoch && at.rev === sent.fresh.rev) continue
      frames.push({ v: PROTOCOL_VERSION, machine, kind: 'whole', snapshot: sent })
    }
    for (const machine of held.keys()) {
      if (!this.held.has(machine)) frames.push({ v: PROTOCOL_VERSION, machine, kind: 'gone' })
    }
    return frames
  }

  /** Every copy, whole: what a page that fell behind is sent again. */
  wholes(): CopyFrame[] {
    return [...this.held].map(
      ([machine, { sent }]): CopyFrame => ({
        v: PROTOCOL_VERSION,
        machine,
        kind: 'whole',
        snapshot: sent,
      }),
    )
  }

  /** What a stream opens with (`resumed`), as the text it is written. */
  opening(held: ReadonlyMap<string, Cursor> | null = null): string[] {
    return this.resumed(held).map((frame) => sseFrame(copyFrame(frame)))
  }
}

/**
 * What changed from one copy to the next: a delta, `same` where nothing did
 * but the moment, or null where only a whole copy will do — another epoch is
 * another lifetime of that machine's server, and its revisions say nothing
 * about this one's.
 */
function changeOf(was: Snapshot, is: Snapshot): Delta | 'same' | null {
  if (was.fresh.epoch !== is.fresh.epoch || is.fresh.rev < was.fresh.rev) return null
  // Two versions of the protocol do not diff: a whole copy is always correct.
  // `deltaBetween` throws for nothing else.
  if (was.v !== is.v) return null
  return deltaBetween(was, is) ?? 'same'
}

/** How many copies a page may say it holds, and how long a machine's name in one may be. */
const HELD_MOST = 32
const NAME_MOST = 120
const EPOCH = /^[0-9a-fA-F-]{8,64}$/

/**
 * The copies a page says it holds, out of its stream's address: a `held`
 * parameter each, `<epoch>:<rev>:<machine>` — the name last, since a name may
 * hold a colon. What does not read is left out, never refused: a page whose
 * word is not taken is sent that copy whole, which is always correct. Bounded
 * in count and length, because this is text off a request and compared with
 * nothing but what this door holds.
 */
export function copiesHeldOf(url: string): ReadonlyMap<string, Cursor> {
  const at = url.indexOf('?')
  const held = new Map<string, Cursor>()
  if (at === -1) return held
  for (const one of new URLSearchParams(url.slice(at + 1)).getAll('held').slice(0, HELD_MOST)) {
    const [epoch, rev, ...rest] = one.split(':')
    const machine = rest.join(':')
    if (epoch === undefined || !EPOCH.test(epoch)) continue
    if (rev === undefined || !/^\d{1,15}$/.test(rev)) continue
    if (machine.length === 0 || machine.length > NAME_MOST) continue
    held.set(machine, { epoch, rev: Number(rev) })
  }
  return held
}
