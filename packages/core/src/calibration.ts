// Whether a judge's questions earn their place, as arithmetic.
//
// The judge gives a probability; a person gives a verdict; this is the only
// place the two are put beside each other. It is pure, and it is deliberately
// arithmetic rather than a reading: a judge asked whether its own questions
// earn their place is the judge marking its own homework, and the whole reason
// a verdict has to cite what in the change decided it is that this table is
// what the citation is for.
//
// In core rather than in Jev because two readers need the one rule: Jev's own
// page and tools (`extensions/jev/src/precision.ts`, which adds the per-day
// table over its record), and the window's Evaluations surface, which reads
// what any judge raised through the `findings` hook and may never import an
// extension by name. Two copies of `ENOUGH` would be two answers to when a
// rate becomes a rate.
//
// Three honesty rules, and they are the point of the file:
//
//   · A rate is counted over FINDINGS, never over readings. One question
//     raised again by a later reading of the same change is one finding with
//     one key, so counting across readings counted the same finding once per
//     look and made a question that fired on one change twenty-one times look
//     like twenty-one mistakes.
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
 * look like a measurement. The scorecards use it for every rate they draw, for
 * the same reason.
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

/** As much of a finding as calibration reads: its verdict, if anybody wrote one. */
export interface Judged {
  verdict: { was: string } | null
}

/** A finding as the tables group it: which question, at what probability. */
export interface Calibrated extends Judged {
  question: string
  probability: number
}

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

/** Precision per question and per band, and over everything. */
export interface Calibration {
  total: Tally
  byQuestion: QuestionRow[]
  byBand: BandRow[]
}

export function noTally(): Tally {
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
export function countFinding(tally: Tally, finding: Judged): void {
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
export function settleTally(tally: Tally): Tally {
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
export const BANDS = 10

/** Which band a probability is in. */
export function bandOf(probability: number): number {
  return Math.min(BANDS - 1, Math.max(0, Math.floor(probability * BANDS)))
}

/** Every band, empty, in order. */
export function noBands(): BandRow[] {
  return Array.from({ length: BANDS }, (_, index) => ({
    from: index / BANDS,
    to: (index + 1) / BANDS,
    tally: noTally(),
  }))
}

/**
 * Loudest first, because a question that fires once is nobody's problem
 * however wrong it was, and ties by name so the table does not shuffle.
 */
export function questionRows(
  questions: ReadonlyMap<string, { tally: Tally; highest: number }>,
): QuestionRow[] {
  return [...questions]
    .map(([question, row]) => {
      const tally = settleTally(row.tally)
      return { question, tally, highest: row.highest, worth: worthOf(tally) }
    })
    .sort((a, b) => b.tally.fired - a.tally.fired || a.question.localeCompare(b.question))
}

/**
 * Precision per question and per band, out of findings that are already one
 * per key. Windowed by the caller, which is the one that knows what a day is.
 */
export function calibrationOf(findings: readonly Calibrated[]): Calibration {
  const total = noTally()
  const questions = new Map<string, { tally: Tally; highest: number }>()
  const bands = noBands()
  for (const finding of findings) {
    countFinding(total, finding)
    const row = questions.get(finding.question) ?? { tally: noTally(), highest: 0 }
    countFinding(row.tally, finding)
    row.highest = Math.max(row.highest, finding.probability)
    questions.set(finding.question, row)
    const band = bands[bandOf(finding.probability)]
    if (band) countFinding(band.tally, finding)
  }
  return {
    total: settleTally(total),
    byQuestion: questionRows(questions),
    byBand: bands.map((band) => ({ ...band, tally: settleTally(band.tally) })),
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
