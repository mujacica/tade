import type { OpenFinding } from './loop.ts'
import type { Review } from './reviews.ts'

// Whether the rubric is worth running, as arithmetic.
//
// The judge gives a probability; a person gives a verdict; this is the only
// place the two are put beside each other. It is pure, and it is deliberately
// arithmetic rather than a reading: a judge asked whether its own questions
// earn their place is the judge marking its own homework, and the whole reason
// a verdict has to cite what in the change decided it is that this table is
// what the citation is for.
//
// Three honesty rules, and they are the point of the file:
//
//   · A rate is counted over FINDINGS, never over readings. One question
//     raised again by a later reading of the same change is one finding with
//     one key, so counting `review.raised` across readings counted the same
//     finding once per look and made a question that fired on one change
//     twenty-one times look like twenty-one mistakes.
//   · A rate nobody has enough verdicts for is not stated as a rate. Three
//     verdicts is not a trend, and a page that prints `0%` over one verdict
//     has invented a fact. `ENOUGH` is where a figure starts being drawn, and
//     under it the counts are said and the rate is not.
//   · An unresolved finding is never counted as anything. It is not a false
//     positive, it is not a confirmation, and nothing here ages it into
//     either: `judged` is out of what somebody actually wrote down.

/**
 * How many verdicts one row needs before its rate is stated as a percentage.
 *
 * Five, because four is where one verdict stops moving the figure by more than
 * a quarter. It is a threshold for *drawing* and nothing else: the counts are
 * always said, so a row under it is still readable — it just does not get to
 * look like a measurement.
 */
export const ENOUGH = 5

/** What was flagged, what was judged, and how much of it was right. */
export interface Tally {
  /** Findings raised, whatever became of them. */
  fired: number
  /** Of those, the ones somebody wrote a verdict about. */
  judged: number
  confirmed: number
  wrong: number
  /** Findings with no verdict. Counted as neither, ever. */
  open: number
  /** `confirmed / judged`, or null where nobody has judged one. */
  precision: number | null
  /** Whether `judged` is enough for `precision` to be read as a rate. */
  enough: boolean
}

/** What a row's verdicts say about whether the question is worth asking. */
export type Worth = 'earns' | 'costs' | 'unproven'

export interface QuestionRow {
  question: string
  tally: Tally
  /** The highest probability it ever fired at, in this window. */
  highest: number
  worth: Worth
}

export interface BandRow {
  /** The band, as a share: `0.8` is 0.8 up to but not including 0.9. */
  from: number
  to: number
  tally: Tally
}

export interface DayRow {
  /** Midnight of the day, in local time, as `sinceOf` means a day. */
  at: number
  /** Changes read that day. */
  read: number
  tally: Tally
  usd: number
}

export interface Precision {
  total: Tally
  byQuestion: QuestionRow[]
  byBand: BandRow[]
  byDay: DayRow[]
}

function empty(): Tally {
  return {
    fired: 0,
    judged: 0,
    confirmed: 0,
    wrong: 0,
    open: 0,
    precision: null,
    enough: false,
  }
}

/** One finding added to a tally. Never counts an unresolved one as an outcome. */
function count(tally: Tally, finding: OpenFinding): void {
  tally.fired += 1
  if (!finding.verdict) {
    tally.open += 1
    return
  }
  tally.judged += 1
  if (finding.verdict.was === 'confirmed') tally.confirmed += 1
  else tally.wrong += 1
}

/** The rate, once everything is counted. Null rather than zero where nobody judged. */
function settle(tally: Tally): Tally {
  tally.precision = tally.judged === 0 ? null : tally.confirmed / tally.judged
  tally.enough = tally.judged >= ENOUGH
  return tally
}

/**
 * Whether a question earns its place, from its verdicts alone.
 *
 * `costs` is the answer the evidence has to be allowed to give: a question
 * that fires often and has never once been right is spending somebody's
 * attention, and the page exists to make that obvious rather than arguable.
 * Both verdicts are needed for either answer, so a question nobody has judged
 * is `unproven` however loudly it fires — which is also the honest reading of
 * a question that has only just been written.
 */
export function worthOf(tally: Tally): Worth {
  if (!tally.enough) return 'unproven'
  if (tally.confirmed === 0) return 'costs'
  return tally.confirmed / tally.judged >= 0.5 ? 'earns' : 'costs'
}

/** The bands a probability is grouped into: tenths, so a threshold lands on an edge. */
const BANDS = 10

/** Which band a probability is in. */
export function bandOf(probability: number): number {
  return Math.min(BANDS - 1, Math.max(0, Math.floor(probability * BANDS)))
}

/**
 * Everything the calibration page says, out of the findings and the readings.
 *
 * `findings` are already folded — one key, one finding, with whatever was said
 * about it since — and `reviews` are only here for how many changes were read
 * and what they cost, which is a fact about looks rather than about findings.
 * Both are windowed by the caller: what a day means is the window's to decide
 * and is decided once, in `sinceOf`.
 */
export function precisionOf(
  findings: readonly OpenFinding[],
  reviews: readonly Review[],
  about: { now: number; dayAt: (at: number) => number },
): Precision {
  const total = empty()
  const questions = new Map<string, { tally: Tally; highest: number }>()
  const bands = Array.from({ length: BANDS }, (_, index) => ({
    from: index / BANDS,
    to: (index + 1) / BANDS,
    tally: empty(),
  }))
  const days = new Map<number, DayRow>()
  const dayRow = (at: number): DayRow => {
    const key = about.dayAt(at)
    const had = days.get(key)
    if (had) return had
    const made: DayRow = { at: key, read: 0, tally: empty(), usd: 0 }
    days.set(key, made)
    return made
  }

  for (const finding of findings) {
    count(total, finding)
    const row = questions.get(finding.question) ?? { tally: empty(), highest: 0 }
    count(row.tally, finding)
    row.highest = Math.max(row.highest, finding.probability)
    questions.set(finding.question, row)
    const band = bands[bandOf(finding.probability)]
    if (band) count(band.tally, finding)
    count(dayRow(finding.at).tally, finding)
  }
  for (const review of reviews) {
    const at = Date.parse(review.at) || 0
    const day = dayRow(at)
    day.read += 1
    day.usd += review.cost_usd
  }

  return {
    total: settle(total),
    byQuestion: [...questions]
      .map(([question, row]) => {
        const tally = settle(row.tally)
        return { question, tally, highest: row.highest, worth: worthOf(tally) }
      })
      // Loudest first, because a question that fires once is nobody's problem
      // however wrong it was, and ties by name so the table does not shuffle.
      .sort((a, b) => b.tally.fired - a.tally.fired || a.question.localeCompare(b.question)),
    byBand: bands.map((band) => ({ ...band, tally: settle(band.tally) })),
    byDay: [...days.values()]
      .sort((a, b) => a.at - b.at)
      .map((day) => ({
        ...day,
        tally: settle(day.tally),
      })),
  }
}

/**
 * A rate in words, and never a percentage nobody has the verdicts for.
 *
 * Three answers and no fourth: nothing judged, too few to call it a rate, and
 * a rate. The counts are in all three, because `2 of 14` is the fact and `14%`
 * is a reading of it.
 */
export function precisionSaid(tally: Tally): string {
  if (tally.judged === 0) return tally.fired === 0 ? '—' : 'none judged'
  const counted = `${tally.confirmed} of ${tally.judged}`
  if (!tally.enough) return `${counted}, too few to call`
  return `${counted} · ${Math.round((tally.precision ?? 0) * 100)}%`
}

/**
 * What a row's worth says, in the words the page reads — and nothing at all
 * where nobody has judged one, because `precisionSaid` has already said that
 * and two columns saying the same thing is one column of the table wasted.
 */
export function worthSaid(worth: Worth, tally?: Tally): string {
  if (worth === 'earns') return 'earns its place'
  if (worth === 'costs') return 'firing and wrong'
  return tally && tally.judged === 0 ? '' : `under ${ENOUGH} verdicts`
}
