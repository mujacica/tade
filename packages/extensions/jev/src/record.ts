import { type TadeEvent, watchedFrom } from '@tade/core'
import type { ExtensionContext } from '@tade/extensions-core'
import { readJournalSince } from '@tade/workbench/events'
import { readSchedules } from '@tade/workbench/schedules'
import type { Found, Look, ReviewRecord } from './report.ts'
import { readReviews } from './reviews.ts'

// What Jev knows about itself, folded out of the journal and the review log.
//
// Derived, like everything else: the looks a watch took, what each found and
// what became of it are the journal's, and the readings are the one thing that
// cannot be asked again. Nothing here asks anybody anything, costs money or
// needs a key — which is what lets the status bar, the view, the brief and
// jev_findings all be the same read.

/** The events this read is folded from, and how far into the journal they got. */
const WATCHED = ['watch_checked', 'watch_found', 'task_done'] as const

/**
 * The last record read, when, and where in the journal it got to.
 *
 * The status bar asks every few seconds whether anybody is looking or not, so
 * this is asked far oftener than it changes. A moment's cache answers the
 * repeat asks; the offset answers the rest, because the journal only grows and
 * the hundred events this folds were all read the first time. Reading the whole
 * file on that beat is exactly what makes a window heavy — 204 ms and 313 MB of
 * garbage to find 101 events among 232,000 — and it got worse every hour the
 * window stayed open, which is what a periodic spike nobody could place was.
 */
let lastRead: {
  home: string
  at: number
  record: ReviewRecord
  readTo: number
  events: TadeEvent[]
} | null = null

/**
 * What was read a moment ago is no longer what happened: read it again.
 *
 * The moment's cache goes and the offset stays. This is called just after
 * something was written to the journal, and what was written was appended —
 * so the bytes already folded are still those bytes, and reading the file
 * again from the start would only find them a second time.
 */
export function forgetRead(): void {
  if (lastRead) lastRead = { ...lastRead, at: Number.NEGATIVE_INFINITY }
}

/** What the record says, read from the journal and the review log. Asks nobody anything. */
export async function recordOf(ctx: ExtensionContext, keepMs = 0): Promise<ReviewRecord> {
  const fresh = lastRead
  if (keepMs > 0 && fresh && fresh.home === ctx.home && ctx.now() - fresh.at <= keepMs) {
    return { ...fresh.record, now: ctx.now() }
  }
  // From where the last read got to: the journal is append-only, so the events
  // already folded cannot have changed, and a beat with nothing new reads
  // nothing at all. A shorter file was rotated rather than appended to, which
  // `readJournalSince` says by starting over, and what it hands back is then
  // the whole journal rather than a delta.
  const had = fresh?.home === ctx.home ? fresh : null
  const since = await readJournalSince(ctx.home, { types: WATCHED }, had?.readTo ?? 0)
  const events =
    since.readFrom === (had?.readTo ?? 0)
      ? [...(had?.events ?? []), ...since.events]
      : // It started over, so what it hands back is the whole journal rather
        // than a delta — and what was held of a file that is no longer that
        // file goes with it.
        since.events
  const looks: Look[] = []
  const findings: Found[] = []
  let schedules: ReturnType<typeof readSchedules> = []
  try {
    schedules = readSchedules(ctx.home)
  } catch {
    // No schedules file is the normal case, not an error.
  }
  for (const schedule of schedules) {
    if (schedule.does.kind !== 'watch' || !schedule.does.watch.startsWith(`${ctx.extension}.`)) {
      continue
    }
    const watched = watchedFrom(events, schedule.id)
    looks.push(...watched.looks)
    findings.push(...watched.findings)
  }
  const finished = new Set(
    events.filter((event) => event.type === 'task_done' && event.task).map((event) => event.task!),
  )
  const record: ReviewRecord = {
    reviews: readReviews(ctx.home),
    looks,
    findings,
    finished,
    now: ctx.now(),
  }
  lastRead = {
    home: ctx.home,
    at: ctx.now(),
    record,
    readTo: since.readTo,
    events,
  }
  return record
}
