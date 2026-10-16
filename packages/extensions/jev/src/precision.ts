import {
  type BandRow,
  bandOf,
  countFinding,
  noBands,
  noTally,
  type QuestionRow,
  questionRows,
  settleTally,
  type Tally,
} from '@tade/core'
import type { OpenFinding } from './loop.ts'
import type { Review } from './reviews.ts'

// Whether the rubric is worth running, as arithmetic — over Jev's own record.
//
// The rule itself (`ENOUGH`, a tally, a band, what a row is worth and how a
// rate is said) is core's `calibration.ts`, because the window's Evaluations
// surface reads the same table out of the `findings` hook and may not import
// an extension. What is Jev's alone is here: the per-day table, which needs
// the readings and what they cost, and which only Jev's record holds.

export {
  type BandRow,
  bandOf,
  ENOUGH,
  precisionSaid,
  type QuestionRow,
  type Tally,
  type Worth,
  worthOf,
  worthSaid,
} from '@tade/core'

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
  const total = noTally()
  const questions = new Map<string, { tally: Tally; highest: number }>()
  const bands = noBands()
  const days = new Map<number, DayRow>()
  const dayRow = (at: number): DayRow => {
    const key = about.dayAt(at)
    const had = days.get(key)
    if (had) return had
    const made: DayRow = { at: key, read: 0, tally: noTally(), usd: 0 }
    days.set(key, made)
    return made
  }

  for (const finding of findings) {
    countFinding(total, finding)
    const row = questions.get(finding.question) ?? { tally: noTally(), highest: 0 }
    countFinding(row.tally, finding)
    row.highest = Math.max(row.highest, finding.probability)
    questions.set(finding.question, row)
    const band = bands[bandOf(finding.probability)]
    if (band) countFinding(band.tally, finding)
    countFinding(dayRow(finding.at).tally, finding)
  }
  for (const review of reviews) {
    const at = Date.parse(review.at) || 0
    const day = dayRow(at)
    day.read += 1
    day.usd += review.cost_usd
  }

  return {
    total: settleTally(total),
    byQuestion: questionRows(questions),
    byBand: bands.map((band) => ({ ...band, tally: settleTally(band.tally) })),
    byDay: [...days.values()]
      .sort((a, b) => a.at - b.at)
      .map((day) => ({
        ...day,
        tally: settleTally(day.tally),
      })),
  }
}
