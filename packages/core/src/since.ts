import type { TadeEvent } from './events.ts'
import { documentsIn, waitingDocuments } from './produces.ts'
import { undecidedProposals } from './proposals.ts'
import { type Spend, spendFrom } from './spend.ts'

// "Since you were here" (REMOTE-TADE.md §5.4): what a machine's own journal
// says happened from the last moment it counted the person present — what
// finished, what was handed over to read, what is held, what was put to its
// orchestrator to decide, and what it cost. Folded on the machine it is about,
// which is the only one whose journal says it; another machine is told the
// answer and never reads the lines.
//
// **The cursor is an instant in this machine's clock, written by this
// machine** (`person_present`), never a `seq` or a byte offset (§4.5): both
// move under a compaction, a restore or a journal begun again, and an instant
// in the machine's own clock does not. It is written when an owner's link
// carries a keypress (`@tade/web`'s `presence.ts`), a line per stretch of
// minutes and never per keystroke (`presenceLineDue`), so the cut is earlier
// than the person really left by at most one stretch — a card that says a
// little more than it needs to, and never one that leaves out something that
// happened while they were away.
//
// **Which line is the cut is asked with a moment the caller supplies**
// (`presentBefore`): the moment the person came back, in this machine's
// clock. Every line written after it is of the stretch they are in now, so a
// presence carried a breath before the card was asked for can never make the
// card empty — which is the race the obvious reading ("the newest line")
// loses every time a laptop opens and its link carries a key in the same beat.
//
// Pure: lines and moments in, a value out.

/** How far apart two presence lines are, at least: the resolution of the cut. */
export const PRESENCE_LINE_MS = 5 * 60_000

/**
 * How recent a keypress somewhere else must be to count the person present
 * here: the stretch push reads a keypress as somebody at the keyboard for.
 */
export const PRESENT_MS = 2 * 60_000

/**
 * Whether a presence carried now is worth a line: it says a key was pressed
 * within `PRESENT_MS`, and the last line is a stretch old — or is from a
 * clock that has since gone backwards, which a line from now corrects.
 */
export function presenceLineDue(lastLineAt: number | null, ago: number, now: number): boolean {
  if (ago < 0 || ago > PRESENT_MS) return false
  return lastLineAt === null || now < lastLineAt || now - lastLineAt >= PRESENCE_LINE_MS
}

/** The moment one line was written, or null where its timestamp does not read. */
function at(event: TadeEvent): number | null {
  const moment = Date.parse(event.ts)
  return Number.isFinite(moment) ? moment : null
}

/**
 * The newest moment this machine counted the person present strictly before
 * `cut`, from its own `person_present` lines — or null where it never has, which
 * is a machine being linked for the first time and has nothing to catch up on.
 */
export function presentBefore(events: readonly TadeEvent[], cut: number): number | null {
  let newest: number | null = null
  for (const event of events) {
    if (event.type !== 'person_present') continue
    const moment = at(event)
    if (moment === null || moment >= cut) continue
    if (newest === null || moment > newest) newest = moment
  }
  return newest
}

/** One thing that happened, about one task: when, and a clause in Tade's words. */
export interface SinceItem {
  task: string
  at: number
  /** How it finished, why it is held, what a proposal is about. Never a path. */
  said: string
}

/** What happened here since a moment, as this machine's journal says it. */
export interface SinceHere {
  since: number
  /** Finished since, and not started again or removed since: newest first. */
  finished: SinceItem[]
  /** Handed over to read since, and nobody has decided about yet. */
  documents: SinceItem[]
  /** Held since, and not answered since. */
  held: SinceItem[]
  /** Put to the orchestrator to decide since, and still undecided. */
  proposed: SinceItem[]
  /** What the agents here spent since, as the journal's `usage` lines add up. */
  spend: Spend
}

/**
 * What this machine's journal says happened from `since` on. Each list holds
 * only what is **still** so at the end of the journal — a hold answered, a
 * document triaged or a task started again is not news to come back to — and
 * is newest first, which is the order somebody reads a catch-up in.
 */
export function sinceHere(events: readonly TadeEvent[], since: number, now: number): SinceHere {
  const after = (event: TadeEvent) => (at(event) ?? Number.NEGATIVE_INFINITY) >= since
  const finished = new Map<string, SinceItem>()
  const held = new Map<string, SinceItem>()
  for (const event of events) {
    const task = event.task
    if (!task) continue
    if (event.type === 'run_started' || event.type === 'task_removed') finished.delete(task)
    if (
      event.type === 'queue_changed' ||
      event.type === 'queue_started' ||
      event.type === 'task_removed'
    )
      held.delete(task)
    if (!after(event)) continue
    if (event.type === 'task_done') {
      finished.set(task, { task, at: at(event) ?? since, said: doneBy(event.detail.by) })
    }
    if (event.type === 'queue_held') {
      const because = typeof event.detail.because === 'string' ? event.detail.because : ''
      held.set(task, { task, at: at(event) ?? since, said: because || 'it could not start' })
    }
  }
  // One that went with its task cannot be read any more, so it is not one to come back to.
  const documents = waitingDocuments(documentsIn(events), now)
    .filter((one) => one.state !== 'gone')
    .map((one) => ({
      task: one.task,
      at: Date.parse(one.at),
      said: one.finished ? 'finished, with a document to read' : 'handed over a document to read',
    }))
    .filter((one) => Number.isFinite(one.at) && one.at >= since)
  const proposed = undecidedProposals(events)
    .filter((one) => one.at >= since)
    .map((one) => ({ task: one.task, at: one.at, said: one.title }))
  // A task that finished with a document is said once, as the document.
  const reading = new Set(documents.map((one) => one.task))
  return {
    since,
    finished: newestFirst([...finished.values()].filter((one) => !reading.has(one.task))),
    documents: newestFirst(documents),
    held: newestFirst([...held.values()]),
    proposed: newestFirst(proposed),
    spend: spendFrom(events, { since }).total,
  }
}

/** Who said a task was finished, as the briefing says it. */
function doneBy(by: unknown): string {
  if (by === 'agent') return 'its agent said so'
  if (by === 'rule') return 'its rule was met'
  if (by === 'orchestrator') return 'the orchestrator marked it'
  return 'you marked it'
}

function newestFirst(items: SinceItem[]): SinceItem[] {
  return items.sort((one, other) => other.at - one.at)
}
