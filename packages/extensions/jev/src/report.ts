import type { Answer, Judgement } from '@tade/judges-core'
import { ACCOUNT_NOT_VERDICT, FINDINGS_ARE_MATERIAL } from './loop.ts'
import { SEVERITY, titleOf } from './questions.ts'
import type { Review } from './reviews.ts'

// What one reading answered, and the few words the status bar keeps.
//
// The page this file used to hold is `page.ts`, which windows it and gives it
// tabs. What is left is the two things that are about a single reading rather
// than about the record — the table of every answer, and what a finding says to
// whoever is woken by it — and the line in the status bar.
//
// Pure: readings, looks and findings in, markdown out. Nothing here asks
// anybody anything, so the status item, the view and the brief are one read —
// and none of them can be slow, cost money or need a key.

/** One thing a watch found, as the journal has it. */
export interface Found {
  at: number
  key: string
  title: string
  task: string | null
  told: string | null
  problem: string | null
}

/** One look a watch took, as the journal has it. */
export interface Look {
  at: number
  found: number
  fresh: number
  left: number
  problem: string | null
}

export interface ReviewRecord {
  reviews: readonly Review[]
  looks: readonly Look[]
  findings: readonly Found[]
  /** Tasks the journal says are finished. */
  finished: ReadonlySet<string>
  now: number
}

/** A probability, said the way a threshold is read. */
function said(probability: number): string {
  return probability.toFixed(2)
}

/** What one judgement answered, as a table: every question, not only what fired. */
export function answersTable(
  judged: Judgement,
  thresholds: { report: number; act: number },
): string {
  const rows = Object.entries(judged.answers)
    .map(([id, answer]) => ({ id, answer, weight: weightOf(answer) }))
    .sort((a, b) => b.weight - a.weight)
    .map(({ id, answer }) => {
      const mark =
        answer.kind === 'yes-no'
          ? answer.probability >= thresholds.act
            ? 'worth acting on'
            : answer.probability >= thresholds.report
              ? 'reported'
              : ''
          : ''
      return `| ${id} | ${describe(answer)} | ${mark} |`
    })
  return [
    '| question | answer | |',
    '| --- | --- | --- |',
    ...rows,
    '',
    `Answered by ${judged.version}. A probability is not a verdict: it cannot say why, and it can be steered by what it read.`,
  ].join('\n')
}

/** One answer in a few words, whatever kind it is. */
export function describe(answer: Answer): string {
  if (answer.kind === 'yes-no') return said(answer.probability)
  if (answer.kind === 'pick') {
    const confidence = answer.confidence === null ? '' : `, confidence ${said(answer.confidence)}`
    return `${answer.picked} (${said(answer.probabilities[answer.picked] ?? 0)}${confidence})`
  }
  const level = answer.levels[Math.round(answer.level)] ?? '?'
  return `${level} (${answer.level.toFixed(1)} of ${answer.levels.length - 1})`
}

function weightOf(answer: Answer): number {
  if (answer.kind === 'yes-no') return answer.probability
  if (answer.kind === 'pick') return answer.probabilities[answer.picked] ?? 0
  return answer.level / Math.max(1, answer.levels.length - 1)
}

/** The severity a reading landed on, in its own words. */
export function severitySaid(answers: Readonly<{ [id: string]: Answer }>): string | null {
  const severity = answers.severity
  if (severity?.kind !== 'rate') return null
  return severity.levels[Math.round(severity.level)] ?? SEVERITY[0]
}

function centsSaid(usd: number): string {
  if (usd <= 0) return 'nothing measured'
  return usd < 0.01 ? `${(usd * 100).toFixed(1)}¢` : `$${usd.toFixed(2)}`
}

/**
 * What the status bar keeps: cheap, today's, and true while it is drawn.
 *
 * Two things were wrong with the line it replaces, and both of them made it a
 * line nobody could get rid of. It counted the whole week, so a figure that
 * never went down read as a figure that was stuck. And `a look failed` was
 * said whenever *any* look in seven days had failed — so one bad hour on
 * Tuesday put a warning in the strip until Tuesday week, with no way to dismiss
 * it, about a watch that had been looking happily ever since.
 *
 * So it is today's, like the page it opens, and the trouble it reports is the
 * **last** look's. A watch that has started working again says so by going
 * quiet, which is the only dismissal a derived line can honestly have — and
 * what it says names what happened rather than that something did.
 */
export function statusLine(record: ReviewRecord): { text: string; flagged: number } {
  const since = startOfDay(record.now)
  const today = record.reviews.filter((review) => Date.parse(review.at) >= since)
  const flagged = today.reduce((sum, review) => sum + review.raised.length, 0)
  const spent = today.reduce((sum, review) => sum + review.cost_usd, 0)
  // `looks` is newest first, as `watchedFrom` hands it over.
  const last = record.looks[0]
  return {
    text: `${today.length} read · ${flagged} flagged${spent > 0 ? ` · ${centsSaid(spent)}` : ''}${last?.problem ? ` · ${shortly(last.problem)}` : ''}`,
    flagged,
  }
}

/** Local midnight: the same day the window means, and never a rolling 24 hours. */
function startOfDay(now: number): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/**
 * A reason short enough for the strip, cut at a word.
 *
 * The strip has one line and the reason may be a sentence, so what goes here is
 * its front — and the whole of it is one click away on the Looks tab. Never a
 * provider's JSON: `{"detail":{"error_type":"max_tokens_exceeded"}}` reached
 * somebody as the whole of why a review did not happen, which is neither a
 * finding nor a reason.
 */
function shortly(said: string): string {
  const first = said.split(/[:.]/)[0]?.trim() || said
  return first.length > 44 ? `${first.slice(0, 43).trimEnd()}…` : first
}

/** What a finding says to whoever is woken by it: the question, and that it is not a verdict. */
export function findingDetail(about: {
  question: string
  probability: number
  unit: string
  file: string
  version: string
  rubric: string
  severity: string | null
  /** What the reading left out, where it could not read the whole change. */
  part?: string | null
  branch: string
  base: string
  head: string
  /** Where it is one agent's own commits on a shared branch: those, oldest first. */
  commits?: readonly string[]
  act: number
}): string {
  return [
    `${about.version} answered ${said(about.probability)} to: ${titleOf(about.question)}`,
    about.severity ? `Its reading of how bad this would be to ship: ${about.severity}.` : '',
    about.probability >= about.act
      ? 'That is at or above the acting threshold, so this one is worth reading first.'
      : '',
    `It was answered about ${about.file} in ${about.unit}, under questions ${about.rubric}.`,
    // Said to the agent that has to account for it, because what was not read
    // is the first thing it would otherwise have to work out for itself.
    about.part ? about.part : '',
    '',
    FINDINGS_ARE_MATERIAL,
    '',
    ACCOUNT_NOT_VERDICT,
    '',
    // The command that shows exactly what was read. On a branch everybody
    // shares that is this agent's own commits and not a range across them:
    // `git diff` between two of its commits takes in whatever anybody else
    // committed in between, which is not what any question was asked about.
    about.commits && about.commits.length > 0
      ? `    git show ${about.commits.join(' ')} -- ${about.file}`
      : `    git diff ${about.base}...${about.head} -- ${about.file}`,
  ]
    .filter((line) => line !== '')
    .join('\n')
}
