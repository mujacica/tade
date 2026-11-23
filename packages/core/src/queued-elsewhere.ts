import type { TadeEvent } from './events.ts'
import { type Fleet, type QueuedThere, queuedThere } from './fleet-waits.ts'

// Every other machine's queued work, said to the orchestrator: in `tade_queue`
// and in its briefing, out of the copies of their journals kept here
// (`queuedThere`). Its own section per machine, labelled, capped and with what
// was left out counted — a shape rather than a budget, so the hub's forty
// queued tasks never crowd out the Mac's three without a word. Only that
// machine starts any of it; this is so the orchestrator can say it, never so
// it can start it here.

/** The kinds of line `queuedThere` reads: all a copy needs to be read for, for this. */
export const QUEUED_THERE_READS = [
  'task_created',
  'queue_started',
  'task_done',
  'task_removed',
  'task_moved',
] as const

/** How many of one machine's queued tasks are named, before the rest are counted. */
export const QUEUED_THERE_MOST = 6

/** The copies of other machines' journals, as `queuedThere` reads them. */
export function fleetOfFeeds(
  self: string,
  feeds: readonly { name: string; called?: string; events: readonly TadeEvent[] }[],
): Fleet {
  return {
    self,
    machines: feeds.map((feed) => {
      const last = feed.events.at(-1)
      const at = last ? Date.parse(last.ts) : Number.NaN
      return {
        name: feed.name,
        ...(feed.called ? { called: feed.called } : {}),
        heardAt: Number.isNaN(at) ? null : at,
        lines: feed.events,
      }
    }),
  }
}

/**
 * Each other machine's queued work in lines, machine by machine: a heading
 * naming it and when it was last heard, then at most `most` of its tasks and a
 * count of the rest. Nothing where nothing waits anywhere else.
 */
export function queuedElsewhereSays(
  fleet: Fleet | undefined,
  now: number,
  clock: (at: number) => string,
  most = QUEUED_THERE_MOST,
): string[] {
  const by = new Map<string, QueuedThere[]>()
  for (const one of queuedThere(fleet, now))
    by.set(one.machine, [...(by.get(one.machine) ?? []), one])
  const lines: string[] = []
  for (const [machine, all] of by) {
    const first = all[0] as QueuedThere
    const heard =
      first.silentDays !== null
        ? `not heard from in ${first.silentDays} days`
        : first.heardAt === null
          ? 'not heard from here yet'
          : `last heard ${clock(first.heardAt)}, by its own clock`
    lines.push(`Queued on ${machine} (${heard}; only ${machine} starts it):`)
    for (const one of all.slice(0, most)) lines.push(`- ${machine}:${one.task}`)
    if (all.length > most) lines.push(`- ${all.length - most} more on ${machine} not listed`)
  }
  return lines
}
