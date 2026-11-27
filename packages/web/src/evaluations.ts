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
  raceDollars,
  racerRunsOn,
  raceSpentSays,
  type Scorecard,
  scorecardsBy,
  UNRECORDED,
  WITHOUT,
  worthSaid,
} from '@tade/core'
import { z } from 'zod'

// The scorecards: which harness, model, persona
// and template lands work, and the judge's own calibration.
//
// **An answer of its own, not a collection**, for the reason the notes and the
// settings are: it changes when work finishes, not twice a second, and a phone
// is not sent four tables of it on every frame for a page nobody has open. The
// page asks while it is open (`GET /api/evaluations`).
//
// Every paired device is the person's own, so the fold is over every project.
//
// Every figure that is a count out of a count arrives with the machine's own
// words for it (`countSaid`, `precisionSaid`), so the page draws and decides
// nothing — and a rate is said only from `ENOUGH`, after its counts.
//
// **And the races**, the head-to-head version of the same question — one
// request, several harnesses or models — read-only here: picking is a press in
// the window or a line to the orchestrator.

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
  /** Null where no judge reads anything here. */
  findings: { fired: number; on: number; confirmed: number; wrong: number; open: number } | null
  /** What a landed task cost, part by part; null where nothing recorded one. */
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
  /** Whether a judge here reads anything. */
  judge: 'read' | 'none here'
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
  usd: string | null
}

/** One race, as the page draws it. */
export interface RaceOut {
  name: string
  project: string
  /** What every entrant was asked, verbatim. */
  said: string | null
  finished: number
  /** What it has cost so far, in a clause. */
  spent: string | null
  /** Who picked, and why. */
  won: { task: string; by: string; why: string | null } | null
  racers: RacerOut[]
}

/** What the window hands over for the races: every one over the projects named. */
export type RacesFor = (projects: ReadonlySet<string> | null) => readonly Race[]

/** What the window hands over: the fold over the projects one device reads, or null before reading. */
export type EvaluationsFor = (projects: ReadonlySet<string> | null) => Evaluations | null

/** The answer for one device. */
export function evaluationsFor(fold: EvaluationsFor | undefined, races?: RacesFor): EvaluationsOut {
  // Every paired device reads every project, so the folds are over all of them.
  const raced = racesOut(races?.(null) ?? [])
  const evals = fold?.(null) ?? null
  const empty = { harness: [], model: [], persona: [], template: [] }
  if (evals === null) {
    return {
      read: false,
      mergedFrom: null,
      judge: 'none here',
      total: null,
      by: empty,
      calibration: null,
      races: raced,
    }
  }
  const card = (row: Scorecard, by: EvalBy | null): CardOut => cardOut(row, by)
  return {
    read: true,
    mergedFrom: evals.mergedFrom,
    judge: evals.calibration === null ? 'none here' : 'read',
    total: card(evals.total, null),
    by: Object.fromEntries(
      EVAL_BY.map(({ id }) => [id, scorecardsBy(evals, id).map((row) => card(row, id))]),
    ) as Record<EvalBy, CardOut[]>,
    calibration: evals.calibration !== null ? calibrationOut(evals.calibration) : null,
    races: raced,
  }
}

/** The races, each with every figure the machine has about its entrants. */
function racesOut(races: readonly Race[]): RaceOut[] {
  return races.map((race) => ({
    name: race.name,
    project: race.project,
    said: race.said,
    finished: race.finished,
    spent: raceSpentSays(race),
    won: race.won ? { task: race.won.task, by: race.won.by, why: race.won.why } : null,
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
        facts.strayed === null
          ? 'no judge reads it'
          : facts.strayed
            ? 'strayed from what was asked'
            : 'kept to what was asked',
        facts.findings === null
          ? 'findings not read'
          : `${facts.findings.open + facts.findings.answered + facts.findings.confirmed} findings open`,
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
        usd: raceDollars(facts.usd),
      }
    }),
  }))
}

function cardOut(row: Scorecard, by: EvalBy | null): CardOut {
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
    findings: row.findings ? { ...row.findings } : null,
    cost: perLandedCost(row),
    tokensPerLanded: perLanded(row, (spend) => spend.tokens),
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

// ── Read by another machine ──────────────────────────────────────────────────
//
// What an owner's window on another machine reads of this answer, over the link
// it holds (`GET /api/evaluations`): read **for its shape and nothing more** — a
// field a newer Tade adds is let be, the races are not read at all — and every
// value bounded, because the machine that reads it reads it as another
// machine's, and draws it as that machine's section beside its own. It is never
// added into the reader's own figures: two machines' scorecards are two folds
// over two journals, and a sum of them would be a third thing nobody counted.

/** How many rows of one grouping another machine reads. */
export const CARDS_MOST = 200

const Count = z.int().nonnegative()
const RateSchema = z.object({ count: Count, of: Count, said: z.string().max(200) })

const CardSchema = z.object({
  key: z.string().max(200),
  label: z.string().max(200),
  named: z.boolean(),
  tasks: Count,
  done: RateSchema,
  landed: RateSchema,
  merged: Count,
  firstPushGreen: RateSchema,
  redsHere: Count.nullable(),
  findings: z
    .object({ fired: Count, on: Count, confirmed: Count, wrong: Count, open: Count })
    .nullable(),
  cost: z
    .array(
      z.object({
        said: z.string().max(80),
        kind: z.enum(['billed', 'worked out', 'at list', 'none']),
      }),
    )
    .max(4)
    .nullable(),
  tokensPerLanded: z.number().nonnegative().nullable(),
  toDoneMs: z.number().nonnegative().nullable(),
  moved: Count,
})
export type CardRead = z.infer<typeof CardSchema>

/** `EvaluationsOut` as another machine reads it: the scorecards, and whether its judge reads anything. */
export const EvaluationsAnswerSchema = z.object({
  read: z.boolean(),
  mergedFrom: z.enum(['journal', 'journal and forge']).nullable(),
  judge: z.enum(['read', 'none here']),
  total: CardSchema.nullable(),
  by: z.object({
    harness: z.array(CardSchema).max(CARDS_MOST),
    model: z.array(CardSchema).max(CARDS_MOST),
    persona: z.array(CardSchema).max(CARDS_MOST),
    template: z.array(CardSchema).max(CARDS_MOST),
  }),
})
export type EvaluationsAnswer = z.infer<typeof EvaluationsAnswerSchema>
