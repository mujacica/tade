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
  type Race,
  type RaceWon,
  raceDollars,
  raceKey,
  racerRunsOn,
  raceSpentSays,
  racesIn,
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
//
// **And the races**, the head-to-head version of the same question — one
// request, several harnesses or models — read-only here: picking is a press in
// the window or a line to the orchestrator. Their order reads the judge, so a
// device without `findings` gets them ordered by the checks and the size alone
// rather than by what it may not read; what was asked is `intent`'s, and the
// money is `spend`'s.

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
  /** Every race over the projects this device reads, undecided first. */
  races: RaceOut[]
}

/** One entrant of a race, as the page draws it. */
export interface RacerOut {
  task: string
  /** Where the facts this device may read put it, from 1: an order, never a verdict. */
  place: number
  /** What it runs on: `codex · gpt-5-codex`. */
  runsOn: string
  won: boolean
  closed: boolean
  /** Every figure this device may read, in the machine's words. */
  says: string[]
  /** Null where not granted `spend`. */
  usd: string | null
}

/** One race, as the page draws it. */
export interface RaceOut {
  name: string
  project: string
  /** What every entrant was asked, verbatim; null where not granted `intent`. */
  said: string | null
  finished: number
  /** What it has cost so far, in a clause; null where not granted `spend`. */
  spent: string | null
  /** Who picked; `why` is null where not granted `intent`. */
  won: { task: string; by: string; why: string | null } | null
  racers: RacerOut[]
}

/** What the window hands over for the races: every one over the projects named. */
export type RacesFor = (projects: ReadonlySet<string> | null) => readonly Race[]

/** What the window hands over: the fold over the projects one device reads, or null before reading. */
export type EvaluationsFor = (projects: ReadonlySet<string> | null) => Evaluations | null

/** The answer for one device. */
export function evaluationsFor(
  reach: Reach,
  fold: EvaluationsFor | undefined,
  races?: RacesFor,
): EvaluationsOut {
  const granted = { spend: has(reach, 'spend'), findings: has(reach, 'findings') }
  const projects = reach.projects.kind === 'every' ? null : new Set(reach.projects.names)
  const raced = racesOut(reach, races?.(projects) ?? [])
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
      races: raced,
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
    races: raced,
  }
}

/**
 * The races as one device may read them. Without `findings` the judge's part is
 * taken out *before* they are ordered, so the order says nothing it may not
 * read; a race in a project it does not read never reaches here at all.
 */
function racesOut(reach: Reach, races: readonly Race[]): RaceOut[] {
  const findings = has(reach, 'findings')
  const intent = has(reach, 'intent')
  const spend = has(reach, 'spend')
  const shown = findings
    ? races
    : racesIn(
        races.flatMap((race) =>
          race.racers.map((one) => ({ ...one.facts, findings: null, strayed: null })),
        ),
        new Map(
          races.flatMap((race) =>
            race.won ? [[raceKey(race.project, race.name), race.won] as [string, RaceWon]] : [],
          ),
        ),
      )
  return shown.map((race) => ({
    name: race.name,
    project: race.project,
    said: intent ? race.said : null,
    finished: race.finished,
    spent: spend ? raceSpentSays(race) : null,
    won: race.won
      ? { task: race.won.task, by: race.won.by, why: intent ? race.won.why : null }
      : null,
    racers: race.racers.map((one) => {
      const facts = one.facts
      const says = [
        facts.finished ? 'finished' : facts.state,
        facts.checks === 'pass'
          ? 'checks green'
          : facts.checks === 'fail'
            ? 'checks red'
            : facts.checks === 'unknown'
              ? 'checks not run'
              : 'checks not looked at',
        ...(findings
          ? [
              facts.strayed === null
                ? 'no judge reads it'
                : facts.strayed
                  ? 'strayed from what was asked'
                  : 'kept to what was asked',
              facts.findings === null
                ? 'findings not read'
                : `${facts.findings.open + facts.findings.answered + facts.findings.confirmed} findings open`,
            ]
          : []),
        facts.size && facts.size.added !== null && facts.size.removed !== null
          ? `+${facts.size.added} −${facts.size.removed}`
          : 'size not counted',
      ]
      return {
        task: facts.task,
        place: one.place,
        runsOn: racerRunsOn(facts),
        won: one.won,
        closed: one.closed,
        says,
        usd: spend ? raceDollars(facts.usd) : null,
      }
    }),
  }))
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
