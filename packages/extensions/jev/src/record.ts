import { watchedFrom } from '@tade/core'
import type { ExtensionContext } from '@tade/extensions-core'
import { readJournal } from '@tade/workbench/events'
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

/**
 * The last record read, and when. The status bar asks every few seconds
 * whether anybody is looking or not, and reading the whole journal on that
 * beat is exactly what makes a window heavy: what is polled is cheap and
 * shared, so one read serves everybody for a moment.
 */
let lastRead: { home: string; at: number; record: ReviewRecord } | null = null

/** What was read a moment ago is no longer what happened: read it again. */
export function forgetRead(): void {
  lastRead = null
}

/** What the record says, read from the journal and the review log. Asks nobody anything. */
export async function recordOf(ctx: ExtensionContext, keepMs = 0): Promise<ReviewRecord> {
  const fresh = lastRead
  if (keepMs > 0 && fresh && fresh.home === ctx.home && ctx.now() - fresh.at <= keepMs) {
    return { ...fresh.record, now: ctx.now() }
  }
  const events = await readJournal(ctx.home, {
    types: ['watch_checked', 'watch_found', 'task_done'],
  }).catch(() => [])
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
  lastRead = { home: ctx.home, at: ctx.now(), record }
  return record
}
