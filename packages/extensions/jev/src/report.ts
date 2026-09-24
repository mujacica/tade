import type { Answer, Judgement } from '@tade/judges-core'
import {
  ACCOUNT_NOT_VERDICT,
  FINDINGS_ARE_MATERIAL,
  findingsOf,
  gapLines,
  type OpenFinding,
} from './loop.ts'
import { SEVERITY, titleOf } from './questions.ts'
import type { Review } from './reviews.ts'

// What everything Jev did adds up to, in words and tables.
//
// Pure: readings, looks and findings in, markdown out. Nothing here asks
// anybody anything, so `jev_findings`, the status item, the view and the brief
// are one function read four ways — and none of them can be slow, cost money
// or need a key.

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

const WEEK = 7 * 24 * 60 * 60_000

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

/** What the record says, as a page: this week, by question, calibration, and what is open. */
export function findingsReport(
  record: ReviewRecord,
  about?: { project?: string; task?: string },
): string {
  const reviews = record.reviews.filter(
    (review) =>
      (!about?.project || review.project === about.project) &&
      (!about?.task || review.unit === about.task || review.tasks.includes(about.task)),
  )
  const findings = record.findings.filter(
    (finding) => !about?.task || finding.key.startsWith(`${about.task}:`),
  )
  const week = reviews.filter((review) => Date.parse(review.at) >= record.now - WEEK)
  const looks = record.looks.filter((look) => look.at >= record.now - WEEK)
  const raised = week.reduce((sum, review) => sum + review.raised.length, 0)
  const spent = week.reduce((sum, review) => sum + review.cost_usd, 0)
  const lines: string[] = []

  lines.push('## This week')
  lines.push('')
  lines.push(
    looks.length === 0 && week.length === 0
      ? 'Nothing read yet — the review watch reads a change once it has stopped moving, and jev_review reads on demand.'
      : `${looks.length} look${looks.length === 1 ? '' : 's'} · ${week.length} change${week.length === 1 ? '' : 's'} read · ${raised} flagged · ${centsSaid(spent)}`,
  )
  const trouble = looks.filter((look) => look.problem)
  if (trouble.length > 0) {
    lines.push('')
    lines.push(`${trouble.length} look(s) could not look: ${trouble[0]?.problem ?? ''}`)
  }

  // The state of the loop, before any of the tables: whether anything it
  // flagged was ever answered is the question the rest of this page is only
  // worth reading if the answer to is yes.
  const raisedFindings = findingsOf(reviews)
  const known = new Map(raisedFindings.map((one) => [one.key, one]))
  lines.push(...gapLines(raisedFindings, record.now))

  const byQuestion = new Map<string, { fired: number; confirmed: number; wrong: number }>()
  for (const review of reviews) {
    for (const id of review.raised) {
      const row = byQuestion.get(id) ?? { fired: 0, confirmed: 0, wrong: 0 }
      row.fired++
      const verdict = review.verdict[id]
      if (verdict?.was === 'confirmed') row.confirmed++
      if (verdict?.was === 'false positive') row.wrong++
      byQuestion.set(id, row)
    }
  }
  if (byQuestion.size > 0) {
    lines.push('')
    lines.push('## By question')
    lines.push('')
    lines.push('| question | fired | confirmed | false positive |')
    lines.push('| --- | --- | --- | --- |')
    for (const [id, row] of [...byQuestion].sort((a, b) => b[1].fired - a[1].fired)) {
      lines.push(`| ${id} | ${row.fired} | ${row.confirmed} | ${row.wrong} |`)
    }
  }

  const buckets = calibration(reviews)
  if (buckets.some((bucket) => bucket.judged > 0)) {
    lines.push('')
    lines.push('## Calibration')
    lines.push('')
    lines.push('| probability | flagged | confirmed |')
    lines.push('| --- | --- | --- |')
    for (const bucket of buckets) {
      if (bucket.judged === 0) continue
      lines.push(
        `| ${bucket.from.toFixed(1)}–${bucket.to.toFixed(1)} | ${bucket.judged} | ${bucket.confirmed} |`,
      )
    }
  }

  if (findings.length > 0) {
    lines.push('')
    lines.push('## What it found')
    lines.push('')
    for (const finding of findings.slice(0, 20)) {
      const became = finding.task
        ? `${finding.task}${record.finished.has(finding.task) ? ', finished' : ', going'}`
        : finding.told
          ? `told ${finding.told}`
          : (finding.problem ?? 'nothing yet')
      lines.push(`- **${finding.key}** — ${finding.title}`)
      lines.push(`  ${became}${saidAbout(known.get(finding.key))}`)
    }
  }
  return lines.join('\n')
}

/** What has been said about one finding since: the agent's account, then the verdict. */
function saidAbout(one: OpenFinding | undefined): string {
  if (!one) return ''
  const account = one.account ? ` · its agent: ${one.account.did} — ${one.account.said}` : ''
  const verdict = one.verdict ? ` · ${one.verdict.was}: ${one.verdict.said}` : ''
  return `${account}${verdict}`
}

function calibration(reviews: readonly Review[]) {
  const buckets = Array.from({ length: 10 }, (_, index) => ({
    from: index / 10,
    to: (index + 1) / 10,
    judged: 0,
    confirmed: 0,
  }))
  for (const review of reviews) {
    for (const id of review.raised) {
      const probability = review.answers[id] ?? 0
      const bucket = buckets[Math.min(9, Math.max(0, Math.floor(probability * 10)))]
      if (!bucket) continue
      bucket.judged++
      if (review.verdict[id]?.was === 'confirmed') bucket.confirmed++
    }
  }
  return buckets
}

function centsSaid(usd: number): string {
  if (usd <= 0) return 'nothing measured'
  return usd < 0.01 ? `${(usd * 100).toFixed(1)}¢` : `$${usd.toFixed(2)}`
}

/** What the status bar keeps: cheap, and the same numbers as everything else. */
export function statusLine(record: ReviewRecord): { text: string; flagged: number } {
  const week = record.reviews.filter((review) => Date.parse(review.at) >= record.now - WEEK)
  const flagged = week.reduce((sum, review) => sum + review.raised.length, 0)
  const spent = week.reduce((sum, review) => sum + review.cost_usd, 0)
  const trouble = record.looks.filter((look) => look.problem && look.at >= record.now - WEEK).length
  return {
    text: `${week.length} read · ${flagged} flagged${spent > 0 ? ` · ${centsSaid(spent)}` : ''}${trouble > 0 ? ' · a look failed' : ''}`,
    flagged,
  }
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
  branch: string
  base: string
  head: string
  act: number
}): string {
  return [
    `${about.version} answered ${said(about.probability)} to: ${titleOf(about.question)}`,
    about.severity ? `Its reading of how bad this would be to ship: ${about.severity}.` : '',
    about.probability >= about.act
      ? 'That is at or above the acting threshold, so this one is worth reading first.'
      : '',
    `It was answered about ${about.file} in ${about.unit}, under questions ${about.rubric}.`,
    '',
    FINDINGS_ARE_MATERIAL,
    '',
    ACCOUNT_NOT_VERDICT,
    '',
    `    git diff ${about.base}...${about.head} -- ${about.file}`,
  ]
    .filter((line) => line !== '')
    .join('\n')
}
