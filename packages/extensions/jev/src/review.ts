import type { Finding } from '@tade/extensions-core'
import type { Question } from '@tade/judges-core'
import type { Asking } from './ask.ts'
import { type FileChange, inBatches, stateOf, type Unit } from './changes.ts'

import { titleOf } from './questions.ts'
import { findingDetail, findingKey, severitySaid } from './report.ts'
import type { Review } from './reviews.ts'

// Reading one change with the pack, and what comes of it.
//
// Two stages, and the split is the whole design: this is stage one — cheap,
// over everything, a number per question. What clears the acting threshold is
// read by something that can write a sentence, because what reaches a person
// must never be a bare probability.

/** What one reading of one change came to. */
export interface Reading {
  version: string
  /** The highest probability each question reached, over every file. */
  answers: Record<string, number>
  /** The file each question was highest about. */
  where: Record<string, string>
  severity: string | null
  files: number
}

/** How much of an ask is left for the diff once the questions are in it. */
function roomFor(asking: Asking, questions: readonly Question[]): number {
  const asked = questions.reduce((sum, one) => sum + one.ask.length, 0)
  const budget = asking.judge.capabilities.stateTokens * 4
  return Math.max(2_000, Math.floor(budget * 0.6) - asked)
}

/**
 * Read one change against a pack of questions: one ask per file, or per few
 * small files, every question in each. A question fires for the change if it
 * clears the threshold anywhere in it, and the reading names where it was
 * highest — which is the only pointer a reader gets, because there is no
 * rationale to give them.
 */
export async function readChange(
  asking: Asking,
  unit: Pick<Unit, 'intent' | 'branch' | 'tasks'>,
  changes: readonly FileChange[],
  questions: readonly Question[],
  options: { signal?: AbortSignal; progress?: (text: string) => void } = {},
): Promise<Reading> {
  const reading: Reading = {
    version: '',
    answers: {},
    where: {},
    severity: null,
    files: changes.length,
  }
  let severity = -1
  for (const batch of inBatches(changes, roomFor(asking, questions))) {
    options.progress?.(`reading ${batch.map((one) => one.file).join(', ')}`)
    const judged = await asking.askAll(stateOf(unit, batch), questions, options.signal)
    reading.version = judged.version
    for (const [id, answer] of Object.entries(judged.answers)) {
      if (answer.kind !== 'yes-no') continue
      if ((reading.answers[id] ?? -1) >= answer.probability) continue
      reading.answers[id] = answer.probability
      reading.where[id] = batch[0]?.file ?? ''
    }
    const rated = judged.answers.severity
    if (rated?.kind === 'rate' && rated.level > severity) {
      severity = rated.level
      reading.severity = severitySaid(judged.answers)
    }
  }
  return reading
}

/** The questions that cleared the reporting threshold, highest first. */
export function raisedIn(reading: Reading, report: number): string[] {
  return Object.entries(reading.answers)
    .filter(([, probability]) => probability >= report)
    .sort(([, a], [, b]) => b - a)
    .map(([id]) => id)
}

/** A reading as the record keeps it: every answer, not only what fired. */
export function reviewLine(
  reading: Reading,
  unit: Unit,
  cost: { requests: number; usd: number },
  report: number,
  at: number,
): Review {
  return {
    at: new Date(at).toISOString(),
    project: unit.project,
    unit: unit.key,
    tasks: [...unit.tasks],
    base: unit.base,
    head: unit.head,
    version: reading.version,
    files: reading.files,
    requests: cost.requests,
    cost_usd: cost.usd,
    answers: { ...reading.answers },
    raised: raisedIn(reading, report),
    verdict: {},
  }
}

/** What fired, as findings a watch can hand on: one change, one question, one key. */
export function findingsIn(
  reading: Reading,
  unit: Unit,
  thresholds: { report: number; act: number },
): Finding[] {
  return raisedIn(reading, thresholds.report).map((question) => ({
    key: findingKey(unit.key, question),
    title: `${unit.key}: ${shorten(titleOf(question), 120)}`,
    detail: findingDetail({
      question,
      probability: reading.answers[question] ?? 0,
      unit: unit.key,
      file: reading.where[question] ?? '',
      version: reading.version,
      severity: reading.severity,
      branch: unit.branch,
      base: unit.base,
      head: unit.head,
      act: thresholds.act,
    }),
  }))
}

/** A sentence cut at a word, so a title stays a title. */
export function shorten(text: string, most: number): string {
  if (text.length <= most) return text
  const cut = text.slice(0, most)
  const at = cut.lastIndexOf(' ')
  return `${cut.slice(0, at > most / 2 ? at : most).trimEnd()}…`
}

/** What an agent sent to look at a finding is told. */
export function stageTwoPrompt(finding: Finding): string {
  return [
    'Jev flagged something in a change on this branch. What it said is in .tade/context.md: a',
    'question and a probability, and no explanation, because it cannot give one.',
    'Read the change yourself first. If it is right, fix the cause and add a test that fails',
    'without the fix. If it is wrong, say so plainly in your last message and change nothing —',
    'a false positive is an expected outcome here, not a failure. Either way, record which it was',
    `with jev_verdict (the finding is ${finding.key}), because nothing else can say whether this`,
    'rubric is worth running.',
  ].join(' ')
}
