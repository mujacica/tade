import type { TadeEvent } from './events.ts'
import type { Note } from './memory.ts'

// What the orchestrator was told, whether its conversation holds it, and when
// Tade does something about either — or about the conversation filling up.
//
// The orchestrator's instructions and tools are handed to its harness at
// launch. A harness that pins them (`capabilities.pins`) declares a
// conversation it comes back to what it was *first* told until it is
// compacted, which is how, for days, the orchestrator never saw a new note or
// a new verb on `tade_queue_change`. So what a launch says is fingerprinted —
// three parts apart, so the line that says what happened can say which — and
// the journal keeps what the conversation was last known to hold
// (`orchestrator_told`, `orchestrator_compacted`): the one thing nothing can
// ask again, because the harness's own record of it is the harness's.
//
// Pure, like `deriveState`: the window decides with it on every beat, so
// nothing here reads a clock or a file.

/** What a launch tells the orchestrator, as three short fingerprints. */
export interface ToldPrint {
  tools: string
  instructions: string
  notes: string
}

export const TOLD_PARTS = ['tools', 'instructions', 'notes'] as const
export type ToldPart = (typeof TOLD_PARTS)[number]

/**
 * What its conversation was told, and what it holds: the same where its
 * harness takes what each launch says, and not where it pins what it was
 * first told and something changed since.
 */
export interface Holding {
  told: ToldPrint
  /** What differs from what the conversation holds: nothing, unless its harness pins. */
  stale: readonly ToldPart[]
  /** Whether what it held was ever written down; when not, `stale` is every part. */
  known: boolean
  /** When what it was told was composed: its own notes since are in its conversation. */
  since: number
}

/** The journal's lines about what the conversation was told. */
export const TOLD_EVENTS = ['orchestrator_told', 'orchestrator_compacted'] as const

/** Which parts differ. Nothing known before is every part: it cannot be said to be the same. */
export function changedFrom(before: ToldPrint | null, now: ToldPrint): ToldPart[] {
  return TOLD_PARTS.filter((part) => before?.[part] !== now[part])
}

function toldIn(detail: Record<string, unknown> | undefined): ToldPrint | null {
  const part = (key: ToldPart) => (typeof detail?.[key] === 'string' ? detail[key] : null)
  const tools = part('tools')
  const instructions = part('instructions')
  const notes = part('notes')
  return tools && instructions && notes ? { tools, instructions, notes } : null
}

/**
 * What the conversation was last known to hold, from the journal: the newest
 * compaction, or the newest launch it took whole (`holds`). Null when the
 * journal never said, which is not the same as nothing having changed.
 */
export function heldIn(events: readonly TadeEvent[]): ToldPrint | null {
  for (let at = events.length - 1; at >= 0; at--) {
    const event = events[at]
    if (event?.type === 'orchestrator_compacted') return toldIn(event.detail)
    if (event?.type === 'orchestrator_told' && event.detail?.holds === true) {
      return toldIn(event.detail)
    }
  }
  return null
}

/**
 * The notes a running conversation has not heard: all of them, less the ones
 * it wrote itself since it was told. Those are in its conversation already —
 * it wrote them — so starting it again for one would be a turn spent telling
 * it what it said; it reads them at its next start like any other.
 *
 * Never one taken on another machine (`from`): notes are shared between homes,
 * and that one was another orchestrator's, which this one has not heard.
 */
export function unheardNotes(notes: readonly Note[], since: number): Note[] {
  return notes.filter(
    (note) =>
      !(note.by === 'orchestrator' && note.from === undefined && Date.parse(note.at) > since),
  )
}

/**
 * Why, as a person reads it: "tools and notes changed" — or, where nothing was
 * ever written down to compare with, that, since it cannot be said to be the
 * same.
 */
export function saidChanged(parts: readonly ToldPart[], known = true): string {
  if (!known) return 'what it held before was never written down'
  const named =
    parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '')
  return named ? `${named} changed` : 'nothing changed'
}

export interface KeepingLook {
  /** A turn in flight, or something already being done to the conversation. */
  busy: boolean
  /** Something is on the orchestrator's line: whoever is writing it is not interrupted. */
  typing: boolean
  /** Whether its harness can be asked to compact (`offer(…, 'compact', …).shown`). */
  compacts: boolean
  holding: Holding | null
  /** How full its context is, as its harness last said; null before it has. */
  percent: number | null
  /** `orchestrator.compact_at`: 0 leaves it to the harness. */
  threshold: number
}

/** What Tade does to the orchestrator's conversation now, if anything. */
export type Keeping =
  | { act: 'compact'; why: 'told'; changed: readonly ToldPart[]; known: boolean }
  | { act: 'compact'; why: 'context'; percent: number }
  | { act: 'say'; why: 'told' | 'context' }

/**
 * Whether to do anything to the orchestrator's conversation, and what.
 *
 * **Never across a turn and never under somebody's fingers**: a compaction is
 * a turn of its own, so one started while a person is writing to it is a
 * question that waits behind a summary they did not ask for. What it holds
 * comes first, because a conversation told the wrong tools makes wrong
 * decisions however short it is; and only a harness that can be asked is
 * asked — one that cannot is *said* (`say`), once, by whoever acts on this.
 */
export function keepingDue(look: KeepingLook): Keeping | null {
  if (look.busy || look.typing || !look.holding) return null
  const { stale, known } = look.holding
  if (stale.length > 0) {
    return look.compacts
      ? { act: 'compact', why: 'told', changed: stale, known }
      : { act: 'say', why: 'told' }
  }
  if (look.threshold <= 0 || look.percent === null || look.percent < look.threshold) return null
  return look.compacts
    ? { act: 'compact', why: 'context', percent: look.percent }
    : { act: 'say', why: 'context' }
}
