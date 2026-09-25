import { duration } from '@tade/core'
import { findingsOf, type OpenFinding, RUNGS, shorten } from './loop.ts'
import {
  ENOUGH,
  precisionOf,
  precisionSaid,
  type QuestionRow,
  type Tally,
  worthSaid,
} from './precision.ts'
import { titleOf } from './questions.ts'
import type { ReviewRecord } from './report.ts'
import {
  type Standing,
  type Stuck,
  standingsOf,
  stuckMark,
  stuckSaid,
  stuckSays,
  stuckTally,
  type Whose,
} from './stuck.ts'

// The page Jev keeps: five tabs over one window of time.
//
// It used to be one flat report of everything that had ever been read, with
// four tables end to end and a paragraph under each. Two things were wrong with
// that and they are the same thing twice: it never said *when*, so a week-old
// failure and this morning's read the same; and it said everything at once, so
// the one figure worth knowing — whether any of this is worth running — was
// four screens down.
//
// So: a window, `today` by default, decided by the window with `sinceOf` and
// handed here as a moment — there is one idea of a day in Tade and this is not
// a second one. And five tabs, because the five questions are different
// questions: what is going on, what is open, which questions earn their place,
// whether a probability means what it says, and whether the watch can look at
// all.
//
// Pure, like the report it replaces: a record and a window in, markdown out.
// The colour is the drawing's — a `chart` fence with a tone mark at the front
// of each row — because what a green tick means is the window's to decide.

/**
 * Who could still answer for a finding, and what has already been asked about
 * one, out of the record and the window.
 *
 * `agents` is the window's answer and null where there is no window: an agent
 * is not gone because nobody is looking, so with no window the journal's
 * `task_done` is all that may be concluded from. `told` reads the keys the
 * sweep has handed over — a watch remembers every key it ever found, which is
 * what makes "somebody has been asked about this" a fact rather than a guess.
 */
export function whoseFrom(record: ReviewRecord, agents: readonly { task: string }[] | null): Whose {
  const running = new Set((agents ?? []).map((agent) => agent.task))
  // The sweep's keys are the finding's with why and which rung after a `#`, so
  // what was asked about is the part in front of it. Cut once into a set rather
  // than scanned per finding: this is read on the window's own beat.
  const asked = new Set(record.findings.map((found) => found.key.split('#')[0] ?? found.key))
  return {
    going: (task) => !record.finished.has(task) && (agents === null || running.has(task)),
    told: (key) => asked.has(key),
  }
}

/** The tabs the page offers, the first being the default. */
export const JEV_TABS: readonly { id: string; title: string }[] = [
  { id: 'overview', title: 'Overview' },
  { id: 'findings', title: 'Findings' },
  { id: 'questions', title: 'Questions' },
  { id: 'calibration', title: 'Calibration' },
  { id: 'looks', title: 'Looks' },
]

/** Where the page is being read: which tab, and how far back. */
export interface PageAt {
  tab: string
  /** Only what happened at or after this. `0` is everything there has ever been. */
  since: number
  /** What the window is called, for saying what an empty page is empty of. */
  window?: string
  /** Narrow to one project, or one task's own change. */
  project?: string
  task?: string
}

/** The marks a row carries, which are the four tones the window paints. */
const GOOD = '●'
const BAD = '✗'
const WAIT = '◐'
const QUIET = '○'

/** A fenced block the window paints: a tone mark per row, figures brightened. */
function chart(rows: readonly string[]): string[] {
  if (rows.length === 0) return []
  return ['```chart', ...rows, '```']
}

/** Columns padded to the widest, so a fence reads as a table without being one. */
function columns(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, at) => {
      widths[at] = Math.max(widths[at] ?? 0, cell.length)
    })
  }
  return rows.map((row) =>
    row
      .map((cell, at) => (at === row.length - 1 ? cell : cell.padEnd(widths[at] ?? 0)))
      .join('  ')
      .trimEnd(),
  )
}

/** A bar of the same width wherever it is drawn, so two rows can be compared. */
const BAR = 16

function bar(share: number): string {
  const filled = Math.max(0, Math.min(BAR, Math.round(share * BAR)))
  return `${'█'.repeat(filled)}${'░'.repeat(BAR - filled)}`
}

function money(usd: number): string {
  if (usd <= 0) return 'nothing measured'
  return usd < 0.01 ? `${(usd * 100).toFixed(1)}¢` : `$${usd.toFixed(2)}`
}

/** What a window is called in a sentence about it being empty. */
function called(at: PageAt): string {
  if (at.window === 'window') return 'since this window opened'
  if (at.window === 'week') return 'in the last seven days'
  if (at.since === 0) return 'ever'
  return 'today'
}

/**
 * The mark a reason carries: settled, waiting on somebody who can decide,
 * waiting on an agent, or waiting on nobody at all.
 *
 * One function, so the count in the overview and the row in the table can never
 * paint the same reason two colours.
 */
function stuckTone(stuck: Stuck): string {
  if (stuck === 'answered') return GOOD
  if (stuck === 'told-not-judged' || stuck === 'waiting-to-be-told') return BAD
  if (stuck === 'agent-working') return WAIT
  return QUIET
}

/** The mark a question's standing carries. */
function questionMark(row: QuestionRow): string {
  if (row.worth === 'earns') return GOOD
  if (row.worth === 'costs') return BAD
  return WAIT
}

/** What the record holds about one window, gathered once for every tab. */
interface Read {
  reviews: ReviewRecord['reviews']
  findings: OpenFinding[]
  standings: Standing[]
  open: Standing[]
  precision: ReturnType<typeof precisionOf>
  looks: ReviewRecord['looks']
  usd: number
  flagged: number
}

/** A local midnight, the way `sinceOf` means a day. */
function midnight(at: number): number {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/**
 * A day as a date, read off the local clock and never off the ISO string.
 *
 * `toISOString()` of a local midnight is the *previous* day anywhere east of
 * Greenwich — 2026-09-13 at midnight in Sarajevo is 2026-09-12T22:00Z — so a
 * table of days labelled that way is a table every row of which is off by one
 * for most of the world.
 */
function dateSaid(at: number): string {
  const day = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
}

/** Everything one window of the record says, before anybody chooses a tab. */
export function readOf(record: ReviewRecord, at: PageAt, whose: Whose): Read {
  const reviews = record.reviews.filter(
    (review) =>
      Date.parse(review.at) >= at.since &&
      (!at.project || review.project === at.project) &&
      (!at.task || review.unit === at.task || review.tasks.includes(at.task)),
  )
  // Findings are folded over every reading there has ever been — an account or
  // a verdict written today is about a reading made on Tuesday, and a finding
  // that lost half of what was said about it is a finding the page would
  // report as unanswered. The *window* is then applied to the finding, by when
  // it was raised.
  const all = findingsOf(record.reviews).filter(
    (one) =>
      (!at.project || one.project === at.project) &&
      (!at.task || one.unit === at.task || one.tasks.includes(at.task)),
  )
  const findings = all.filter((one) => one.at >= at.since)
  const standings = standingsOf(findings, whose, record.now)
  return {
    reviews,
    findings,
    standings,
    open: standings.filter((one) => one.stuck !== 'answered'),
    precision: precisionOf(findings, reviews, { now: record.now, dayAt: midnight }),
    looks: record.looks.filter((look) => look.at >= at.since),
    usd: reviews.reduce((sum, review) => sum + review.cost_usd, 0),
    flagged: findings.length,
  }
}

/** The page, as the window asks for it. */
export function jevPage(record: ReviewRecord, at: PageAt, whose: Whose): string {
  const read = readOf(record, at, whose)
  if (at.tab === 'findings') return findingsTab(read, at, record.now).join('\n')
  if (at.tab === 'questions') return questionsTab(read, at).join('\n')
  if (at.tab === 'calibration') return calibrationTab(read, at).join('\n')
  if (at.tab === 'looks') return looksTab(read, at, record.now).join('\n')
  return overviewTab(read, at).join('\n')
}

/**
 * What is going on: what was read, where the findings stand, whether any of it
 * is worth running, and the questions that fire loudest.
 *
 * Four figures and a sentence each. Anything that wants a table of its own has
 * a tab of its own.
 */
function overviewTab(read: Read, at: PageAt): string[] {
  const lines = [`## Read ${called(at)}`, '']
  lines.push(
    read.reviews.length === 0
      ? `Nothing read ${called(at)}. The review watch reads each agent’s change once it has stopped moving; jev_review reads on demand.`
      : `${read.reviews.length} change${read.reviews.length === 1 ? '' : 's'} · ${read.flagged} flagged · ${money(read.usd)} · ${read.looks.length} look${read.looks.length === 1 ? '' : 's'}`,
  )
  const last = read.looks[0]
  if (last?.problem) {
    // The last look and not "a look failed in the last week": a failure that
    // has been fixed must stop being said, or the line is one nobody can get
    // rid of and everybody learns to read past.
    lines.push('')
    lines.push(...chart([`${BAD} the last look could not look — ${last.problem}`]))
  }

  if (read.standings.length > 0) {
    lines.push('', '## Where they stand', '')
    lines.push(
      ...chart(
        columns(
          stuckTally(read.standings).map((row) => [
            `${stuckTone(row.stuck)} ${stuckMark(row.stuck)}`,
            String(row.count),
          ]),
        ),
      ),
    )
    const says = stuckSays(read.standings)
    if (says) lines.push('', says)
  }

  const total = read.precision.total
  if (total.fired > 0) {
    lines.push('', '## Worth running', '')
    lines.push(
      ...chart([
        [
          `${total.judged === 0 ? QUIET : total.enough ? ((total.precision ?? 0) >= 0.5 ? GOOD : BAD) : WAIT} precision`,
          // A bar is a picture of a rate, so it is drawn only where the rate may
          // be read as one: eight blocks out of sixteen off two verdicts is the
          // figure the `too few to call` beside it is warning about.
          ...(total.enough ? [bar(total.precision ?? 0)] : []),
          precisionSaid(total),
        ].join('  '),
      ]),
    )
    lines.push('', honesty(total))
  }

  const loud = read.precision.byQuestion.slice(0, 3)
  if (loud.length > 0) {
    lines.push('', '## Loudest questions', '')
    lines.push(
      ...chart(
        columns(
          loud.map((row) => [
            `${questionMark(row)} ${row.question}`,
            `${row.tally.fired} fired`,
            precisionSaid(row.tally),
            worthSaid(row.worth, row.tally),
          ]),
        ),
      ),
    )
  }
  return lines
}

/** What a rate may be read as, given how many verdicts are behind it. */
function honesty(tally: Tally): string {
  if (tally.judged === 0) {
    return `Nothing has been judged, so nothing here is a rate. A verdict is the orchestrator’s or a person’s: ${tally.fired} finding(s) are waiting for one.`
  }
  if (!tally.enough) {
    return `${tally.judged} verdict(s) is not a rate. Under ${ENOUGH} the counts are said and the percentage is not, because one verdict moving a figure by a quarter is not a trend.`
  }
  return `Out of ${tally.judged} verdict(s). ${tally.open} finding(s) have none and are counted as neither.`
}

/** Every finding in the window, longest waiting first, with why it has not closed. */
function findingsTab(read: Read, at: PageAt, now: number): string[] {
  const lines = [`## ${read.standings.length} flagged ${called(at)}`, '']
  if (read.standings.length === 0) {
    lines.push(
      `Nothing was flagged ${called(at)}. That is an answer and not a pass: the rubric reads each question as written and cannot say why.`,
    )
    return lines
  }
  lines.push(
    ...chart(
      columns(
        read.standings.map((one) => [
          `${stuckTone(one.stuck)} ${one.finding.key}`,
          one.finding.probability.toFixed(2),
          duration(one.waitedMs),
          one.stuck === 'answered' ? (one.finding.verdict?.was ?? 'judged') : stuckMark(one.stuck),
        ]),
      ),
    ),
  )
  // Why, in full, for the ones nothing has closed: the mark says which of the
  // five it is and this says what to do about it. Once per reason and not once
  // per finding — the same sentence under nine rows is a sentence nobody reads.
  const reasons = stuckTally(read.open)
  if (reasons.length > 0) {
    lines.push('', '## Why they are open', '')
    for (const row of reasons) {
      lines.push(`- **${stuckMark(row.stuck)}** (${row.count}) — ${stuckSaid(row.stuck)}`)
    }
    lines.push('')
    lines.push(
      `Nothing here becomes a false positive by getting old. jev_verdict is the only thing that closes one, it is never an agent’s to give about its own change, and its sentence has to cite what in the change decided it. The sweep asks again as a wait passes ${RUNGS.filter(
        (rung) => rung.said,
      )
        .map((rung) => rung.said)
        .join(', ')} — four times ever, per finding.`,
    )
  }
  // The account that has waited longest for somebody to decide about it, which
  // is where whoever is writing verdicts would start.
  const said = read.open
    .filter((one) => one.finding.account)
    .sort(
      (a, b) =>
        (Date.parse(a.finding.account?.at ?? '') || a.finding.at) -
        (Date.parse(b.finding.account?.at ?? '') || b.finding.at),
    )[0]
  if (said?.finding.account) {
    lines.push(
      '',
      `Waiting longest with an account: **${said.finding.key}** — its agent said ${said.finding.account.did === 'fixed' ? 'it fixed this' : 'this is not real'}, ${duration(Math.max(0, now - (Date.parse(said.finding.account.at) || said.finding.at)))} ago.`,
    )
  }
  return lines
}

/** Which questions earn their place: fired, judged, and what the verdicts said. */
function questionsTab(read: Read, at: PageAt): string[] {
  const rows = read.precision.byQuestion
  const lines = [`## ${rows.length} question(s) fired ${called(at)}`, '']
  if (rows.length === 0) {
    lines.push(`No question in the pack fired ${called(at)}.`)
    return lines
  }
  const most = Math.max(1, ...rows.map((row) => row.tally.fired))
  lines.push(
    ...chart(
      columns([
        ['  question', 'fired', '', 'verdicts', 'highest', ''],
        ...rows.map((row) => [
          `${questionMark(row)} ${row.question}`,
          String(row.tally.fired),
          bar(row.tally.fired / most),
          precisionSaid(row.tally),
          row.highest.toFixed(2),
          worthSaid(row.worth, row.tally),
        ]),
      ]),
    ),
  )
  const costs = rows.filter((row) => row.worth === 'costs')
  lines.push('')
  lines.push(
    costs.length === 0
      ? `Nothing has enough verdicts against it to be called wrong. A question needs ${ENOUGH} before either answer is drawn.`
      : `${costs.map((row) => row.question).join(', ')} ${costs.length === 1 ? 'has' : 'have'} fired and been wrong more often than right. Reword or delete ${costs.length === 1 ? 'it' : 'them'} in questions.ts; every finding, account and verdict keeps the pack version that produced it, so what is already written stays readable under the version that judged it.`,
  )
  lines.push('')
  lines.push('What each of them asks, in its own words:')
  // Its own words and not the whole of them: a question's wording is the only
  // explanation a finding gets, and three of these at full length is the page.
  for (const row of rows.slice(0, 6)) {
    lines.push(`- **${row.question}** — ${shorten(titleOf(row.question), 150)}`)
  }
  return lines
}

/** Whether a probability means what it says, by band and over time. */
function calibrationTab(read: Read, at: PageAt): string[] {
  const bands = read.precision.byBand.filter((band) => band.tally.fired > 0)
  const lines = ['## By probability', '']
  if (bands.length === 0) {
    lines.push(`Nothing was flagged ${called(at)}, so there is nothing to calibrate.`)
    return lines
  }
  lines.push(
    ...chart(
      columns([
        ['  band', 'flagged', 'verdicts', ''],
        ...bands.map((band) => [
          `${band.tally.judged === 0 ? QUIET : band.tally.enough ? ((band.tally.precision ?? 0) >= 0.5 ? GOOD : BAD) : WAIT} ${band.from.toFixed(1)}–${band.to.toFixed(1)}`,
          String(band.tally.fired),
          precisionSaid(band.tally),
          band.tally.enough ? bar(band.tally.precision ?? 0) : '',
        ]),
      ]),
    ),
  )
  lines.push('')
  lines.push(
    'A band is calibrated when the share confirmed is near the band itself: 0.8–0.9 should be right about four times in five. Read nothing off a band with fewer verdicts than that.',
  )
  const days = read.precision.byDay.filter((day) => day.read > 0 || day.tally.fired > 0)
  if (days.length > 0) {
    lines.push('', '## Over time', '')
    lines.push(
      ...chart(
        columns([
          ['  day', 'read', 'flagged', 'verdicts', 'cost'],
          ...days.map((day) => [
            `${day.tally.judged > 0 ? GOOD : day.tally.fired > 0 ? WAIT : QUIET} ${dateSaid(day.at)}`,
            String(day.read),
            String(day.tally.fired),
            precisionSaid(day.tally),
            money(day.usd),
          ]),
        ]),
      ),
    )
    lines.push('')
    lines.push(
      'A day is where a finding was raised, not where it was judged: a verdict written this morning about Tuesday’s reading counts on Tuesday, because what is being measured is the reading.',
    )
  }
  return lines
}

/** Whether the watch can look at all: every look in the window, newest first. */
function looksTab(read: Read, at: PageAt, now: number): string[] {
  const lines = [`## ${read.looks.length} look(s) ${called(at)}`, '']
  if (read.looks.length === 0) {
    lines.push(
      `The review watch has not looked ${called(at)}. It is a schedule like any other — pause it, change it or remove it in the queue.`,
    )
    return lines
  }
  const trouble = read.looks.filter((look) => look.problem)
  lines.push(
    ...chart(
      columns(
        read.looks.slice(0, 40).map((look) => [
          // A look that found nothing looked. Only one thing on this tab is
          // wrong, and it is a look that could not look.
          `${look.problem ? BAD : GOOD} ${duration(Math.max(0, now - look.at))} ago`,
          look.problem ? look.problem : `found ${look.found}, ${look.fresh} new`,
        ]),
      ),
    ),
  )
  lines.push('')
  lines.push(
    trouble.length === 0
      ? 'Every look in this window looked. A look that finds nothing is a look, not a failure.'
      : `${trouble.length} of ${read.looks.length} could not look. A change too big for one ask is read as far as the budget goes and what was left out is named on the finding; a look that could read nothing at all is what this says.`,
  )
  return lines
}

/**
 * The whole page, every tab at once and no window: what `jev_findings` answers
 * with, because a tool call has no tabs to press and the orchestrator is
 * usually asking about findings older than today.
 */
export function findingsReport(
  record: ReviewRecord,
  about: { project?: string; task?: string } = {},
  // The cautious reading unless the caller has a window to ask: an agent is not
  // gone because nobody is looking, so with none the journal's `task_done` is all
  // this may conclude from.
  whose: Whose = whoseFrom(record, null),
): string {
  const at: PageAt = { tab: '', since: 0, ...about }
  return JEV_TABS.map((tab) => jevPage(record, { ...at, tab: tab.id }, whose)).join('\n\n')
}
