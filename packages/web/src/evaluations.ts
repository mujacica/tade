import {
  type Calibration,
  type CostPart,
  countSaid,
  EVAL_BY,
  type EvalBy,
  type Evaluations,
  perLanded,
  perLandedCost,
  precisionSaid,
  type Scorecard,
  scorecardsBy,
  UNRECORDED,
  WITHOUT,
  worthSaid,
} from '@tade/core'
import { has, type Reach } from './reach.ts'

// The scorecards, as one device may read them: which harness, model, persona
// and template lands work, and the judge's own calibration.
//
// **An answer of its own, not a collection**, for the reason the notes and the
// settings are: it changes when work finishes, not twice a second, and a phone
// is not sent four tables of it on every frame for a page nobody has open. The
// page asks while it is open (`GET /api/evaluations`).
//
// **Folded per device, never filtered afterwards.** A scorecard is a sum, and a
// sum over work a device may not read cannot be made safe by removing rows from
// it — so the window folds again over the projects this device reads
// (`EvaluationsFor`), and what comes back is only ever about those.
//
// Every figure that is a count out of a count arrives with the machine's own
// words for it (`countSaid`, `precisionSaid`), so the page draws and decides
// nothing — and a rate is said only from `ENOUGH`, after its counts. Money is
// the `spend` grant's and what the judge said is the `findings` grant's, each
// withheld here as a *not granted* the page can say rather than as a nought.

/** A count out of a count, and the machine's words for it. */
export interface RateOut {
  count: number
  of: number
  said: string
}

/** One row of a scorecard, as the page draws it. */
export interface CardOut {
  key: string
  /** The key as a person reads it: `not recorded`, `no persona`, never `unknown`. */
  label: string
  /** Whether the key is one somebody named, rather than nothing recorded or none. */
  named: boolean
  tasks: number
  done: RateOut
  landed: RateOut
  merged: number
  firstPushGreen: RateOut
  /** Red runs on this machine; null where nothing ran a check here. */
  redsHere: number | null
  /** Null where no judge reads anything here, or this device was not granted it. */
  findings: { fired: number; on: number; confirmed: number; wrong: number; open: number } | null
  /** What a landed task cost, part by part; null where not granted `spend`. */
  cost: CostPart[] | null
  tokensPerLanded: number | null
  toDoneMs: number | null
  moved: number
}

export interface CalibrationOut {
  fired: number
  open: number
  said: string
  questions: {
    question: string
    fired: number
    open: number
    said: string
    worth: string
    tone: 'earns' | 'costs' | 'unproven'
  }[]
  /** Only the bands anything fired in. */
  bands: { from: number; to: number; fired: number; open: number; said: string }[]
}

export interface EvaluationsOut {
  /** False until the window has read the journal: a page of noughts before then would be a lie. */
  read: boolean
  mergedFrom: Evaluations['mergedFrom'] | null
  /** Whether the money and the judge reached this device, each its own grant. */
  granted: { spend: boolean; findings: boolean }
  /** Null where nothing reads anything here; withheld where not granted. */
  judge: 'read' | 'none here' | 'not granted'
  total: CardOut | null
  by: Readonly<Record<EvalBy, CardOut[]>>
  calibration: CalibrationOut | null
}

/** What the window hands over: the fold over the projects one device reads, or null before reading. */
export type EvaluationsFor = (projects: ReadonlySet<string> | null) => Evaluations | null

/** The answer for one device. */
export function evaluationsFor(reach: Reach, fold: EvaluationsFor | undefined): EvaluationsOut {
  const granted = { spend: has(reach, 'spend'), findings: has(reach, 'findings') }
  const projects = reach.projects.kind === 'every' ? null : new Set(reach.projects.names)
  const evals = fold?.(projects) ?? null
  const empty = { harness: [], model: [], persona: [], template: [] }
  if (evals === null) {
    return {
      read: false,
      mergedFrom: null,
      granted,
      judge: granted.findings ? 'none here' : 'not granted',
      total: null,
      by: empty,
      calibration: null,
    }
  }
  const card = (row: Scorecard, by: EvalBy | null): CardOut => cardOut(row, by, granted)
  return {
    read: true,
    mergedFrom: evals.mergedFrom,
    granted,
    judge: !granted.findings ? 'not granted' : evals.calibration === null ? 'none here' : 'read',
    total: card(evals.total, null),
    by: Object.fromEntries(
      EVAL_BY.map(({ id }) => [id, scorecardsBy(evals, id).map((row) => card(row, id))]),
    ) as Record<EvalBy, CardOut[]>,
    calibration:
      granted.findings && evals.calibration !== null ? calibrationOut(evals.calibration) : null,
  }
}

function cardOut(
  row: Scorecard,
  by: EvalBy | null,
  granted: { spend: boolean; findings: boolean },
): CardOut {
  const rate = (count: number, of: number): RateOut => ({ count, of, said: countSaid(count, of) })
  return {
    key: row.key,
    label: by === null ? 'all' : labelOf(row.key, by),
    named: row.key !== UNRECORDED && row.key !== WITHOUT,
    tasks: row.tasks,
    done: rate(row.done, row.tasks),
    landed: rate(row.landed, row.tasks),
    merged: row.merged,
    firstPushGreen: rate(row.firstPushGreen, row.pushed),
    redsHere: row.checkedHere === 0 ? null : row.redsHere,
    findings: granted.findings && row.findings ? { ...row.findings } : null,
    cost: granted.spend ? perLandedCost(row) : null,
    tokensPerLanded: granted.spend ? perLanded(row, (spend) => spend.tokens) : null,
    toDoneMs: row.toDoneMs,
    moved: row.moved,
  }
}

function calibrationOut(calibration: Calibration): CalibrationOut {
  return {
    fired: calibration.total.fired,
    open: calibration.total.open,
    said: precisionSaid(calibration.total),
    questions: calibration.byQuestion.map((row) => ({
      question: row.question,
      fired: row.tally.fired,
      open: row.tally.open,
      said: precisionSaid(row.tally),
      worth: worthSaid(row.worth, row.tally),
      tone: row.worth,
    })),
    bands: calibration.byBand
      .filter((band) => band.tally.fired > 0)
      .map((band) => ({
        from: band.from,
        to: band.to,
        fired: band.tally.fired,
        open: band.tally.open,
        said: precisionSaid(band.tally),
      })),
  }
}

/** A key as a person reads it: never a harness or a persona called `unknown`. */
function labelOf(key: string, by: EvalBy): string {
  if (key === UNRECORDED) return 'not recorded'
  if (key === WITHOUT) return `no ${by}`
  return key
}
