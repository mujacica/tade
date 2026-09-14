import { z } from 'zod'
import { DONE_RULES } from './model.ts'

// Work on a clock.
//
// A schedule is a rule for when, and what to do each time: start an agent, ask
// the orchestrator something, or run a watch that decides whether there is work
// at all. Schedules are told to Wilco, not derived, so they are kept like notes
// (`schedules.jsonl`); when one last ran is what the journal says, so what is
// due is a query of the rule, the journal and the clock.
//
// Wilco has no daemon: a schedule fires while a window is open. What came due
// while none was is caught up once, or skipped, as the schedule says.
//
// Pure: rules and moments in, moments out. Times of day are in the schedule's
// time zone, the machine's unless it names one.

/** When a schedule runs. Exactly one of `at`, `every` or `cron` says it. */
export const When = z
  .object({
    /** Once, at this moment: an ISO time. */
    at: z.string().optional(),
    /**
     * Every so often — `30m`, `2h`, `1d` — counted from when it was made; or a
     * calendar unit — `day`, `weekday`, `week`, `month` — at `times`, on `on`.
     */
    every: z.string().optional(),
    /** For a calendar unit: times of day, `HH:MM`. */
    times: z.array(z.string()).optional(),
    /** For `week`: days, `mon` … `sun`. For `month`: days of the month, 1–31. */
    on: z.array(z.union([z.string(), z.number()])).optional(),
    /** Anything else: minute hour day-of-month month day-of-week. */
    cron: z.string().optional(),
    /** Stop after this many runs. */
    count: z.number().int().positive().optional(),
    /** Stop after this moment: an ISO time. */
    until: z.string().optional(),
    /** An IANA time zone, like `Europe/Sarajevo`. */
    tz: z.string().optional(),
  })
  .strict()
export type When = z.infer<typeof When>

/** What a schedule does each time it runs. */
export const ScheduleDoes = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agent'),
    /** What its agent is told. */
    prompt: z.string(),
    done: z.enum(DONE_RULES).optional(),
    model: z.object({ provider: z.string().optional(), id: z.string() }).optional(),
    thinking: z.string().optional(),
  }),
  z.object({
    kind: z.literal('ask'),
    /** What the orchestrator is asked. */
    prompt: z.string(),
  }),
  z.object({
    kind: z.literal('watch'),
    /** `<extension>.<watch>`, like `sentry.new-errors`. */
    watch: z.string(),
    /** What the watch was turned on with. */
    input: z.record(z.string(), z.unknown()).default({}),
    /**
     * What each thing it finds becomes: an agent on it, or a question for the
     * orchestrator. Not called `then`, which makes any object look like a promise.
     */
    found: z.enum(['agent', 'ask']).default('agent'),
    /** At most this many agents from one look. */
    most: z.number().int().positive().default(2),
  }),
])
export type ScheduleDoes = z.infer<typeof ScheduleDoes>

export const Schedule = z.object({
  /** Its own name for good: what the journal and its tasks are named by. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** What it is called, which can change. */
  name: z.string().min(1),
  project: z.string().min(1),
  /** What was said to make it, verbatim. */
  said: z.string().default(''),
  when: When,
  does: ScheduleDoes,
  /** What happens to runs that came due while Wilco was closed. */
  missed: z.enum(['once', 'skip']).default('once'),
  /** Who made it, as `TaskOrigin` says it. */
  by: z.string().default('you'),
  created: z.string(),
})
export type Schedule = z.infer<typeof Schedule>

const DAY = 86_400_000
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** The machine's own time zone. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

const formats = new Map<string, Intl.DateTimeFormat>()

/** A moment as a calendar and a clock in a time zone. */
export function wallClock(
  at: number,
  tz: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  let format = formats.get(tz)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
      hourCycle: 'h23',
    })
    formats.set(tz, format)
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]))
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: DAYS.indexOf(String(parts.weekday).slice(0, 3).toLowerCase() as (typeof DAYS)[number]),
  }
}

/**
 * The moment a calendar date and time of day happen in a time zone. A time
 * that a clock change skips happens at the moment it would have been.
 */
export function momentOf(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const wanted = Date.UTC(year, month - 1, day, hour, minute)
  let guess = wanted
  for (let i = 0; i < 3; i++) {
    const seen = wallClock(guess, tz)
    const diff = wanted - Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute)
    if (diff === 0) return guess
    guess += diff
  }
  return guess
}

const INTERVAL = /^(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/

/** An interval's length, when `every` is one. */
function intervalOf(every: string): number | null {
  const match = INTERVAL.exec(every.trim().toLowerCase())
  if (!match) return null
  const n = Number(match[1])
  const unit = match[2]?.[0]
  return n > 0 ? n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : DAY) : null
}

/** `HH:MM`, as hours and minutes; null for anything else. */
function timeOf(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour < 24 && minute < 60 ? { hour, minute } : null
}

/** A cron field as the values it allows, within its range. */
function cronField(
  field: string,
  low: number,
  high: number,
  names: readonly string[] = [],
): Set<number> | null {
  const allowed = new Set<number>()
  for (const part of field.toLowerCase().split(',')) {
    const [range = '', stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step <= 0) return null
    const value = (text: string) => {
      const named = names.indexOf(text)
      return named >= 0 ? named : Number(text)
    }
    let from = low
    let to = high
    if (range !== '*') {
      const [a = '', b] = range.split('-')
      from = value(a)
      to = b === undefined ? (stepText === undefined ? from : high) : value(b)
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < low || to > high || from > to) {
      return null
    }
    for (let n = from; n <= to; n += step) allowed.add(n)
  }
  return allowed
}

interface Cron {
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  anyDay: boolean
  anyWeekday: boolean
}

function parseCron(expression: string): Cron | null {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute = '', hour = '', dom = '', month = '', dow = ''] = fields
  const minutes = cronField(minute, 0, 59)
  const hours = cronField(hour, 0, 23)
  const days = cronField(dom, 1, 31)
  const months = cronField(month, 1, 12, ['', ...MONTH_NAMES.map((m) => m.toLowerCase())])
  const weekdays = cronField(dow, 0, 7, DAYS)
  if (!minutes || !hours || !days || !months || !weekdays) return null
  if (weekdays.has(7)) weekdays.add(0)
  return { minutes, hours, days, months, weekdays, anyDay: dom === '*', anyWeekday: dow === '*' }
}

/** Why a rule cannot be kept, or null when it can. */
export function whenProblem(when: When): string | null {
  const ways = [when.at, when.every, when.cron].filter((way) => way !== undefined)
  if (ways.length !== 1) return 'say when with exactly one of at, every or cron'
  if (when.tz) {
    try {
      wallClock(0, when.tz)
    } catch {
      return `${when.tz} is not a time zone`
    }
  }
  if (when.at !== undefined && Number.isNaN(Date.parse(when.at)))
    return `"${when.at}" is not a time`
  if (when.until !== undefined && Number.isNaN(Date.parse(when.until))) {
    return `"${when.until}" is not a time`
  }
  if (when.cron !== undefined && !parseCron(when.cron)) {
    return `"${when.cron}" is not a cron rule: minute hour day-of-month month day-of-week`
  }
  if (when.every !== undefined && intervalOf(when.every) === null) {
    const unit = when.every.trim().toLowerCase()
    if (!['day', 'weekday', 'week', 'month'].includes(unit)) {
      return `every "${when.every}" is neither a length like 30m, 2h, 1d nor day, weekday, week or month`
    }
    for (const time of when.times ?? []) {
      if (!timeOf(time)) return `"${time}" is not a time of day: HH:MM`
    }
    for (const day of when.on ?? []) {
      if (
        unit === 'week' &&
        !DAYS.includes(String(day).slice(0, 3).toLowerCase() as (typeof DAYS)[number])
      ) {
        return `"${day}" is not a day of the week`
      }
      if (unit === 'month' && !(Number(day) >= 1 && Number(day) <= 31)) {
        return `"${day}" is not a day of the month`
      }
    }
  }
  return null
}

/**
 * The moments a rule runs after `after`, up to `until` and at most `most` of
 * them, oldest first. `created` anchors intervals, and names the day and time
 * a calendar rule that does not say uses.
 */
export function runsOf(
  when: When,
  created: number,
  after: number,
  until: number,
  most: number,
): number[] {
  if (whenProblem(when)) return []
  const tz = when.tz ?? localZone()
  const stop = Math.min(until, when.until ? Date.parse(when.until) : Number.POSITIVE_INFINITY)
  const out: number[] = []
  const keep = (moment: number) => {
    if (moment > after && moment <= stop && out.length < most) out.push(moment)
  }
  if (when.at !== undefined) {
    keep(Date.parse(when.at))
    return out
  }
  const interval = when.every ? intervalOf(when.every) : null
  if (interval !== null) {
    // The first run is one interval after it was made: "every two hours" made
    // at noon starts no agent at noon.
    const first = Math.max(1, Math.floor((after - created) / interval) + 1)
    for (let n = first; out.length < most; n++) {
      const moment = created + n * interval
      if (moment > stop) break
      keep(moment)
    }
    return out
  }

  const cron = when.cron ? parseCron(when.cron) : null
  const unit = when.every?.trim().toLowerCase()
  const made = wallClock(created, tz)
  const times = (when.times ?? [])
    .flatMap((time) => timeOf(time) ?? [])
    .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute))
  const clock = times.length > 0 ? times : [{ hour: made.hour, minute: made.minute }]
  const weekdays = new Set(
    (when.on ?? [DAYS[made.weekday] ?? 'mon']).map((day) =>
      DAYS.indexOf(String(day).slice(0, 3).toLowerCase() as (typeof DAYS)[number]),
    ),
  )
  const monthDays = new Set((when.on ?? [made.day]).map(Number))
  const start = wallClock(Math.max(after, created - DAY), tz)
  // A calendar rule runs at most every day, so a little over a year of days
  // finds the next run of any rule that runs at all.
  for (let d = 0; d < 400 && out.length < most; d++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + d))
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const day = date.getUTCDate()
    const weekday = date.getUTCDay()
    let moments: { hour: number; minute: number }[] = []
    if (cron) {
      const domOk = cron.days.has(day)
      const dowOk = cron.weekdays.has(weekday)
      // Cron's own rule: with both restricted, either one is enough.
      const dayOk =
        cron.anyDay && cron.anyWeekday
          ? true
          : cron.anyDay
            ? dowOk
            : cron.anyWeekday
              ? domOk
              : domOk || dowOk
      if (!cron.months.has(month) || !dayOk) continue
      for (const hour of [...cron.hours].sort((a, b) => a - b)) {
        for (const minute of [...cron.minutes].sort((a, b) => a - b)) moments.push({ hour, minute })
      }
    } else {
      const runsToday =
        unit === 'day' ||
        (unit === 'weekday' && weekday >= 1 && weekday <= 5) ||
        (unit === 'week' && weekdays.has(weekday)) ||
        (unit === 'month' && monthDays.has(day))
      if (!runsToday) continue
      moments = clock
    }
    for (const { hour, minute } of moments) {
      const moment = momentOf(tz, year, month, day, hour, minute)
      if (moment > stop) return out
      keep(moment)
    }
  }
  return out
}

/** How long after a run's moment it still counts as on time rather than missed. */
export const ON_TIME_MS = 5 * 60_000

export type Due =
  /** Run now, for the moment `due`; `missed` runs before it came and went unseen. */
  | { run: true; due: number; missed: number }
  /** Runs came due while Wilco was closed, and the schedule says to skip them. */
  | { run: false; due: number; missed: number }

/**
 * Whether a schedule is due now: the latest moment it should have run since it
 * last did, and how many before that went by. On time, it runs. Missed while
 * Wilco was closed, it runs once or is skipped, as it says — never once for
 * each run it missed.
 */
export function dueNow(
  schedule: { when: When; missed: 'once' | 'skip'; created: string },
  last: number | null,
  ran: number,
  now: number,
): Due | null {
  if (schedule.when.count !== undefined && ran >= schedule.when.count) return null
  const created = Date.parse(schedule.created)
  // A rule every minute left for a week is ten thousand runs: only the count
  // matters, and past a thousand, the count is "many".
  const passed = runsOf(schedule.when, created, last ?? created - 1, now, 1_000)
  const latest = passed.at(-1)
  if (latest === undefined) return null
  const missed = passed.length - 1
  if (now - latest <= ON_TIME_MS) return { run: true, due: latest, missed }
  return schedule.missed === 'once'
    ? { run: true, due: latest, missed: passed.length }
    : { run: false, due: latest, missed: passed.length }
}

/** Whether a schedule has nothing left to run: a one-off that ran, a count reached, an end passed. */
export function scheduleEnded(
  schedule: { when: When; created: string },
  last: number | null,
  ran: number,
  now: number,
): boolean {
  if (schedule.when.count !== undefined && ran >= schedule.when.count) return true
  const created = Date.parse(schedule.created)
  return (
    runsOf(schedule.when, created, Math.max(last ?? created - 1, now), Number.POSITIVE_INFINITY, 1)
      .length === 0
  )
}

/** A number of the month as people say it: 1st, 2nd, 23rd. */
function nth(n: number): string {
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${n % 10 > 3 ? 'th' : suffix}`
}

function listed(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/** When a schedule runs, in words: `every weekday at 09:00`. */
export function describeWhen(
  when: When,
  clock: (at: number) => string = defaultClock(when),
): string {
  const tail = [
    when.count !== undefined ? `${when.count} time${when.count === 1 ? '' : 's'}` : '',
    when.until !== undefined ? `until ${clock(Date.parse(when.until))}` : '',
  ].filter(Boolean)
  const said = (text: string) => (tail.length > 0 ? `${text}, ${tail.join(', ')}` : text)
  if (when.at !== undefined) return `once, ${clock(Date.parse(when.at))}`
  if (when.cron !== undefined) return said(`on cron ${when.cron}`)
  const every = (when.every ?? '').trim().toLowerCase()
  const interval = intervalOf(every)
  if (interval !== null) {
    const units: [number, string][] = [
      [DAY, 'day'],
      [3_600_000, 'hour'],
      [60_000, 'minute'],
    ]
    const [size, unit] = units.find(([length]) => interval % length === 0) ?? [60_000, 'minute']
    const n = interval / size
    return said(n === 1 ? `every ${unit}` : `every ${n} ${unit}s`)
  }
  const at = when.times && when.times.length > 0 ? ` at ${listed(when.times)}` : ''
  if (every === 'day') return said(`every day${at}`)
  if (every === 'weekday') return said(`every weekday${at}`)
  if (every === 'week') {
    const days = (when.on ?? []).map(
      (day) =>
        DAY_NAMES[DAYS.indexOf(String(day).slice(0, 3).toLowerCase() as (typeof DAYS)[number])] ??
        String(day),
    )
    return said(`every ${days.length > 0 ? listed(days) : 'week'}${at}`)
  }
  if (every === 'month') {
    const days = (when.on ?? []).map((day) => nth(Number(day)))
    return said(`${days.length > 0 ? `on the ${listed(days)} of ` : ''}every month${at}`)
  }
  return said(`every ${every}`)
}

/** Moments said in a schedule's own time zone: `Tue 15 Sep 09:00`. */
export function defaultClock(when: { tz?: string | undefined }): (at: number) => string {
  const tz = when.tz ?? localZone()
  return (at) => {
    const wall = wallClock(at, tz)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${DAY_NAMES[wall.weekday]?.slice(0, 3) ?? ''} ${wall.day} ${MONTH_NAMES[wall.month - 1] ?? ''} ${pad(wall.hour)}:${pad(wall.minute)}`
  }
}
