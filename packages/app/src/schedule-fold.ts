import { type TadeEvent, type Watched, watchedFrom } from '@tade/core'

// What each schedule has done, folded as the journal says it rather than kept
// a line apiece.
//
// A watch looks every few minutes and writes two lines each time — that it
// came due, and what it saw — so a real journal held 15,448 `schedule_fired`
// and 15,434 `watch_checked` across 29 schedules, 24 MB of a window's heap and
// four thousand more lines a day. What reads them wants three things: how many
// times a schedule has run (a schedule that runs three times stops at three),
// when it last came due, and the newest few runs and looks to draw. So that is
// what is kept, and every finding besides: one finding never starts work
// twice, so a found key is never forgotten.

/** A schedule's run as the journal has it. */
export interface ScheduleRun {
  due: number
  ran: boolean
  missed: number
  task: string | null
  /** That its task was made parked, for the orchestrator to decide (`proposals.ts`). */
  proposed?: boolean
}

/** What a schedule has done: how many times it ran in all, and its newest runs, oldest first. */
export interface ScheduleRuns {
  ran: number
  runs: readonly ScheduleRun[]
}

/** What a schedule that has never come due has done. */
export const NEVER_RAN: ScheduleRuns = { ran: 0, runs: [] }

/** The lines this keeps in place of the journal's. */
export const SCHEDULE_LINES: readonly string[] = ['schedule_fired', 'watch_checked', 'watch_found']

/** How many runs, and looks, of each schedule are kept: more than any page draws (eight and six). */
export const KEPT = 20

export class ScheduleFold {
  private readonly fired = new Map<string, { ran: number; runs: ScheduleRun[] }>()
  /** Each watch's newest looks, and the newest that worked and said where the next one starts. */
  private readonly looked = new Map<string, { lines: TadeEvent[]; since: TadeEvent | null }>()
  private readonly found = new Map<string, TadeEvent[]>()

  add(event: TadeEvent): void {
    const schedule = event.detail.schedule
    if (typeof schedule !== 'string') return
    if (event.type === 'schedule_fired') {
      const kept = this.fired.get(schedule) ?? { ran: 0, runs: [] }
      this.fired.set(schedule, kept)
      const ran = event.detail.ran !== false
      if (ran) kept.ran++
      keep(kept.runs, {
        due: Date.parse(String(event.detail.due ?? event.ts)),
        ran,
        missed: typeof event.detail.missed === 'number' ? event.detail.missed : 0,
        task: event.task,
        ...(event.detail.proposed === true ? { proposed: true } : {}),
      })
    } else if (event.type === 'watch_checked') {
      const kept = this.looked.get(schedule) ?? { lines: [], since: null }
      this.looked.set(schedule, kept)
      keep(kept.lines, event)
      // Held apart, because a look that has scrolled out of the newest is
      // still where the next one starts until another that worked says so.
      if (saysSince(event)) kept.since = event
    } else if (event.type === 'watch_found') {
      const kept = this.found.get(schedule) ?? []
      this.found.set(schedule, kept)
      kept.push(event)
    }
  }

  /** How many times it has run, and its newest runs, oldest first. */
  runsOf(schedule: string): ScheduleRuns {
    return this.fired.get(schedule) ?? NEVER_RAN
  }

  /** What a watch has done — every finding, and its newest looks. */
  watchedOf(schedule: string): Watched {
    const looked = this.looked.get(schedule)
    const lines = looked?.lines ?? []
    const watched = watchedFrom([...lines, ...(this.found.get(schedule) ?? [])], schedule)
    if (!looked?.since || lines.includes(looked.since)) return watched
    return { ...watched, since: watchedFrom([looked.since], schedule).since }
  }
}

/**
 * Whether a look is one `watchedFrom` takes where the next starts from: one
 * that worked and said, even where what it said was nothing.
 */
function saysSince(event: TadeEvent): boolean {
  const problem = event.detail.problem
  return !(typeof problem === 'string' && problem !== '') && 'since' in event.detail
}

/** One more at the end, and the oldest let go of past `KEPT`. */
function keep<T>(list: T[], one: T): void {
  list.push(one)
  if (list.length > KEPT) list.splice(0, list.length - KEPT)
}
