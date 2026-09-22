import { appendFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The record: what was read, what every question answered, and what came of
// it.
//
// Almost all of it is derived — the looks, the findings, what each became — and
// stays that way: `jev_findings` works it out from the journal, the way status
// does. What cannot be derived is kept here, append-only, next to the journal:
// every answer including the ones that did not fire, and the version that gave
// them. Keep only what cleared the threshold and you can never ask what 0.75
// would have done; lose the version and the first time the numbers drift after
// a release there is nothing to argue from.
//
// This file is evidence, not state. Delete it and the review watch behaves
// exactly the same — it just goes blind about itself, and the sweep finds
// nothing left to ask about. Nothing in the loop reads it to decide anything:
// an account is an agent's testimony and a verdict is somebody else's answer,
// and neither of them starts, stops, holds or allows a single thing.

const DIR = 'jev'
const FILE = 'reviews.jsonl'

/** What one reading of one change answered. */
export interface Review {
  at: string
  project: string
  /** What the finding keys are built from: a task, or a project and a branch. */
  unit: string
  tasks: string[]
  base: string
  head: string
  /** The version that answered. */
  version: string
  /** The version of the questions it answered: `RUBRIC` when they were asked. */
  rubric: string
  files: number
  requests: number
  cost_usd: number
  /** Every question's answer, not only the ones that fired. */
  answers: Record<string, number>
  /** The file each question was highest about: the one thing a reader is pointed at. */
  where: Record<string, string>
  /** The questions that cleared the reporting threshold. */
  raised: string[]
  /** What the agent whose change it was said about it, per question. */
  account: Record<string, Account>
  /** What somebody who could explain it said afterwards, per question. */
  verdict: Record<string, Verdict>
}

/**
 * What the agent whose diff it was said about a finding, while it still
 * remembered why the code is the way it is.
 *
 * It is not a verdict and never becomes one. An agent knows its own reasons,
 * which is worth having; it is also the party being measured, and a defendant
 * does not grade the exam. So this is testimony the calibration never reads —
 * what it feeds is the sweep, which asks somebody else to decide.
 */
export interface Account {
  /** What the agent did about it: fixed the cause, or says there is nothing to fix. */
  did: 'fixed' | 'not real'
  /** The agent's task. */
  by: string
  said: string
  at: string
  /** The questions version it was answering. */
  rubric: string
}

/** What a reader made of one finding: the half of the record Jev cannot give. */
export interface Verdict {
  was: 'confirmed' | 'false positive'
  by: string
  said: string
  at: string
  /** What in the change decided it: the first thing the sentence cited. */
  cited: string
  /** The questions version it was answering. */
  rubric: string
}

type Line = Partial<Review> & {
  verdict?: Record<string, Verdict>
  account?: Record<string, Account>
}

function pathOf(home: string): string {
  return join(home, DIR, FILE)
}

/** Write one reading down. Never throws over a record: evidence is not the work. */
export function recordReview(home: string, review: Review): void {
  append(home, review)
}

/**
 * What a reader made of a finding, afterwards. Appended like everything else,
 * never a rewrite: the review as it was read stays exactly as it was.
 */
export function recordVerdict(
  home: string,
  about: { project: string; unit: string; question: string; verdict: Verdict },
): void {
  append(home, {
    at: about.verdict.at,
    project: about.project,
    unit: about.unit,
    verdict: { [about.question]: about.verdict },
  })
}

/**
 * What the agent whose change it was said about a finding. Appended beside the
 * verdicts and never mixed with them: two different people answering two
 * different questions.
 */
export function recordAccount(
  home: string,
  about: { project: string; unit: string; question: string; account: Account },
): void {
  append(home, {
    at: about.account.at,
    project: about.project,
    unit: about.unit,
    account: { [about.question]: about.account },
  })
}

function append(home: string, line: Line): void {
  try {
    mkdirSync(join(home, DIR), { recursive: true, mode: 0o700 })
    const path = pathOf(home)
    appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
  } catch {
    // A record that cannot be written is not a reason to fail the reading.
  }
}

/**
 * Every reading, oldest first, with the verdicts folded onto the reading they
 * are about. A line that will not read is skipped, never thrown over.
 */
export function readReviews(home: string): Review[] {
  let raw: string
  try {
    raw = readFileSync(pathOf(home), 'utf8')
  } catch {
    // Nothing has been read yet, which is the normal case.
    return []
  }
  const reviews: Review[] = []
  for (const text of raw.split('\n')) {
    if (text.trim() === '') continue
    let line: Line
    try {
      line = JSON.parse(text) as Line
    } catch {
      continue
    }
    if (!line || typeof line !== 'object' || typeof line.unit !== 'string') continue
    if (!line.answers) {
      // An account or a verdict on its own: it belongs to the newest reading
      // of that unit, which is the one the finding was raised by.
      const about = [...reviews].reverse().find((one) => one.unit === line.unit)
      if (!about) continue
      if (line.verdict) Object.assign(about.verdict, line.verdict)
      if (line.account) Object.assign(about.account, line.account)
      continue
    }
    reviews.push({
      at: String(line.at ?? ''),
      project: String(line.project ?? ''),
      unit: line.unit,
      tasks: Array.isArray(line.tasks) ? line.tasks.map(String) : [],
      base: String(line.base ?? ''),
      head: String(line.head ?? ''),
      version: String(line.version ?? ''),
      // A line written before there was a rubric version says so as nothing,
      // which is the honest answer: it is not the rubric of the day it is read.
      rubric: String(line.rubric ?? ''),
      files: Number(line.files ?? 0),
      requests: Number(line.requests ?? 0),
      cost_usd: Number(line.cost_usd ?? 0),
      answers: { ...(line.answers ?? {}) },
      where: { ...(line.where ?? {}) },
      raised: Array.isArray(line.raised) ? line.raised.map(String) : [],
      account: { ...(line.account ?? {}) },
      verdict: { ...(line.verdict ?? {}) },
    })
  }
  return reviews
}
