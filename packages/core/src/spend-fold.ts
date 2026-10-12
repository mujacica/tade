import type { TadeEvent } from './events.ts'

// What has been spent, folded as it is written rather than kept a line apiece.
//
// A window keeps every `usage` line there has ever been, because the Spend
// page offers the whole journal as a range. A real one held 86,778 of them —
// 42 MB of heap — and was writing ten thousand more a day, each kept for as
// long as the window stayed open. But nothing reads a usage line as itself:
// `spendFrom` adds up its counts into buckets named by everything else on it,
// so lines alike in everything but their counts can be one line with the
// counts added, and every answer folded out of the list is the same answer.
// The same journal folded is 3,072 lines.
//
// Pure: lines in, lines out. No clock reads, no I/O.

/** What a usage line counts, which adds up: everything else on one is a fact a merge keeps as it was. */
const COUNTS: ReadonlySet<string> = new Set([
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'tokens',
  'usd',
])

/**
 * The grain lines are merged at: a quarter of an hour.
 *
 * A range starts at a local midnight, at a whole number of days before one,
 * or at the moment the window opened. Across a change of clocks a whole number
 * of days before midnight is an hour, or half of one, off it — and every
 * zone's offset and every change of clocks is a whole number of quarter
 * hours, so a quarter hour is the coarsest grain no range but the window's
 * can begin inside. A day would put the hour after the clocks went back on
 * the wrong side of a week. The window's own moment is kept by splitting on
 * it (`keyOf`), since it falls wherever it falls.
 */
const GRAIN = 15 * 60_000

/**
 * Every usage line, merged where nothing could tell two apart.
 *
 * Lines merge when they share a quarter hour, a side of the moment the window
 * opened, their task, run and lane, every field of `detail` that is not a
 * count, and whether each count was positive, nought or missing — which is
 * what decides how `spendFrom` prices one: reported money or a listed rate,
 * a turn a plan paid for that could be put a price on or could not. A line
 * with a count below nought is kept on its own, because there a sum could
 * change which way that goes. The merged line carries the newest of its
 * lines' sequence number and time, so it sorts where its newest did — which
 * keeps "the last model a task or a run said" the same answer.
 */
export class UsageFold {
  private readonly lines = new Map<string, TadeEvent>()
  private readonly opened: number
  private listed: TadeEvent[] | null = null
  private newest = Number.NEGATIVE_INFINITY
  private inOrder = true
  private added = 0

  /** `opened` is the moment the window opened, which "this window" is measured from. */
  constructor(opened: number) {
    this.opened = opened
  }

  /** How many lines it has been handed: the same count is the same list. */
  get size(): number {
    return this.added
  }

  /** The merged lines, oldest first by their newest line. */
  get events(): readonly TadeEvent[] {
    if (this.listed === null) {
      const all = [...this.lines.values()]
      // A merged line moves to the end as its newest arrives, so lines handed
      // over in order are listed in order; only a late one needs a sort.
      if (!this.inOrder) all.sort((a, b) => a.seq - b.seq)
      this.listed = all
    }
    return this.listed
  }

  add(event: TadeEvent): void {
    if (event.type !== 'usage') return
    this.added++
    this.listed = null
    if (event.seq < this.newest) this.inOrder = false
    this.newest = Math.max(this.newest, event.seq)
    const key = keyOf(event, this.opened)
    const was = this.lines.get(key)
    this.lines.delete(key)
    this.lines.set(key, was ? merged(was, event) : event)
  }
}

/** Everything about a line that is not a count, which is what two lines must share to be one. */
function keyOf(event: TadeEvent, opened: number): string {
  const facts: [string, unknown][] = []
  for (const name of Object.keys(event.detail).sort()) {
    const value = event.detail[name]
    if (!COUNTS.has(name)) facts.push([name, value])
    else if (typeof value !== 'number' || !Number.isFinite(value)) facts.push([name, 'none'])
    else if (value < 0) return `alone\0${event.seq}`
    else facts.push([name, value > 0 ? '+' : '0'])
  }
  const at = Date.parse(event.ts)
  const grain = Number.isFinite(at) ? Math.floor(at / GRAIN) : null
  return JSON.stringify([
    grain,
    at >= opened,
    event.task,
    event.run,
    event.lane,
    event.urgency,
    facts,
  ])
}

/** Two lines alike in everything but their counts, as one: the newer's, with the counts added. */
function merged(a: TadeEvent, b: TadeEvent): TadeEvent {
  const [older, newer] = a.seq <= b.seq ? [a, b] : [b, a]
  const detail = { ...newer.detail }
  for (const name of COUNTS) {
    const one = older.detail[name]
    const two = newer.detail[name]
    if (typeof one === 'number' && typeof two === 'number') detail[name] = one + two
  }
  return { ...newer, detail }
}
